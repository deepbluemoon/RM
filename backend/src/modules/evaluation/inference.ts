// P7 7.5 일괄 추론 — P3 평가 모드(INC3). 작업 실행기(enqueue)에서 돌고 HTTP 요청을 막지 않는다.
// M1·M2(/v1/jobs, 관점 없음 A3) → 기준치 선별 → 근거 검색(평가 기준일) → M3(/v1/judge, 전역 제한기 judgeGate — 공유 모델 동시 1건).
// 서비스 판정 캐시(judgment)는 조회도 저장도 하지 않는다(P-5 "공유 안 함", A5): uq_judgment_cache_key 에 origin 이 없어
// 평가 행이 같은 키의 서비스 판정 저장을 막을 수 있기 때문이다. 예측은 eval_run_item 에만 고정 저장한다(3.9 건너뜀 — SD_01 §10-3).
// 조항 타임아웃은 지표에서 제외(timed_out), 서버 다운이면 평가 중단(aborted·G5, 기록 없음 — UC8 E6)
import { exec, getPool, select, selectOne } from '../../db/pool.js';
import { policy } from '../../config/policy.js';
import { logger } from '../../logger.js';
import { asKvId, fromStoredDeid } from '../../domain/types.js';
import { CancelledError, enqueue, judgeGate, release as releaseJob, throwIfAborted } from '../../jobs/runner.js';
import { modelApi, ModelApiError, type DetectScore, type JudgeRequest } from '../modelApi/client.js';
import { AdapterError, normalizeJudge, normalizeRiskTypeHint } from '../modelApi/adapter.js';
import { getServerStatus } from '../modelApi/status.js';
import { searchEvidence } from '../evidence/search.js';
import { recordGate } from '../gates/gates.service.js';
import { presentEvalTexts } from './items.service.js';

const POLL_MS = 500;
/** 한 /v1/jobs 에 싣는 조항 수 상한(모델 API 413 방지) */
const JOB_CHUNK = 200;
/** 서비스 분석보다 뒤에 배정한다 — 서비스 prio 는 실행 시작 시각(ms) */
const EVAL_PRIORITY_BASE = 1e15;
const jobKey = (evalRunId: number) => -evalRunId; // 요청 ID 와 겹치지 않게 음수 키

export interface EvalProgress {
  phase: 'queued' | 'detecting' | 'judging';
  detectTotal: number;
  detectDone: number;
  judgeTotal: number;
  judgeDone: number;
  judgeMsSum: number;
}

const active = new Set<number>();
const progress = new Map<number, EvalProgress>();

/** 이 프로세스에서 진행 중인 평가인지 — 아니면 재기동으로 끊긴 것(재개 없음) */
export const isActive = (evalRunId: number): boolean => active.has(evalRunId);
export const progressOf = (evalRunId: number): EvalProgress | null => progress.get(evalRunId) ?? null;

class ServerDownError extends Error {}

async function isServerDown(e: unknown): Promise<boolean> {
  if (e instanceof ServerDownError) return true;
  if (!(e instanceof ModelApiError)) return false;
  if (e.kind === 'auth') return true;
  if (e.kind !== 'unavailable') return false;
  const s = await getServerStatus(true);
  return s.state !== 'ready';
}

/** 7.5 중단 — 부분 지표는 기록하지 않는다(chk_er_aborted) */
export async function abortEvalRun(evalRunId: number, reason: string): Promise<void> {
  const r = await exec(getPool(), "UPDATE eval_run SET stage = 'aborted' WHERE eval_run_id = ? AND stage IN ('eligibility','inferring')", [evalRunId]);
  if (r.affectedRows > 0) await recordGate('G5', reason, { evalRunId }).catch(() => undefined);
}

export function startInference(evalRunId: number): void {
  active.add(evalRunId);
  progress.set(evalRunId, { phase: 'queued', detectTotal: 0, detectDone: 0, judgeTotal: 0, judgeDone: 0, judgeMsSum: 0 });
  enqueue(jobKey(evalRunId), 'eval-inference', async (signal) => {
    try {
      await infer(evalRunId, signal);
    } finally {
      active.delete(evalRunId);
      progress.delete(evalRunId);
      releaseJob(jobKey(evalRunId));
    }
  });
}

interface ItemRow {
  eval_item_id: number;
  clause_text_deid: string;
  contract_type: string;
}

interface Scored {
  loophole: DetectScore | null;
  illegal: DetectScore | null;
  error: boolean;
}

