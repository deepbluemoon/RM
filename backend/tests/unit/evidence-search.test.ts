// T060 — 명시 참조가 첫 후보, 기준일이 다르면 결과가 다름, 같은 입력이면 같은 순위(FR-017·022·023)
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDb, teardown, sql } from '../integration/setup.js';
import { searchEvidence, explicitRefs, clearSearchIndex, tokenize } from '../../src/modules/evidence/search.js';
import { asKvId } from '../../src/domain/types.js';
import { getPool, selectOne } from '../../src/db/pool.js';

let kv1: number;
beforeAll(async () => {
  await resetDb();
  clearSearchIndex();
  kv1 = (await selectOne<{ kv_id: number }>(getPool(), "SELECT kv_id FROM knowledge_version WHERE status = 'active'"))!.kv_id;
});
afterAll(teardown);

describe('근거 검색', () => {
  it('한글 2-gram 토큰화', () => {
    expect(tokenize('위약금 3배')).toEqual(['위약', '약금', '배', '3']);
  });

  it('명시 참조 해석', () => {
    expect(explicitRefs('이 조항은 약관법 제6조 제2항과 전자상거래법 시행령 제21조의2에 따른다')).toEqual([
      { law: '약관의 규제에 관한 법률', article: '제6조 제2항' },
      { law: '전자상거래 등에서의 소비자보호에 관한 법률 시행령', article: '제21조의2' },
    ]);
  });

  it('명시 참조가 첫 후보가 된다', async () => {
    const hits = await searchEvidence(asKvId(kv1), '회사는 약관법 제14조에도 불구하고 관할 법원을 회사 소재지로 한다');
    expect(hits[0]!.explicit).toBe(true);
    expect(hits[0]!.row.source_name).toBe('약관의 규제에 관한 법률');
    expect(hits[0]!.row.identifier).toBe('제14조');
  });

  it('상위 5개, 출처 유형별 최대 3개', async () => {
    const hits = await searchEvidence(asKvId(kv1), '중도 해지 시 잔여 기간 이용료 전액을 위약금으로 청구하며 환불하지 않는다', { riskType: 'excessive_penalty' });
    expect(hits.length).toBeLessThanOrEqual(5);
    const per = new Map<string, number>();
    for (const h of hits) per.set(h.row.source_type, (per.get(h.row.source_type) ?? 0) + 1);
    for (const n of per.values()) expect(n).toBeLessThanOrEqual(3);
    expect(hits.some((h) => h.row.identifier === '제8조' || h.row.identifier === '제9조')).toBe(true);
  });

  it('같은 입력이면 같은 순위(결정적)', async () => {
    const q = '회사는 사전 통지 없이 서비스 내용과 요금을 변경할 수 있다';
    const a = await searchEvidence(asKvId(kv1), q);
    clearSearchIndex();
    const b = await searchEvidence(asKvId(kv1), q);
    expect(a.map((h) => h.row.evidence_version_id)).toEqual(b.map((h) => h.row.evidence_version_id));
  });

  it('기준일이 다르면 결과가 달라진다(폐지 조문 제외 — FR-022)', async () => {
    // 새 기준일 2 를 만들고 약관법 제10조를 기준일 2 에서 폐지(구간 닫기)
    await sql("UPDATE knowledge_version SET status = 'superseded' WHERE kv_id = ?", [kv1]);
    const r = await sql("INSERT INTO knowledge_version (kv_seq, knowledge_date, analysis_basis_version, status) VALUES (2, '2026-09-27', 'v1.1', 'active')");
    const kv2 = r.insertId;
    await sql(
      "UPDATE evidence_version ev JOIN evidence_item ei ON ei.evidence_item_id = ev.evidence_item_id SET ev.to_kv_id = ? WHERE ei.source_name = '약관의 규제에 관한 법률' AND ei.identifier = '제10조'",
      [kv2],
    );
    const q = '회사는 사전 통지 없이 급부 내용을 일방적으로 변경할 수 있다';
    const before = await searchEvidence(asKvId(kv1), q);
    const after = await searchEvidence(asKvId(kv2), q);
    expect(before.some((h) => h.row.identifier === '제10조')).toBe(true);
    expect(after.some((h) => h.row.identifier === '제10조' && h.row.source_name === '약관의 규제에 관한 법률')).toBe(false);
  });
});
