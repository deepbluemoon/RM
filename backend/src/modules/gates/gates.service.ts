// 게이트 발생·해제(T022). raise 는 gate_event 를 남기고 GateError 를 던진다. 사유 코드만 기록한다(BR-PRV-04 — 개인정보 금지)
import { exec, getPool, type Db } from '../../db/pool.js';
import { GateError, type GateOptions } from './GateError.js';
import type { GateCode } from './messages.js';

export interface GateSubject {
  userId?: number | null;
  sessionId?: string | null;
  requestId?: number | null;
  runId?: number | null;
  assessmentId?: number | null;
  judgmentId?: number | null;
  batchId?: number | null;
  ingestItemId?: number | null;
  evalRunId?: number | null;
  evalItemId?: number | null;
  contractType?: string | null;
  feedbackId?: number | null;
}

export async function recordGate(gate: GateCode, reasonCode: string, subject: GateSubject, reasonDetail: string | null = null, db: Db = getPool()): Promise<number> {
  const res = await exec(
    db,
    `INSERT INTO gate_event (gate_code, reason_code, reason_detail, user_id, session_id, request_id, run_id, assessment_id,
       judgment_id, batch_id, ingest_item_id, eval_run_id, eval_item_id, contract_type, feedback_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      gate, reasonCode.slice(0, 40), reasonDetail ? reasonDetail.slice(0, 300) : null,
      subject.userId ?? null, subject.sessionId ?? null, subject.requestId ?? null, subject.runId ?? null,
      subject.assessmentId ?? null, subject.judgmentId ?? null, subject.batchId ?? null, subject.ingestItemId ?? null,
      subject.evalRunId ?? null, subject.evalItemId ?? null, subject.contractType ?? null, subject.feedbackId ?? null,
    ],
  );
  return res.insertId;
}

/** 게이트 이벤트를 기록하고 GateError 를 던진다 */
export async function raise(gate: GateCode, reasonCode: string, subject: GateSubject, opts: GateOptions = {}, db?: Db): Promise<never> {
  let eventId: number | undefined;
  try {
    eventId = await recordGate(gate, reasonCode, subject, null, db);
  } catch {
    // 기록 실패가 차단 응답을 막지 않게 한다(예: 대상 행이 아직 없음)
  }
  throw new GateError(gate, { ...opts, ...(eventId !== undefined ? { eventId } : {}) });
}

export async function release(eventId: number, action: string, db: Db = getPool()): Promise<void> {
  await exec(db, 'UPDATE gate_event SET released_at = CURRENT_TIMESTAMP, release_action = ? WHERE event_id = ? AND released_at IS NULL', [action.slice(0, 40), eventId]);
}
