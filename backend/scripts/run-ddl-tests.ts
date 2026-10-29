// design/crd_ddl_test.sql 실행기(T016, research R-14).
// 빈 스키마(DDL_TEST_DB_NAME, 기본 crd_ddltest)에 001(= design/crd_ddl.sql)을 적용한 뒤
// "-- @setup / @accept / @reject <규칙> / @expect <값>" 표지 단위로 한 문장씩 실행한다. 실패 건수만큼 exit code.
import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { config as loadDotenv } from 'dotenv';
import { splitSql } from '../src/db/sqlSplit.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
loadDotenv({ path: path.join(root, '.env') });
const e = process.env;
const conf = {
  host: e.TEST_DB_HOST ?? '127.0.0.1',
  port: Number(e.TEST_DB_PORT ?? 3306),
  user: e.TEST_DB_USER ?? 'root',
  password: e.TEST_DB_PASSWORD ?? '',
};
const dbName = e.DDL_TEST_DB_NAME ?? 'crd_ddltest';

async function main(): Promise<number> {
  const admin = await mysql.createConnection(conf);
  await admin.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
  await admin.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await admin.end();
  const conn = await mysql.createConnection({ ...conf, database: dbName, charset: 'utf8mb4', timezone: '+09:00' });
  const ddl = fs.readFileSync(path.join(root, '..', 'design', 'crd_ddl.sql'), 'utf8');
  for (const st of splitSql(ddl)) await conn.query(st.sql);
  // 멱등 검증 — 두 번째 적용도 무오류여야 한다
  for (const st of splitSql(ddl)) await conn.query(st.sql);

  const tests = splitSql(fs.readFileSync(path.join(root, '..', 'design', 'crd_ddl_test.sql'), 'utf8'));
  let pass = 0;
  const failures: string[] = [];
  for (const t of tests) {
    const marker = [...t.leadingComments].reverse().find((c) => c.startsWith('@'));
    if (!marker) continue;
    const [kind, ...rest] = marker.slice(1).split(/\s+/);
    const label = rest.join(' ');
    let ok = false;
    let note = '';
    try {
      const [rows] = await conn.query(t.sql);
      if (kind === 'reject') {
        note = '거부되어야 하는데 성공';
      } else if (kind === 'expect') {
        const first = Array.isArray(rows) && rows.length ? Object.values(rows[0] as object)[0] : null;
        const got = first === null || first === undefined ? 'NULL' : String(first);
        ok = got === label || Number(got) === Number(label);
        if (!ok) note = `기대 ${label}, 실제 ${got}`;
      } else {
        ok = true;
      }
    } catch (err) {
      if (kind === 'reject') ok = true;
      else note = (err as Error).message;
    }
    if (ok) pass++;
    else failures.push(`line ${t.line} @${kind} ${label} — ${note}`);
  }
  await conn.end();
  process.stdout.write(`DDL 규칙 테스트: ${pass} 통과, ${failures.length} 실패 (총 ${pass + failures.length})\n`);
  for (const f of failures) process.stdout.write(`  ✗ ${f}\n`);
  return failures.length;
}

main()
  .then((n) => process.exit(Math.min(n, 125)))
  .catch((err: Error) => {
    process.stderr.write(`실행 오류: ${err.message}\n`);
    process.exit(126);
  });
