// T142 — 개발·CI 스텁(tools/model-api-stub)이 model-api 계약(contracts/model-api.openapi.yaml)과 맞는지.
// 실제 게이트웨이(model-server/)는 model-server/tests/test_contract.py 가 같은 계약으로 검증한다
import supertest from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createStubApp, configFromEnv } from '../../../tools/model-api-stub/src/server.js';
import { expectResponse } from './harness.js';

const AUTH = { Authorization: 'Bearer any' };
const CLAUSES = [
  { clause_id: 'c1', article_no: '1', title: '목적', text: '이 약관은 구독 서비스 이용 조건을 정한다.' },
  { clause_id: 'c2', article_no: '7', title: '환불', text: '결제 후에는 어떠한 경우에도 환불되지 않습니다.' },
];
const JUDGE = {
  clause: '회사는 사전 통지 없이 요금을 임의로 변경할 수 있으며 어떠한 경우에도 환불하지 않는다.',
  contract_type: 'subscription',
  perspective: 'consumer',
  knowledge_date: '2026-09-01',
  scores: { loophole: 0.8, illegal: 0.75 },
  evidence: [
    { id: '11', source_type: 'law_article', title: '약관법 제6조', text: '공정성을 잃은 약관 조항은 무효로 한다.' },
    { id: '12', source_type: 'ftc_case', title: '시정 사례', text: '환불 불가 조항 시정' },
  ],
};

let stub: ReturnType<typeof createStubApp>;
let api: ReturnType<typeof supertest>;
beforeEach(() => {
  stub = createStubApp({ ...configFromEnv({}), coldDelayMs: 0 });
  api = supertest(stub.app);
});

describe('model-api 계약 — 스텁', () => {
  it('GET /health (ready 200 · cold · loading 503)', async () => {
    const r = await api.get('/health').set(AUTH).expect(200);
    expectResponse('model', 'GET', '/health', 200, r.body);
    stub.warm.M3 = false;
    const cold = await api.get('/health').set(AUTH).expect(200);
    expectResponse('model', 'GET', '/health', 200, cold.body);
    expect(cold.body.warmup_estimate_sec).toBeGreaterThan(0);
    stub.config.health = 'loading';
    const l = await api.get('/health').set(AUTH).expect(503);
    expectResponse('model', 'GET', '/health', 503, l.body);
    expect(l.body.status).toBe('loading');
  });

  it('GET /v1/models', async () => {
    const r = await api.get('/v1/models').set(AUTH).expect(200);
    expectResponse('model', 'GET', '/v1/models', 200, r.body);
    expect(r.body.models.map((m: { id: string }) => m.id)).toEqual(['M1', 'M2', 'M3', 'M4']);
  });

  it('POST /v1/summarize (+ 실패 503)', async () => {
    const r = await api.post('/v1/summarize').set(AUTH).send({ clauses: CLAUSES }).expect(200);
    expectResponse('model', 'POST', '/v1/summarize', 200, r.body);
    stub.config.summaryFail = true;
    const f = await api.post('/v1/summarize').set(AUTH).send({ clauses: CLAUSES }).expect(503);
    expectResponse('model', 'POST', '/v1/summarize', 503, f.body);
  });

  it('POST /v1/detect/loophole · /v1/detect/illegal', async () => {
    for (const p of ['/v1/detect/loophole', '/v1/detect/illegal']) {
      const r = await api.post(p).set(AUTH).send({ clauses: CLAUSES, contract_type: 'subscription' }).expect(200);
      expectResponse('model', 'POST', p, 200, r.body);
      expect(r.body.results).toHaveLength(2);
    }
  });

  it('POST /v1/jobs → GET /v1/jobs/{id} (관점 필드는 400 — A3)', async () => {
    const c = await api.post('/v1/jobs').set(AUTH).send({ clauses: CLAUSES, contract_type: 'subscription' }).expect(202);
    expectResponse('model', 'POST', '/v1/jobs', 202, c.body);
    let body: { status: string } = { status: 'running' };
    for (let i = 0; i < 20 && body.status !== 'done'; i++) {
      const g = await api.get(`/v1/jobs/${c.body.job_id}`).set(AUTH).expect(200);
      expectResponse('model', 'GET', '/v1/jobs/{id}', 200, g.body);
      body = g.body;
    }
    expect(body.status).toBe('done');
    await api.post('/v1/jobs').set(AUTH).send({ clauses: CLAUSES, contract_type: 'subscription', perspective: 'consumer' }).expect(400);
    await api.get('/v1/jobs/nope').set(AUTH).expect(404);
  });

  it('POST /v1/judge — 주장 근거는 요청 근거 안에서만', async () => {
    const r = await api.post('/v1/judge').set(AUTH).send(JUDGE).expect(200);
    expectResponse('model', 'POST', '/v1/judge', 200, r.body);
    const ids = new Set(JUDGE.evidence.map((e) => e.id));
    for (const c of r.body.explanation as { evidence_ids: string[] }[]) for (const id of c.evidence_ids) expect(ids.has(id)).toBe(true);
    const bad = await api.post('/v1/judge').set(AUTH).send({ ...JUDGE, clause: 42 }).expect(400);
    expectResponse('model', 'POST', '/v1/judge', 400, bad.body);
  });

  it('인증: 키가 다르면 401', async () => {
    stub.config.apiKey = 'right';
    const r = await api.get('/health').set({ Authorization: 'Bearer wrong' }).expect(401);
    expectResponse('model', 'GET', '/health', 401, r.body);
  });
});
