// P4 결과(T077·T078): 3.9 저장(+사용량 차감, 같은 트랜잭션), 4.1~4.4 결과·조항 상세. 표시값은 v_assessment_display 한 곳에서
import { abstentionsOf, ABSTENTION_LABEL } from '../abstention/abstention.service.js';
import type { Request } from 'express';
import { getPool, select, selectOne } from '../../db/pool.js';
import { withTx } from '../../db/tx.js';
import { DISCLAIMER, type DisplayCategory } from '../../domain/codes.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { raise } from '../gates/gates.service.js';
import { evidenceOfJudgment, toEvidenceDto } from '../evidence/evidence.repo.js';
import { getRequest, getRun } from '../analysis/analysis.repo.js';
import { openGatesFor } from '../analysis/status.service.js';
import { identifyImpactsForRun } from '../knowledge/impact.service.js';

/** 3.9·6.7 "결과 보기" — stage='saved' + usage_charge(최초 분석만, A9 / 재분석 미차감 FR-035(e)). 멱등 */
export async function saveRun(req: Request, requestId: number, runId: number): Promise<void> {
  const openG7 = await selectOne<{ event_id: number }>(getPool(), "SELECT event_id FROM v_gate_open WHERE gate_code = 'G7' AND run_id = ?", [runId]);
  if (openG7) await raise('G7', 'perspective_mismatch', { runId }, { status: 409, eventId: openG7.event_id });
  await withTx(async (conn) => {
    const [[run]] = await conn.query<import('mysql2').RowDataPacket[]>('SELECT stage, run_kind FROM analysis_run WHERE run_id = ? FOR UPDATE', [runId]);
    if (!run) throw new HttpError(404, 'not_found', '실행을 찾을 수 없습니다');
    if (run.stage === 'saved') return;
    if (run.stage !== 'completed') throw new HttpError(409, 'run_not_completed', '분석이 아직 끝나지 않았습니다');
    const [[r]] = await conn.query<import('mysql2').RowDataPacket[]>('SELECT user_id, session_id FROM analysis_request WHERE request_id = ?', [requestId]);
    await conn.query("UPDATE analysis_run SET stage = 'saved', saved_at = CURRENT_TIMESTAMP WHERE run_id = ?", [runId]);
    // 일부 조항이 분석 불가여도 차감한다(FR-035(a)). 재분석은 차감하지 않는다
    if (run.run_kind === 'analysis') {
      await conn.query('INSERT INTO usage_charge (user_id, session_id, run_id) VALUES (?, ?, ?)', [r!.user_id, r!.user_id ? null : r!.session_id, runId]);
    }
  });
  // 분석 도중 새 기준일이 승인됐으면(FR-039 — 고정 기준일로 끝난 실행) 저장 직후 영향 결과를 보충한다(0.5). 멱등, 없으면 아무 일도 안 한다
  await identifyImpactsForRun(runId);
  void req;
}

interface DisplayRow {
  assessment_id: number;
  run_id: number;
  clause_id: number;
  status: string;
  judgment_id: number | null;
  risk_type: string | null;
  risk_level: 'high' | 'mid' | 'low' | null;
  confidence: string | null;
  evidence_count: number;
  display_category: DisplayCategory | null;
  evidence_unconfirmed: number;
  expert_review_recommended: number;
  explanation_available: number | null;
  low_ocr_quality: number;
}

const LEVEL_ORDER = { high: 0, mid: 1, low: 2 } as const;
const CAT_ORDER: Record<string, number> = { illegal: 0, unfair: 1, dispute: 2, unanalyzable: 3, normal: 4 };

export async function assertSaved(runId: number): Promise<void> {
  const run = await getRun(runId);
  // 저장하지 않은 결과는 "결과 없음"(G8, 계약 404 GateError) — "결과 보기"를 누르지 않은 실행은 열 수 없다
  if (!run || run.stage !== 'saved') {
    await raise('G8', 'result_not_saved', { runId: run?.run_id }, {
      status: 404,
      params: { what: '결과를 열', detail: '저장된 결과가 없습니다', how: '분석 화면에서 "결과 보기"' },
      nextActions: [{ id: 'new_analysis', label: '새 분석 시작' }],
    });
  }
}

