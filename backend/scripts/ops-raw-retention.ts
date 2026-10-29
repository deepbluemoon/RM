// npm run ops:raw-retention — 원본 보관 기한 초과(v_raw_retention_overdue) 점검. 0건이어야 한다(SC-014). --purge 면 즉시 삭제 실행
import { getPool, select, closePool } from '../src/db/pool.js';
import { loadPolicy } from '../src/config/policy.js';
import { runRetention } from '../src/jobs/retention.js';

async function main() {
  await loadPolicy();
  if (process.argv.includes('--purge')) process.stdout.write(`${JSON.stringify(await runRetention())}\n`);
  const rows = await select<{ document_id: number; raw_delete_due_at: Date }>(getPool(), 'SELECT document_id, raw_delete_due_at FROM v_raw_retention_overdue');
  process.stdout.write(`원본 보관 기한 초과: ${rows.length}건\n`);
  for (const r of rows) process.stdout.write(`  document ${r.document_id} due ${new Date(r.raw_delete_due_at).toISOString()}\n`);
  if (rows.length) process.exitCode = 1;
}
main().finally(() => closePool());
