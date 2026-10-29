// GET /api/analyses/{id} 진행 상태(T072): 레일 6단계(FR-024), 문서별 유형 후보, 실행 진행, 열린 게이트,
// 경과 시간과 모델 적재·대기 안내(modelNotice — model-serving §0.1)
import { getPool, select, selectOne } from '../../db/pool.js';
import { openGate, type OpenGate } from '../gates/GateError.js';
import { NOTICES, type GateCode } from '../gates/messages.js';
import { getServerStatus, isCold, queueDepth } from '../modelApi/status.js';
import { judgeGate } from '../../jobs/runner.js';
import { getDocuments, getRequest, latestRun, type RequestRow, type RunRow } from './analysis.repo.js';

type Step = 'received' | 'deidentify' | 'structure' | 'detect' | 'search' | 'explain';
type StepState = 'waiting' | 'running' | 'done' | 'blocked' | 'reused';

export async function openGatesFor(requestId: number, runId: number | null): Promise<OpenGate[]> {
  const rows = await select<{ event_id: number; gate_code: GateCode; reason_code: string }>(
    getPool(),
    'SELECT event_id, gate_code, reason_code FROM v_gate_open WHERE request_id = ? OR (run_id IS NOT NULL AND run_id = ?) ORDER BY event_id',
    [requestId, runId ?? -1],
  );
  return rows.map((g) => {
    const params: Record<string, string> =
      g.gate_code === 'G5' ? { state: g.reason_code === 'model_loading' ? '모델을 불러오는 중' : '응답하지 않음' } : {};
    return { ...openGate(g.gate_code, params, g.event_id), scope: g.gate_code === 'G9' ? 'partial' : 'full' };
  });
}

function rail(req: RequestRow, run: RunRow | null, gates: OpenGate[], progress: { total: number; scored: number } | null) {
  const s = req.stage;
  const order = ['received', 'deidentifying', 'structuring', 'awaiting_type', 'type_confirmed'];
  const reqIdx = order.indexOf(s);
  const blockedG6 = gates.some((g) => g.gate === 'G6');
  // 업로드 뒤 본문 추출이 실패(변형·암호화·손상 — G2)하면 비식별화 전에 멈춘다(US3)
  const blockedG2 = s === 'stopped' && gates.some((g) => g.gate === 'G2');
  const reused = run?.run_kind === 'reanalysis';
  const st = (step: Step): StepState => {
    if (reused && (step === 'received' || step === 'deidentify' || step === 'structure')) return 'reused';
    if (step === 'received') return 'done';
    if (step === 'deidentify') {
      if (s === 'deidentifying') return 'running';
      if (blockedG2) return 'blocked';
      if (s === 'stopped' && blockedG6) return 'done';
      return reqIdx >= 2 || s === 'stopped' ? 'done' : 'waiting';
    }
    if (step === 'structure') {
      if (s === 'structuring') return 'running';
      if (blockedG2) return 'waiting';
      if (s === 'stopped' && blockedG6) return 'blocked';
      return reqIdx >= 3 || run ? 'done' : 'waiting';
    }
    if (!run) return 'waiting';
    const rs = run.stage;
    const aborted = rs === 'aborted';
    const scoringDone = progress ? progress.scored >= progress.total : false;
    if (step === 'detect') {
      if (rs === 'detecting') return 'running';
      if (aborted && !scoringDone) return 'blocked';
      return 'done';
    }
    if (step === 'search') {
      if (rs === 'detecting') return 'waiting';
      if (rs === 'searching') return 'running';
      if (aborted) return scoringDone ? 'done' : 'waiting';
      return 'done';
    }
    if (rs === 'explaining') return 'running';
    if (aborted) return scoringDone ? 'blocked' : 'waiting';
    if (rs === 'completed' || rs === 'saved') return gates.some((g) => g.gate === 'G7') ? 'blocked' : 'done';
    return 'waiting';
  };
  return (['received', 'deidentify', 'structure', 'detect', 'search', 'explain'] as Step[]).map((step) => ({ step, state: st(step) }));
}

export function isCancellable(req: RequestRow, run: RunRow | null): boolean {
  if (['received', 'deidentifying', 'structuring', 'awaiting_type'].includes(req.stage)) return true;
  return req.stage === 'type_confirmed' && !!run && run.run_kind === 'analysis' && ['detecting', 'searching', 'explaining'].includes(run.stage);
}

