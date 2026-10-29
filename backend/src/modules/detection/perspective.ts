// 3.7 관점 불일치(G7, BR-ANL-03) — 사업자 관점 판정을 같은 조항의 소비자 관점 캐시 판정과 대조한다(US6 T124)
// 대조 기준은 DB 뷰 v_perspective_mismatch 한 곳(분류·위험도·근거 집합). 소비자 캐시 판정이 없으면 대조하지 않는다 —
// 대조만을 위해 M3 를 한 번 더 부르지 않는다(공유 모델 동시 1건, model-serving §0).
// 불일치면 실행은 completed 로 두되 gate_event(G7)를 남겨 저장(결과 보기)을 막는다. 해제는 운영자(P-4 기본값: 기록만).
import { getPool, select } from '../../db/pool.js';
import { recordGate } from '../gates/gates.service.js';

export async function afterBusinessJudgments(runId: number): Promise<number> {
  const rows = await select<{ request_id: number; assessment_id: number; business_judgment_id: number }>(
    getPool(),
    `SELECT DISTINCT r.request_id, a.assessment_id, m.business_judgment_id
       FROM clause_assessment a
       JOIN analysis_run r ON r.run_id = a.run_id
       JOIN v_perspective_mismatch m ON m.business_judgment_id = a.judgment_id
      WHERE a.run_id = ?
      ORDER BY a.assessment_id`,
    [runId],
  );
  if (!rows.length) return 0;
  const first = rows[0]!;
  await recordGate(
    'G7',
    'perspective_mismatch',
    { runId, requestId: first.request_id, assessmentId: first.assessment_id, judgmentId: first.business_judgment_id },
    `불일치 조항 ${rows.length}건`,
  );
  return rows.length;
}
