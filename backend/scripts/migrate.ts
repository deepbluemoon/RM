// 마이그레이션 실행기(T015). schema_migrations 로 001→002→003→004… 을 번호 순으로 멱등 적용한다.
//   npm run db:migrate            → .env 의 DB_* (팀 DB 또는 로컬 dev DB)
//   npm run db:test:reset         → TEST_DB_NAME 을 DROP·CREATE 후 같은 순서로 적용
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import { config as loadDotenv } from 'dotenv';
import { splitSql } from '../src/db/sqlSplit.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
loadDotenv({ path: path.join(root, '.env') });
const MIGRATIONS_DIR = path.join(root, 'db', 'migrations');

interface Target { host: string; port: number; user: string; password: string; database: string }

function target(test: boolean): Target {
  const e = process.env;
  const pick = (k: string) => (test ? e[`TEST_${k}`] : e[k]) ?? '';
  const t = { host: pick('DB_HOST'), port: Number(pick('DB_PORT') || 3306), user: pick('DB_USER'), password: pick('DB_PASSWORD'), database: pick('DB_NAME') };
  if (!t.host || !t.user || !t.database) throw new Error(`${test ? 'TEST_' : ''}DB_* 설정이 없습니다 (backend/.env)`);
  return t;
}

export async function applyMigrations(t: Target, opts: { reset?: boolean; log?: (s: string) => void } = {}): Promise<string[]> {
  const log = opts.log ?? ((s: string) => process.stdout.write(s + '\n'));
  if (opts.reset) {
    const admin = await mysql.createConnection({ host: t.host, port: t.port, user: t.user, password: t.password });
    await admin.query(`DROP DATABASE IF EXISTS \`${t.database}\``);
    await admin.query(`CREATE DATABASE \`${t.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await admin.end();
    log(`reset ${t.database}`);
  }
  const conn = await mysql.createConnection({ ...t, multipleStatements: false, charset: 'utf8mb4', timezone: '+09:00' });
  const applied: string[] = [];
  try {
    await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name VARCHAR(100) NOT NULL PRIMARY KEY, sha256 CHAR(64) NOT NULL, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
    for (const f of files) {
      const text = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
      const sha = crypto.createHash('sha256').update(text).digest('hex');
      const [rows] = await conn.query<mysql.RowDataPacket[]>('SELECT sha256 FROM schema_migrations WHERE name = ?', [f]);
      if (rows.length && rows[0]!.sha256 === sha) continue;
      // 파일 자체가 멱등(IF NOT EXISTS·OR REPLACE)이므로 내용이 바뀌었으면 다시 적용한다
      for (const st of splitSql(text)) await conn.query(st.sql);
      await conn.query('REPLACE INTO schema_migrations (name, sha256) VALUES (?, ?)', [f, sha]);
      applied.push(f);
      log(`applied ${f}`);
    }
  } finally {
    await conn.end();
  }
  return applied;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const reset = process.argv.includes('--reset-test');
  applyMigrations(target(reset), { reset })
    .then((a) => {
      process.stdout.write(a.length ? `done (${a.length} applied)\n` : 'up to date\n');
    })
    .catch((e: Error) => {
      process.stderr.write(`migration failed: ${e.message}\n`);
      process.exit(1);
    });
}