async function modelNotice(req: RequestRow, run: RunRow | null) {
  const status = await getServerStatus();
  if (status.state === 'loading') return { kind: 'loading', model: 'M3', message: '모델 서버가 모델을 불러오는 중입니다', estimatedSec: status.warmupEstimateSec };
  if (req.stage === 'structuring' || req.stage === 'deidentifying') {
    const c = isCold('M4');
    if (c.cold) return { kind: 'cold_start', model: 'M4', message: `요약 모델을 메모리에 올리는 중입니다 — ${NOTICES.coldStart}`, estimatedSec: c.estimateSec };
  }
  if (run && ['detecting', 'searching', 'explaining'].includes(run.stage)) {
    const c = isCold('M3');
    if (c.cold) return { kind: 'cold_start', model: 'M3', message: `판정 모델을 메모리에 올리는 중입니다 — ${NOTICES.coldStart}`, estimatedSec: c.estimateSec };
    if (run.stage === 'explaining' && (judgeGate.queued > 0 || queueDepth() > 0)) {
      return { kind: 'queue', model: 'M3', message: `${NOTICES.queue}. 앞 요청이 끝나면 이어집니다`, estimatedSec: null };
    }
  }
  return null;
}

/** 판정 단계 진행(2026-09-30) — 위험 후보 수·판정 수와 판정을 마친 위험 조항(판정 순서 = 위험 점수 높은 순).
 *  판정 단계 전에는 pending 이 "아직 점수 없음"과 섞이므로 싣지 않는다 */
async function judgeProgress(runId: number) {
  const rows = await select<{ status: string; display_category: string | null; clause_id: number; seq: number; article_no: string | null;
    paragraph_no: string | null; item_no: string | null; title: string | null; preview: string }>(getPool(),
    `SELECT a.status, v.display_category, c.clause_id, c.seq, c.article_no, c.paragraph_no, c.item_no, c.title, LEFT(c.deid_text, 60) AS preview
       FROM clause_assessment a
       JOIN v_assessment_display v ON v.assessment_id = a.assessment_id
       JOIN clause c ON c.clause_id = a.clause_id
      WHERE a.run_id = ? AND (a.status IN ('pending', 'judged') OR (a.status = 'unanalyzable' AND a.screen_result = 'risk_candidate'))
      ORDER BY a.assessment_id`, [runId]);
  const risky = new Set(['dispute', 'unfair', 'illegal']);
  return {
    riskTotal: rows.length,
    judgedCount: rows.filter((r) => r.status !== 'pending').length,
    judgedNormalCount: rows.filter((r) => r.status === 'judged' && r.display_category === 'normal').length,
    judged: rows.filter((r) => r.status === 'judged' && r.display_category && risky.has(r.display_category)).map((r) => ({
      clauseId: Number(r.clause_id), seq: Number(r.seq), category: r.display_category as 'dispute' | 'unfair' | 'illegal',
      ...(r.article_no ? { articleNo: r.article_no } : {}), ...(r.paragraph_no ? { paragraphNo: r.paragraph_no } : {}),
      ...(r.item_no ? { itemNo: r.item_no } : {}), ...(r.title ? { title: r.title } : {}), preview: r.preview,
    })),
  };
}

export async function analysisStatus(requestId: number) {
  const req = (await getRequest(requestId))!;
  const run = await latestRun(requestId);
  const docs = await getDocuments(requestId);
  const progress = run
    ? await selectOne<{ clause_total: number; scored_cnt: number }>(getPool(), 'SELECT clause_total, scored_cnt FROM v_run_progress WHERE run_id = ?', [run.run_id])
    : null;
  const gates = await openGatesFor(requestId, run?.run_id ?? null);
  const prog = progress ? { total: Number(progress.clause_total), scored: Number(progress.scored_cnt) } : null;
  return {
    requestId,
    perspective: req.perspective,
    knowledgeDate: req.knowledge_date,
    requestStage: req.stage,
    rail: rail(req, run, gates, prog),
    documents: docs.map((d) => ({
      documentId: d.document_id,
      docSeq: d.doc_seq,
      displayName: d.display_name,
      // nullable enum 은 값이 없으면 싣지 않는다(계약 enum 에 null 이 없음)
      ...(d.split_method ? { splitMethod: d.split_method } : {}),
      ocrApplied: Boolean(d.ocr_applied),
      ...(d.summary_status ? { summaryStatus: d.summary_status } : {}),
      contractTypeCandidate: d.contract_type_candidate ?? undefined,
      contractType: d.contract_type ?? undefined,
    })),
    run: run
      ? { runId: run.run_id, runKind: run.run_kind, stage: run.stage, clauseTotal: prog?.total ?? 0, scoredCount: prog?.scored ?? 0,
          ...(['explaining', 'completed', 'saved'].includes(run.stage) ? await judgeProgress(run.run_id) : {}) }
      : null,
    openGates: gates,
    elapsedSec: Math.max(0, Math.round((Date.now() - new Date(req.requested_at).getTime()) / 1000)),
    modelNotice: await modelNotice(req, run),
    cancellable: isCancellable(req, run),
  };
}
