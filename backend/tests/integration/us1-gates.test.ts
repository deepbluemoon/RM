// T062 — G2·G5·G6·G8, 사용자 취소, 연속 분석(한도 없음·G4 없음), 조항 타임아웃은 그 조항만 분석 불가(FR-018)
import fs from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { browserAgent, fixture, newAgent, resetDb, startStub, teardown, sql, waitFor, type StubHandle } from './setup.js';
import { analyzeToSaved, startFile, startText, status, upload, waitStage } from './flow.js';
import { expectResponse } from '../contract/harness.js';
import { getPool, select, selectOne } from '../../src/db/pool.js';
import { resetStatusCache } from '../../src/modules/modelApi/status.js';

let stub: StubHandle;
const SAMPLE = fs.readFileSync(fixture('contracts/subscription-sample.txt'), 'utf8');
const count = async (q: string, p: unknown[] = []) => Number((await selectOne<{ n: number }>(getPool(), q, p))!.n);

beforeAll(async () => {
  await resetDb();
  stub = await startStub();
});
afterAll(async () => {
  await stub.close();
  await teardown();
});
beforeEach(() => {
  Object.assign(stub.config, { health: 'ready', timeoutMatch: '', judgeDelayMs: 0, summaryFail: false });
  resetStatusCache();
});

describe('G2 파일 조건', () => {
  it('55MB 초과는 413 G2, 요청 행 없음', async () => {
    const agent = newAgent();
    const big = Buffer.alloc(60 * 1024 * 1024, 0x20);
    big.write('%PDF-1.4');
    const r = await agent.post('/api/intake/uploads').attach('file', big, 'big.pdf');
    expect(r.status).toBe(413);
    expectResponse('web', 'POST', '/intake/uploads', 413, r.body);
    expect(r.body.gate).toBe('G2');
  });

  it.each([
    ['contracts/encrypted.pdf', 'encrypted'],
    ['contracts/pages-301.pdf', 'pages'],
  ])('%s → G2 (%s 실패)', async (file, check) => {
    const agent = newAgent();
    const r = await upload(agent, file);
    expect(r.status).toBe(400);
    expectResponse('web', 'POST', '/intake/uploads', 400, r.body);
    expect(r.body.gate).toBe('G2');
    expect(r.body.checks.find((c: { check: string }) => c.check === check).passed).toBe(false);
  });

  it('손상 PDF → G2 corrupt', async () => {
    const agent = newAgent();
    const r = await agent.post('/api/intake/uploads').attach('file', Buffer.from('%PDF-1.7\n garbage garbage'), 'broken.pdf');
    expect(r.status).toBe(400);
    expect(r.body.checks.find((c: { check: string }) => c.check === 'corrupt').passed).toBe(false);
  });

  it('G2 로는 요청이 만들어지지 않는다', async () => {
    expect(await count('SELECT COUNT(*) AS n FROM analysis_request')).toBe(0);
  });
});

describe('G5 모델 서버 불가', () => {
  it('요청 전 차단 — 503 G5, 요청 행 없음', async () => {
    stub.config.health = 'loading';
    const agent = newAgent();
    const r = await startText(agent, SAMPLE);
    expect(r.status).toBe(503);
    expectResponse('web', 'POST', '/analyses', 503, r.body);
    expect(r.body.gate).toBe('G5');
    expect(r.body.reason).toContain('서버가 복구되면 다시 시도해 주세요');
    expect(r.body.reason).not.toContain('한도');
    expect(await count('SELECT COUNT(*) AS n FROM analysis_request')).toBe(0);
  });

  it('진행 중 서버 다운 — 실행 aborted, G5, 결과 보기 기록(usage_charge) 없음', async () => {
    const agent = newAgent();
    stub.config.judgeDelayMs = 1500;
    const s = await startText(agent, SAMPLE);
    expect(s.status).toBe(201);
    const id = s.body.requestId;
    const st = await waitStage(agent, id, (x) => x.requestStage === 'awaiting_type');
    await agent.put(`/api/analyses/${id}/documents/${st.documents[0].documentId}/contract-type`).send({ contractType: 'subscription' }).expect(200);
    await waitStage(agent, id, (x) => x.run?.stage === 'explaining');
    stub.config.health = 'down';
    const done = await waitStage(agent, id, (x) => x.run?.stage === 'aborted', 30_000);
    const g5 = done.openGates.find((g: { gate: string }) => g.gate === 'G5');
    expect(g5).toBeTruthy();
    expect(g5.reason).toContain('서버가 복구되면 다시 시도해 주세요');
    stub.config.health = 'ready';
    resetStatusCache();
    expect(await count('SELECT COUNT(*) AS n FROM usage_charge')).toBe(0);
  });
});

