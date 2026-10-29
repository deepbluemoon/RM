// 4.8 쉬운 설명(T090): 저장된 주장 조회 → 2차 단정 필터(T074) → 근거 집합 밖 주장 제외 →
// 비면 같은 캐시 키로 /v1/judge 1회 재생성해 설명 필드만 채택(분류·위험도·유형이 다르면 폐기 — A6) → 여전히 비면 G9(부분 차단).
// 관점별 초점: 소비자 = 소비자 불리 사항, 사업자 = 분쟁·시정 위험과 검토 포인트(4.8 A4)
import { getPool, select, selectOne } from '../../db/pool.js';
import { fromStoredDeid } from '../../domain/types.js';
import { logger } from '../../logger.js';
import { openGate } from '../gates/GateError.js';
import { recordGate } from '../gates/gates.service.js';
import { modelApi, ModelApiError } from '../modelApi/client.js';
import { AdapterError, normalizeJudge } from '../modelApi/adapter.js';
import { judgeGate } from '../../jobs/runner.js';
import { evidenceOfJudgment } from '../evidence/evidence.repo.js';
import { replaceClaims } from '../detection/judgment.repo.js';
import { getRequest, getRun } from '../analysis/analysis.repo.js';
import { containsAssertion, filterClaims } from './explanation.filter.js';
import { assessmentRow } from './results.service.js';

interface JudgmentRow {
  judgment_id: number;
  m3_category: string;
  risk_type: string | null;
  risk_level: string | null;
  confidence: string | null;
  explanation_regen_count: number;
  contract_type: string;
  perspective: 'consumer' | 'business';
  kv_id: number;
}

export async function explanation(runId: number, assessmentId: number) {
  const a = await assessmentRow(runId, assessmentId);
  const run = (await getRun(runId))!;
  const req = (await getRequest(run.request_id))!;
  const perspective = req.perspective;
  const focus = perspective === 'business' ? 'business_review_points' : 'consumer_disadvantage';
  const base = { perspective, focus };
  if (!a.judgment_id || a.display_category === 'normal' || a.display_category === 'unanalyzable') return { ...base, available: false, claims: [] };

  const j = (await selectOne<JudgmentRow>(getPool(), 'SELECT * FROM judgment WHERE judgment_id = ?', [a.judgment_id]))!;
  const evidence = await evidenceOfJudgment(j.judgment_id);
  const allowed = evidence.map((e) => e.evidence_version_id);
  const openG9 = await selectOne<{ event_id: number }>(getPool(), "SELECT event_id FROM v_gate_open WHERE gate_code = 'G9' AND judgment_id = ?", [j.judgment_id]);
  if (openG9) return { ...base, available: false, claims: [], gate: openGate('G9', {}, openG9.event_id) };

  const stored = await select<{ seq: number; claim_text: string; evidence_version_id: number }>(getPool(), 'SELECT seq, claim_text, evidence_version_id FROM explanation_claim WHERE judgment_id = ? ORDER BY seq', [j.judgment_id]);
  let kept = stored.filter((c) => !containsAssertion(c.claim_text) && allowed.includes(c.evidence_version_id));

  if (!kept.length && j.explanation_regen_count === 0 && evidence.length) {
    try {
      const clause = await selectOne<{ deid_text: string }>(getPool(), 'SELECT deid_text FROM clause WHERE clause_id = ?', [a.clause_id]);
      const kv = await selectOne<{ knowledge_date: string }>(getPool(), "SELECT DATE_FORMAT(knowledge_date, '%Y-%m-%d') AS knowledge_date FROM knowledge_version WHERE kv_id = ?", [j.kv_id]);
      const scores = await selectOne<{ score_loophole: number | null; score_illegal: number | null }>(getPool(), 'SELECT score_loophole, score_illegal FROM clause_assessment WHERE assessment_id = ?', [assessmentId]);
      const raw = await judgeGate.run(Date.now(), () =>
        modelApi.judge({
          clause: fromStoredDeid(clause!.deid_text),
          contract_type: j.contract_type,
          perspective: j.perspective,
          knowledge_date: kv!.knowledge_date,
          scores: { ...(scores?.score_loophole != null ? { loophole: Number(scores.score_loophole) } : {}), ...(scores?.score_illegal != null ? { illegal: Number(scores.score_illegal) } : {}) },
          evidence: evidence.map((e) => ({ id: String(e.evidence_version_id), source_type: e.source_type, title: `${e.source_name} ${e.identifier}`, text: e.excerpt })),
        }),
      );
      const regen = normalizeJudge(raw);
      // A6 — 분류·위험도·유형이 저장된 판정과 다르면 재생성 결과를 폐기한다(판정은 불변)
      const same = regen.category === j.m3_category && (regen.riskLevel ?? null) === j.risk_level && (regen.riskType ?? null) === j.risk_type;
      const f = same ? filterClaims(regen.claims, allowed) : { kept: [] };
      await replaceClaims(j.judgment_id, f.kept);
      kept = (await select<{ seq: number; claim_text: string; evidence_version_id: number }>(getPool(), 'SELECT seq, claim_text, evidence_version_id FROM explanation_claim WHERE judgment_id = ? ORDER BY seq', [j.judgment_id])).filter(
        (c) => !containsAssertion(c.claim_text),
      );
    } catch (e) {
      if (e instanceof ModelApiError) {
        // 서버 문제로 재생성하지 못함 — G9 를 남기지 않고(나중에 다시 시도) 이번 응답만 막는다
        return { ...base, available: false, claims: [], gate: openGate('G5', { state: '응답하지 않음' }) };
      }
      if (!(e instanceof AdapterError)) throw e;
      logger.warn({ judgmentId: j.judgment_id }, 'explanation regen label error');
    }
  }
  if (!kept.length) {
    const eventId = await recordGate('G9', 'explanation_filtered', { judgmentId: j.judgment_id });
    return { ...base, available: false, claims: [], gate: openGate('G9', {}, eventId) };
  }
  return { ...base, available: true, claims: kept.map((c, i) => ({ seq: i + 1, text: c.claim_text, evidenceVersionId: c.evidence_version_id })) };
}