export async function resultView(runId: number) {
  const run = (await getRun(runId))!;
  const req = (await getRequest(run.request_id))!;
  const kv = await selectOne<{ knowledge_date: string; analysis_basis_version: string }>(
    getPool(),
    "SELECT DATE_FORMAT(knowledge_date, '%Y-%m-%d') AS knowledge_date, analysis_basis_version FROM knowledge_version WHERE kv_id = ?",
    [run.kv_id],
  );
  const docs = await select<{ document_id: number; display_name: string; contract_type: string; in_scope: number; split_method: string; summary_text: string | null; summary_status: string | null; source_url: string | null; collected_at: Date | null; ocr_applied: number }>(
    getPool(),
    `SELECT d.document_id, d.display_name, d.contract_type, ct.in_scope, d.split_method, d.summary_text, d.summary_status, d.source_url, d.collected_at, d.ocr_applied
       FROM document d LEFT JOIN contract_type_code ct ON ct.contract_type = d.contract_type WHERE d.request_id = ? AND d.is_contract = TRUE ORDER BY d.doc_seq`,
    [run.request_id],
  );
  const counts = await selectOne<{ high_cnt: number; mid_cnt: number; low_cnt: number; unanalyzable_cnt: number }>(getPool(), 'SELECT * FROM v_run_risk_counts WHERE run_id = ?', [runId]);
  const rows = await select<DisplayRow & { seq: number; doc_seq: number; document_id: number; article_no: string | null; paragraph_no: string | null; item_no: string | null; title: string | null; deid_text: string }>(
    getPool(),
    `SELECT v.*, c.seq, c.document_id, d.doc_seq, c.article_no, c.paragraph_no, c.item_no, c.title, c.deid_text
       FROM v_assessment_display v JOIN clause c ON c.clause_id = v.clause_id JOIN document d ON d.document_id = c.document_id
      WHERE v.run_id = ? ORDER BY d.doc_seq, c.seq`,
    [runId],
  );
  // 판정 불가(migration 008): 모델을 부르지 않은 조항 — "분석 불가" 범주로 보이고 사유를 붙인다
  const abst = await abstentionsOf(runId);
  for (const r of rows) if (abst.has(r.clause_id)) r.display_category = 'unanalyzable';
  let impactNotice = null;
  const im = await select<{ change_kind: string; n: number }>(getPool(), 'SELECT change_kind, COUNT(*) AS n FROM v_result_impact_active WHERE run_id = ? GROUP BY change_kind', [runId]);
  if (im.length) {
    const g = (k: string) => Number(im.find((x) => x.change_kind === k)?.n ?? 0);
    impactNotice = { amend: g('amend'), repeal: g('repeal'), newCase: g('new_case'), stdTermsRevision: g('std_terms_revision') };
  }
  const clauses = rows.map((r) => ({
    assessmentId: r.assessment_id,
    clauseId: r.clause_id,
    documentId: r.document_id,
    seq: r.seq,
    articleNo: r.article_no,
    paragraphNo: r.paragraph_no,
    itemNo: r.item_no,
    title: r.title,
    text: r.deid_text,
    displayCategory: r.display_category ?? 'normal',
    ...(r.risk_level && r.display_category && ['dispute', 'unfair', 'illegal'].includes(r.display_category) ? { riskLevel: r.risk_level } : {}),
    lowOcrQuality: Boolean(r.low_ocr_quality),
    ...(abst.has(r.clause_id) ? { abstention: { reason: abst.get(r.clause_id)!.reason, label: ABSTENTION_LABEL[abst.get(r.clause_id)!.reason] } } : {}),
  }));
  const riskOrder = rows
    .filter((r) => r.display_category && r.display_category !== 'normal')
    .sort(
      (a, b) =>
        (a.risk_level ? LEVEL_ORDER[a.risk_level] : 3) - (b.risk_level ? LEVEL_ORDER[b.risk_level] : 3) ||
        CAT_ORDER[a.display_category!]! - CAT_ORDER[b.display_category!]! ||
        a.doc_seq - b.doc_seq ||
        a.seq - b.seq,
    )
    .map((r) => r.assessment_id);
  return {
    runId,
    requestId: run.request_id,
    runKind: run.run_kind,
    prevRunId: run.prev_run_id,
    disclaimer: DISCLAIMER,
    knowledgeDate: kv!.knowledge_date,
    analysisBasisVersion: kv!.analysis_basis_version,
    perspective: req.perspective,
    documents: docs.map((d) => ({
      documentId: d.document_id,
      displayName: d.display_name,
      contractType: d.contract_type,
      contractTypeInScope: Boolean(d.in_scope),
      ...(d.split_method ? { splitMethod: d.split_method } : {}),
      summary: d.summary_status === 'ok' ? d.summary_text : null,
      sourceUrl: d.source_url,
      collectedAt: d.collected_at ? new Date(d.collected_at).toISOString() : null,
      ocrApplied: Boolean(d.ocr_applied),
    })),
    counts: { high: Number(counts?.high_cnt ?? 0), mid: Number(counts?.mid_cnt ?? 0), low: Number(counts?.low_cnt ?? 0), unanalyzable: Number(counts?.unanalyzable_cnt ?? 0) + abst.size },
    impactNotice,
    clauses,
    riskOrder,
    openGates: await openGatesFor(run.request_id, runId),
    lowOcrQuality: rows.some((r) => r.low_ocr_quality),
  };
}