describe('G6 계약서 아님', () => {
  it('영수증 — 중단, G6', async () => {
    const agent = newAgent();
    const r = await startFile(agent, 'non-contract/receipt.pdf');
    expect(r.status).toBe(201);
    const st = await waitStage(agent, r.body.requestId, (x) => x.requestStage === 'stopped');
    expect(st.openGates.map((g: { gate: string }) => g.gate)).toContain('G6');
    expect(st.rail.find((x: { step: string }) => x.step === 'structure').state).toBe('blocked');
  });
});

describe('사용자 취소(FR-035(b))', () => {
  it('S2(유형 확인 대기)에서 취소 — 응답은 requestId 만, 차감 기록 없음, 두 번째 취소는 409', async () => {
    const agent = newAgent();
    const r = await startText(agent, SAMPLE);
    const id = r.body.requestId;
    const st = await waitStage(agent, id, (x) => x.requestStage === 'awaiting_type');
    expect(st.cancellable).toBe(true);
    const c = await agent.post(`/api/analyses/${id}/cancel`);
    expect(c.status).toBe(200);
    // 계약(openapi)은 아직 charged·quota 를 필수로 둔다 — 로컬 모드 응답은 { requestId } 뿐이라 스키마 검증은 하지 않는다
    expect(c.body).toEqual({ requestId: id });
    expect(await count('SELECT COUNT(*) AS n FROM cancel_charge WHERE request_id = ?', [id])).toBe(0);
    const again = await agent.post(`/api/analyses/${id}/cancel`);
    expect(again.status).toBe(409);
    expect((await status(agent, id)).requestStage).toBe('stopped');
  });

  it('S3(탐지 중)에서 취소 — 실행 aborted', async () => {
    const agent = newAgent();
    stub.config.judgeDelayMs = 1000;
    const r = await startText(agent, SAMPLE);
    const id = r.body.requestId;
    const st = await waitStage(agent, id, (x) => x.requestStage === 'awaiting_type');
    await agent.put(`/api/analyses/${id}/documents/${st.documents[0].documentId}/contract-type`).send({ contractType: 'subscription' }).expect(200);
    await waitStage(agent, id, (x) => x.run?.stage === 'explaining');
    const c = await agent.post(`/api/analyses/${id}/cancel`).expect(200);
    expect(c.body).toEqual({ requestId: id });
    const after = await status(agent, id);
    expect(after.run.stage).toBe('aborted');
    expect(after.cancellable).toBe(false);
  });

  it('완료된 분석은 취소할 수 없다(409)', async () => {
    const agent = newAgent();
    const { requestId } = await analyzeToSaved(agent, () => startText(agent, SAMPLE));
    expect((await agent.post(`/api/analyses/${requestId}/cancel`)).status).toBe(409);
  });
});

describe('한도 없음(로컬 모드)', () => {
  it('한 브라우저에서 저장 1건 + 취소 2건 뒤에도 연속 분석이 받아진다(G4 없음)', async () => {
    const agent = newAgent();
    await analyzeToSaved(agent, () => startText(agent, SAMPLE));
    for (let i = 0; i < 2; i++) {
      const r = await startText(agent, SAMPLE);
      await waitStage(agent, r.body.requestId, (x) => x.requestStage === 'awaiting_type');
      await agent.post(`/api/analyses/${r.body.requestId}/cancel`).expect(200);
    }
    // 4·5번째 요청도 201 — 예전 무료 한도(3건)를 넘겨도 막지 않는다
    for (let i = 0; i < 2; i++) {
      const r = await startText(agent, SAMPLE);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body.gate).toBeUndefined();
      await waitStage(agent, r.body.requestId, (x) => x.requestStage === 'awaiting_type');
      await agent.post(`/api/analyses/${r.body.requestId}/cancel`).expect(200);
    }
    expect(await count("SELECT COUNT(*) AS n FROM gate_event WHERE gate_code = 'G4'")).toBe(0);
  });
});

