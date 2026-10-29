// 문서·결과 영구 삭제(T110, FR-008, A16) — 한 트랜잭션에서
//  (1) 이 요청의 실행·조항 판정에 연결된 feedback 의 user_id·session_id·judgment_id·assessment_id 를 NULL 로(익명화, 유형·분류·기준일·의견은 보존)
//  (2) 원본 파일 즉시 삭제  (3) analysis_request 이하 삭제(usage_charge.run_id 는 DDL 이 SET NULL, cancel_charge.request_id 도 SET NULL)
// 비로그인 TTL 만료 삭제(retention)도 이 서비스를 쓴다
//
// DDL chk_fb_owner(user_id 또는 session_id 필수)는 익명화와 충돌해 migration 004 가 "소유자 없음 = 대상 연결도 없음"일 때만
// 허용하도록 좁혔다(crd_ddl.sql 은 그대로). 제약 검사를 끄지 않는다.
import type { PoolConnection, ResultSetHeader } from 'mysql2/promise';
import { getPool, select } from '../../db/pool.js';
import { withTx } from '../../db/tx.js';
import { deleteRaw } from '../intake/rawStore.js';

async function anonymizeFeedback(conn: PoolConnection, requestId: number): Promise<number> {
  // 소유자 없는 행은 대상 연결도 없어야 한다(migration 004 chk_fb_owner) — 네 열을 한 문장에서 함께 비운다
  const [r] = await conn.query<ResultSetHeader>(
    `UPDATE feedback f
        JOIN clause_assessment a ON a.assessment_id = f.assessment_id
        JOIN analysis_run r ON r.run_id = a.run_id
        SET f.user_id = NULL, f.session_id = NULL, f.judgment_id = NULL, f.assessment_id = NULL
      WHERE r.request_id = ?`,
    [requestId],
  );
  return r.affectedRows;
}

export async function deleteRequest(requestId: number): Promise<boolean> {
  const refs = await select<{ raw_file_ref: string | null }>(getPool(), 'SELECT raw_file_ref FROM document WHERE request_id = ?', [requestId]);
  const deleted = await withTx(async (conn) => {
    await conn.query('SELECT request_id FROM analysis_request WHERE request_id = ? FOR UPDATE', [requestId]);
    await anonymizeFeedback(conn, requestId);
    // G13 등 피드백 게이트 이벤트는 피드백과 함께 남는다. 요청·실행 게이트는 CASCADE 로 지워진다
    const [res] = await conn.query<ResultSetHeader>('DELETE FROM analysis_request WHERE request_id = ?', [requestId]);
    return res.affectedRows > 0;
  });
  for (const r of refs) if (r.raw_file_ref) deleteRaw(r.raw_file_ref);
  return deleted;
}
