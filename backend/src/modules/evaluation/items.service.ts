// P7 7.2 평가 데이터 등록·검수 채택(T135). 채택은 법률 전문가·운영자만(RBAC eval.review), 검수자·검수일 필수(BR-QA-01 CHECK).
// 인위적 변형·학습 중복 조항의 채택은 DB CHECK(chk_eitem_br_qa_01)가 거부 → G10(해제 불가)으로 번역만 한다.
// 평가 데이터 텍스트는 등록 시 비식별화하고, 응답 직전 다시 검사한다(BR-PRV-04)
import { exec, getPool, select, selectOne } from '../../db/pool.js';
import { withTx } from '../../db/tx.js';
import { isDuplicate } from '../../db/errors.js';
import { HttpError } from '../../middleware/errorHandler.js';
import type { ContractType, RiskCategory } from '../../domain/codes.js';
import { deidentifyDetailed } from '../deid/deid.service.js';
import { GateError } from '../gates/GateError.js';
import { present } from '../feedbackReview/presenter.js';

export type EvalOrigin = 'new_label' | 'feedback_candidate' | 'synthetic';
export type ItemReviewStatus = 'pending' | 'accepted' | 'rejected';

interface EvalItemRow {
  eval_item_id: number;
  clause_text_deid: string;
  contract_type: ContractType;
  gold_category: RiskCategory;
  origin: EvalOrigin;
  candidate_id: number | null;
  overlaps_training: number;
  review_status: ItemReviewStatus;
  reviewed_at: Date | null;
  reviewer_masked: string | null;
}

/** 평가 데이터 텍스트 재검사 — 가림은 저장 텍스트에도 반영하고 사고는 유형만 남긴다(G13 은 피드백 대상 게이트라 남기지 않음) */
export async function presentEvalTexts(rows: { eval_item_id: number; clause_text_deid: string }[]): Promise<string[]> {
  const shown = await present(
    rows.map((r) => ({
      field: 'clause' as const,
      text: r.clause_text_deid,
      persist: (conn, masked) => conn.query('UPDATE eval_item SET clause_text_deid = ? WHERE eval_item_id = ?', [masked, r.eval_item_id]),
    })),
  );
  return shown.texts.map((t) => t ?? '');
}

export async function listItems(f: { reviewStatus?: ItemReviewStatus; contractType?: ContractType }) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.reviewStatus) {
    where.push('i.review_status = ?');
    params.push(f.reviewStatus);
  }
  if (f.contractType) {
    where.push('i.contract_type = ?');
    params.push(f.contractType);
  }
  const rows = await select<EvalItemRow>(
    getPool(),
    `SELECT i.eval_item_id, i.clause_text_deid, i.contract_type, i.gold_category, i.origin, i.candidate_id, i.overlaps_training,
            i.review_status, i.reviewed_at, u.email_masked AS reviewer_masked
       FROM eval_item i LEFT JOIN v_user_masked u ON u.user_id = i.reviewer_user_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY i.eval_item_id LIMIT 2000`,
    params,
  );
  const texts = await presentEvalTexts(rows);
  return rows.map((r, k) => ({
    evalItemId: r.eval_item_id,
    clauseTextDeid: texts[k]!,
    contractType: r.contract_type,
    goldCategory: r.gold_category,
    origin: r.origin,
    candidateId: r.candidate_id,
    overlapsTraining: Boolean(r.overlaps_training),
    reviewStatus: r.review_status,
    reviewedAt: r.reviewed_at ? new Date(r.reviewed_at).toISOString() : null,
    reviewerMasked: r.reviewer_masked,
  }));
}

export interface RegisterInput {
  clauseTextDeid: string;
  contractType: ContractType;
  goldCategory: RiskCategory;
  origin: EvalOrigin;
  candidateId?: number;
  goldEvidenceItemIds?: number[];
  overlapsTraining?: boolean;
}

