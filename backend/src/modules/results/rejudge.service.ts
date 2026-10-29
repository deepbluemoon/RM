// 4.5 "분석 불가" 조항 1건 다시 분석(T080): /v1/detect/* → 근거 검색(당시 기준일) → /v1/judge. G5, 한도 미차감.
// 트리거 trg_ca_bu 가 judgment_id 변경을 unanalyzable 에서만 허용한다(UC2 A9)
import type { Request } from 'express';
import { exec, getPool } from '../../db/pool.js';
import { policy } from '../../config/policy.js';
import { fromStoredDeid } from '../../domain/types.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { modelApi, ModelApiError } from '../modelApi/client.js';
import { normalizeRiskTypeHint } from '../modelApi/adapter.js';
import { assertModelServerReady } from '../modelApi/gate.js';
import { raise } from '../gates/gates.service.js';
import { judgeClause, m3VersionFor } from '../detection/detection.service.js';
import { knowledgeVersion } from '../evidence/evidence.repo.js';
import { getClauses, getRequest, getRun } from '../analysis/analysis.repo.js';
import { assessmentRow, clauseDetail } from './results.service.js';

export async function rejudge(req: Request, runId: number, assessmentId: number) {
  const a = await assessmentRow(runId, assessmentId);
  if (a.status !== 'unanalyzable') throw new HttpError(409, 'not_unanalyzable', '분석 불가 조항만 다시 분석할 수 있습니다');
  const run = (await getRun(runId))!;
  const request = (await getRequest(run.request_id))!;
  const subject = { runId, assessmentId, userId: req.owner.userId, sessionId: req.owner.sessionId };
  await assertModelServerReady(subject);
  const clause = (await getClauses(run.request_id)).find((c) => c.clause_id === a.clause_id)!;
  const kv = (await knowledgeVersion(run.kv_id))!;
  try {
    const input = [{ clause_id: String(clause.clause_id), text: fromStoredDeid(clause.deid_text), article_no: clause.article_no, title: clause.title }];
    const [lo, il] = await Promise.all([modelApi.detect('loophole', input, clause.contract_type!), modelApi.detect('illegal', input, clause.contract_type!)]);
    const l = lo.results[0];
    const i = il.results[0];
    const isRisk = (l?.score ?? 0) >= policy('DETECT_THRESHOLD_M1') || (i?.score ?? 0) >= policy('DETECT_THRESHOLD_M2');
    if (!isRisk) {
      await exec(
        getPool(),
        "UPDATE clause_assessment SET status = 'normal', unanalyzable_reason = NULL, screen_result = 'normal_candidate', score_loophole = ?, score_illegal = ?, m1_model_version = ?, m2_model_version = ?, rejudged_at = CURRENT_TIMESTAMP WHERE assessment_id = ? AND status = 'unanalyzable'",
        [l?.score ?? null, i?.score ?? null, lo.model_version.slice(0, 40), il.model_version.slice(0, 40), assessmentId],
      );
    } else {
      const j = await judgeClause({
        clause,
        perspective: request.perspective,
        kvId: run.kv_id,
        knowledgeDate: kv.knowledge_date,
        m3Version: await m3VersionFor(-runId),
        scores: { loophole: l?.score ?? null, illegal: i?.score ?? null },
        hints: { riskType: normalizeRiskTypeHint(l?.type), relatedLaws: i?.related_laws ?? [] },
        prio: Date.now(),
      });
      await exec(
        getPool(),
        "UPDATE clause_assessment SET status = 'judged', judgment_id = ?, unanalyzable_reason = NULL, screen_result = 'risk_candidate', score_loophole = ?, score_illegal = ?, m1_model_version = ?, m2_model_version = ?, rejudged_at = CURRENT_TIMESTAMP WHERE assessment_id = ? AND status = 'unanalyzable'",
        [j.judgmentId, l?.score ?? null, i?.score ?? null, lo.model_version.slice(0, 40), il.model_version.slice(0, 40), assessmentId],
      );
    }
  } catch (e) {
    if (e instanceof ModelApiError) {
      // 분석 불가 유지 — G5(한도 미차감)
      await raise('G5', 'rejudge_failed', subject, { params: { state: '응답하지 않음' } });
    }
    throw e;
  }
  return clauseDetail(runId, assessmentId);
}
