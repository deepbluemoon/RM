// P5 판정 피드백(T117, UC6): 5.1 대상 조항·판정·기준일 조회(G8) → 5.2 유형 제한(위험 판정→오탐, 정상·분석 불가→미탐)
// → 5.3 의견 비식별화(미리보기와 저장 모두 서버에서) → 5.4 저장(미검토). 연결값 일치는 DB 트리거 trg_fb_bi(BR-FDB-01)가 판정한다
import type { Request } from 'express';
import { getPool, selectOne } from '../../db/pool.js';
import { withTx } from '../../db/tx.js';
import { translateDbError } from '../../db/errors.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { assertOwner } from '../../middleware/guards.js';
import { raise } from '../gates/gates.service.js';
import { deidentifyDetailed } from '../deid/deid.service.js';
import type { DisplayCategory, PiiType } from '../../domain/codes.js';

export type FeedbackType = 'false_positive' | 'false_negative';

export const RECEIVED_NOTICE = '접수되었습니다. 판정은 바로 바뀌지 않으며 운영자가 검토합니다';

/** 5.2 — 표시 판정별 허용 유형(chk_fb_type_by_cat 과 같은 규칙) */
export function allowedFeedbackType(cat: DisplayCategory): FeedbackType {
  return cat === 'normal' || cat === 'unanalyzable' ? 'false_negative' : 'false_positive';
}

/** 5.3 — 의견 비식별화. 빈 의견은 생략(UC6 A2) */
export function deidOpinion(opinion: string | undefined | null): { opinionDeid: string | null; maskedTypes: PiiType[] } {
  const t = (opinion ?? '').trim();
  if (!t) return { opinionDeid: null, maskedTypes: [] };
  const r = deidentifyDetailed(t);
  return { opinionDeid: r.text, maskedTypes: r.maskedTypes };
}

interface Target {
  assessment_id: number;
  run_id: number;
  request_id: number;
  judgment_id: number | null;
  display_category: DisplayCategory | null;
  kv_id: number;
  stage: string;
}

/** 5.1~5.5 피드백 제출. 대상이 없거나 만료면 G8(404), 본인 결과가 아니면 G8 */
export async function submitFeedback(req: Request, input: { assessmentId: number; feedbackType: FeedbackType; opinion?: string }) {
  const t = await selectOne<Target>(
    getPool(),
    `SELECT v.assessment_id, v.run_id, r.request_id, v.judgment_id, v.display_category, r.kv_id, r.stage
       FROM v_assessment_display v JOIN analysis_run r ON r.run_id = v.run_id WHERE v.assessment_id = ?`,
    [input.assessmentId],
  );
  if (!t) {
    return raise('G8', 'not_found_or_expired', { userId: req.owner.userId, sessionId: req.owner?.sessionId ?? null }, {
      status: 404,
      params: { what: '피드백을 남길', detail: '세션이 만료되었습니다', how: '로그인 후 다시 분석' },
      nextActions: [{ id: 'new_analysis', label: '새 분석 시작' }, { id: 'login', label: '로그인' }],
    });
  }
  const owned = await assertOwner(req, t.request_id, '피드백을 남길');
  if (t.stage !== 'saved' || !t.display_category) throw new HttpError(404, 'not_saved', '저장된 결과가 아닙니다');
  const allowed = allowedFeedbackType(t.display_category);
  if (input.feedbackType !== allowed) {
    throw new HttpError(
      400,
      'feedback_type_mismatch',
      allowed === 'false_positive' ? '위험으로 판정된 조항에는 "위험하지 않음(오탐)"만 남길 수 있습니다' : '정상·분석 불가 조항에는 "놓친 위험(미탐)"만 남길 수 있습니다',
    );
  }
  const { opinionDeid } = deidOpinion(input.opinion);
  // 소유자: 로그인 결과는 user_id, 비로그인 결과는 그 세션(chk_fb_owner)
  const userId = owned.user_id ?? null;
  const sessionId = userId ? null : owned.session_id;
  try {
    const feedbackId = await withTx(async (conn) => {
      const [r] = await conn.query<import('mysql2').ResultSetHeader>(
        `INSERT INTO feedback (assessment_id, judgment_id, kv_id, category_at_submit, feedback_type, opinion_deid, user_id, session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [t.assessment_id, t.judgment_id, t.kv_id, t.display_category, input.feedbackType, opinionDeid, userId, sessionId],
      );
      return r.insertId;
    });
    return { feedbackId, notice: RECEIVED_NOTICE };
  } catch (e) {
    translateDbError(e);
  }
}
