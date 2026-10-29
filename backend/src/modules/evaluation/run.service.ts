// P7 평가 실행(T135): 7.4 적격성(G10·G12) → 7.5 일괄 추론(inference.ts, 백그라운드) → 7.6 지표(v_eval_metric_live)
// → 7.7 근거 적합성(G11) → 7.8 편향·미달 경고 → 7.9 기록(eval_metric 고정)·성공 기준 확정(v_eval_confirmable, 트리거 trg_er_bu).
// 측정 가능·확정 가능 판정은 DB 뷰가 단일 지점이다 — 앱은 읽어서 표시만 한다
import { exec, getPool, select, selectOne } from '../../db/pool.js';
import { withTx } from '../../db/tx.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { policy } from '../../config/policy.js';
import { CONTRACT_TYPE_LABEL, type ContractType } from '../../domain/codes.js';
import { modelApi } from '../modelApi/client.js';
import { assertModelServerReady } from '../modelApi/gate.js';
import { queueDepth } from '../modelApi/status.js';
import { raise, recordGate, release } from '../gates/gates.service.js';
import { GateError, openGate, type OpenGate } from '../gates/GateError.js';
import { activeKnowledgeVersion, evidenceVersion, toEvidenceDto } from '../evidence/evidence.repo.js';
import { present } from '../feedbackReview/presenter.js';
import { presentEvalTexts } from './items.service.js';
import { abortEvalRun, isActive, progressOf, startInference } from './inference.js';

type Stage = 'eligibility' | 'inferring' | 'awaiting_expert' | 'result' | 'recorded' | 'aborted';
const label = (ct: string) => CONTRACT_TYPE_LABEL[ct as ContractType] ?? ct;
const v40 = (s: string | undefined, fallback: string) => (s ?? fallback).slice(0, 40);

