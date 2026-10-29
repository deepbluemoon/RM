// IG-7: backend/db/migrations/001_crd_ddl.sql 이 design/crd_ddl.sql 과 바이트 단위로 같은지 확인(T012)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const sha = (p: string) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const a = sha(path.join(root, '..', 'design', 'crd_ddl.sql'));
const b = sha(path.join(root, 'db', 'migrations', '001_crd_ddl.sql'));
if (a !== b) {
  process.stderr.write(`DDL 사본 불일치: design=${a} migration=${b}\n`);
  process.exit(1);
}
process.stdout.write(`DDL 사본 일치 ${a}\n`);
