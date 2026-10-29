// 수집·전처리 결과 임시 보관(0.2 → 0.4). DDL 의 ingest_item 은 항목명·날짜·판정만 갖고 본문(발췌·사례 3구분)은 없다 —
// 승인 때 evidence_version 에 넣을 본문을 배치별 JSON 파일로 둔다(DB 밖, 공개 법령·사례 텍스트만. 이용자 데이터 아님).
// 경로 = KNOWLEDGE_STAGING_DIR/<DB_NAME>/batch-<id>.json (테스트 DB 를 여럿 병렬로 써도 부딪히지 않게 DB 이름으로 나눈다)
import fs from 'node:fs/promises';
import path from 'node:path';
import { BACKEND_ROOT, env } from '../../config/env.js';
import type { PreparedUnit, PreprocessStats } from './preprocess.js';

export interface StagedBatch {
  batchId: number;
  stats: PreprocessStats | null;
  /** ingest_item.item_id → 반영 단위 */
  units: Record<string, PreparedUnit>;
}

const dir = () => path.resolve(BACKEND_ROOT, env.KNOWLEDGE_STAGING_DIR, env.DB_NAME.replace(/[^\w-]/g, '_'));
const file = (batchId: number) => path.join(dir(), `batch-${batchId}.json`);

export async function writeStaged(s: StagedBatch): Promise<void> {
  await fs.mkdir(dir(), { recursive: true });
  const tmp = `${file(s.batchId)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(s), 'utf8');
  await fs.rename(tmp, file(s.batchId));
}

export async function readStaged(batchId: number): Promise<StagedBatch | null> {
  try {
    return JSON.parse(await fs.readFile(file(batchId), 'utf8')) as StagedBatch;
  } catch {
    return null;
  }
}
