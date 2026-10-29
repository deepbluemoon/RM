// T128 — P0 근거 데이터 갱신: 수집기 목(mock)으로 개정 1·폐지 1·신규 사례 1건을 넣고 승인한다.
// 단일 활성 기준일, evidence_version 구간 닫힘, 폐지 조문이 새 분석 근거에서 빠짐(FR-022), result_impact,
// 분석 도중 승인해도 진행 중 분석은 고정 기준일로 끝남(FR-039), G0(수집 실패)·G1(분리 실패 제외), 7일 경과 경고, 운영 화면은 역할 가드 없음(G14 없음)
import fs from 'node:fs';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture, newAgent, resetDb, startStub, teardown, waitFor, type StubHandle } from './setup.js';
import type { Role } from '../../src/domain/codes.js';
import { analyzeToSaved, startText, waitStage } from './flow.js';
import { expectResponse } from '../contract/harness.js';
import { getPool, select, selectOne } from '../../src/db/pool.js';
import { setCollectors, type Collector, type SourceDelta } from '../../src/modules/knowledge/collectors/index.js';
import { CollectorError } from '../../src/modules/knowledge/collectors/http.js';
import { lawCenterCollector } from '../../src/modules/knowledge/collectors/lawCenter.js';
import { ftcCollector } from '../../src/modules/knowledge/collectors/ftc.js';
import { dataPortalCollector } from '../../src/modules/knowledge/collectors/dataPortal.js';
import { kcaCollector } from '../../src/modules/knowledge/collectors/kca.js';
import { drainIngest } from '../../src/modules/knowledge/ingest.service.js';
import { preprocess } from '../../src/modules/knowledge/preprocess.js';
import { DEFAULT_INCLUDE } from '../../src/modules/knowledge/select.js';

type Agent = ReturnType<typeof newAgent>;
const SAMPLE = fs.readFileSync(fixture('contracts/subscription-sample.txt'), 'utf8');

let stub: StubHandle;
let op: Agent;
let userAgent: Agent;
let owner: Agent;
let r1 = 0; // 승인 전 저장된 결과(kv1)
let kv1 = 0;
let today = '';
let amendItem: { evidence_item_id: number; source_name: string; identifier: string };
let repealItem: { evidence_item_id: number; source_name: string; identifier: string };

const daysAgo = (n: number) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
const articleOf = (identifier: string) => /^제\s*\d+\s*조(?:의\s*\d+)?/.exec(identifier)![0].replace(/\s+/g, '');
const paraOf = (identifier: string) => Number(/제\s*(\d+)\s*항/.exec(identifier)?.[1] ?? 0);
const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩';

function mock(agency: Collector['agency'], deltas: SourceDelta[] | (() => SourceDelta[]), fail?: string): Collector {
  return {
    agency,
    async collect() {
      if (fail) throw new CollectorError(fail);
      return typeof deltas === 'function' ? deltas() : deltas;
    },
  };
}