describe('조항 타임아웃(FR-018)', () => {
  it('타임아웃 조항만 분석 불가, 나머지는 결과 제공', async () => {
    stub.config.timeoutMatch = '포인트의 유효기간';
    const agent = newAgent();
    const { runId } = await analyzeToSaved(agent, () => startText(agent, SAMPLE));
    const r = await agent.get(`/api/results/${runId}`).expect(200);
    const un = r.body.clauses.filter((c: { displayCategory: string }) => c.displayCategory === 'unanalyzable');
    expect(un).toHaveLength(1);
    expect(un[0].articleNo).toBe('제28조');
    expect(r.body.counts.unanalyzable).toBe(1);
    expect(r.body.riskOrder.length).toBeGreaterThan(1);
    const d = await agent.get(`/api/results/${runId}/clauses/${un[0].assessmentId}`).expect(200);
    expect(d.body.unanalyzableReason).toBe('timeout');
    expect(d.body.feedbackTypeAllowed).toBe('false_negative');
    // 4.5 다시 분석
    stub.config.timeoutMatch = '';
    const rj = await agent.post(`/api/results/${runId}/clauses/${un[0].assessmentId}/rejudge`);
    expect(rj.status, JSON.stringify(rj.body)).toBe(200);
    expectResponse('web', 'POST', '/results/{runId}/clauses/{assessmentId}/rejudge', 200, rj.body);
    expect(rj.body.displayCategory).not.toBe('unanalyzable');
    // 판정된 조항은 다시 분석할 수 없다(409)
    const again = await agent.post(`/api/results/${runId}/clauses/${un[0].assessmentId}/rejudge`);
    expect(again.status).toBe(409);
  });
});

describe('G8 접근 권한', () => {
  it('다른 브라우저가 결과를 열면 403 G8(not_owner), 없는 결과는 404 G8', async () => {
    const alice = browserAgent();
    const { runId } = await analyzeToSaved(alice, () => startText(alice, SAMPLE));
    const bob = browserAgent();
    const r = await bob.get(`/api/results/${runId}`);
    expect(r.status).toBe(403);
    expectResponse('web', 'GET', '/results/{runId}', 403, r.body);
    expect(r.body.gate).toBe('G8');
    expect(r.body.reason).toContain('다른 계정으로 만든 기록입니다');
    const missing = await bob.get('/api/results/99999999');
    expect(missing.status).toBe(404);
    expectResponse('web', 'GET', '/results/{runId}', 404, missing.body);
    expect(missing.body.gate).toBe('G8');
  });

  it('저장하지 않은 결과는 열 수 없다', async () => {
    const agent = newAgent();
    const r = await startText(agent, SAMPLE);
    const st = await waitStage(agent, r.body.requestId, (x) => x.requestStage === 'awaiting_type');
    await agent.put(`/api/analyses/${r.body.requestId}/documents/${st.documents[0].documentId}/contract-type`).send({ contractType: 'subscription' });
    const done = await waitStage(agent, r.body.requestId, (x) => x.run?.stage === 'completed');
    expect((await agent.get(`/api/results/${done.run.runId}`)).status).toBe(404);
  });
});

describe('콜드 스타트 안내(model-serving §0.1)', () => {
  it('M3·M4 가 cold 이면 C11 이 coldStart·예상 시간을 싣고, 분석은 막지 않는다', async () => {
    stub.warm.M3 = false;
    stub.warm.M4 = false;
    const agent = newAgent();
    const s = await agent.get('/api/model-server/status?refresh=1').expect(200);
    expect(s.body.state).toBe('ready');
    expect(s.body.coldStart).toBe(true);
    expect(s.body.warmupEstimateSec).toBeGreaterThan(0);
    expect((await startText(agent, SAMPLE)).status).toBe(201);
  });

  it('cold 모델을 부르는 동안(loading) 진행 상태에 적재 안내와 경과 시간이 실린다', async () => {
    Object.assign(stub.config, { coldDelayMs: 2500 });
    stub.warm.M3 = false;
    stub.warm.M4 = true;
    const agent = newAgent();
    const r = await startText(agent, SAMPLE);
    const st = await waitStage(agent, r.body.requestId, (x) => x.requestStage === 'awaiting_type');
    await agent.put(`/api/analyses/${r.body.requestId}/documents/${st.documents[0].documentId}/contract-type`).send({ contractType: 'subscription' }).expect(200);
    const seen = await waitFor(
      async () => {
        await agent.get('/api/model-server/status?refresh=1');
        return status(agent, r.body.requestId);
      },
      (x) => x.modelNotice?.kind === 'cold_start' || x.run?.stage === 'completed',
    );
    expect(seen.modelNotice).toMatchObject({ kind: 'cold_start', model: 'M3' });
    expect(seen.modelNotice.estimatedSec).toBeGreaterThan(0);
    expect(seen.elapsedSec).toBeGreaterThanOrEqual(0);
    const done = await waitStage(agent, r.body.requestId, (x) => x.run?.stage === 'completed');
    expect(done.modelNotice).toBeNull();
    Object.assign(stub.config, { coldDelayMs: 0 });
  });
});

void sql;
void select;
void waitFor;