export async function assessmentRow(runId: number, assessmentId: number) {
  const r = await selectOne<DisplayRow & { seq: number; document_id: number; article_no: string | null; paragraph_no: string | null; item_no: string | null; title: string | null; deid_text: string; unanalyzable_reason: string | null; kv_id: number }>(
    getPool(),
    `SELECT v.*, c.seq, c.document_id, c.article_no, c.paragraph_no, c.item_no, c.title, c.deid_text, a.unanalyzable_reason, r.kv_id
       FROM v_assessment_display v JOIN clause_assessment a ON a.assessment_id = v.assessment_id
       JOIN clause c ON c.clause_id = v.clause_id JOIN analysis_run r ON r.run_id = v.run_id
      WHERE v.assessment_id = ? AND v.run_id = ?`,
    [assessmentId, runId],
  );
  if (!r) throw new HttpError(404, 'not_found', '조항 판정을 찾을 수 없습니다');
  const ab = (await abstentionsOf(runId)).get(r.clause_id);
  if (ab) return { ...r, display_category: 'unanalyzable' as DisplayCategory, abstention: { reason: ab.reason, label: ABSTENTION_LABEL[ab.reason] } };
  return { ...r, abstention: null as null | { reason: string; label: string } };
}

/** 4.4 판정 상세 + 4.6 근거 목록. 근거 변경(이후 기준일에 구간이 닫힘)은 changedSinceAnalysis */
export async function clauseDetail(runId: number, assessmentId: number) {
  const r = await assessmentRow(runId, assessmentId);
  const evidence = r.judgment_id ? await evidenceOfJudgment(r.judgment_id) : [];
  const cat = r.display_category ?? 'normal';
  return {
    assessmentId: r.assessment_id,
    clause: {
      assessmentId: r.assessment_id,
      clauseId: r.clause_id,
      documentId: r.document_id,
      seq: r.seq,
      articleNo: r.article_no,
      paragraphNo: r.paragraph_no,
      itemNo: r.item_no,
      title: r.title,
      text: r.deid_text,
      displayCategory: cat,
      ...(r.risk_level && ['dispute', 'unfair', 'illegal'].includes(cat) ? { riskLevel: r.risk_level } : {}),
      lowOcrQuality: Boolean(r.low_ocr_quality),
      ...(r.abstention ? { abstention: r.abstention } : {}),
    },
    displayCategory: cat,
    ...(r.abstention ? { abstention: r.abstention } : {}),
    ...(r.risk_type && cat !== 'normal' ? { riskType: r.risk_type } : {}),
    ...(r.risk_level && cat !== 'normal' ? { riskLevel: r.risk_level } : {}),
    ...(r.confidence && cat !== 'normal' ? { confidence: r.confidence } : {}),
    evidenceUnconfirmed: Boolean(r.evidence_unconfirmed),
    expertReviewRecommended: Boolean(r.expert_review_recommended),
    explanationAvailable: r.explanation_available === null ? null : Boolean(r.explanation_available),
    ...(r.unanalyzable_reason ? { unanalyzableReason: r.unanalyzable_reason as 'timeout' | 'server_down' } : {}),
    evidence: evidence.map((e) => toEvidenceDto(e, e.to_kv_id !== null)),
    feedbackTypeAllowed: ['dispute', 'unfair', 'illegal'].includes(cat) ? 'false_positive' : 'false_negative',
  };
}