/** 새 라벨링 조항·H5 후보 승격 — 검수 전 pending. H5 후보는 후보 스냅샷(비식별 텍스트·유형)을 그대로 쓴다 */
export async function registerItem(input: RegisterInput): Promise<{ evalItemId: number; reviewStatus: 'pending'; maskedTypes: string[] }> {
  let text: string;
  let contractType: string = input.contractType;
  let maskedTypes: string[] = [];
  if (input.origin === 'feedback_candidate') {
    if (!input.candidateId) throw new HttpError(400, 'bad_request', '평가 데이터 후보 번호가 필요합니다');
    const c = await selectOne<{ clause_text_deid: string; contract_type: string }>(getPool(), 'SELECT clause_text_deid, contract_type FROM eval_candidate WHERE candidate_id = ?', [input.candidateId]);
    if (!c) throw new HttpError(404, 'not_found', '평가 데이터 후보를 찾을 수 없습니다');
    text = c.clause_text_deid;
    contractType = c.contract_type;
  } else {
    if (input.candidateId) throw new HttpError(400, 'bad_request', '피드백 후보가 아닌 평가 데이터에는 후보 번호를 줄 수 없습니다');
    const d = deidentifyDetailed(input.clauseTextDeid.trim());
    text = d.text;
    maskedTypes = d.maskedTypes;
  }
  if (!text) throw new HttpError(400, 'bad_request', '조항 텍스트가 비어 있습니다');
  try {
    const id = await withTx(async (conn) => {
      const [r] = await conn.query<import('mysql2').ResultSetHeader>(
        `INSERT INTO eval_item (clause_text_deid, contract_type, gold_category, origin, candidate_id, overlaps_training)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [text, contractType, input.goldCategory, input.origin, input.origin === 'feedback_candidate' ? input.candidateId : null, Boolean(input.overlapsTraining)],
      );
      for (const ev of new Set(input.goldEvidenceItemIds ?? [])) {
        await conn.query('INSERT INTO eval_item_gold_evidence (eval_item_id, evidence_item_id) VALUES (?, ?)', [r.insertId, ev]);
      }
      return r.insertId;
    });
    return { evalItemId: id, reviewStatus: 'pending', maskedTypes };
  } catch (e) {
    if (isDuplicate(e)) throw new HttpError(409, 'duplicate', '이미 평가 데이터로 등록한 후보입니다');
    if ((e as { errno?: number }).errno === 1452) throw new HttpError(422, 'unknown_evidence', '정답 근거 항목을 찾을 수 없습니다');
    throw e;
  }
}

const ORIGIN_REASON: Record<string, string> = { synthetic: '인위적 변형', overlap: '학습 데이터 중복' };

/** 7.2 법률 전문가 검수 — 채택·반려. 채택 불가(인위적 변형·학습 중복)는 DB 가 판정 → G10 */
export async function reviewItem(evalItemId: number, decision: 'accepted' | 'rejected', reviewerUserId: number) {
  try {
    const r = await exec(getPool(), 'UPDATE eval_item SET review_status = ?, reviewer_user_id = ?, reviewed_at = CURRENT_TIMESTAMP WHERE eval_item_id = ?', [decision, reviewerUserId, evalItemId]);
    if (r.affectedRows === 0) throw new HttpError(404, 'not_found', '평가 데이터를 찾을 수 없습니다');
  } catch (e) {
    const err = e as { errno?: number; sqlMessage?: string };
    if (err.errno === 4025 && /chk_eitem_br_qa_01/.test(err.sqlMessage ?? '')) {
      const row = await selectOne<{ origin: string; overlaps_training: number }>(getPool(), 'SELECT origin, overlaps_training FROM eval_item WHERE eval_item_id = ?', [evalItemId]);
      const why = row?.origin === 'synthetic' ? ORIGIN_REASON.synthetic : ORIGIN_REASON.overlap;
      // 해제 불가 — 다음 행동 없음. gate_event G10 은 평가 실행 대상이라 여기서는 기록하지 않는다(chk_ge_subject)
      throw new GateError('G10', { params: { n: 1, detail: why }, nextActions: [], detail: { evalItemId, reason: row?.origin === 'synthetic' ? 'synthetic' : 'training_overlap' } });
    }
    throw e;
  }
  const row = await selectOne<{ review_status: string; reviewed_at: Date }>(getPool(), 'SELECT review_status, reviewed_at FROM eval_item WHERE eval_item_id = ?', [evalItemId]);
  return { evalItemId, reviewStatus: row!.review_status, reviewedAt: new Date(row!.reviewed_at).toISOString() };
}
