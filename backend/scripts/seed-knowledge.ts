// npm run seed:knowledge -- --fixture tests/fixtures/knowledge/initial.json  (T033)
import fs from 'node:fs';
import path from 'node:path';
import { BACKEND_ROOT } from '../src/config/env.js';
import { seedKnowledge, type KnowledgeFixture } from '../src/modules/evidence/seed.js';
import { closePool } from '../src/db/pool.js';

const i = process.argv.indexOf('--fixture');
const file = path.resolve(BACKEND_ROOT, i > 0 ? process.argv[i + 1]! : 'tests/fixtures/knowledge/initial.json');
const fx = JSON.parse(fs.readFileSync(file, 'utf8')) as KnowledgeFixture;
seedKnowledge(fx)
  .then((r) => process.stdout.write(r.created ? `지식 기준일 ${r.kvId} 생성, 근거 ${r.items}건\n` : `이미 기준일이 있습니다(kv_id=${r.kvId}) — 변경 없음\n`))
  .catch((e: Error) => {
    process.stderr.write(`seed 실패: ${e.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
