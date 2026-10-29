// 보관 기한 작업(T081, FR-007·FR-032, SC-014) — node-cron 10분:
//  원본 보관 기한 초과(v_raw_retention_overdue) 삭제 → raw_file_ref=NULL, raw_deleted_at 기록
//  분석 요청이 없는 업로드 1시간 뒤 삭제
//  비로그인 세션 만료(마지막 접근 + 24시간) → 그 세션의 요청·결과 삭제(피드백은 익명화 — T110), 세션 행 삭제
import { exec, getPool, select } from '../db/pool.js';
import { logger } from '../logger.js';
import { deleteRaw, purgeStaleUploads } from '../modules/intake/rawStore.js';
import { deleteRequest } from '../modules/history/delete.service.js';

export async function purgeOverdueRaw(): Promise<number> {
  const rows = await select<{ document_id: number }>(getPool(), 'SELECT document_id FROM v_raw_retention_overdue');
  let n = 0;
  for (const r of rows) {
    const [d] = await select<{ raw_file_ref: string | null }>(getPool(), 'SELECT raw_file_ref FROM document WHERE document_id = ?', [r.document_id]);
    if (d?.raw_file_ref) deleteRaw(d.raw_file_ref);
    await exec(getPool(), 'UPDATE document SET raw_file_ref = NULL, raw_deleted_at = CURRENT_TIMESTAMP WHERE document_id = ?', [r.document_id]);
    n++;
  }
  return n;
}

export async function purgeExpiredAnon(): Promise<{ requests: number; sessions: number }> {
  const sessions = await select<{ session_id: string }>(getPool(), 'SELECT session_id FROM anon_session WHERE expires_at IS NOT NULL AND expires_at < CURRENT_TIMESTAMP');
  let requests = 0;
  let removed = 0;
  for (const s of sessions) {
    const reqs = await select<{ request_id: number }>(getPool(), 'SELECT request_id FROM analysis_request WHERE session_id = ?', [s.session_id]);
    for (const r of reqs) if (await deleteRequest(r.request_id)) requests++;
    // 차감 원장·피드백·게이트가 세션을 참조하면 행은 남긴다(한도 산정·익명 피드백 보존) — 참조가 없을 때만 지운다
    try {
      // 남은 피드백도 익명화 규칙(A16, migration 004)대로 — 소유자와 대상 연결을 함께 끊는다
      await exec(getPool(), 'UPDATE feedback SET session_id = NULL, judgment_id = NULL, assessment_id = NULL WHERE session_id = ? AND user_id IS NULL', [s.session_id]);
      const r = await exec(
        getPool(),
        `DELETE FROM anon_session WHERE session_id = ?
           AND NOT EXISTS (SELECT 1 FROM usage_charge WHERE session_id = ?)
           AND NOT EXISTS (SELECT 1 FROM cancel_charge WHERE session_id = ?)
           AND NOT EXISTS (SELECT 1 FROM gate_event WHERE session_id = ?)`,
        [s.session_id, s.session_id, s.session_id, s.session_id],
      );
      removed += r.affectedRows;
    } catch {
      /* 참조 남음 — 다음 주기 */
    }
  }
  return { requests, sessions: removed };
}

export async function runRetention(): Promise<{ raw: number; uploads: number; anonRequests: number }> {
  const raw = await purgeOverdueRaw();
  const uploads = purgeStaleUploads();
  const anon = await purgeExpiredAnon();
  if (raw || uploads || anon.requests) logger.info({ raw, uploads, anonRequests: anon.requests }, 'retention');
  return { raw, uploads, anonRequests: anon.requests };
}
