// mysql2 Promise 풀 (T018). SQL 은 저장소 모듈에서 이름 있는 쿼리로 쓴다(research R-03).
import mysql, { type Pool, type PoolConnection, type RowDataPacket, type ResultSetHeader } from 'mysql2/promise';
import { env } from '../config/env.js';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = mysql.createPool({
      host: env.DB_HOST,
      port: env.DB_PORT,
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      database: env.DB_NAME,
      connectionLimit: 10,
      charset: 'utf8mb4',
      timezone: '+09:00',
      dateStrings: ['DATE'],
      decimalNumbers: true,
      supportBigNumbers: true,
      bigNumberStrings: false,
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

export type Db = Pool | PoolConnection;
export type Row = RowDataPacket;

export async function select<T = Row>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  const [rows] = await db.query<RowDataPacket[]>(sql, params);
  return rows as unknown as T[];
}

export async function selectOne<T = Row>(db: Db, sql: string, params: unknown[] = []): Promise<T | null> {
  const rows = await select<T>(db, sql, params);
  return rows[0] ?? null;
}

export async function exec(db: Db, sql: string, params: unknown[] = []): Promise<ResultSetHeader> {
  const [res] = await db.query<ResultSetHeader>(sql, params);
  return res;
}