/** 7.1 모델 목록(현재 model_version·학습 기준일). 서버가 응답하지 않으면 null — 화면은 막지 않는다 */
async function currentModels() {
  try {
    const m = await modelApi.models();
    const get = (id: string) => m.models.find((x) => x.id === id);
    return {
      modelVersions: { m1: get('M1')?.model_version, m2: get('M2')?.model_version, m3: get('M3')?.model_version, m4: get('M4')?.model_version },
      trainedDataDates: { m1: get('M1')?.trained_data_date ?? null, m2: get('M2')?.trained_data_date ?? null, m3: get('M3')?.trained_data_date ?? null },
    };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ 7.4 적격성 + 7.5 시작

/**
 * 평가 시작 — G5 사전 확인, 버전 고정(M1~M3 model_version·활성 기준일), 적격성(G10) 고정 저장 후 추론을 작업 실행기에 넘긴다.
 * evalItemIds 를 비우면 반려되지 않은 등록 평가 데이터 전체를 고르고, 그 가운데 검수 완료만 평가에 넣는다(나머지는 G10 제외 표시)
 */
export async function startRun(userId: number, evalItemIds?: number[]): Promise<{ evalRunId: number }> {
  await assertModelServerReady({ userId });
  const kv = await activeKnowledgeVersion();
  if (!kv) throw new HttpError(409, 'no_active_knowledge', '활성 지식 기준일이 없습니다');
  const models = await currentModels();
  if (!models?.modelVersions.m3) {
    await raise('G5', 'model_list_unavailable', { userId }, { params: { state: '응답하지 않음' } });
  }
  const ids = [...new Set(evalItemIds ?? [])].filter((n) => Number.isInteger(n) && n > 0);
  const pick = ids.length ? `eval_item_id IN (${ids.map(() => '?').join(',')})` : "review_status <> 'rejected'";
  const evalRunId = await withTx(async (conn) => {
    const [r] = await conn.query<import('mysql2').ResultSetHeader>(
      "INSERT INTO eval_run (kv_id, m1_model_version, m2_model_version, m3_model_version, stage) VALUES (?, ?, ?, ?, 'eligibility')",
      [kv.kv_id, v40(models!.modelVersions.m1, 'unknown-m1'), v40(models!.modelVersions.m2, 'unknown-m2'), v40(models!.modelVersions.m3, 'unknown-m3')],
    );
    // G10 제외 사유 3종 — 인위적 변형·학습 중복은 해제 불가(BR-QA-01), 검수 미완료는 전문가 검수로 해제
    const [ins] = await conn.query<import('mysql2').ResultSetHeader>(
      `INSERT INTO eval_run_item (eval_run_id, eval_item_id, eligibility)
       SELECT ?, eval_item_id,
              CASE WHEN origin = 'synthetic' THEN 'excluded_synthetic'
                   WHEN overlaps_training THEN 'excluded_training_overlap'
                   WHEN review_status <> 'accepted' THEN 'excluded_unreviewed'
                   ELSE 'included' END
         FROM eval_item WHERE ${pick}`,
      [r.insertId, ...ids],
    );
    if (ins.affectedRows === 0) throw new HttpError(409, 'no_eval_items', '평가할 평가 데이터가 없습니다 - 평가 데이터를 먼저 등록하세요');
    return r.insertId;
  });
  const excluded = await select<{ eval_item_id: number; eligibility: string }>(getPool(), "SELECT eval_item_id, eligibility FROM eval_run_item WHERE eval_run_id = ? AND eligibility <> 'included'", [evalRunId]);
  for (const x of excluded) await recordGate('G10', x.eligibility, { evalRunId, evalItemId: x.eval_item_id });
  const included = await selectOne<{ n: number }>(getPool(), "SELECT COUNT(*) AS n FROM eval_run_item WHERE eval_run_id = ? AND eligibility = 'included'", [evalRunId]);
  if (Number(included?.n ?? 0) === 0) {
    // 평가할 조항이 없으면 추론 없이 결과 단계(모든 유형 측정 불가 — G12)
    await exec(getPool(), "UPDATE eval_run SET stage = 'result' WHERE eval_run_id = ?", [evalRunId]);
    const types = await select<{ contract_type: string }>(getPool(), 'SELECT contract_type FROM v_eval_metric_live WHERE eval_run_id = ? AND (measurable IS NULL OR measurable = FALSE)', [evalRunId]);
    for (const t of types) await recordGate('G12', 'insufficient_clauses', { evalRunId, contractType: t.contract_type });
    return { evalRunId };
  }
  await exec(getPool(), "UPDATE eval_run SET stage = 'inferring' WHERE eval_run_id = ?", [evalRunId]);
  startInference(evalRunId);
  return { evalRunId };
}

// ------------------------------------------------------------------ 7.6~7.8 조회

interface RunHead {
  eval_run_id: number;
  kv_id: number;
  knowledge_date: string;
  analysis_basis_version: string;
  m1_model_version: string;
  m2_model_version: string;
  m3_model_version: string;
  stage: Stage;
  started_at: Date;
  sc_confirmed_at: Date | null;
  recorded_at: Date | null;
}

async function head(evalRunId: number): Promise<RunHead> {
  const r = await selectOne<RunHead>(
    getPool(),
    `SELECT r.eval_run_id, r.kv_id, DATE_FORMAT(kv.knowledge_date, '%Y-%m-%d') AS knowledge_date, kv.analysis_basis_version,
            r.m1_model_version, r.m2_model_version, r.m3_model_version, r.stage, r.started_at, r.sc_confirmed_at, r.recorded_at
       FROM eval_run r JOIN knowledge_version kv ON kv.kv_id = r.kv_id WHERE r.eval_run_id = ?`,
    [evalRunId],
  );
  if (!r) throw new HttpError(404, 'not_found', '평가 실행을 찾을 수 없습니다');
  return r;
}

export interface MetricDto {
  contractType: string;
  contractTypeLabel: string;
  clauseCount: number;
  timeoutExcluded: number;
  recallPct: number | null;
  precisionPct: number | null;
  evidenceFitPct: number | null;
  measurable: boolean | null;
  reviewPending?: number;
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const bool = (v: unknown) => (v === null || v === undefined ? null : Boolean(Number(v)));

async function liveMetrics(evalRunId: number): Promise<MetricDto[]> {
  const rows = await select<Record<string, unknown>>(getPool(), 'SELECT * FROM v_eval_metric_live WHERE eval_run_id = ? ORDER BY contract_type', [evalRunId]);
  return rows.map((m) => {
    const measurable = bool(m.measurable);
    return {
      contractType: String(m.contract_type),
      contractTypeLabel: label(String(m.contract_type)),
      clauseCount: Number(m.clause_count),
      timeoutExcluded: Number(m.timeout_excluded),
      // G12 — 측정 불가 유형은 지표를 내지 않는다(eval_metric chk_em_g12 와 같은 표시)
      recallPct: measurable ? num(m.recall_pct) : null,
      precisionPct: measurable ? num(m.precision_pct) : null,
      evidenceFitPct: measurable ? num(m.evidence_fit_pct) : null,
      measurable,
      reviewPending: Number(m.review_pending),
    };
  });
}

async function recordedMetrics(evalRunId: number): Promise<MetricDto[]> {
  const rows = await select<Record<string, unknown>>(getPool(), 'SELECT * FROM eval_metric WHERE eval_run_id = ? ORDER BY contract_type', [evalRunId]);
  return rows.map((m) => ({
    contractType: String(m.contract_type),
    contractTypeLabel: label(String(m.contract_type)),
    clauseCount: Number(m.clause_count),
    timeoutExcluded: Number(m.timeout_excluded),
    recallPct: num(m.recall_pct),
    precisionPct: num(m.precision_pct),
    evidenceFitPct: num(m.evidence_fit_pct),
    measurable: Boolean(Number(m.measurable)),
  }));
}

const pp = (n: number) => Math.round(n * 10) / 10;

/** 7.8 — 성공 기준(SC-001·002·004·007) 결과와 경고. 경고는 게이트가 아니다(UC8 E3·E4, SD_01 §10-3 — 배포 차단 없음) */
function assess(metrics: MetricDto[], pendingReviews: number) {
  const ok = metrics.filter((m) => m.measurable);
  const warnings: { kind: 'bias_gap' | 'below_criteria'; message: string }[] = [];
  const target = { recall: policy('SC_RECALL_PCT'), precision: policy('SC_PRECISION_PCT'), fit: policy('SC_EVIDENCE_FIT_PCT'), gap: policy('BIAS_GAP_PP') };
  const below = (key: 'recallPct' | 'precisionPct' | 'evidenceFitPct', name: string, t: number) => {
    const bad = ok.filter((m) => m[key] !== null && m[key]! < t);
    for (const m of bad) warnings.push({ kind: 'below_criteria', message: `${m.contractTypeLabel} ${name} ${m[key]}% - 목표 ${t}% 미달` });
    return bad;
  };
  const rBad = below('recallPct', '재현율', target.recall);
  const pBad = below('precisionPct', '정밀도', target.precision);
  const fBad = below('evidenceFitPct', '근거 적합률', target.fit);
  // SC-007 — 유형별 재현율 최저값이 전체 평균(측정 가능 유형 평균) 대비 BIAS_GAP_PP 이내
  const recalls = ok.filter((m) => m.recallPct !== null);
  let gap: number | null = null;
  if (recalls.length >= 2) {
    const avg = recalls.reduce((s, m) => s + m.recallPct!, 0) / recalls.length;
    const min = recalls.reduce((a, m) => (m.recallPct! < a.recallPct! ? m : a));
    gap = pp(avg - min.recallPct!);
    if (gap > target.gap) warnings.push({ kind: 'bias_gap', message: `유형 간 재현율 편차 ${gap}%p - 기준 ${target.gap}%p 초과(최저 ${min.contractTypeLabel} ${min.recallPct}%, 평균 ${pp(avg)}%)` });
  }
  const status = (bad: MetricDto[], key: 'recallPct' | 'precisionPct' | 'evidenceFitPct') =>
    !ok.length ? 'unmeasurable' : bad.length ? 'below' : ok.every((m) => m[key] !== null) ? 'met' : key === 'evidenceFitPct' && pendingReviews > 0 ? 'pending' : 'unmeasurable';
  const criteria = [
    { code: 'SC-001', label: '재현율', target: `${target.recall}% 이상`, status: status(rBad, 'recallPct'), below: rBad.map((m) => m.contractTypeLabel) },
    { code: 'SC-002', label: '정밀도', target: `${target.precision}% 이상`, status: status(pBad, 'precisionPct'), below: pBad.map((m) => m.contractTypeLabel) },
    { code: 'SC-004', label: '근거 적합률', target: `${target.fit}% 이상`, status: pendingReviews > 0 ? 'pending' : status(fBad, 'evidenceFitPct'), below: fBad.map((m) => m.contractTypeLabel) },
    { code: 'SC-007', label: '유형 간 편차', target: `${target.gap}%p 이내`, status: gap === null ? 'unmeasurable' : gap > target.gap ? 'below' : 'met', gapPp: gap, below: [] as string[] },
  ];
  return { warnings, criteria };
}

async function openEventId(evalRunId: number, gate: string, contractType?: string): Promise<number | undefined> {
  const r = await selectOne<{ event_id: number }>(
    getPool(),
    `SELECT MIN(event_id) AS event_id FROM v_gate_open WHERE gate_code = ? AND eval_run_id = ?${contractType ? ' AND contract_type = ?' : ''}`,
    contractType ? [gate, evalRunId, contractType] : [gate, evalRunId],
  );
  return r?.event_id ?? undefined;
}

const EXCLUDE_LABEL: Record<string, string> = { excluded_unreviewed: '검수 미완료', excluded_synthetic: '인위적 변형', excluded_training_overlap: '학습 데이터 중복' };

/** GET /admin/eval/runs/{id} — 진행·지표·경고·확정 가능 여부·열린 게이트(C2) */
export async function runView(evalRunId: number) {
  let h = await head(evalRunId);
  // 재기동으로 끊긴 평가(이 프로세스에 작업이 없음)는 재개하지 않고 중단 처리한다(R-06)
  if ((h.stage === 'eligibility' || h.stage === 'inferring') && !isActive(evalRunId)) {
    await abortEvalRun(evalRunId, 'server_restart');
    h = await head(evalRunId);
  }
  const elig = await select<{ eligibility: string; n: number; predicted: number; timed_out: number }>(
    getPool(),
    `SELECT eligibility, COUNT(*) AS n, SUM(predicted_category IS NOT NULL) AS predicted, SUM(timed_out) AS timed_out
       FROM eval_run_item WHERE eval_run_id = ? GROUP BY eligibility`,
    [evalRunId],
  );
  const cnt = (k: string) => Number(elig.find((e) => e.eligibility === k)?.n ?? 0);
  const inc = elig.find((e) => e.eligibility === 'included');
  const excluded = { unreviewed: cnt('excluded_unreviewed'), synthetic: cnt('excluded_synthetic'), trainingOverlap: cnt('excluded_training_overlap') };
  const metrics = h.stage === 'recorded' ? await recordedMetrics(evalRunId) : await liveMetrics(evalRunId);
  const conf = await selectOne<{ pending_reviews: number; unmeasurable_types: number; confirmable: number }>(getPool(), 'SELECT * FROM v_eval_confirmable WHERE eval_run_id = ?', [evalRunId]);
  const pending = Number(conf?.pending_reviews ?? 0);
  const reviewTotal = Number((await selectOne<{ n: number }>(getPool(), 'SELECT COUNT(*) AS n FROM eval_evidence_review WHERE eval_run_id = ?', [evalRunId]))?.n ?? 0);
  const inferenceDone = !['eligibility', 'inferring', 'aborted'].includes(h.stage);

  const openGates: OpenGate[] = [];
  if (h.stage === 'aborted') openGates.push(openGate('G5', { state: '응답하지 않음' }, await openEventId(evalRunId, 'G5')));
  const exTotal = excluded.unreviewed + excluded.synthetic + excluded.trainingOverlap;
  if (exTotal > 0) {
    const detail = Object.entries({ excluded_unreviewed: excluded.unreviewed, excluded_synthetic: excluded.synthetic, excluded_training_overlap: excluded.trainingOverlap })
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${EXCLUDE_LABEL[k]} ${n}건`)
      .join(' · ');
    openGates.push(openGate('G10', { n: exTotal, detail }, await openEventId(evalRunId, 'G10')));
  }
  if (inferenceDone) {
    if (pending > 0) openGates.push(openGate('G11', { done: reviewTotal - pending, total: reviewTotal }, await openEventId(evalRunId, 'G11')));
    const live = h.stage === 'recorded' ? await liveMetrics(evalRunId) : metrics;
    for (const m of live.filter((x) => !x.measurable)) openGates.push(openGate('G12', { contractType: m.contractTypeLabel }, await openEventId(evalRunId, 'G12', m.contractType)));
  }

  const mem = progressOf(evalRunId);
  const startedAt = new Date(h.started_at);
  const elapsedSec = Math.max(0, Math.round((Date.now() - startedAt.getTime()) / 1000));
  const avgJudgeSec = mem && mem.judgeDone > 0 ? mem.judgeMsSum / mem.judgeDone / 1000 : null;
  const { warnings, criteria } = assess(metrics, pending);
  return {
    evalRunId,
    stage: h.stage,
    kvId: h.kv_id,
    knowledgeDate: h.knowledge_date,
    analysisBasisVersion: h.analysis_basis_version,
    modelVersions: { m1: h.m1_model_version, m2: h.m2_model_version, m3: h.m3_model_version },
    excluded,
    progress: {
      phase: mem?.phase ?? (inferenceDone ? 'done' : h.stage === 'aborted' ? 'aborted' : 'queued'),
      total: Number(inc?.n ?? 0),
      done: Number(inc?.predicted ?? 0) + Number(inc?.timed_out ?? 0),
      timedOut: Number(inc?.timed_out ?? 0),
      judgeTotal: mem?.judgeTotal ?? null,
      judgeDone: mem?.judgeDone ?? null,
      avgJudgeSec: avgJudgeSec === null ? null : Math.round(avgJudgeSec * 10) / 10,
      // 남은 M3 판정 × 평균 판정 시간. 첫 판정 전에는 알 수 없다(null)
      etaSec: mem && avgJudgeSec !== null ? Math.round((mem.judgeTotal - mem.judgeDone) * avgJudgeSec) : null,
      sharedModelQueue: queueDepth(),
      startedAt: startedAt.toISOString(),
      elapsedSec: inferenceDone || h.stage === 'aborted' ? null : elapsedSec,
    },
    metrics,
    criteria,
    warnings,
    reviews: { total: reviewTotal, pending },
    confirmable: Boolean(Number(conf?.confirmable ?? 0)) && inferenceDone,
    scConfirmedAt: h.sc_confirmed_at ? new Date(h.sc_confirmed_at).toISOString() : null,
    recordedAt: h.recorded_at ? new Date(h.recorded_at).toISOString() : null,
    openGates,
  };
}

// ------------------------------------------------------------------ 7.9 기록·확정

/** 7.9 평가 기록(H6) — 그 시점 v_eval_metric_live 를 eval_metric 으로 고정. 판정 대기 상태로도 기록할 수 있다(SD_02 §11-2) */
export async function recordRun(evalRunId: number) {
  await withTx(async (conn) => {
    const [[r]] = await conn.query<import('mysql2').RowDataPacket[]>('SELECT stage FROM eval_run WHERE eval_run_id = ? FOR UPDATE', [evalRunId]);
    if (!r) throw new HttpError(404, 'not_found', '평가 실행을 찾을 수 없습니다');
    if (r.stage === 'aborted') throw new HttpError(409, 'aborted', '중단된 평가는 기록할 수 없습니다');
    if (r.stage === 'recorded') throw new HttpError(409, 'already_recorded', '이미 기록한 평가입니다');
    if (r.stage !== 'awaiting_expert' && r.stage !== 'result') throw new HttpError(409, 'not_ready', '지표 계산이 끝나면 기록할 수 있습니다');
    await conn.query(
      `INSERT INTO eval_metric (eval_run_id, contract_type, clause_count, timeout_excluded, recall_pct, precision_pct, evidence_fit_pct, measurable)
       SELECT eval_run_id, contract_type, clause_count, timeout_excluded,
              CASE WHEN measurable THEN recall_pct END, CASE WHEN measurable THEN precision_pct END,
              CASE WHEN measurable THEN evidence_fit_pct END, COALESCE(measurable, FALSE)
         FROM v_eval_metric_live WHERE eval_run_id = ?`,
      [evalRunId],
    );
    await conn.query("UPDATE eval_run SET stage = 'recorded', recorded_at = CURRENT_TIMESTAMP WHERE eval_run_id = ?", [evalRunId]);
  });
  return runView(evalRunId);
}

/** 성공 기준 확정(SD_02 U-4) — 판정 대기(G11)·측정 불가(G12)가 남으면 트리거가 거부한다. 거부 사유는 v_eval_confirmable 에서 읽는다 */
export async function confirmRun(evalRunId: number) {
  const h = await head(evalRunId);
  if (!['awaiting_expert', 'result', 'recorded'].includes(h.stage)) throw new HttpError(409, 'not_ready', '평가 결과가 나온 뒤에 확정할 수 있습니다');
  if (h.sc_confirmed_at) return runView(evalRunId);
  try {
    await exec(getPool(), 'UPDATE eval_run SET sc_confirmed_at = CURRENT_TIMESTAMP WHERE eval_run_id = ? AND sc_confirmed_at IS NULL', [evalRunId]);
  } catch (e) {
    if ((e as { sqlState?: string }).sqlState !== '45000') throw e;
    const c = await selectOne<{ pending_reviews: number }>(getPool(), 'SELECT pending_reviews FROM v_eval_confirmable WHERE eval_run_id = ?', [evalRunId]);
    const pending = Number(c?.pending_reviews ?? 0);
    if (pending > 0) {
      const total = Number((await selectOne<{ n: number }>(getPool(), 'SELECT COUNT(*) AS n FROM eval_evidence_review WHERE eval_run_id = ?', [evalRunId]))?.n ?? 0);
      throw new GateError('G11', { params: { done: total - pending, total }, eventId: await openEventId(evalRunId, 'G11'), detail: { pendingReviews: pending } });
    }
    const u = await select<{ contract_type: string }>(getPool(), 'SELECT contract_type FROM v_eval_metric_live WHERE eval_run_id = ? AND (measurable IS NULL OR measurable = FALSE) ORDER BY contract_type', [evalRunId]);
    const first = u[0]?.contract_type ?? '';
    throw new GateError('G12', {
      params: { contractType: u.map((x) => label(x.contract_type)).join('·') },
      eventId: first ? await openEventId(evalRunId, 'G12', first) : undefined,
      detail: { unmeasurableTypes: u.map((x) => x.contract_type) },
    });
  }
  return runView(evalRunId);
}

// ------------------------------------------------------------------ 7.7 근거 적합성

export async function evidenceReviews(evalRunId: number) {
  await head(evalRunId);
  const rows = await select<{ eval_item_id: number; evidence_version_id: number; verdict: 'relevant' | 'irrelevant' | null; responded_at: Date | null; requested_at: Date; clause_text_deid: string; contract_type: string; predicted_category: string | null }>(
    getPool(),
    `SELECT r.eval_item_id, r.evidence_version_id, r.verdict, r.responded_at, r.requested_at, it.clause_text_deid, it.contract_type, ri.predicted_category
       FROM eval_evidence_review r
       JOIN eval_run_item ri ON ri.eval_run_id = r.eval_run_id AND ri.eval_item_id = r.eval_item_id
       JOIN eval_item it ON it.eval_item_id = r.eval_item_id
      WHERE r.eval_run_id = ? ORDER BY r.eval_item_id, r.evidence_version_id`,
    [evalRunId],
  );
  const texts = await presentEvalTexts(rows);
  const out = [];
  for (const [k, r] of rows.entries()) {
    const ev = await evidenceVersion(r.evidence_version_id);
    out.push({
      evalItemId: r.eval_item_id,
      evidenceVersionId: r.evidence_version_id,
      clauseTextDeid: texts[k]!,
      contractType: r.contract_type,
      displayCategory: r.predicted_category,
      evidence: ev ? toEvidenceDto(ev, ev.to_kv_id !== null) : null,
      verdict: r.verdict,
      respondedAt: r.responded_at ? new Date(r.responded_at).toISOString() : null,
      // 이전 평가의 같은 조항·근거 판정을 재사용했는지(UC8 A3)
      reused: r.responded_at !== null && new Date(r.responded_at).getTime() < new Date(r.requested_at).getTime(),
    });
  }
  return out;
}

/** 7.7 판정 회신 — 판정 대기 0건이 되면 G11 해제, awaiting_expert → result. 기록된 평가면 고정 지표의 적합률도 채운다 */
export async function putEvidenceReview(evalRunId: number, evalItemId: number, evidenceVersionId: number, verdict: 'relevant' | 'irrelevant', reviewerUserId: number) {
  const h = await head(evalRunId);
  if (h.stage === 'aborted') throw new HttpError(409, 'aborted', '중단된 평가입니다');
  const r = await exec(
    getPool(),
    'UPDATE eval_evidence_review SET verdict = ?, reviewer_user_id = ?, responded_at = CURRENT_TIMESTAMP WHERE eval_run_id = ? AND eval_item_id = ? AND evidence_version_id = ?',
    [verdict, reviewerUserId, evalRunId, evalItemId, evidenceVersionId],
  );
  if (r.affectedRows === 0) throw new HttpError(404, 'not_found', '판정 대상 표본을 찾을 수 없습니다');
  const c = await selectOne<{ pending_reviews: number }>(getPool(), 'SELECT pending_reviews FROM v_eval_confirmable WHERE eval_run_id = ?', [evalRunId]);
  if (Number(c?.pending_reviews ?? 0) === 0) {
    for (const g of await select<{ event_id: number }>(getPool(), "SELECT event_id FROM v_gate_open WHERE gate_code = 'G11' AND eval_run_id = ?", [evalRunId])) await release(g.event_id, 'expert_replied');
    await exec(getPool(), "UPDATE eval_run SET stage = 'result' WHERE eval_run_id = ? AND stage = 'awaiting_expert'", [evalRunId]);
  }
  if (h.stage === 'recorded') {
    await exec(
      getPool(),
      `UPDATE eval_metric m JOIN v_eval_metric_live l ON l.eval_run_id = m.eval_run_id AND l.contract_type = m.contract_type
          SET m.evidence_fit_pct = l.evidence_fit_pct
        WHERE m.eval_run_id = ? AND m.measurable = TRUE AND l.review_pending = 0`,
      [evalRunId],
    );
  }
  return { evalRunId, evalItemId, evidenceVersionId, verdict };
}

// ------------------------------------------------------------------ 7.3 비교 · 7.1 진입

/** 7.3 비교만 수행 — 기록된 두 평가의 고정 지표(eval_metric)를 나란히. 새 추론 없음 */
export async function compareRuns(a: number, b: number) {
  const [ha, hb] = [await head(a), await head(b)];
  for (const h of [ha, hb]) if (h.stage !== 'recorded') throw new HttpError(409, 'not_recorded', `EV-${h.eval_run_id} 은 아직 기록되지 않았습니다 - 기록된 평가끼리만 비교합니다`);
  const [ma, mb] = [await recordedMetrics(a), await recordedMetrics(b)];
  const types = [...new Set([...ma, ...mb].map((m) => m.contractType))].sort();
  const side = (h: RunHead, m: MetricDto[]) => ({
    evalRunId: h.eval_run_id,
    knowledgeDate: h.knowledge_date,
    analysisBasisVersion: h.analysis_basis_version,
    modelVersions: { m1: h.m1_model_version, m2: h.m2_model_version, m3: h.m3_model_version },
    recordedAt: h.recorded_at ? new Date(h.recorded_at).toISOString() : null,
    scConfirmedAt: h.sc_confirmed_at ? new Date(h.sc_confirmed_at).toISOString() : null,
    metrics: m,
  });
  const d = (x: number | null | undefined, y: number | null | undefined) => (x === null || x === undefined || y === null || y === undefined ? null : pp(y - x));
  return {
    a: side(ha, ma),
    b: side(hb, mb),
    modelChanged: ha.m1_model_version !== hb.m1_model_version || ha.m2_model_version !== hb.m2_model_version || ha.m3_model_version !== hb.m3_model_version,
    knowledgeChanged: ha.kv_id !== hb.kv_id,
    rows: types.map((t) => {
      const x = ma.find((m) => m.contractType === t);
      const y = mb.find((m) => m.contractType === t);
      return {
        contractType: t,
        contractTypeLabel: label(t),
        a: x ?? null,
        b: y ?? null,
        delta: { recallPp: d(x?.recallPct, y?.recallPct), precisionPp: d(x?.precisionPct, y?.precisionPct), evidenceFitPp: d(x?.evidenceFitPct, y?.evidenceFitPct) },
      };
    }),
  };
}

/** 7.1 평가 화면 진입 — 검수 완료 평가 데이터(유형별), 활성 기준일·분석 기준 버전, 현재 model_version·학습 기준일, 최근 평가 */
export async function overview() {
  const kv = await activeKnowledgeVersion();
  const models = await currentModels();
  const accepted = await select<{ contract_type: string; n: number }>(getPool(), "SELECT contract_type, COUNT(*) AS n FROM eval_item WHERE review_status = 'accepted' GROUP BY contract_type ORDER BY contract_type");
  const pendingReview = await selectOne<{ n: number }>(getPool(), "SELECT COUNT(*) AS n FROM eval_item WHERE review_status = 'pending'");
  const candidates = await select<{ candidate_id: number; contract_type: string; candidate_at: Date; clause_text_deid: string; feedback_id: number | null }>(
    getPool(),
    `SELECT c.candidate_id, c.contract_type, c.candidate_at, c.clause_text_deid, c.feedback_id FROM eval_candidate c
       LEFT JOIN eval_item i ON i.candidate_id = c.candidate_id WHERE i.eval_item_id IS NULL ORDER BY c.candidate_id DESC LIMIT 200`,
  );
  const shown = await present(
    candidates.map((c) => ({ field: 'clause' as const, text: c.clause_text_deid, persist: (conn, masked) => conn.query('UPDATE eval_candidate SET clause_text_deid = ? WHERE candidate_id = ?', [masked, c.candidate_id]) })),
  );
  const runs = await select<{ eval_run_id: number; stage: Stage; started_at: Date; recorded_at: Date | null; sc_confirmed_at: Date | null; m3_model_version: string; knowledge_date: string }>(
    getPool(),
    `SELECT r.eval_run_id, r.stage, r.started_at, r.recorded_at, r.sc_confirmed_at, r.m3_model_version, DATE_FORMAT(kv.knowledge_date, '%Y-%m-%d') AS knowledge_date
       FROM eval_run r JOIN knowledge_version kv ON kv.kv_id = r.kv_id ORDER BY r.eval_run_id DESC LIMIT 30`,
  );
  const iso = (d: Date | null) => (d ? new Date(d).toISOString() : undefined);
  return {
    kvId: kv?.kv_id,
    knowledgeDate: kv?.knowledge_date,
    analysisBasisVersion: kv?.analysis_basis_version,
    modelServer: models ? 'ready' : 'unreachable',
    ...(models ?? {}),
    acceptedByType: accepted.map((a) => ({ contractType: a.contract_type, count: Number(a.n) })),
    pendingReviewCount: Number(pendingReview?.n ?? 0),
    candidates: candidates.map((c, k) => ({ candidateId: c.candidate_id, contractType: c.contract_type, candidateAt: iso(c.candidate_at), clauseTextDeid: shown.texts[k] ?? '' })),
    runs: runs.map((r) => ({ evalRunId: r.eval_run_id, stage: r.stage, startedAt: iso(r.started_at), recordedAt: iso(r.recorded_at), scConfirmedAt: iso(r.sc_confirmed_at), m3: r.m3_model_version, knowledgeDate: r.knowledge_date })),
    recordedRuns: runs.filter((r) => r.stage === 'recorded').map((r) => ({ evalRunId: r.eval_run_id, recordedAt: iso(r.recorded_at), m3: r.m3_model_version, knowledgeDate: r.knowledge_date })),
  };
}
