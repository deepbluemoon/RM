// 트랜잭션 도우미 (T018)
import type { PoolConnection } from 'mysql2/promise';
import { getPool } from './pool.js';

export async function withTx<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (e) {
    await conn.rollback().catch(() => undefined);
    throw e;
  } finally {
    conn.release();
  }
}
