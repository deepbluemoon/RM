// P3 위험 탐지(T075, INC3 분석 모드): 3.1 /v1/jobs(관점 없음) → 3.2 폴링·점수 저장 → 3.3 기준치 선별 → 3.4 근거 검색 →
// 3.5 캐시 조회 → 미적중이면 /v1/judge(전역 제한기, 먼저 시작한 실행 우선) → 3.6 조항 타임아웃 = 분석 불가, 서버 다운 = aborted·G5 → 3.8 completed
import { exec, getPool, select } from '../../db/pool.js';
import { withTx } from '../../db/tx.js';
import { policy } from '../../config/policy.js';
import { logger } from '../../logger.js';
import { asKvId, fromStoredDeid, type ModelJudgeResult } from '../../domain/types.js';
import type { Perspective, RiskType } from '../../domain/codes.js';
import { CancelledError, judgeGate, throwIfAborted } from '../../jobs/runner.js';
import { modelApi, ModelApiError, type ClauseIn, type DetectScore } from '../modelApi/client.js';
import { AdapterError, normalizeJudge, normalizeRiskTypeHint } from '../modelApi/adapter.js';
import { getServerStatus } from '../modelApi/status.js';
import { recordGate } from '../gates/gates.service.js';
import { searchEvidence, type SearchHit } from '../evidence/search.js';
import { recordAbstentions, screenClauses } from '../abstention/abstention.service.js';
import { knowledgeVersion } from '../evidence/evidence.repo.js';
import { getClauses, getRequest, getRun, type ClauseRow } from '../analysis/analysis.repo.js';
import { findCached, saveJudgment } from './judgment.repo.js';
import { afterBusinessJudgments } from './perspective.js';

export class ServerDownError extends Error {}

interface Scored {
  clause: ClauseRow;
  loophole: DetectScore | null;
  illegal: DetectScore | null;
  m1: string | null;
  m2: string | null;
  error: 'timeout' | null;
}

const POLL_MS = 500;

async function setRunStage(runId: number, stage: string, extra = ''): Promise<void> {
  const r = await exec(getPool(), `UPDATE analysis_run SET stage = ?${extra} WHERE run_id = ? AND stage NOT IN ('aborted','saved')`, [stage, runId]);
  if (r.affectedRows === 0) throw new CancelledError();
}

/** 실행 단위로 고정한 M3 버전(research R-11) */
const runM3Version = new Map<number, string>();
export async function m3VersionFor(runId: number): Promise<string> {
  let v = runM3Version.get(runId);
  if (!v) {
    const models = await modelApi.models();
    v = models.models.find((m) => m.id === 'M3')?.model_version ?? 'unknown-m3';
    runM3Version.set(runId, v);
  }
  return v;
}

function toClauseIn(c: ClauseRow): ClauseIn {
  return { clause_id: String(c.clause_id), text: fromStoredDeid(c.deid_text), article_no: c.article_no, title: c.title };
}

async function isServerDown(e: unknown): Promise<boolean> {
  if (!(e instanceof ModelApiError)) return false;
  if (e.kind === 'auth') return true;
  if (e.kind !== 'unavailable') return false;
  const s = await getServerStatus(true);
  return s.state !== 'ready';
}