async function detect(items: ItemRow[], texts: Map<number, string>, contractType: string, signal: AbortSignal, prog: EvalProgress): Promise<Map<number, Scored>> {
  const out = new Map<number, Scored>();
  for (let i = 0; i < items.length; i += JOB_CHUNK) {
    const chunk = items.slice(i, i + JOB_CHUNK);
    const jobId = await modelApi.createDetectJob(chunk.map((c) => ({ clause_id: String(c.eval_item_id), text: fromStoredDeid(texts.get(c.eval_item_id)!) })), contractType);
    for (;;) {
      throwIfAborted(signal);
      const job = await modelApi.getJob(jobId);
      for (const r of job.results) {
        const id = Number(r.clause_id);
        if (out.has(id)) continue;
        out.set(id, { loophole: r.loophole ?? null, illegal: r.illegal ?? null, error: Boolean(r.error) });
        prog.detectDone++;
      }
      if (job.status === 'done' || job.status === 'failed') break;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }
  return out;
}

async function setTimedOut(evalRunId: number, itemId: number): Promise<void> {
  await exec(getPool(), 'UPDATE eval_run_item SET timed_out = TRUE, predicted_category = NULL WHERE eval_run_id = ? AND eval_item_id = ?', [evalRunId, itemId]);
}

async function setPredicted(evalRunId: number, itemId: number, category: string): Promise<void> {
  await exec(getPool(), 'UPDATE eval_run_item SET predicted_category = ? WHERE eval_run_id = ? AND eval_item_id = ?', [category, evalRunId, itemId]);
}

/**
 * 7.7 근거 적합성 표본 — 위험 판정 조항마다 모델이 주장에 쓴 첫 근거(없으면 검색 1순위) 1건.
 * 같은 조항·같은 근거 버전을 이전 평가에서 전문가가 이미 판정했으면 재사용한다(UC8 A3 [추론] 근거 불변 시 재사용)
 */
async function sampleEvidence(evalRunId: number, itemId: number, evidenceVersionId: number): Promise<void> {
  await exec(
    getPool(),
    `INSERT IGNORE INTO eval_evidence_review (eval_run_id, eval_item_id, evidence_version_id, verdict, reviewer_user_id, responded_at)
     SELECT ?, ?, ?, p.verdict, p.reviewer_user_id, p.responded_at
       FROM (SELECT 1 AS one) x
       LEFT JOIN (SELECT verdict, reviewer_user_id, responded_at FROM eval_evidence_review
                   WHERE eval_item_id = ? AND evidence_version_id = ? AND verdict IS NOT NULL AND eval_run_id <> ?
                   ORDER BY responded_at DESC LIMIT 1) p ON 1 = 1`,
    [evalRunId, itemId, evidenceVersionId, itemId, evidenceVersionId, evalRunId],
  );
}

async function judgeOne(
  run: { kv_id: number; knowledge_date: string; prio: number },
  item: ItemRow,
  text: string,
  s: Scored,
  signal: AbortSignal,
): Promise<{ category: string; sampleEvidenceId: number | null }> {
  const hits = await searchEvidence(asKvId(run.kv_id), text, { riskType: normalizeRiskTypeHint(s.loophole?.type), relatedLaws: s.illegal?.related_laws ?? [] });
  const req: JudgeRequest = {
    clause: fromStoredDeid(text),
    contract_type: item.contract_type,
    perspective: 'consumer',
    knowledge_date: run.knowledge_date,
    scores: { ...(s.loophole ? { loophole: s.loophole.score } : {}), ...(s.illegal ? { illegal: s.illegal.score } : {}) },
    evidence: hits.map((h) => ({ id: String(h.row.evidence_version_id), source_type: h.row.source_type, title: `${h.row.source_name} ${h.row.identifier}`, text: h.row.excerpt })),
  };
  for (let attempt = 0; ; attempt++) {
    throwIfAborted(signal);
    const raw = await judgeGate.run(run.prio, () => modelApi.judge(req, signal));
    try {
      const result = normalizeJudge(raw);
      const hitIds = hits.map((h) => h.row.evidence_version_id);
      const cited = result.claims.flatMap((c) => c.evidenceIds).find((id) => hitIds.includes(id));
      return { category: result.category, sampleEvidenceId: result.category === 'normal' ? null : (cited ?? hitIds[0] ?? null) };
    } catch (e) {
      // 모르는 라벨은 1회 재시도(T030)
      if (!(e instanceof AdapterError) || attempt >= 1) throw e;
    }
  }
}

/** 7.5 → 7.6 전이: 판정 대기 표본이 있으면 awaiting_expert(G11), 없으면 result. 측정 불가 유형은 G12 (판정 지점은 DB 뷰) */
async function finish(evalRunId: number): Promise<void> {
  const c = await selectOne<{ pending_reviews: number }>(getPool(), 'SELECT pending_reviews FROM v_eval_confirmable WHERE eval_run_id = ?', [evalRunId]);
  const pending = Number(c?.pending_reviews ?? 0);
  const r = await exec(getPool(), "UPDATE eval_run SET stage = ? WHERE eval_run_id = ? AND stage = 'inferring'", [pending > 0 ? 'awaiting_expert' : 'result', evalRunId]);
  if (r.affectedRows === 0) return;
  if (pending > 0) await recordGate('G11', 'expert_verdict_pending', { evalRunId });
  const unmeasurable = await select<{ contract_type: string }>(getPool(), 'SELECT contract_type FROM v_eval_metric_live WHERE eval_run_id = ? AND (measurable IS NULL OR measurable = FALSE)', [evalRunId]);
  for (const u of unmeasurable) await recordGate('G12', 'insufficient_clauses', { evalRunId, contractType: u.contract_type });
}

async function infer(evalRunId: number, signal: AbortSignal): Promise<void> {
  const prog = progress.get(evalRunId)!;
  const head = await selectOne<{ kv_id: number; knowledge_date: string; started_at: Date; stage: string }>(
    getPool(),
    "SELECT r.kv_id, DATE_FORMAT(kv.knowledge_date, '%Y-%m-%d') AS knowledge_date, r.started_at, r.stage FROM eval_run r JOIN knowledge_version kv ON kv.kv_id = r.kv_id WHERE r.eval_run_id = ?",
    [evalRunId],
  );
  if (!head || head.stage !== 'inferring') return;
  const run = { kv_id: head.kv_id, knowledge_date: head.knowledge_date, prio: EVAL_PRIORITY_BASE + new Date(head.started_at).getTime() };
  try {
    const items = await select<ItemRow>(
      getPool(),
      `SELECT it.eval_item_id, it.clause_text_deid, it.contract_type FROM eval_run_item ri JOIN eval_item it ON it.eval_item_id = ri.eval_item_id
        WHERE ri.eval_run_id = ? AND ri.eligibility = 'included' AND ri.predicted_category IS NULL AND ri.timed_out = FALSE ORDER BY it.eval_item_id`,
      [evalRunId],
    );
    // A1 — 모델 API 로 보내기 직전 비식별 재검사(누락 발견 시 저장 텍스트도 가린다)
    const shown = await presentEvalTexts(items);
    const texts = new Map(items.map((it, k) => [it.eval_item_id, shown[k]!]));
    prog.phase = 'detecting';
    prog.detectTotal = items.length;

    // 3.1~3.3 평가 모드 — 계약 유형별 M1·M2 → 기준치 선별
    const th1 = policy('DETECT_THRESHOLD_M1');
    const th2 = policy('DETECT_THRESHOLD_M2');
    const risk: { item: ItemRow; s: Scored }[] = [];
    const byType = new Map<string, ItemRow[]>();
    for (const it of items) byType.set(it.contract_type, [...(byType.get(it.contract_type) ?? []), it]);
    for (const [ct, group] of byType) {
      const scores = await detect(group, texts, ct, signal, prog);
      for (const it of group) {
        const s = scores.get(it.eval_item_id);
        if (!s || s.error) await setTimedOut(evalRunId, it.eval_item_id);
        else if ((s.loophole?.score ?? 0) >= th1 || (s.illegal?.score ?? 0) >= th2) risk.push({ item: it, s });
        else await setPredicted(evalRunId, it.eval_item_id, 'normal');
      }
    }

    // 3.4~3.5 근거 검색 → M3 판정. 공유 모델은 한 번에 1건 — 순서대로 보낸다(서비스 분석이 먼저 배정된다)
    prog.phase = 'judging';
    prog.judgeTotal = risk.length;
    for (const { item, s } of risk) {
      throwIfAborted(signal);
      const t0 = Date.now();
      try {
        const out = await judgeOne(run, item, texts.get(item.eval_item_id)!, s, signal);
        await setPredicted(evalRunId, item.eval_item_id, out.category);
        if (out.sampleEvidenceId) await sampleEvidence(evalRunId, item.eval_item_id, out.sampleEvidenceId);
      } catch (e) {
        if (e instanceof CancelledError || signal.aborted) throw new CancelledError();
        if (await isServerDown(e)) throw new ServerDownError();
        // 조항 단위 실패(타임아웃·형식 오류) — 그 조항만 지표에서 제외(UC8 E6)
        logger.warn({ evalRunId, evalItemId: item.eval_item_id, err: (e as Error).message }, 'eval judge failed');
        await setTimedOut(evalRunId, item.eval_item_id);
      } finally {
        prog.judgeDone++;
        prog.judgeMsSum += Date.now() - t0;
      }
    }
    await finish(evalRunId);
  } catch (e) {
    if (e instanceof CancelledError) {
      await abortEvalRun(evalRunId, 'eval_cancelled');
      return;
    }
    if (await isServerDown(e).catch(() => false)) {
      await abortEvalRun(evalRunId, 'server_down_during_eval');
      return;
    }
    logger.error({ evalRunId, err: (e as Error).message, stack: (e as Error).stack }, 'eval inference failed');
    await abortEvalRun(evalRunId, 'eval_failed');
  }
}
