// P8 사용자 피드백 검토(T138): 8.1·8.2 목록·필터, 8.3 상세(E1 대상 표시 불가, E2 G13, A3 근거 변경), 8.4 검토 기록,
// 8.5 평가 후보(H5 — 트리거 trg_ecand_bi 가 "타당"·G13 가림 완료를 강제), 8.6 기준일별 현황(v_feedback_summary).
// 판정을 바꾸는 경로는 없다(UC9 사후조건 2, SD_01 §11-3)
import { exec, getPool, select, selectOne } from '../../db/pool.js';
import { isDuplicate, isRuleViolation } from '../../db/errors.js';
import { HttpError } from '../../middleware/errorHandler.js';
import type { DisplayCategory } from '../../domain/codes.js';
import { clauseDetail } from '../results/results.service.js';
import { present, type Presentable } from './presenter.js';

export type FeedbackType = 'false_positive' | 'false_negative';
export type ReviewStatus = 'unreviewed' | 'reviewed';
export type ReviewDecision = 'valid' | 'invalid' | 'needs_expert';

interface FeedbackDbRow {
  feedback_id: number;
  assessment_id: number | null;
  judgment_id: number | null;
  kv_id: number;
  knowledge_date: string;
  category_at_submit: DisplayCategory;
  feedback_type: FeedbackType;
  opinion_deid: string | null;
  user_id: number | null;
  session_id: string | null;
  submitted_at: Date;
  review_status: ReviewStatus;
  review_decision: ReviewDecision | null;
  run_id: number | null;
}

const BASE = `SELECT f.feedback_id, f.assessment_id, f.judgment_id, f.kv_id, DATE_FORMAT(kv.knowledge_date, '%Y-%m-%d') AS knowledge_date,
                     f.category_at_submit, f.feedback_type, f.opinion_deid, f.user_id, f.session_id, f.submitted_at,
                     f.review_status, f.review_decision, a.run_id
                FROM feedback f
                JOIN knowledge_version kv ON kv.kv_id = f.kv_id
                LEFT JOIN clause_assessment a ON a.assessment_id = f.assessment_id`;

/** 목록 행(FeedbackRow). 원문(의견·조항)은 싣지 않는다 — 상세에서 재검사 후 표시 */
function toRow(r: FeedbackDbRow) {
  return {
    feedbackId: r.feedback_id,
    feedbackType: r.feedback_type,
    categoryAtSubmit: r.category_at_submit,
    kvId: r.kv_id,
    knowledgeDate: r.knowledge_date,
    submittedAt: new Date(r.submitted_at).toISOString(),
    reviewStatus: r.review_status,
    // 계약 enum 에 null 이 없어 미검토면 싣지 않는다
    ...(r.review_decision ? { reviewDecision: r.review_decision } : {}),
    assessmentId: r.assessment_id,
    judgmentId: r.judgment_id,
    // UC9 E1 — 결과가 삭제되면 assessment_id 가 NULL(DDL SET NULL)
    targetAvailable: r.assessment_id !== null,
    // 결과 삭제 시 소유자 식별자가 지워진 익명 피드백(FR-041, R-15 미해결 1)
    anonymous: r.assessment_id === null || (r.user_id === null && r.session_id === null),
    hasOpinion: Boolean(r.opinion_deid),
  };
}

export interface ListFilter {
  type?: FeedbackType;
  kvId?: number;
  reviewStatus?: ReviewStatus;
}

/** 8.1·8.2 — 조항·판정·지식 기준일별 목록 + 필터 */
export async function listFeedback(f: ListFilter) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.type) {
    where.push('f.feedback_type = ?');
    params.push(f.type);
  }
  if (f.kvId) {
    where.push('f.kv_id = ?');
    params.push(f.kvId);
  }
  if (f.reviewStatus) {
    where.push('f.review_status = ?');
    params.push(f.reviewStatus);
  }
  const rows = await select<FeedbackDbRow>(getPool(), `${BASE}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY f.submitted_at DESC, f.feedback_id DESC LIMIT 500`, params);
  return rows.map(toRow);
}

/** 8.6 — 기준일별 검토·미검토, 오탐·미탐 건수(v_feedback_summary 가 단일 지점). 비율만 앱에서 나눈다 */
export async function feedbackSummary() {
  const rows = await select<{ kv_id: number; knowledge_date: string; unreviewed_cnt: number; false_positive_cnt: number; false_negative_cnt: number }>(
    getPool(),
    `SELECT s.kv_id, DATE_FORMAT(kv.knowledge_date, '%Y-%m-%d') AS knowledge_date, s.unreviewed_cnt, s.false_positive_cnt, s.false_negative_cnt
       FROM v_feedback_summary s JOIN knowledge_version kv ON kv.kv_id = s.kv_id ORDER BY kv.kv_seq DESC`,
  );
  return rows.map((r) => {
    const total = Number(r.false_positive_cnt) + Number(r.false_negative_cnt);
    const unreviewed = Number(r.unreviewed_cnt);
    const pct = (n: number) => (total ? Math.round((1000 * n) / total) / 10 : null);
    return {
      kvId: r.kv_id,
      knowledgeDate: r.knowledge_date,
      totalCnt: total,
      unreviewedCnt: unreviewed,
      reviewedCnt: total - unreviewed,
      falsePositiveCnt: Number(r.false_positive_cnt),
      falseNegativeCnt: Number(r.false_negative_cnt),
      falsePositivePct: pct(Number(r.false_positive_cnt)),
      falseNegativePct: pct(Number(r.false_negative_cnt)),
    };
  });
}