/** 3.1~3.2 문서별 /v1/jobs 생성 → 폴링. 점수는 받는 대로 clause_assessment(pending)에 저장해 진행률을 보인다 */
async function detectScores(runId: number, clauses: ClauseRow[], signal: AbortSignal): Promise<Scored[]> {
  const byDoc = new Map<number, ClauseRow[]>();
  for (const c of clauses) byDoc.set(c.document_id, [...(byDoc.get(c.document_id) ?? []), c]);
  await withTx(async (conn) => {
    for (const c of clauses) await conn.query("INSERT INTO clause_assessment (run_id, clause_id, status) VALUES (?, ?, 'pending')", [runId, c.clause_id]);
  });
  const out = new Map<number, Scored>();
  for (const [, docClauses] of byDoc) {
    const contractType = docClauses[0]!.contract_type!;
    const jobId = await modelApi.createDetectJob(docClauses.map(toClauseIn), contractType);
    await exec(getPool(), 'UPDATE analysis_run SET job_ref = COALESCE(job_ref, ?) WHERE run_id = ?', [jobId.slice(0, 64), runId]);
    const byId = new Map(docClauses.map((c) => [String(c.clause_id), c]));
    for (;;) {
      throwIfAborted(signal);
      const job = await modelApi.getJob(jobId);
      for (const r of job.results) {
        const c = byId.get(r.clause_id);
        if (!c || out.has(c.clause_id)) continue;
        const s: Scored = { clause: c, loophole: r.loophole ?? null, illegal: r.illegal ?? null, m1: job.model_versions?.M1 ?? null, m2: job.model_versions?.M2 ?? null, error: r.error ?? null };
        out.set(c.clause_id, s);
        if (!s.error) {
          await exec(getPool(), 'UPDATE clause_assessment SET score_loophole = ?, score_illegal = ?, m1_model_version = ?, m2_model_version = ? WHERE run_id = ? AND clause_id = ?', [
            s.loophole?.score ?? null, s.illegal?.score ?? null, s.m1?.slice(0, 40) ?? null, s.m2?.slice(0, 40) ?? null, runId, c.clause_id,
          ]);
        }
      }
      if (job.status === 'done' || job.status === 'failed') break;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    for (const c of docClauses) if (!out.has(c.clause_id)) out.set(c.clause_id, { clause: c, loophole: null, illegal: null, m1: null, m2: null, error: 'timeout' });
  }
  return clauses.map((c) => out.get(c.clause_id)!);
}

async function markUnanalyzable(runId: number, clauseId: number, reason: 'timeout' | 'server_down', scores?: Scored): Promise<void> {
  await exec(
    getPool(),
    "UPDATE clause_assessment SET status = 'unanalyzable', unanalyzable_reason = ?, screen_result = COALESCE(screen_result, ?) WHERE run_id = ? AND clause_id = ? AND status IN ('pending','unanalyzable')",
    [reason, scores && !scores.error ? 'risk_candidate' : null, runId, clauseId],
  );
}

/** M3 /v1/judge 요청의 evidence[] — 평가 도구(scripts/search-evidence-batch.ts)도 같은 형식을 쓴다 */
export function evidencePayload(hits: SearchHit[]) {
  return hits.map((h) => ({
    id: String(h.row.evidence_version_id),
    source_type: h.row.source_type,
    title: `${h.row.source_name} ${h.row.identifier}`,
    text: h.row.excerpt,
  }));
}

export interface JudgeOnceInput {
  clause: ClauseRow;
  perspective: Perspective;
  kvId: number;
  knowledgeDate: string;
  m3Version: string;
  scores: { loophole: number | null; illegal: number | null };
  hints: { riskType: RiskType | null; relatedLaws: string[] };
  prio: number;
  /** 같은 실행 안의 판정 순서(작을수록 먼저) — 위험 점수 높은 조항부터 판정해 결과 화면에 먼저 채운다 */
  rank?: number;
  signal?: AbortSignal;
  origin?: 'service' | 'evaluation';
}

/** 조항 1건 판정 — 캐시 적중이면 그대로, 아니면 M3 호출(모르는 라벨은 1회 재시도) 후 저장. 판정 ID 를 돌려준다 */
export async function judgeClause(i: JudgeOnceInput): Promise<{ judgmentId: number; cached: boolean; category: string }> {
  const key = { clauseId: i.clause.clause_id, contractType: i.clause.contract_type!, perspective: i.perspective, kvId: i.kvId, m3Version: i.m3Version, origin: i.origin ?? 'service' };
  const cached = await findCached(key);
  if (cached) return { judgmentId: cached, cached: true, category: '' };
  const hits = await searchEvidence(asKvId(i.kvId), i.clause.deid_text, i.hints);
  const req = {
    clause: fromStoredDeid(i.clause.deid_text),
    contract_type: i.clause.contract_type!,
    perspective: i.perspective,
    knowledge_date: i.knowledgeDate,
    scores: { ...(i.scores.loophole !== null ? { loophole: i.scores.loophole } : {}), ...(i.scores.illegal !== null ? { illegal: i.scores.illegal } : {}) },
    evidence: evidencePayload(hits),
  };
  let result: ModelJudgeResult | null = null;
  for (let attempt = 0; attempt < 2 && !result; attempt++) {
    if (i.signal) throwIfAborted(i.signal);
    const raw = await judgeGate.run(i.prio, () => modelApi.judge(req, i.signal), i.rank ?? 0);
    try {
      result = normalizeJudge(raw);
    } catch (e) {
      if (!(e instanceof AdapterError) || attempt === 1) throw e;
    }
    if (i.signal?.aborted) throw new CancelledError();
  }
  const saved = await saveJudgment(key, result!, hits.map((h) => h.row.evidence_version_id));
  return { judgmentId: saved.judgmentId, cached: false, category: result!.category };
}

/** pending → judged. 트리거 trg_ca_bu 가 judgment_id 변경을 unanalyzable 에서만 허용하므로 pending 행을 지우고 다시 넣는다 */
async function recordJudged(runId: number, s: Scored, judgmentId: number): Promise<void> {
  await withTx(async (conn) => {
    const [del] = await conn.query<import('mysql2').ResultSetHeader>("DELETE FROM clause_assessment WHERE run_id = ? AND clause_id = ? AND status = 'pending'", [runId, s.clause.clause_id]);
    if (del.affectedRows === 0) return; // 이미 처리됨(취소·중단)
    await conn.query(
      `INSERT INTO clause_assessment (run_id, clause_id, score_loophole, score_illegal, m1_model_version, m2_model_version, screen_result, judgment_id, status)
       VALUES (?, ?, ?, ?, ?, ?, 'risk_candidate', ?, 'judged')`,
      [runId, s.clause.clause_id, s.loophole?.score ?? null, s.illegal?.score ?? null, s.m1?.slice(0, 40) ?? null, s.m2?.slice(0, 40) ?? null, judgmentId],
    );
  });
}

async function abortRun(runId: number, requestId: number): Promise<void> {
  await exec(getPool(), "UPDATE analysis_run SET stage = 'aborted' WHERE run_id = ? AND stage IN ('detecting','searching','explaining')", [runId]);
  await exec(getPool(), "UPDATE clause_assessment SET status = 'unanalyzable', unanalyzable_reason = 'server_down' WHERE run_id = ? AND status = 'pending'", [runId]);
  await recordGate('G5', 'server_down_during_run', { runId, requestId });
}

export interface DetectionOptions {
  /** 재분석 모드(P6) — 한도·요약 관련 차이는 호출 측에서 */
  kind?: 'analysis' | 'reanalysis';
}

/**
 * P3 분석·재분석 모드(INC3). 재분석(6.6, T116)은 같은 요청에 보관된 비식별 조항(clause)·요약·확정 유형을 그대로 쓰고
 * 실행 행의 kv_id(= 요청 시점의 활성 기준일)로 근거 검색·판정한다. P2(추출·비식별·구조화·M4 요약)는 다시 돌지 않는다(UC5 A3·A5).
 * 도중 서버 다운(G5)이면 새 실행만 aborted — 이전 결과(prev_run_id)는 저장 상태 그대로 남는다(UC5 E5)
 */
export async function runDetection(runId: number, signal: AbortSignal, opts: DetectionOptions = {}): Promise<void> {
  const run = await getRun(runId);
  if (!run) return;
  // 실행 행의 종류와 호출 모드가 어긋나면 돌리지 않는다(재분석은 prev_run_id 가 있어야 한다 — chk_run_prev)
  if (opts.kind && opts.kind !== run.run_kind) {
    logger.error({ runId, kind: opts.kind, runKind: run.run_kind }, 'detection mode mismatch');
    await exec(getPool(), "UPDATE analysis_run SET stage = 'aborted' WHERE run_id = ? AND stage IN ('detecting','searching','explaining')", [runId]);
    return;
  }
  const req = await getRequest(run.request_id);
  if (!req) return;
  const kv = await knowledgeVersion(run.kv_id);
  const prio = run.started_at.getTime();
  try {
    const m3Version = await m3VersionFor(runId);
    const allClauses = await getClauses(run.request_id);
    // 3.0 판정 불가 선별(관문 1 규칙·관문 2 계약 조항다움) — 걸린 조항은 M1·M2·M3 를 부르지 않는다(migration 008)
    const abstained = await screenClauses(asKvId(run.kv_id), allClauses.map((c) => ({ clauseId: c.clause_id, text: fromStoredDeid(c.deid_text) })));
    await recordAbstentions(runId, abstained);
    const skip = new Set(abstained.map((a) => a.clauseId));
    const clauses = allClauses.filter((c) => !skip.has(c.clause_id));
    // 3.1~3.2
    const scored = clauses.length ? await detectScores(runId, clauses, signal) : [];
    // 3.3 선별
    const th1 = policy('DETECT_THRESHOLD_M1');
    const th2 = policy('DETECT_THRESHOLD_M2');
    const risk: Scored[] = [];
    for (const s of scored) {
      if (s.error) {
        await markUnanalyzable(runId, s.clause.clause_id, 'timeout');
        continue;
      }
      const isRisk = (s.loophole?.score ?? 0) >= th1 || (s.illegal?.score ?? 0) >= th2;
      if (isRisk) risk.push(s);
      else await exec(getPool(), "UPDATE clause_assessment SET screen_result = 'normal_candidate', status = 'normal' WHERE run_id = ? AND clause_id = ? AND status = 'pending'", [runId, s.clause.clause_id]);
    }
    throwIfAborted(signal);
    // 3.4 근거 검색 → 3.5 판정(설명 포함)
    await setRunStage(runId, 'searching');
    await setRunStage(runId, 'explaining');
    let serverDown = false;
    // 위험 점수(M1·M2 중 큰 값) 높은 순으로 판정 — 진행 중 결과 화면에 중요한 조항이 먼저 채워진다(2026-09-30)
    const riskScore = (s: Scored) => Math.max(s.loophole?.score ?? 0, s.illegal?.score ?? 0);
    risk.sort((a, b) => riskScore(b) - riskScore(a) || a.clause.clause_id - b.clause.clause_id);
    await Promise.all(
      risk.map(async (s, rank) => {
        if (serverDown) return;
        try {
          const j = await judgeClause({
            clause: s.clause,
            perspective: req.perspective,
            kvId: run.kv_id,
            knowledgeDate: kv!.knowledge_date,
            m3Version,
            scores: { loophole: s.loophole?.score ?? null, illegal: s.illegal?.score ?? null },
            hints: { riskType: normalizeRiskTypeHint(s.loophole?.type), relatedLaws: s.illegal?.related_laws ?? [] },
            prio,
            rank,
            signal,
          });
          throwIfAborted(signal);
          await recordJudged(runId, s, j.judgmentId);
        } catch (e) {
          if (e instanceof CancelledError || signal.aborted) throw new CancelledError();
          if (await isServerDown(e)) {
            serverDown = true;
            return;
          }
          // 3.6 조항 단위 실패(타임아웃·형식 오류) — 그 조항만 분석 불가, 나머지는 계속(FR-018)
          logger.warn({ runId, clauseId: s.clause.clause_id, err: (e as Error).message }, 'clause judge failed');
          await markUnanalyzable(runId, s.clause.clause_id, e instanceof ModelApiError && e.kind !== 'timeout' ? 'server_down' : 'timeout', s);
        }
      }),
    );
    if (serverDown) {
      await abortRun(runId, run.request_id);
      return;
    }
    throwIfAborted(signal);
    // 3.7 관점 불일치(G7) — 사업자 관점
    if (req.perspective === 'business') await afterBusinessJudgments(runId);
    // 3.8 완료
    await setRunStage(runId, 'completed', ', completed_at = CURRENT_TIMESTAMP');
  } catch (e) {
    if (e instanceof CancelledError) return;
    if (await isServerDown(e).catch(() => false)) {
      await abortRun(runId, run.request_id);
      return;
    }
    logger.error({ runId, kind: run.run_kind, err: (e as Error).message, stack: (e as Error).stack }, 'detection failed');
    await abortRun(runId, run.request_id).catch(() => undefined);
  } finally {
    runM3Version.delete(runId);
  }
}

/** 6.6 재분석 실행 시작 — 실행 행은 호출 측(history.reanalysis)이 만든다. M4 는 부르지 않는다 */
export function runReanalysis(runId: number, signal: AbortSignal): Promise<void> {
  return runDetection(runId, signal, { kind: 'reanalysis' });
}

/** 진행 중 실행의 조항 목록(재분석 등에서 사용) */
export async function assessmentsOf(runId: number) {
  return select<{ assessment_id: number; clause_id: number; status: string }>(getPool(), 'SELECT assessment_id, clause_id, status FROM clause_assessment WHERE run_id = ?', [runId]);
}
