// 근거 임베딩 채우기 — npm run knowledge:embed [-- --kv <kv_id>] [--limit N]
// 기본은 활성 기준일. 빠진 것만 채우므로 중단 뒤 다시 돌려도 된다. 공유 Ollama 가 한가한 시간에 돌린다(가이드 1.7-7).
import { closePool, selectOne } from '../src/db/pool.js';
import { asKvId } from '../src/domain/types.js';
import { embedEvidence } from '../src/modules/evidence/embedding.js';

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };

async function main() {
  const kv = arg('--kv') ? Number(arg('--kv')) : (await selectOne<{ kv_id: number }>((await import('../src/db/pool.js')).getPool(),
    "SELECT kv_id FROM knowledge_version WHERE status = 'active'"))?.kv_id;
  if (!kv) throw new Error('활성 지식 기준일이 없습니다');
  const limit = arg('--limit') ? Number(arg('--limit')) : undefined;
  const r = await embedEvidence(asKvId(kv), { ...(limit ? { limit } : {}), log: (s) => process.stdout.write(`\r임베딩 ${s}   `) });
  process.stdout.write(`\n기준일 ${kv}: 모델 ${r.model}, 이번에 ${r.embedded}건, 남은 것 ${r.remaining}건\n`);
}
main()
  .catch((e: Error) => { process.stderr.write(`임베딩 실패: ${e.message}\n`); process.exitCode = 1; })
  .finally(() => closePool());