/** 개정 1·폐지 1·신규 사례 1 + 분리 실패 2(G1) + 시행 전 1(보류) + 공개 10일 경과 표준약관 1 + 소비자원 참고 1 */
function deltas() {
  const amendArticle = articleOf(amendItem.identifier);
  const p = paraOf(amendItem.identifier);
  const amendText = p
    ? Array.from({ length: p }, (_, i) => `${CIRCLED[i]} (개정) 사업자는 고객에게 부당하게 불리한 약관 조항을 두어서는 아니 된다 ${i + 1}.`).join('\n')
    : '(개정) 사업자는 고객에게 부당하게 과중한 손해배상 의무를 부담시키는 약관 조항을 두어서는 아니 된다. <개정 2026. 9. 1.>';
  const law: SourceDelta[] = [
    {
      agency: 'law_center', changeKind: 'amend', sourceType: 'law_article', sourceName: amendItem.source_name, identifier: amendArticle,
      title: `${amendItem.source_name} ${amendArticle} 개정`, rawText: `${amendArticle}(개정 테스트)\n${amendText}`,
      sourceUrl: 'https://www.law.go.kr/test/amend', effectiveDate: daysAgo(2), publishedDate: daysAgo(30),
    },
    {
      agency: 'law_center', changeKind: 'repeal', sourceType: 'law_article', sourceName: repealItem.source_name, identifier: articleOf(repealItem.identifier),
      title: `${repealItem.source_name} ${articleOf(repealItem.identifier)} 폐지`, rawText: '삭제 <2026. 9. 1.>',
      sourceUrl: 'https://www.law.go.kr/test/repeal', effectiveDate: daysAgo(1), publishedDate: daysAgo(20),
    },
    // G1: "다음 각 호"라고 하고 호가 없다 → 조·항·호 분리 실패
    {
      agency: 'law_center', changeKind: 'new_law', sourceType: 'law_article', sourceName: '소비자기본법', identifier: '제98조',
      title: '소비자기본법 제98조 신설', rawText: '제98조(금지행위) 사업자는 다음 각 호의 행위를 하여서는 아니 된다.',
      sourceUrl: 'https://www.law.go.kr/test/g1', effectiveDate: daysAgo(3), publishedDate: daysAgo(3),
    },
    // 시행 전 개정(UC7 A4) → 보류
    {
      agency: 'law_center', changeKind: 'new_law', sourceType: 'law_article', sourceName: '소비자기본법', identifier: '제99조',
      title: '소비자기본법 제99조 신설(시행 전)', rawText: '제99조(시행 전 조문) 사업자는 소비자에게 거래 조건을 명확히 알려야 한다.',
      sourceUrl: 'https://www.law.go.kr/test/hold', effectiveDate: '2099-01-01', publishedDate: daysAgo(1),
    },
  ];
  const ftc: SourceDelta[] = [
    {
      agency: 'ftc', changeKind: 'new_case', sourceType: 'ftc_case', sourceName: '(가상 사례) 구독 중도 해지 위약금 전액 청구 시정', identifier: '(가상) 2026약관0099',
      title: '(가상) 2026약관0099 구독 중도 해지 위약금 시정',
      rawText: '사실관계: 회원이 구독 기간 중 해지하는 경우 회사는 잔여 기간 이용료 전액을 위약금으로 청구하였다.\n'
        + '판단: 중도 해지 시 잔여 기간 이용료 전액을 위약금으로 청구하는 조항은 고객에게 부당하게 과중한 손해배상 의무를 부담시켜 무효로 보아 시정을 권고하였다.\n'
        + '근거: 약관의 규제에 관한 법률 제8조',
      sourceUrl: 'https://case.ftc.go.kr/test/1', publishedDate: daysAgo(2),
    },
    // G1: 사실관계·판단·근거로 나눌 수 없는 사례
    {
      agency: 'ftc', changeKind: 'new_case', sourceType: 'ftc_case', sourceName: '(가상 사례) 구분 불가 사례', identifier: '(가상) 2026약관0100',
      title: '(가상) 2026약관0100 구분 불가', rawText: '본문이 한 문단으로만 되어 있어 구분할 수 없다.',
      sourceUrl: 'https://case.ftc.go.kr/test/2', publishedDate: daysAgo(2),
    },
  ];
  const portal: SourceDelta[] = [
    {
      agency: 'data_portal', changeKind: 'std_terms_revision', sourceType: 'std_terms', sourceName: '할부거래 표준약관', identifier: '제99조(테스트 조항)',
      title: '할부거래 표준약관 제99조 개정', rawText: '제99조(테스트 조항) 소비자는 할부계약을 체결한 날부터 7일 이내에 청약을 철회할 수 있다.',
      sourceUrl: 'https://www.ftc.go.kr/test/std', effectiveDate: daysAgo(10), publishedDate: daysAgo(10),
    },
  ];
  const kca: SourceDelta[] = [
    {
      agency: 'kca', changeKind: 'reference', sourceType: null, sourceName: '소비자분쟁조정 사례', identifier: '(가상) 2026-분쟁-01',
      title: '(가상) 온라인 강의 환불 분쟁조정 사례', rawText: '온라인 강의 중도 해지 환불 분쟁 조정 사례 요지.',
      sourceUrl: 'https://www.kca.go.kr/test/1', publishedDate: daysAgo(4),
    },
  ];
  return { law, ftc, portal, kca };
}

