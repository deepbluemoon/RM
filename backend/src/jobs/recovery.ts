// 재기동 복구(T032, research R-06): 미완료 요청·실행을 stopped/aborted 로 닫는다. 재개하지 않는다.
// 시스템 실패이므로 한도를 차감하지 않는다(FR-035(d)) — 차감 원장에 아무것도 넣지 않는다.
import { exec, getPool, select } from '../db/pool.js';
import { recordGate } from '../modules/gates/gates.service.js';
import { logger } from '../logger.js';

export async function recoverInterrupted(): Promise<{ requests: number; runs: number }> {
  const db = getPool();
  const runs = await select<{ run_id: number; request_id: number }>(db, "SELECT run_id, request_id FROM analysis_run WHERE stage IN ('detecting','searching','explaining')");
  for (const r of runs) {
    await exec(db, "UPDATE analysis_run SET stage = 'aborted' WHERE run_id = ?", [r.run_id]);
    await exec(db, "UPDATE clause_assessment SET status = 'unanalyzable', unanalyzable_reason = 'server_down', judgment_id = NULL WHERE run_id = ? AND status = 'pending'", [r.run_id]).catch(() => undefined);
    await recordGate('G5', 'server_restart', { runId: r.run_id }).catch(() => undefined);
  }
  const reqs = await select<{ request_id: number }>(db, "SELECT request_id FROM analysis_request WHERE stage IN ('received','deidentifying','structuring')");
  for (const q of reqs) {
    await exec(db, "UPDATE analysis_request SET stage = 'stopped' WHERE request_id = ?", [q.request_id]);
    await recordGate('G5', 'server_restart', { requestId: q.request_id }).catch(() => undefined);
  }
  if (runs.length || reqs.length) logger.warn({ requests: reqs.length, runs: runs.length }, '재기동 복구 — 미완료 분석을 중단 처리(한도 미차감)');
  return { requests: reqs.length, runs: runs.length };
}
