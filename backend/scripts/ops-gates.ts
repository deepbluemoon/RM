// npm run ops:gates — 미해제 게이트(v_gate_open) 요약
import { getPool, select, closePool } from '../src/db/pool.js';

async function main() {
  const rows = await select<{ gate_code: string; title_text: string; n: number; oldest: Date }>(
    getPool(),
    'SELECT gate_code, title_text, COUNT(*) AS n, MIN(occurred_at) AS oldest FROM v_gate_open GROUP BY gate_code, title_text ORDER BY gate_code',
  );
  if (!rows.length) process.stdout.write('미해제 게이트 없음\n');
  for (const r of rows) process.stdout.write(`${r.gate_code}\t${r.n}건\t${r.title_text}\t(가장 오래된 발생 ${new Date(r.oldest).toISOString()})\n`);
}
main().finally(() => closePool());