async function getFeedback(feedbackId: number): Promise<FeedbackDbRow> {
  const r = await selectOne<FeedbackDbRow>(getPool(), `${BASE} WHERE f.feedback_id = ?`, [feedbackId]);
  if (!r) throw new HttpError(404, 'not_found', '피드백을 찾을 수 없습니다');
  return r;
}

const persistOpinion = (feedbackId: number): Presentable['persist'] => (conn, masked) =>
  conn.query('UPDATE feedback SET opinion_deid = ? WHERE feedback_id = ?', [masked, feedbackId]);
const persistClauseText = (clauseId: number): Presentable['persist'] => (conn, masked) =>
  conn.query('UPDATE clause SET deid_text = ? WHERE clause_id = ?', [masked, clauseId]);
const persistClauseTitle = (clauseId: number): Presentable['persist'] => (conn, masked) =>
  conn.query('UPDATE clause SET title = ? WHERE clause_id = ?', [masked, clauseId]);

/** 8.3 피드백 상세 — 표시 직전 PII 재검사(G13). 결과 삭제됨이면 대상 없이 분류·기준일만(FR-041) */
export async function feedbackDetail(feedbackId: number) {
  const f = await getFeedback(feedbackId);
  const detail = f.assessment_id !== null && f.run_id !== null ? await clauseDetail(f.run_id, f.assessment_id).catch(() => null) : null;
  const items: Presentable[] = [{ field: 'opinion', text: f.opinion_deid, persist: persistOpinion(feedbackId) }];
  if (detail) {
    items.push({ field: 'clause', text: detail.clause.text, persist: persistClauseText(detail.clause.clauseId) });
    items.push({ field: 'clause', text: detail.clause.title ?? null, persist: persistClauseTitle(detail.clause.clauseId) });
  }
  const shown = await present(items, feedbackId);
  const [opinion, clauseText, clauseTitle] = shown.texts;
  return {
    ...toRow(f),
    targetAvailable: detail !== null,
    opinionDeid: opinion ?? null,
    ...(detail
      ? {
          clause: { ...detail.clause, text: clauseText ?? '', title: clauseTitle ?? null },
          judgment: { ...detail, clause: { ...detail.clause, text: clauseText ?? '', title: clauseTitle ?? null } },
          // UC9 A3 — 당시 판정 근거 중 이후 기준일에서 구간이 닫힌(개정·폐지) 근거가 있으면 "이후 근거 변경됨"
          evidenceChangedSince: detail.evidence.some((e) => e.changedSinceAnalysis),
        }
      : { evidenceChangedSince: false }),
    gates: shown.gate ? [shown.gate] : [],
  };
}

/** 8.4 검토 판단·상태 기록(재기록 허용). 판정은 건드리지 않는다 */
export async function recordReview(feedbackId: number, decision: ReviewDecision) {
  const r = await exec(getPool(), "UPDATE feedback SET review_status = 'reviewed', review_decision = ? WHERE feedback_id = ?", [decision, feedbackId]);
  if (r.affectedRows === 0) throw new HttpError(404, 'not_found', '피드백을 찾을 수 없습니다');
  return { feedbackId, reviewStatus: 'reviewed' as const, reviewDecision: decision };
}

/**
 * 8.5 평가 데이터 후보(H5) — 조항 비식별 원문 스냅샷. "타당" 여부·미가림 G13 은 트리거가 판정한다(앱에서 다시 구현하지 않음).
 * 스냅샷 직전에 한 번 더 재검사한다(가림이 끝나야 트리거를 통과)
 */
export async function makeEvalCandidate(feedbackId: number): Promise<{ candidateId: number; feedbackId: number }> {
  const f = await getFeedback(feedbackId);
  const target = f.assessment_id === null
    ? null
    : await selectOne<{ clause_id: number; deid_text: string; contract_type: string | null }>(
        getPool(),
        `SELECT c.clause_id, c.deid_text, d.contract_type FROM clause_assessment a JOIN clause c ON c.clause_id = a.clause_id
           JOIN document d ON d.document_id = c.document_id WHERE a.assessment_id = ?`,
        [f.assessment_id],
      );
  if (!target || !target.contract_type) throw new HttpError(409, 'target_unavailable', '대상 조항이 삭제되어 평가 후보로 지정할 수 없습니다');
  const shown = await present([{ field: 'clause', text: target.deid_text, persist: persistClauseText(target.clause_id) }], feedbackId);
  try {
    const r = await exec(getPool(), 'INSERT INTO eval_candidate (feedback_id, clause_text_deid, contract_type) VALUES (?, ?, ?)', [feedbackId, shown.texts[0], target.contract_type]);
    return { candidateId: r.insertId, feedbackId };
  } catch (e) {
    if (isDuplicate(e)) throw new HttpError(409, 'duplicate', '이미 평가 데이터 후보로 지정한 피드백입니다');
    if (isRuleViolation(e)) throw new HttpError(409, 'not_valid_feedback', '타당으로 검토 기록한 피드백만 평가 데이터 후보로 지정할 수 있습니다');
    throw e;
  }
}
