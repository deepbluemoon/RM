// T122 — 두 관점 결과는 분류·위험도·근거가 같고 설명만 다르다(SC-008, BR-ANL-03).
// 스텁이 관점별로 다른 분류를 내면(STUB_PERSPECTIVE_DIVERGE) G7 이벤트가 남고 저장이 거부된다. /v1/jobs 에는 관점이 없다(A3)
import fs from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fixture, newAgent, resetDb, startStub, teardown, type StubHandle } from './setup.js';
import { analyzeToSaved, startText, waitStage } from './flow.js';
import { getPool, select } from '../../src/db/pool.js';
import { resetStatusCache } from '../../src/modules/modelApi/status.js';

let stub: StubHandle;
const SAMPLE = fs.readFileSync(fixture('contracts/subscription-sample.txt'), 'utf8');

interface Row { text_hash: string; m3_category: string | null; risk_level: string | null; ev: string | null; claims: string | null }

/** 실행의 판정을 조항 원문 해시로 모은다(두 요청의 clause_id 는 다르므로) */
async function judgedByHash(runId: number): Promise<Map<string, Row>> {
  const rows = await select<Row>(
    getPool(),
    `SELECT j.text_hash, j.m3_category, j.risk_level,
            (SELECT GROUP_CONCAT(je.evidence_version_id ORDER BY je.evidence_version_id) FROM judgment_evidence je WHERE je.judgment_id = j.judgment_id) AS ev,
            (SELECT GROUP_CONCAT(ec.claim_text ORDER BY ec.seq SEPARATOR '|') FROM explanation_claim ec WHERE ec.judgment_id = j.judgment_id) AS claims
       FROM clause_assessment a JOIN judgment j ON j.judgment_id = a.judgment_id
      WHERE a.run_id = ?`,
    [runId],
  );
  return new Map(rows.map((r) => [r.text_hash, r]));
}

beforeAll(async () => {
  await resetDb();
  stub = await startStub();
});
afterAll(async () => {
  await stub.close();
  await teardown();
});
beforeEach(() => {
  Object.assign(stub.config, { perspectiveDiverge: false, health: 'ready' });
  resetStatusCache();
});

describe('관점 일관성(US6)', () => {
  it('소비자·사업자 결과는 분류·위험도·근거가 같고 설명만 다르다', async () => {
    const a = newAgent();
    const consumer = await analyzeToSaved(a, () => startText(a, SAMPLE, 'consumer'));
    const business = await analyzeToSaved(a, () => startText(a, SAMPLE, 'business'));
    const c = await judgedByHash(consumer.runId);
    const b = await judgedByHash(business.runId);
    expect(c.size).toBeGreaterThan(0);
    expect([...b.keys()].sort()).toEqual([...c.keys()].sort());
    let differentExplanations = 0;
    for (const [hash, cr] of c) {
      const br = b.get(hash)!;
      expect([br.m3_category, br.risk_level, br.ev]).toEqual([cr.m3_category, cr.risk_level, cr.ev]);
      if (cr.claims && br.claims && cr.claims !== br.claims) differentExplanations++;
    }
    expect(differentExplanations).toBeGreaterThan(0);
    // 사업자 결과 화면은 S4-B(관점 = 요청 관점)
    const view = (await a.get(`/api/results/${business.runId}`).expect(200)).body;
    expect(view.perspective).toBe('business');
    // 관점 차이로 G7 이 생기지 않는다
    const g7 = await select<{ n: number }>(getPool(), "SELECT COUNT(*) AS n FROM gate_event WHERE gate_code = 'G7' AND run_id = ?", [business.runId]);
    expect(Number(g7[0]!.n)).toBe(0);
  });

  it('탐지 작업(/v1/jobs) 요청 본문에는 관점이 없다(A3)', () => {
    const jobs = stub.received.filter((r) => r.path === '/v1/jobs');
    expect(jobs.length).toBeGreaterThan(0);
    for (const j of jobs) expect(Object.keys(j.body as object)).not.toContain('perspective');
    const judges = stub.received.filter((r) => r.path === '/v1/judge');
    expect(new Set(judges.map((j) => (j.body as { perspective: string }).perspective))).toEqual(new Set(['consumer', 'business']));
  });

  it('관점에 따라 분류가 달라지면 G7 을 남기고 결과 저장(결과 보기)을 거부한다', async () => {
    const a = newAgent();
    // 소비자 캐시 판정을 먼저 만든다(다른 계약 유형 → 새 캐시 키)
    await analyzeToSaved(a, () => startText(a, SAMPLE, 'consumer'), 'ecommerce');
    stub.config.perspectiveDiverge = true;
    const s = await startText(a, SAMPLE, 'business');
    expect(s.status).toBe(201);
    const requestId = s.body.requestId as number;
    const st = await waitStage(a, requestId, (x) => x.requestStage === 'awaiting_type');
    for (const d of st.documents as { documentId: number }[]) {
      await a.put(`/api/analyses/${requestId}/documents/${d.documentId}/contract-type`).send({ contractType: 'ecommerce' }).expect(200);
    }
    const done = await waitStage(a, requestId, (x) => !!x.run && ['completed', 'aborted'].includes(x.run.stage));
    expect(done.run.stage).toBe('completed'); // 실행은 완료로 두고 제공만 보류
    const runId = done.run.runId as number;
    const ev = await select<{ reason_code: string }>(getPool(), "SELECT reason_code FROM gate_event WHERE gate_code = 'G7' AND run_id = ?", [runId]);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.reason_code).toBe('perspective_mismatch');
    const save = await a.post(`/api/analyses/${requestId}/runs/${runId}/save`);
    expect(save.status).toBe(409);
    expect(save.body.gate).toBe('G7');
    // 저장되지 않았으므로 차감도, 결과 조회도 없다
    const charged = await select<{ n: number }>(getPool(), 'SELECT COUNT(*) AS n FROM usage_charge WHERE run_id = ?', [runId]);
    expect(Number(charged[0]!.n)).toBe(0);
    expect((await a.get(`/api/results/${runId}`)).status).not.toBe(200);
  });
});
