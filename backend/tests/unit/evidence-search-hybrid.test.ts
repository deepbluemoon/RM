// 하이브리드 RAG(2026-09-29) — 근거 벡터가 있으면 BM25 + 코사인 RRF, 조항 임베딩이 실패하면 BM25 만, 평가용 제외 옵션
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resetDb, teardown } from '../integration/setup.js';
import { searchEvidence, clearSearchIndex } from '../../src/modules/evidence/search.js';
import { modelApi } from '../../src/modules/modelApi/client.js';
import { vecText } from '../../src/modules/evidence/embedding.js';
import { asKvId } from '../../src/domain/types.js';
import { exec, getPool, select, selectOne } from '../../src/db/pool.js';

const MODEL = 'bge-m3@test000000000';
const DIM = 1024;
/** 근거마다 다른 결정적 단위 벡터 — i 번째 축이 1 */
const unit = (i: number) => { const v = new Array<number>(DIM).fill(0); v[i % DIM] = 1; return v; };

let kv: number;
let target: { evidence_version_id: number; source_name: string; identifier: string };
beforeAll(async () => {
  await resetDb();
  clearSearchIndex();
  kv = (await selectOne<{ kv_id: number }>(getPool(), "SELECT kv_id FROM knowledge_version WHERE status = 'active'"))!.kv_id;
  const rows = await select<{ evidence_version_id: number; source_name: string; identifier: string }>(getPool(),
    'SELECT evidence_version_id, source_name, identifier FROM v_evidence_in_force WHERE kv_id = ? ORDER BY evidence_version_id', [kv]);
  for (const [i, r] of rows.entries()) {
    await exec(getPool(), 'INSERT INTO evidence_embedding (evidence_version_id, model, embedding) VALUES (?,?,VEC_FromText(?))', [r.evidence_version_id, MODEL, vecText(unit(i))]);
  }
  target = rows[7]!;   // 이 근거의 벡터와 같은 조항 벡터를 돌려주게 한다
  vi.spyOn(modelApi, 'embed').mockImplementation(async () => ({ model_version: MODEL, dim: DIM, embeddings: [unit(7)] }));
});
afterAll(async () => {
  vi.restoreAllMocks();
  await teardown();
});

describe('하이브리드 근거 검색', () => {
  it('코사인 1위 근거가 BM25 에 안 걸려도 후보에 든다(RRF)', async () => {
    const hits = await searchEvidence(asKvId(kv), '전혀 관계없는 낱말들 가나다라', { tuning: { minLaw: 0, caseExpand: false } });
    expect(hits.some((h) => h.row.evidence_version_id === target.evidence_version_id)).toBe(true);
    const h = hits.find((x) => x.row.evidence_version_id === target.evidence_version_id)!;
    expect(h.dense).toBe(1);
    expect(h.rrf).toBeGreaterThan(0);
  });

  it('같은 입력이면 같은 순위(결정적)', async () => {
    const a = (await searchEvidence(asKvId(kv), '중도 해지 시 위약금으로 청구한다')).map((h) => h.row.evidence_version_id);
    const b = (await searchEvidence(asKvId(kv), '중도 해지 시 위약금으로 청구한다')).map((h) => h.row.evidence_version_id);
    expect(a).toEqual(b);
  });

  it('조항 임베딩이 실패하면 BM25 만으로 동작한다', async () => {
    vi.mocked(modelApi.embed).mockRejectedValueOnce(new Error('down'));
    const hits = await searchEvidence(asKvId(kv), '중도 해지 시 잔여 이용료를 위약금으로 청구하며 환불하지 않는다 다른문장');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.dense === undefined && h.score > 0)).toBe(true);
  });

  it('평가용 제외 옵션', async () => {
    const hits = await searchEvidence(asKvId(kv), '전혀 관계없는 낱말들 가나다라', { exclude: (r) => r.evidence_version_id === target.evidence_version_id });
    expect(hits.some((h) => h.row.evidence_version_id === target.evidence_version_id)).toBe(false);
  });

  it('법령 최소 개수(기본 2) — 법령 후보가 있으면 상위 결과에 법령이 2개 이상', async () => {
    const hits = await searchEvidence(asKvId(kv), '중도 해지 시 잔여 이용료를 위약금으로 청구하며 환불하지 않는다');
    expect(hits.filter((h) => h.row.source_type === 'law_article').length).toBeGreaterThanOrEqual(2);
    expect(hits.length).toBeLessThanOrEqual(5);
  });

  it('hybrid:false 면 BM25 만', async () => {
    const hits = await searchEvidence(asKvId(kv), '전혀 관계없는 낱말들 가나다라', { hybrid: false });
    expect(hits.every((h) => h.dense === undefined)).toBe(true);
  });
});