function okCollectors(): Collector[] {
  const d = deltas();
  return [mock('law_center', d.law), mock('ftc', d.ftc), mock('data_portal', d.portal), mock('kca', d.kca)];
}

async function batch(id: number) {
  const r = await op.get(`/api/admin/knowledge/ingest-batches/${id}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expectResponse('web', 'GET', '/admin/knowledge/ingest-batches/{batchId}', 200, r.body);
  return r.body;
}

async function waitBatch(id: number, stages: string[]) {
  await drainIngest();
  return waitFor(() => batch(id), (b) => stages.includes(b.stage), 20_000);
}

/**
 * newAgent() 의 listen(0) 이 끝나기 전에 첫 요청을 보내면 supertest 가 서버를 다시 listen·close 해
 * 다음 요청이 엉뚱한 포트로 간다 — 사용 전에 listening 을 기다린다
 */
async function agent(role: Role = 'user'): Promise<Agent> {
  const a = newAgent({ role });
  const srv = (a as unknown as { app: Server }).app;
  if (!srv.listening) await once(srv, 'listening');
  return a;
}

beforeAll(async () => {
  await resetDb();
  stub = await startStub();
  today = (await selectOne<{ d: string }>(getPool(), "SELECT DATE_FORMAT(CURRENT_DATE, '%Y-%m-%d') AS d"))!.d;
  kv1 = (await selectOne<{ kv_id: number }>(getPool(), "SELECT kv_id FROM knowledge_version WHERE status = 'active'"))!.kv_id;
  owner = await agent();
  r1 = (await analyzeToSaved(owner, () => startText(owner, SAMPLE))).runId;
  // 저장 결과가 근거로 쓴 법령 조문 중 서로 다른 조 2개를 개정·폐지 대상으로 고른다
  const used = await select<{ evidence_item_id: number; source_name: string; identifier: string }>(
    getPool(),
    `SELECT DISTINCT ei.evidence_item_id, ei.source_name, ei.identifier
       FROM clause_assessment a JOIN judgment_evidence je ON je.judgment_id = a.judgment_id
       JOIN evidence_version ev ON ev.evidence_version_id = je.evidence_version_id
       JOIN evidence_item ei ON ei.evidence_item_id = ev.evidence_item_id
      WHERE a.run_id = ? AND ei.source_type = 'law_article' ORDER BY ei.evidence_item_id`,
    [r1],
  );
  expect(used.length).toBeGreaterThanOrEqual(2);
  amendItem = used[0]!;
  repealItem = used.find((u) => `${u.source_name}|${articleOf(u.identifier)}` !== `${amendItem.source_name}|${articleOf(amendItem.identifier)}`)!;
  expect(repealItem).toBeTruthy();
  op = await agent('operator');
  userAgent = await agent();
});

afterAll(async () => {
  setCollectors(null);
  await drainIngest();
  await stub.close();
  await teardown();
});

describe('접근(RBAC knowledge.manage — 운영자만)', () => {
  it('일반 사용자는 G14, 운영자는 200', async () => {
    const u = await userAgent.get('/api/admin/knowledge/versions');
    expect(u.status, JSON.stringify(u.body)).toBe(403);
    expect(u.body.gate).toBe('G14');
    const a = await (await agent('operator')).get('/api/admin/knowledge/versions');
    expect(a.status).toBe(200);
  });

  it('기준일 목록을 본다(활성 1개)', async () => {
    const r = await op.get('/api/admin/knowledge/versions').expect(200);
    expectResponse('web', 'GET', '/admin/knowledge/versions', 200, r.body);
    expect(r.body.filter((v: { status: string }) => v.status === 'active')).toHaveLength(1);
  });
});

describe('수집기 키 미설정(0.1)', () => {
  it('키가 없으면 네트워크 호출 없이 "키 미설정" 실패를 낸다', async () => {
    const since = { kvId: kv1, knowledgeDate: '2026-09-15' };
    for (const c of [lawCenterCollector({ oc: '' }), ftcCollector({ oc: '' }), dataPortalCollector({ serviceKey: '' }), kcaCollector({ apiKey: '' })]) {
      await expect(c.collect(since)).rejects.toThrow(/키 미설정/);
    }
  });
});

describe('전처리·반영 대상 확정(0.2·0.3) 단위', () => {
  it('법령은 조·항·호로, 사례는 사실관계·판단·근거로 나누고 중복·노이즈를 제거한다', () => {
    const base = { agency: 'law_center' as const, changeKind: 'amend' as const, sourceType: 'law_article' as const, sourceName: '테스트법', sourceUrl: 'u', effectiveDate: '2026-01-01' };
    const out = preprocess(
      [
        { ...base, identifier: '제5조', title: 't', rawText: '제5조(정의) ① 첫째 항. <개정 2020. 1. 1.>\n② 다음 각 호의 어느 하나.\n1. 가호\n2. 나호' },
        { ...base, identifier: '제5조', title: 't(중복)', rawText: '제5조(정의) ① 첫째 항.\n② 다음 각 호의 어느 하나.\n1. 가호\n2. 나호' },
        { ...base, identifier: '제6조', title: 'x', rawText: '   ' },
      ],
      [],
    );
    const ok = out.units.filter((u) => u.parseStatus === 'ok');
    expect(ok.map((u) => u.identifier)).toEqual(['제5조 제1항', '제5조 제2항']);
    expect(ok[0]!.excerpt).not.toContain('<개정');
    expect(ok[1]!.excerpt).toContain('1. 가호');
    expect(out.stats.duplicates).toBe(1);
    expect(out.stats.noise).toBe(1);
  });

  it('라벨(v_ingest_item_status)별 기본 포함: 후보·폐지(구간 닫기)는 포함, 보류·참고·분리 실패는 제외', () => {
    expect(DEFAULT_INCLUDE).toEqual({
      candidate: true, excluded_repealed: true, hold_not_effective: false, reference_only: false, excluded_parse_fail: false,
    });
  });

  it('사례 3구분을 원천이 주면 그대로, 아니면 본문 머리말로 나눈다', () => {
    const base = { agency: 'ftc' as const, changeKind: 'new_case' as const, sourceType: 'ftc_case' as const, sourceName: '사건', identifier: '2026-1', title: 't', sourceUrl: 'u', publishedDate: '2026-09-01' };
    const [a] = preprocess([{ ...base, rawText: '1. 사실관계\n가 했다.\n2. 판단\n부당하다.\n3. 법령의 적용\n약관법 제6조' }], []).units;
    expect(a).toMatchObject({ parseStatus: 'ok', caseFacts: '가 했다.', caseJudgment: '부당하다.', caseBasis: '약관법 제6조', excerpt: '부당하다.' });
    const [b] = preprocess([{ ...base, rawText: '', caseSections: { facts: 'F', judgment: '판단 내용', basis: 'B' } }], []).units;
    expect(b).toMatchObject({ parseStatus: 'ok', caseJudgment: '판단 내용' });
  });
});

describe('갱신 흐름(0.1~0.6)', () => {
  let batchId = 0;
  let inflight: { agent: Agent; requestId: number } | null = null;
  let kv2 = 0;

  it('G0: 한 기관이라도 실패하면 collect_failed, 실패 기관·사유를 남기고 승인할 수 없다', async () => {
    const d = deltas();
    setCollectors([mock('law_center', d.law), mock('ftc', [], '키 미설정 - LAW_API_OC'), mock('data_portal', d.portal), mock('kca', d.kca)]);
    const s = await op.post('/api/admin/knowledge/ingest-batches');
    expect(s.status, JSON.stringify(s.body)).toBe(202);
    expectResponse('web', 'POST', '/admin/knowledge/ingest-batches', 202, s.body);
    batchId = s.body.batchId;
    const b = await waitBatch(batchId, ['collect_failed', 'selecting']);
    expect(b.stage).toBe('collect_failed');
    const ftc = b.sources.find((x: { agency: string }) => x.agency === 'ftc');
    expect(ftc).toMatchObject({ status: 'failed', failReason: '키 미설정 - LAW_API_OC' });
    expect(b.sources.find((x: { agency: string }) => x.agency === 'law_center').status).toBe('ok');
    expect(b.items).toHaveLength(0);
    const g0 = b.openGates.find((g: { gate: string }) => g.gate === 'G0');
    expect(g0.title).toBe('외부 자료를 모두 받지 못했습니다');
    expect(g0.reason).toContain('공정거래위원회');
    const ev = await selectOne<{ n: number }>(getPool(), "SELECT COUNT(*) AS n FROM gate_event WHERE gate_code = 'G0' AND batch_id = ? AND released_at IS NULL", [batchId]);
    expect(ev!.n).toBe(1);

    const ap = await op.post(`/api/admin/knowledge/ingest-batches/${batchId}/approve`);
    expect(ap.status).toBe(409);
    expect(ap.body.gate).toBe('G0');
    expectResponse('web', 'POST', '/admin/knowledge/ingest-batches/{batchId}/approve', 409, ap.body);
    // 기존 기준일 유지
    const act = await select<{ kv_id: number }>(getPool(), "SELECT kv_id FROM knowledge_version WHERE status = 'active'");
    expect(act.map((x) => x.kv_id)).toEqual([kv1]);
  });

  it('다시 수집(retry)하면 G0 이 해제되고 반영 대상이 확정된다(G1 분리 실패는 제외·검토 목록)', async () => {
    setCollectors(okCollectors());
    const r = await op.post(`/api/admin/knowledge/ingest-batches/${batchId}/retry`);
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    const b = await waitBatch(batchId, ['selecting', 'collect_failed']);
    expect(b.stage).toBe('selecting');
    expect(b.sources.every((x: { status: string }) => x.status === 'ok')).toBe(true);
    expect(b.openGates.find((g: { gate: string }) => g.gate === 'G0')).toBeUndefined();
    const released = await selectOne<{ n: number }>(getPool(), "SELECT COUNT(*) AS n FROM gate_event WHERE gate_code = 'G0' AND batch_id = ? AND released_at IS NOT NULL", [batchId]);
    expect(released!.n).toBe(1);

    const labels = (kind: string) => b.items.filter((i: { changeKind: string }) => i.changeKind === kind).map((i: { decisionLabel: string }) => i.decisionLabel);
    expect(labels('amend').every((l: string) => l === 'candidate')).toBe(true);
    expect(labels('repeal').length).toBeGreaterThanOrEqual(1);
    expect(labels('repeal').every((l: string) => l === 'excluded_repealed')).toBe(true);
    expect(labels('reference')).toEqual(['reference_only']);
    const fails = b.items.filter((i: { decisionLabel: string }) => i.decisionLabel === 'excluded_parse_fail');
    expect(fails).toHaveLength(2);
    expect(fails.every((i: { include: boolean }) => i.include === false)).toBe(true);
    const hold = b.items.find((i: { itemTitle: string }) => i.itemTitle.includes('제99조') && i.itemTitle.includes('소비자기본법'));
    expect(hold).toMatchObject({ decisionLabel: 'hold_not_effective', include: false });
    const g1 = b.openGates.find((g: { gate: string }) => g.gate === 'G1');
    expect(g1.title).toBe('구조 분리 실패 2건 - 이번 반영에서 제외됩니다');
    expect(g1.scope).toBe('partial');
    const g1ev = await selectOne<{ n: number }>(getPool(), "SELECT COUNT(*) AS n FROM gate_event g JOIN ingest_item i ON i.item_id = g.ingest_item_id WHERE g.gate_code = 'G1' AND i.batch_id = ?", [batchId]);
    expect(g1ev!.n).toBe(2);
    // 검토 목록(분리 실패 사유)
    expect(b.reviewList).toHaveLength(2);
    expect(b.reviewList[0].reason).toBeTruthy();

    // 분리 실패 항목은 포함할 수 없다(DB 거부 → G1 409)
    const bad = await op.patch(`/api/admin/knowledge/ingest-batches/${batchId}/items/${fails[0].itemId}`).send({ include: true });
    expect(bad.status).toBe(409);
    expect(bad.body.gate).toBe('G1');
    expectResponse('web', 'PATCH', '/admin/knowledge/ingest-batches/{batchId}/items/{itemId}', 409, bad.body);

    // 항목 제외·복원
    const cand = b.items.find((i: { changeKind: string; decisionLabel: string }) => i.changeKind === 'new_case' && i.decisionLabel === 'candidate');
    await op.patch(`/api/admin/knowledge/ingest-batches/${batchId}/items/${cand.itemId}`).send({ include: false }).expect(200);
    expect((await batch(batchId)).items.find((i: { itemId: number }) => i.itemId === cand.itemId).include).toBe(false);
    await op.patch(`/api/admin/knowledge/ingest-batches/${batchId}/items/${cand.itemId}`).send({ include: true }).expect(200);
    expect((await batch(batchId)).items.find((i: { itemId: number }) => i.itemId === cand.itemId).include).toBe(true);
  });

  it('승인 전에 시작한 분석은 고정 기준일(kv1)을 쥐고 있다', async () => {
    const ag = await agent();
    const s = await startText(ag, SAMPLE);
    expect(s.status, JSON.stringify(s.body)).toBe(201);
    await waitStage(ag, s.body.requestId, (x) => x.requestStage === 'awaiting_type');
    inflight = { agent: ag, requestId: s.body.requestId };
    const fixed = await selectOne<{ fixed_kv_id: number }>(getPool(), 'SELECT fixed_kv_id FROM analysis_request WHERE request_id = ?', [s.body.requestId]);
    expect(fixed!.fixed_kv_id).toBe(kv1);
  });

  it('승인(0.4): 단일 트랜잭션 — 새 kv 하나만 active, 이전 구간 닫힘, 영향 결과(0.5), 7일 경과 경고(0.6)', async () => {
    const r = await op.post(`/api/admin/knowledge/ingest-batches/${batchId}/approve`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expectResponse('web', 'POST', '/admin/knowledge/ingest-batches/{batchId}/approve', 200, r.body);
    kv2 = r.body.knowledgeVersion.kvId;
    expect(r.body.knowledgeVersion).toMatchObject({ status: 'active', knowledgeDate: today, kvSeq: 2 });

    const kvs = await select<{ kv_id: number; status: string }>(getPool(), 'SELECT kv_id, status FROM knowledge_version ORDER BY kv_seq');
    expect(kvs).toEqual([{ kv_id: kv1, status: 'superseded' }, { kv_id: kv2, status: 'active' }]);

    // 개정: 이전 버전 to_kv=kv2, 새 버전 from_kv=kv2
    const vers = await select<{ from_kv_id: number; to_kv_id: number | null; excerpt: string }>(
      getPool(), 'SELECT from_kv_id, to_kv_id, excerpt FROM evidence_version WHERE evidence_item_id = ? ORDER BY evidence_version_id', [amendItem.evidence_item_id]);
    expect(vers).toHaveLength(2);
    expect(vers[0]).toMatchObject({ from_kv_id: kv1, to_kv_id: kv2 });
    expect(vers[1]).toMatchObject({ from_kv_id: kv2, to_kv_id: null });
    expect(vers[1]!.excerpt).toContain('(개정)');
    expect(vers[1]!.excerpt).not.toContain('<개정');

    // 폐지: 구간만 닫히고 새 버전 없음 → kv2 유효 집합에서 빠지고 kv1 에는 남는다(FR-022, 재열람)
    const rep = await select<{ to_kv_id: number | null }>(getPool(), 'SELECT to_kv_id FROM evidence_version WHERE evidence_item_id = ?', [repealItem.evidence_item_id]);
    expect(rep).toEqual([{ to_kv_id: kv2 }]);
    const inForce = async (kv: number, item: number) =>
      (await selectOne<{ n: number }>(getPool(), 'SELECT COUNT(*) AS n FROM v_evidence_in_force WHERE kv_id = ? AND evidence_item_id = ?', [kv, item]))!.n;
    expect(await inForce(kv2, repealItem.evidence_item_id)).toBe(0);
    expect(await inForce(kv1, repealItem.evidence_item_id)).toBe(1);

    // 신규 사례 반영, 분리 실패·시행 전·참고 자료는 근거가 되지 않는다
    const newCase = await selectOne<{ evidence_item_id: number; case_facts: string; case_judgment: string; case_basis: string }>(
      getPool(), `SELECT ei.evidence_item_id, ev.case_facts, ev.case_judgment, ev.case_basis FROM evidence_item ei JOIN evidence_version ev ON ev.evidence_item_id = ei.evidence_item_id
                   WHERE ei.identifier = '(가상) 2026약관0099'`);
    expect(newCase!.case_facts).toContain('잔여 기간');
    expect(newCase!.case_basis).toContain('제8조');
    expect(await inForce(kv2, newCase!.evidence_item_id)).toBe(1);
    const none = await selectOne<{ n: number }>(getPool(), "SELECT COUNT(*) AS n FROM evidence_item WHERE identifier IN ('(가상) 2026약관0100', '제98조', '(가상) 2026-분쟁-01') OR (source_name = '소비자기본법' AND identifier = '제99조')");
    expect(none!.n).toBe(0);

    // 변경 내역(v_kv_changes)과 batch 단계
    const changes = await select<{ change_kind: string }>(getPool(), 'SELECT change_kind FROM v_kv_changes WHERE kv_id = ?', [kv2]);
    expect(changes.map((c) => c.change_kind)).toEqual(expect.arrayContaining(['amend', 'repeal', 'new_case', 'std_terms_revision']));
    const bb = await batch(batchId);
    expect(bb.stage).toBe('deadline_checked');

    // 0.5 영향 결과: r1 이 개정·폐지 조문을 참조했으므로 식별된다
    expect(r.body.impactedResultCount).toBeGreaterThanOrEqual(1);
    const impacts = await select<{ change_kind: string; evidence_item_id: number }>(getPool(), 'SELECT change_kind, evidence_item_id FROM v_result_impact_active WHERE run_id = ? AND kv_id = ?', [r1, kv2]);
    expect(impacts).toEqual(expect.arrayContaining([
      { change_kind: 'amend', evidence_item_id: amendItem.evidence_item_id },
      { change_kind: 'repeal', evidence_item_id: repealItem.evidence_item_id },
    ]));
    // 관련 신규 사례(UC7 A1): 위약금 조항과 관련도가 높은 새 사례도 안내 대상
    expect(impacts.some((i) => i.change_kind === 'new_case' && i.evidence_item_id === newCase!.evidence_item_id)).toBe(true);

    // 0.6 반영 기한: 공개 10일 경과 표준약관 개정은 7일 초과 경고
    const std = bb.items.find((i: { changeKind: string }) => i.changeKind === 'std_terms_revision');
    expect(std.elapsedDays).toBe(10);
    expect(r.body.deadlineWarnings).toEqual(expect.arrayContaining([expect.objectContaining({ itemId: std.itemId, elapsedDays: 10 })]));
    expect(r.body.deadlineWarnings.every((w: { elapsedDays: number }) => w.elapsedDays >= 7)).toBe(true);

    // 같은 갱신을 두 번 승인할 수 없다
    const again = await op.post(`/api/admin/knowledge/ingest-batches/${batchId}/approve`);
    expect(again.status).toBe(409);
    const versions = await op.get('/api/admin/knowledge/versions').expect(200);
    expect(versions.body.filter((v: { status: string }) => v.status === 'active').map((v: { kvId: number }) => v.kvId)).toEqual([kv2]);
  });

  it('FR-039: 승인 전에 시작한 분석은 kv1 로 끝난다', async () => {
    const { agent, requestId } = inflight!;
    const st = await waitStage(agent, requestId, (x) => x.requestStage === 'awaiting_type');
    for (const d of st.documents as { documentId: number }[]) {
      await agent.put(`/api/analyses/${requestId}/documents/${d.documentId}/contract-type`).send({ contractType: 'subscription' }).expect(200);
    }
    const done = await waitStage(agent, requestId, (x) => !!x.run && ['completed', 'aborted'].includes(x.run.stage));
    expect(done.run.stage).toBe('completed');
    const run = await selectOne<{ kv_id: number }>(getPool(), 'SELECT kv_id FROM analysis_run WHERE run_id = ?', [done.run.runId]);
    expect(run!.kv_id).toBe(kv1);
    // 붙은 근거는 모두 kv1 유효 집합 안(폐지 조문이 kv1 에서는 쓰일 수 있다)
    const outside = await selectOne<{ n: number }>(
      getPool(),
      `SELECT COUNT(*) AS n FROM clause_assessment a JOIN judgment_evidence je ON je.judgment_id = a.judgment_id
        WHERE a.run_id = ? AND je.evidence_version_id NOT IN (SELECT evidence_version_id FROM v_evidence_in_force WHERE kv_id = ?)`,
      [done.run.runId, kv1],
    );
    expect(outside!.n).toBe(0);
    // 저장하면 승인 뒤에 끝난 이 실행도 영향 결과가 보충된다(0.5) — 닫힌 근거를 썼을 때만
    await agent.post(`/api/analyses/${requestId}/runs/${done.run.runId}/save`).expect(200);
    const closedUsed = await selectOne<{ n: number }>(
      getPool(),
      `SELECT COUNT(DISTINCT ev.evidence_item_id) AS n FROM clause_assessment a JOIN judgment_evidence je ON je.judgment_id = a.judgment_id
         JOIN evidence_version ev ON ev.evidence_version_id = je.evidence_version_id WHERE a.run_id = ? AND ev.to_kv_id IS NOT NULL`,
      [done.run.runId],
    );
    const impacts = await selectOne<{ n: number }>(getPool(), 'SELECT COUNT(DISTINCT evidence_item_id) AS n FROM result_impact WHERE run_id = ?', [done.run.runId]);
    expect(Number(impacts!.n)).toBeGreaterThanOrEqual(Number(closedUsed!.n));
  });

  it('FR-022: 승인 뒤 새 분석은 kv2 로 수행되고 폐지 조문을 근거로 쓰지 않는다', async () => {
    const ag = await agent();
    const { runId } = await analyzeToSaved(ag, () => startText(ag, SAMPLE));
    const run = await selectOne<{ kv_id: number }>(getPool(), 'SELECT kv_id FROM analysis_run WHERE run_id = ?', [runId]);
    expect(run!.kv_id).toBe(kv2);
    const used = await select<{ evidence_item_id: number; from_kv_id: number }>(
      getPool(),
      `SELECT DISTINCT ev.evidence_item_id, ev.from_kv_id FROM clause_assessment a JOIN judgment_evidence je ON je.judgment_id = a.judgment_id
         JOIN evidence_version ev ON ev.evidence_version_id = je.evidence_version_id WHERE a.run_id = ?`,
      [runId],
    );
    expect(used.length).toBeGreaterThan(0);
    expect(used.some((u) => u.evidence_item_id === repealItem.evidence_item_id)).toBe(false);
    // 개정 조문이 쓰였다면 새 버전(kv2)이다
    for (const u of used.filter((x) => x.evidence_item_id === amendItem.evidence_item_id)) expect(u.from_kv_id).toBe(kv2);
  });

  it('보류(시행 전) 항목은 다음 갱신으로 이월된다', async () => {
    setCollectors([mock('law_center', []), mock('ftc', []), mock('data_portal', []), mock('kca', [])]);
    const s = await op.post('/api/admin/knowledge/ingest-batches').expect(202);
    const b = await waitBatch(s.body.batchId, ['selecting', 'collect_failed']);
    expect(b.stage).toBe('selecting');
    const carried = b.items.find((i: { itemTitle: string }) => i.itemTitle.includes('제99조') && i.itemTitle.includes('소비자기본법'));
    expect(carried).toMatchObject({ decisionLabel: 'hold_not_effective', include: false });
  });
});
