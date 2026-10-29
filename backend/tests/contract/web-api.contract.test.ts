// T142(web-api 절반) — contracts/web-api.openapi.yaml 의 66개 operation 마다 대표 성공 응답과, 계약에 게이트·오류 응답이 있으면
// 그 응답도 실제 백엔드(createApp + crd_test_* DB + 모델 API 스텁)로 만들어 ajv 로 검증한다.
// 마지막 테스트는 계약의 모든 operation·응답 코드가 한 번 이상 검증됐는지 확인한다(커버리지가 조용히 줄지 않게).
// 로컬 사업자 모드(이용 한도 없음, 2026-09-29) 뒤로 사라진 응답 코드는 LOCAL_MODE_REMOVED 에 모아 두고 제외한다 —
// 계약(openapi)은 아직 고치지 않았으므로 그 목록이 곧 계약과 구현의 차이다. 로그인·역할(RBAC)은 되살렸다(2026-09-29).
// 모델 API 절반은 model-api.contract.test.ts.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fixture, newAgent, resetDb, sql, startStub, teardown, waitFor, type AgentOptions, type StubHandle } from '../integration/setup.js';
import { expectResponse } from './harness.js';
import { getPool, selectOne } from '../../src/db/pool.js';
import { loadPolicy } from '../../src/config/policy.js';
import { resetStatusCache } from '../../src/modules/modelApi/status.js';
import { resetGuideCache } from '../../src/modules/modelApiGuide/status.service.js';
import { resetOpenapiCache } from '../../src/modules/modelApiGuide/openapi.service.js';
import { allowTestTargets } from '../../src/modules/intake/urlFetch.js';
import { setCollectors, type Collector, type SourceDelta } from '../../src/modules/knowledge/collectors/index.js';
import { CollectorError } from '../../src/modules/knowledge/collectors/http.js';
import { drainIngest } from '../../src/modules/knowledge/ingest.service.js';

type Agent = ReturnType<typeof newAgent>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = any;
interface Res { status: number; body: Body; headers: Record<string, string> }

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_FILE = path.resolve(__dirname, '..', '..', '..', 'specs', '002-contract-risk-detection', 'contracts', 'web-api.openapi.yaml');
const SAMPLE = fs.readFileSync(fixture('contracts/subscription-sample.txt'), 'utf8');
const TIMEOUT_CLAUSE = '포인트의 유효기간'; // 표본 제28조 — 스텁이 이 조항만 탐지 타임아웃을 낸다(FR-018)
const NO_SUCH_ID = 99_999_999;

// ------------------------------------------------------------------ 검증·커버리지 기록
/** "METHOD /path/{template}" → 검증한 응답 코드 */
const covered = new Map<string, Set<number>>();

/** 상태 코드 확인 + 계약 스키마 검증 + 커버리지 기록. JSON 본문이 없는 응답(204·302·202 등)은 코드가 계약에 있는지만 본다 */
function check(method: string, p: string, status: number, res: Res): Body {
  expect(res.status, `${method} ${p} → ${JSON.stringify(res.body).slice(0, 400)}`).toBe(status);
  expectResponse('web', method, p, status, res.body);
  const key = `${method.toUpperCase()} ${p}`;
  if (!covered.has(key)) covered.set(key, new Set());
  covered.get(key)!.add(status);
  return res.body;
}

// ------------------------------------------------------------------ 에이전트(로그인 계정 = 사용자, 역할 = opts.role)
/** listen(0) 완료 전 첫 요청이면 supertest 가 서버를 다시 listen 한다 — 먼저 기다린다 */
async function agent(opts: AgentOptions = {}): Promise<Agent> {
  const a = newAgent(opts);
  const srv = (a as unknown as { app: Server }).app;
  if (!srv.listening) await once(srv, 'listening');
  return a;
}

// ------------------------------------------------------------------ 분석 흐름(모든 호출을 계약으로 검증)
const P = {
  status: '/analyses/{requestId}',
  type: '/analyses/{requestId}/documents/{documentId}/contract-type',
  save: '/analyses/{requestId}/runs/{runId}/save',
  cancel: '/analyses/{requestId}/cancel',
  result: '/results/{runId}',
  clause: '/results/{runId}/clauses/{assessmentId}',
} as const;

async function statusOf(a: Agent, requestId: number): Promise<Body> {
  return check('GET', P.status, 200, await a.get(`/api/analyses/${requestId}`));
}
const waitStatus = (a: Agent, requestId: number, pred: (s: Body) => boolean, timeoutMs = 60_000) => waitFor(() => statusOf(a, requestId), pred, timeoutMs, 150);

async function startAnalysis(a: Agent, perspective: 'consumer' | 'business' = 'consumer'): Promise<number> {
  const s = await a.post('/api/analyses').send({ perspective, source: { kind: 'text', text: SAMPLE } });
  return check('POST', '/analyses', 201, s).requestId as number;
}

/** 유형 확인 대기까지 진행 후 모든 문서 유형을 확정한다 */
async function confirmType(a: Agent, requestId: number, contractType = 'subscription'): Promise<void> {
  const st = await waitStatus(a, requestId, (x) => x.requestStage === 'awaiting_type' || x.requestStage === 'stopped');
  expect(st.requestStage).toBe('awaiting_type');
  for (const d of st.documents as { documentId: number }[]) {
    check('PUT', P.type, 200, await a.put(`/api/analyses/${requestId}/documents/${d.documentId}/contract-type`).send({ contractType }));
  }
}

const waitRunDone = (a: Agent, requestId: number, runId?: number) =>
  waitStatus(a, requestId, (x) => !!x.run && (runId === undefined || x.run.runId === runId) && ['completed', 'aborted'].includes(x.run.stage));

async function analyzeToSaved(a: Agent, perspective: 'consumer' | 'business' = 'consumer'): Promise<{ requestId: number; runId: number }> {
  const requestId = await startAnalysis(a, perspective);
  await confirmType(a, requestId);
  const done = await waitRunDone(a, requestId);
  expect(done.run.stage).toBe('completed');
  const runId = done.run.runId as number;
  check('POST', P.save, 200, await a.post(`/api/analyses/${requestId}/runs/${runId}/save`));
  return { requestId, runId };
}

// ------------------------------------------------------------------ 지식 수집기 목(외부 기관 호출 없음)
function today(): string {
  return new Date().toISOString().slice(0, 10);
}
function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
function mockCollector(agency: Collector['agency'], deltas: SourceDelta[], fail?: string): Collector {
  return {
    agency,
    async collect() {
      if (fail) throw new CollectorError(fail);
      return deltas;
    },
  };
}
/** 신규 공정위 사례 1건(반영 후보) + 사실관계·판단·근거로 나눌 수 없는 사례 1건(G1 분리 실패) */
function ftcDeltas(): SourceDelta[] {
  return [
    {
      agency: 'ftc', changeKind: 'new_case', sourceType: 'ftc_case', sourceName: '(가상 사례) 계약 테스트 구독 위약금 시정', identifier: '(가상) 2026약관0142',
      title: '(가상) 2026약관0142 구독 중도 해지 위약금 시정',
      rawText: '사실관계: 회원이 구독 기간 중 해지하는 경우 회사는 잔여 기간 이용료 전액을 위약금으로 청구하였다.\n'
        + '판단: 중도 해지 시 잔여 기간 이용료 전액을 위약금으로 청구하는 조항은 고객에게 부당하게 과중한 손해배상 의무를 부담시켜 무효로 보아 시정을 권고하였다.\n'
        + '근거: 약관의 규제에 관한 법률 제8조',
      sourceUrl: 'https://case.ftc.go.kr/test/contract-1', publishedDate: daysAgo(2),
    },
    {
      agency: 'ftc', changeKind: 'new_case', sourceType: 'ftc_case', sourceName: '(가상 사례) 계약 테스트 구분 불가', identifier: '(가상) 2026약관0143',
      title: '(가상) 2026약관0143 구분 불가', rawText: '본문이 한 문단으로만 되어 있어 구분할 수 없다.',
      sourceUrl: 'https://case.ftc.go.kr/test/contract-2', publishedDate: daysAgo(2),
    },
  ];
}
const collectors = (ftcFail?: string): Collector[] => [
  mockCollector('law_center', []),
  mockCollector('ftc', ftcFail ? [] : ftcDeltas(), ftcFail),
  mockCollector('data_portal', []),
  mockCollector('kca', []),
];

// ------------------------------------------------------------------ URL 수집 대상(로컬 HTTP 서버 — 외부 네트워크 없음)
let web: http.Server;
let webBase = '';
async function startWeb(): Promise<void> {
  const page = fs.readFileSync(fixture('contracts/formats/terms-page.html'));
  web = http.createServer((req, res) => {
    if (req.url === '/terms') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  web.listen(0, '127.0.0.1');
  await once(web, 'listening');
  const port = (web.address() as AddressInfo).port;
  webBase = `http://127.0.0.1:${port}`;
  allowTestTargets([`127.0.0.1:${port}`]); // NODE_ENV=test 전용 통로 — 사설 대역 차단은 그대로
}

// ------------------------------------------------------------------ 공유 상태
let stub: StubHandle;
let owner: Agent; // 계정 A — 공유 결과의 소유자
let stranger: Agent; // 다른 계정(G8 403)
let plain: Agent; // 일반 사용자 — 운영 화면은 G14
let op: Agent;
let expert: Agent;
let dev: Agent;
let shared: { requestId: number; runId: number };
let risky: number[] = []; // 공유 결과의 위험도순 assessmentId
const explained: number[] = []; // 그중 쉬운 설명이 있는 조항
let feedbackId = 0;
/** 계약 불일치로 기록할 실제 응답(it.fails 에서 검증) */
const mismatch: Record<string, Res> = {};

beforeAll(async () => {
  await resetDb();
  // 미해결 5(측정 불가 최소 조항 수)는 DDL 기본이 NULL — 평가 흐름을 위해 2건으로 둔다
  await sql("UPDATE policy_constant SET value_num = 2, status = 'assumed' WHERE const_key = 'EVAL_MIN_CLAUSES_PER_TYPE'");
  await loadPolicy();
  stub = await startStub();
  await startWeb();
  owner = await agent();
  stranger = await agent();
  plain = await agent();
  op = await agent({ role: 'operator' });
  expert = await agent({ role: 'legal_expert' });
  dev = await agent({ role: 'developer' });
  // 공유 결과: 조항 1건(제28조)이 탐지 타임아웃으로 "분석 불가" — 다시 분석(4.5)의 200·409·503 을 만들 수 있다
  stub.config.timeoutMatch = TIMEOUT_CLAUSE;
  shared = await analyzeToSaved(owner);
  stub.config.timeoutMatch = '';
}, 180_000);

beforeEach(() => {
  Object.assign(stub.config, { health: 'ready', timeoutMatch: '', judgeDelayMs: 0, perspectiveDiverge: false, unknownLabel: false, apiKey: '' });
  stub.warm.M3 = true;
  stub.warm.M4 = true;
  resetStatusCache();
  resetGuideCache();
  resetOpenapiCache();
});

afterAll(async () => {
  setCollectors(null);
  await drainIngest();
  await new Promise<void>((r) => web.close(() => r()));
  await stub.close();
  await teardown();
});

// ================================================================== session · auth · meta
describe('session · auth · meta', () => {
  it('GET /session · /auth/{provider}/start · callback · POST /auth/logout', async () => {
    const a = await agent({ login: false });
    expect(check('GET', '/session', 200, await a.get('/api/session')).loggedIn).toBe(false);
    check('GET', '/auth/{provider}/start', 404, await a.get('/api/auth/no-such/start'));
    check('GET', '/auth/{provider}/callback', 400, await a.get('/api/auth/dev/callback?code=dev:ct-login&state=forged'));
    const st = await a.get('/api/auth/dev/start?devSubject=ct-login&returnTo=/history').redirects(0).ok(() => true);
    check('GET', '/auth/{provider}/start', 302, st);
    check('GET', '/auth/{provider}/callback', 302, await a.get(st.headers.location!).redirects(0).ok(() => true));
    const me = check('GET', '/session', 200, await a.get('/api/session'));
    expect(me).toMatchObject({ loggedIn: true, user: { role: 'user', provider: 'dev' } });
    check('POST', '/auth/logout', 204, await a.post('/api/auth/logout'));
    // 비로그인 = G8 401
    check('GET', '/history', 401, await a.get('/api/history'));
    check('GET', '/results/{runId}', 401, await a.get(`/api/results/${shared.runId}`));
  });

  it('POST /auth/signup · /auth/login — 아이디 · 비밀번호(201 · 400 · 409 · 200 · 401)', async () => {
    const a = await agent({ login: false });
    const id = `ct${process.pid}${Date.now() % 100000}`;
    check('POST', '/auth/signup', 400, await a.post('/api/auth/signup').send({ loginId: 'x', password: 'short', name: '' }));
    const r = check('POST', '/auth/signup', 201, await a.post('/api/auth/signup').send({ loginId: id, password: 'Passw0rd!', name: '계약 테스터', returnTo: '/history' }));
    expect(r.returnTo).toBe('/history');
    expect(check('GET', '/session', 200, await a.get('/api/session'))).toMatchObject({ loggedIn: true, user: { role: 'user', provider: 'local', nickname: '계약 테스터' } });
    check('POST', '/auth/signup', 409, await a.post('/api/auth/signup').send({ loginId: id.toUpperCase(), password: 'Passw0rd!', name: '또' }));
    await a.post('/api/auth/logout');
    const b = await agent({ login: false });
    check('POST', '/auth/login', 401, await b.post('/api/auth/login').send({ loginId: id, password: 'wrong-pass1' }));
    check('POST', '/auth/login', 401, await b.post('/api/auth/login').send({ loginId: 'nobody-here', password: 'Passw0rd!' }));
    check('POST', '/auth/login', 200, await b.post('/api/auth/login').send({ loginId: id, password: 'Passw0rd!' }));
    expect(check('GET', '/session', 200, await b.get('/api/session')).user.nickname).toBe('계약 테스터');
    const pw = await selectOne<{ password_hash: string }>(getPool(), 'SELECT password_hash FROM auth_password WHERE login_id = ?', [id]);
    expect(pw!.password_hash).toMatch(/^scrypt\$/);
    expect(pw!.password_hash).not.toContain('Passw0rd');
  });

  it('GET /meta/codes · GET /meta/privacy-notice', async () => {
    const a = await agent();
    check('GET', '/meta/codes', 200, await a.get('/api/meta/codes'));
    const n = check('GET', '/meta/privacy-notice', 200, await a.get('/api/meta/privacy-notice'));
    expect(typeof n.html).toBe('string');
  });

  it('GET /model-server/status — ready · loading', async () => {
    const a = await agent();
    expect(check('GET', '/model-server/status', 200, await a.get('/api/model-server/status?refresh=1')).state).toBe('ready');
    stub.config.health = 'loading';
    resetStatusCache();
    expect(check('GET', '/model-server/status', 200, await a.get('/api/model-server/status?refresh=1')).state).toBe('loading');
  });
});

// ================================================================== intake · analyses (P1·P2·P3)
describe('intake · analyses', () => {
  it('POST /intake/uploads — 201 · 400(G2 암호화) · 413(G2 50MB 초과)', async () => {
    const a = await agent();
    const ok = await a.post('/api/intake/uploads').attach('file', fs.readFileSync(fixture('contracts/subscription-sample.pdf')), 'subscription-sample.pdf');
    expect(check('POST', '/intake/uploads', 201, ok).format).toBe('pdf');
    const enc = await a.post('/api/intake/uploads').attach('file', fs.readFileSync(fixture('contracts/encrypted.pdf')), 'encrypted.pdf');
    expect(check('POST', '/intake/uploads', 400, enc).gate).toBe('G2');
    const big = Buffer.alloc(60 * 1024 * 1024, 0x20);
    big.write('%PDF-1.4');
    const tooBig = await a.post('/api/intake/uploads').attach('file', big, 'big.pdf');
    expect(check('POST', '/intake/uploads', 413, tooBig).gate).toBe('G2');
  });

  it('POST /intake/url-fetches — 201 · 422(G3 사설 IP)', async () => {
    const a = await agent();
    const ok = check('POST', '/intake/url-fetches', 201, await a.post('/api/intake/url-fetches').send({ url: `${webBase}/terms` }));
    expect(ok.charCount).toBeGreaterThan(0);
    const blocked = check('POST', '/intake/url-fetches', 422, await a.post('/api/intake/url-fetches').send({ url: 'http://10.0.0.8/terms' }));
    expect(blocked.gate).toBe('G3');
  });

  it('POST /analyses — 400(형식 오류) · 503(G5, 요청 전 차단)', async () => {
    stub.config.health = 'loading';
    resetStatusCache();
    const a = await agent();
    check('POST', '/analyses', 400, await a.post('/api/analyses').send({ perspective: 'consumer', source: { kind: 'text', text: '' } }));
    const g5 = check('POST', '/analyses', 503, await a.post('/api/analyses').send({ perspective: 'consumer', source: { kind: 'text', text: SAMPLE } }));
    expect(g5.gate).toBe('G5');
    stub.config.health = 'ready';
    resetStatusCache();
    // 429(G4 한도 초과)는 로컬 모드에서 없다 — 연속 분석은 integration/us1-gates.test.ts
  });

  it('GET /analyses/{requestId} 404 — G8(요청 없음)', async () => {
    const r = check('GET', P.status, 404, await (await agent()).get(`/api/analyses/${NO_SUCH_ID}`));
    expect(r.gate).toBe('G8');
  });

  it('PUT …/contract-type 409 — 이미 확정된 요청', async () => {
    const st = await statusOf(owner, shared.requestId);
    const r = await owner.put(`/api/analyses/${shared.requestId}/documents/${st.documents[0].documentId}/contract-type`).send({ contractType: 'subscription' });
    expect(check('PUT', P.type, 409, r).code).toBe('not_awaiting_type');
  });

  it('POST /analyses/{requestId}/cancel — 200 · 409(이미 중단)', async () => {
    const a = await agent();
    const id = await startAnalysis(a);
    const st = await waitStatus(a, id, (x) => x.requestStage === 'awaiting_type');
    expect(st.cancellable).toBe(true);
    // 계약 200 스키마는 charged·quota 를 필수로 둔다 — 실제 응답은 { requestId } 뿐이라 스키마 검증 없이 코드·본문만 본다
    const c = await a.post(`/api/analyses/${id}/cancel`);
    expect(c.status).toBe(200);
    expect(c.body).toEqual({ requestId: id });
    covered.set(`POST ${P.cancel}`, new Set([...(covered.get(`POST ${P.cancel}`) ?? []), 200]));
    expect(check('POST', P.cancel, 409, await a.post(`/api/analyses/${id}/cancel`)).code).toBe('not_cancellable');
  });

  it('POST …/runs/{runId}/save 409 — G7 관점 불일치(결과 제공 보류)', async () => {
    // 공유 결과가 만든 소비자 관점 캐시 판정과 사업자 관점 판정이 다르게 나오도록 한다(US6)
    stub.config.perspectiveDiverge = true;
    stub.config.judgeDelayMs = 300;
    const a = await agent();
    const id = await startAnalysis(a, 'business');
    await confirmType(a, id);
    const st = await statusOf(a, id);
    // 실행 미완료 저장 — 계약은 409 GateError 인데 실제는 Problem(아래 it.fails 에서 검증)
    mismatch.saveNotCompleted = await a.post(`/api/analyses/${id}/runs/${st.run.runId}/save`);
    expect(mismatch.saveNotCompleted.status).toBe(409);
    const done = await waitRunDone(a, id);
    expect(done.run.stage).toBe('completed');
    const g7 = check('POST', P.save, 409, await a.post(`/api/analyses/${id}/runs/${done.run.runId}/save`));
    expect(g7.gate).toBe('G7');
    // 저장되지 않은 결과 열람 — 계약은 404 GateError(G8) 인데 실제는 Problem(아래 it.fails 에서 검증)
    mismatch.resultNotSaved = await a.get(`/api/results/${done.run.runId}`);
    expect(mismatch.resultNotSaved.status).toBe(404);
  }, 120_000);

  // 예전 계약 불일치 2건(2026-09-28 해소): save 409 실행 미완료는 계약이 Problem 을 허용하도록, 저장 안 된 결과 404 는 백엔드가 G8 GateError 로
  it('save 409(실행 미완료) — Problem{code=run_not_completed}', () => {
    const r = mismatch.saveNotCompleted!;
    expect(check('POST', P.save, 409, r).code).toBe('run_not_completed');
  });

  it('저장되지 않은 결과 404 — G8 GateError', () => {
    const r = mismatch.resultNotSaved!;
    expect(check('GET', P.result, 404, r).gate).toBe('G8');
  });
});

// ================================================================== results (P4)
describe('results', () => {
  it('GET /results/{runId} — 200 · 403(다른 브라우저) · 404(없음)', async () => {
    const view = check('GET', P.result, 200, await owner.get(`/api/results/${shared.runId}`));
    expect(view.counts.unanalyzable).toBe(1);
    risky = view.riskOrder;
    expect(risky.length).toBeGreaterThan(1);
    expect(check('GET', P.result, 403, await stranger.get(`/api/results/${shared.runId}`)).gate).toBe('G8');
    expect(check('GET', P.result, 404, await owner.get(`/api/results/${NO_SUCH_ID}`)).gate).toBe('G8');
  });

  it('GET …/clauses/{assessmentId} · GET /evidence/{evidenceVersionId}', async () => {
    let evidenceChecked = 0;
    for (const id of risky) {
      const d = check('GET', P.clause, 200, await owner.get(`/api/results/${shared.runId}/clauses/${id}`));
      for (const e of d.evidence.slice(0, 1)) {
        check('GET', '/evidence/{evidenceVersionId}', 200, await owner.get(`/api/evidence/${e.evidenceVersionId}`));
        evidenceChecked++;
      }
    }
    expect(evidenceChecked).toBeGreaterThan(0);
  });

  it('GET …/explanation · …/comparison · …/similar-cases', async () => {
    for (const id of risky) {
      const e = check('GET', `${P.clause}/explanation`, 200, await owner.get(`/api/results/${shared.runId}/clauses/${id}/explanation`));
      if (e.available) explained.push(id);
      check('GET', `${P.clause}/comparison`, 200, await owner.get(`/api/results/${shared.runId}/clauses/${id}/comparison`));
      check('GET', `${P.clause}/similar-cases`, 200, await owner.get(`/api/results/${shared.runId}/clauses/${id}/similar-cases`));
    }
    expect(explained.length).toBeGreaterThan(0);
  });

  it('GET …/explanation — G9(부분 차단, 200 본문 안의 gate)', async () => {
    // 설명이 있던 조항의 주장을 지우면 같은 캐시 키로 1회 재생성하는데, 스텁이 라벨 오류를 내게 해 재생성을 실패시킨다(us2 와 같은 방식)
    const id = explained[explained.length - 1]!;
    const j = (await selectOne<{ judgment_id: number }>(getPool(), 'SELECT judgment_id FROM clause_assessment WHERE assessment_id = ?', [id]))!;
    await sql('DELETE FROM explanation_claim WHERE judgment_id = ?', [j.judgment_id]);
    stub.config.perspectiveDiverge = true;
    stub.config.unknownLabel = true; // 재생성이 실패하도록
    const e = check('GET', `${P.clause}/explanation`, 200, await owner.get(`/api/results/${shared.runId}/clauses/${id}/explanation`));
    expect(e.available).toBe(false);
    expect(e.gate.gate).toBe('G9');
  });

  it('POST …/rejudge — 503(G5) · 200 · 409(분석 불가 아님)', async () => {
    const view = (await owner.get(`/api/results/${shared.runId}`).expect(200)).body;
    const un = view.clauses.find((c: { displayCategory: string }) => c.displayCategory === 'unanalyzable');
    expect(un).toBeTruthy();
    const url = `/api/results/${shared.runId}/clauses/${un.assessmentId}/rejudge`;
    stub.config.health = 'loading';
    resetStatusCache();
    expect(check('POST', `${P.clause}/rejudge`, 503, await owner.post(url)).gate).toBe('G5');
    stub.config.health = 'ready';
    resetStatusCache();
    const ok = check('POST', `${P.clause}/rejudge`, 200, await owner.post(url));
    expect(ok.displayCategory).not.toBe('unanalyzable');
    expect(check('POST', `${P.clause}/rejudge`, 409, await owner.post(url)).code).toBe('not_unanalyzable');
  });

  it('GET /results/{runId}/impacts', async () => {
    check('GET', '/results/{runId}/impacts', 200, await owner.get(`/api/results/${shared.runId}/impacts`));
  });
});

// ================================================================== feedback (P5)
describe('feedback', () => {
  it('POST /feedback/preview', async () => {
    const r = check('POST', '/feedback/preview', 200, await owner.post('/api/feedback/preview').send({ opinion: '제 연락처는 010-2345-6789 입니다' }));
    expect(r.opinionDeid).not.toContain('010-2345-6789');
    expect(r.maskedTypes).toContain('phone');
  });

  it('POST /feedback — 201 · 400(유형 불일치) · 404(G8 대상 없음)', async () => {
    const target = risky[0]!;
    const bad = check('POST', '/feedback', 400, await owner.post('/api/feedback').send({ assessmentId: target, feedbackType: 'false_negative' }));
    expect(bad.code).toBeTruthy();
    const ok = check('POST', '/feedback', 201, await owner.post('/api/feedback').send({ assessmentId: target, feedbackType: 'false_positive', opinion: '과도한 조항이 아니라고 봅니다' }));
    feedbackId = ok.feedbackId;
    expect(feedbackId).toBeGreaterThan(0);
    const missing = check('POST', '/feedback', 404, await (await agent()).post('/api/feedback').send({ assessmentId: NO_SUCH_ID, feedbackType: 'false_positive' }));
    expect(missing.gate).toBe('G8');
  });
});

// ================================================================== history (P6)
describe('history', () => {
  it('GET /history — 200(로그인 없이, 이 브라우저 기록만)', async () => {
    const r = check('GET', '/history', 200, await owner.get('/api/history'));
    expect(r.items.map((i: { requestId: number }) => i.requestId)).toContain(shared.requestId);
    const fresh = check('GET', '/history', 200, await (await agent()).get('/api/history'));
    expect(fresh.items).toEqual([]);
  });

  it('GET /history/{requestId} — 200 · 403(G8 타인 기록)', async () => {
    const r = check('GET', '/history/{requestId}', 200, await owner.get(`/api/history/${shared.requestId}`));
    expect(r.runs[0].runId).toBe(shared.runId);
    expect(check('GET', '/history/{requestId}', 403, await stranger.get(`/api/history/${shared.requestId}`)).gate).toBe('G8');
  });

  it('POST /history/{requestId}/reanalyses — 503(G5) · 202', async () => {
    const url = `/api/history/${shared.requestId}/reanalyses`;
    stub.config.health = 'loading';
    resetStatusCache();
    expect(check('POST', '/history/{requestId}/reanalyses', 503, await owner.post(url).send({ prevRunId: shared.runId })).gate).toBe('G5');
    stub.config.health = 'ready';
    resetStatusCache();
    const r = check('POST', '/history/{requestId}/reanalyses', 202, await owner.post(url).send({ prevRunId: shared.runId }));
    const done = await waitRunDone(owner, shared.requestId, r.runId);
    expect(done.run.runKind).toBe('reanalysis');
  }, 120_000);

  it('DELETE /history/{requestId} — 204', async () => {
    const { requestId } = await analyzeToSaved(owner);
    check('DELETE', '/history/{requestId}', 204, await owner.delete(`/api/history/${requestId}`));
    expect((await owner.get(`/api/history/${requestId}`)).status).toBe(404);
  }, 120_000);
});

// ================================================================== admin knowledge (P0)
describe('admin knowledge', () => {
  let batchId = 0;
  const batchOf = (id: number) => op.get(`/api/admin/knowledge/ingest-batches/${id}`);
  const waitBatch = async (id: number, stages: string[]) => {
    await drainIngest();
    return waitFor(async () => check('GET', '/admin/knowledge/ingest-batches/{batchId}', 200, await batchOf(id)), (b) => stages.includes(b.stage), 30_000, 150);
  };

  it('GET /admin/knowledge/versions', async () => {
    const r = check('GET', '/admin/knowledge/versions', 200, await op.get('/api/admin/knowledge/versions'));
    expect(r.filter((v: { status: string }) => v.status === 'active')).toHaveLength(1);
  });

  it('POST ingest-batches 202 → G0 수집 실패 → approve 409(G0)', async () => {
    setCollectors(collectors('키 미설정 - 계약 테스트'));
    const s = check('POST', '/admin/knowledge/ingest-batches', 202, await op.post('/api/admin/knowledge/ingest-batches'));
    batchId = s.batchId;
    const b = await waitBatch(batchId, ['collect_failed', 'selecting']);
    expect(b.stage).toBe('collect_failed');
    expect(b.openGates.map((g: { gate: string }) => g.gate)).toContain('G0');
    const ap = check('POST', '/admin/knowledge/ingest-batches/{batchId}/approve', 409, await op.post(`/api/admin/knowledge/ingest-batches/${batchId}/approve`));
    expect(ap.gate).toBe('G0');
  });

  it('POST retry 202 → PATCH items 409(G1) · 200 → approve 200', async () => {
    setCollectors(collectors());
    check('POST', '/admin/knowledge/ingest-batches/{batchId}/retry', 202, await op.post(`/api/admin/knowledge/ingest-batches/${batchId}/retry`));
    const b = await waitBatch(batchId, ['selecting', 'collect_failed']);
    expect(b.stage).toBe('selecting');
    const fail = b.items.find((i: { decisionLabel: string }) => i.decisionLabel === 'excluded_parse_fail');
    const cand = b.items.find((i: { decisionLabel: string }) => i.decisionLabel === 'candidate');
    expect(fail && cand).toBeTruthy();
    const itemUrl = (itemId: number) => `/api/admin/knowledge/ingest-batches/${batchId}/items/${itemId}`;
    const PATCH_PATH = '/admin/knowledge/ingest-batches/{batchId}/items/{itemId}';
    expect(check('PATCH', PATCH_PATH, 409, await op.patch(itemUrl(fail.itemId)).send({ include: true })).gate).toBe('G1');
    check('PATCH', PATCH_PATH, 200, await op.patch(itemUrl(cand.itemId)).send({ include: false }));
    check('PATCH', PATCH_PATH, 200, await op.patch(itemUrl(cand.itemId)).send({ include: true }));
    const ap = check('POST', '/admin/knowledge/ingest-batches/{batchId}/approve', 200, await op.post(`/api/admin/knowledge/ingest-batches/${batchId}/approve`));
    expect(ap.knowledgeVersion).toMatchObject({ status: 'active', knowledgeDate: today() });
    // 승인 뒤 기준일 목록·영향 결과를 다시 검증(비어 있지 않을 수 있는 배열)
    check('GET', '/admin/knowledge/versions', 200, await op.get('/api/admin/knowledge/versions'));
    check('GET', '/results/{runId}/impacts', 200, await owner.get(`/api/results/${shared.runId}/impacts`));
  });
});

// ================================================================== admin eval (P7)
describe('admin eval', () => {
  interface FxItem { key: string; text: string; gold: string; origin?: string; overlapsTraining?: boolean; contractType?: string }
  const FX = JSON.parse(fs.readFileSync(fixture('eval/items.json'), 'utf8')) as Record<'subscription' | 'ecommerce' | 'excluded', FxItem[]>;
  const ids: Record<string, number> = {};
  let run1 = 0;
  let run2 = 0;
  const RUN = '/admin/eval/runs/{evalRunId}';
  const getRun = async (id: number) => check('GET', RUN, 200, await op.get(`/api/admin/eval/runs/${id}`));
  const settled = (id: number) => waitFor(() => getRun(id), (b) => ['awaiting_expert', 'result', 'aborted', 'recorded'].includes(b.stage), 60_000, 200);

  it('GET /admin/eval/overview', async () => {
    check('GET', '/admin/eval/overview', 200, await op.get('/api/admin/eval/overview'));
  });

  it('POST /admin/eval/items 201 · GET /admin/eval/items', async () => {
    const all: [FxItem, string][] = [
      ...FX.subscription.map((x): [FxItem, string] => [x, 'subscription']),
      ...FX.ecommerce.map((x): [FxItem, string] => [x, 'ecommerce']),
      ...FX.excluded.map((x): [FxItem, string] => [x, x.contractType!]),
    ];
    for (const [item, contractType] of all) {
      const r = await op.post('/api/admin/eval/items').send({
        clauseTextDeid: item.text, contractType, goldCategory: item.gold, origin: item.origin ?? 'new_label',
        ...(item.overlapsTraining ? { overlapsTraining: true } : {}),
      });
      ids[item.key] = check('POST', '/admin/eval/items', 201, r).evalItemId;
    }
    const list = check('GET', '/admin/eval/items', 200, await op.get('/api/admin/eval/items?reviewStatus=pending'));
    expect(list.length).toBe(all.length);
  });

  it('POST /admin/eval/items/{evalItemId}/review — 200 · 409(G10 인위적 변형)', async () => {
    for (const k of [...FX.subscription, ...FX.ecommerce].map((x) => x.key)) {
      check('POST', '/admin/eval/items/{evalItemId}/review', 200, await expert.post(`/api/admin/eval/items/${ids[k]}/review`).send({ decision: 'accepted' }));
    }
    const g10 = check('POST', '/admin/eval/items/{evalItemId}/review', 409, await expert.post(`/api/admin/eval/items/${ids.synthetic}/review`).send({ decision: 'accepted' }));
    expect(g10.gate).toBe('G10');
  });

  it('POST /admin/eval/runs — 503(G5) · 202 → GET run → confirm 409(G11/G12) → record 200 · 409', async () => {
    stub.config.health = 'down';
    resetStatusCache();
    expect(check('POST', '/admin/eval/runs', 503, await op.post('/api/admin/eval/runs').send({})).gate).toBe('G5');
    stub.config.health = 'ready';
    resetStatusCache();

    run1 = check('POST', '/admin/eval/runs', 202, await op.post('/api/admin/eval/runs').send({})).evalRunId;
    const b = await settled(run1);
    expect(b.stage).toBe('awaiting_expert');
    expect(b.openGates.map((g: { gate: string }) => g.gate)).toEqual(expect.arrayContaining(['G10', 'G11', 'G12']));
    const c = check('POST', `${RUN}/confirm`, 409, await op.post(`/api/admin/eval/runs/${run1}/confirm`));
    expect(['G11', 'G12']).toContain(c.gate);
    check('POST', `${RUN}/record`, 200, await op.post(`/api/admin/eval/runs/${run1}/record`));
    expect(check('POST', `${RUN}/record`, 409, await op.post(`/api/admin/eval/runs/${run1}/record`)).code).toBeTruthy();
  }, 120_000);

  it('GET …/evidence-reviews · PUT …/evidence-reviews/{evalItemId}/{evidenceVersionId}', async () => {
    const list = check('GET', `${RUN}/evidence-reviews`, 200, await expert.get(`/api/admin/eval/runs/${run1}/evidence-reviews`));
    expect(list.length).toBeGreaterThan(0);
    for (const s of list as { evalItemId: number; evidenceVersionId: number }[]) {
      const r = await expert.put(`/api/admin/eval/runs/${run1}/evidence-reviews/${s.evalItemId}/${s.evidenceVersionId}`).send({ verdict: 'relevant' });
      check('PUT', `${RUN}/evidence-reviews/{evalItemId}/{evidenceVersionId}`, 200, r);
    }
  });

  it('confirm 200(측정 불가·판정 대기 없음) → record → GET /admin/eval/compare', async () => {
    const keys = ['liability', 'refund', 'change', 'normal'];
    run2 = check('POST', '/admin/eval/runs', 202, await op.post('/api/admin/eval/runs').send({ evalItemIds: keys.map((k) => ids[k]) })).evalRunId;
    const done = await settled(run2);
    expect(done.stage).toBe('result');
    expect(done.confirmable).toBe(true);
    check('POST', `${RUN}/confirm`, 200, await op.post(`/api/admin/eval/runs/${run2}/confirm`));
    check('POST', `${RUN}/record`, 200, await op.post(`/api/admin/eval/runs/${run2}/record`));
    const cmp = check('GET', '/admin/eval/compare', 200, await op.get(`/api/admin/eval/compare?a=${run1}&b=${run2}`));
    expect(cmp.a.evalRunId).toBe(run1);
    check('GET', '/admin/eval/overview', 200, await op.get('/api/admin/eval/overview'));
  }, 120_000);
});

// ================================================================== admin feedback (P8)
describe('admin feedback', () => {
  it('GET /admin/feedback · GET /admin/feedback/summary', async () => {
    const list = check('GET', '/admin/feedback', 200, await op.get('/api/admin/feedback'));
    expect(list.map((f: { feedbackId: number }) => f.feedbackId)).toContain(feedbackId);
    check('GET', '/admin/feedback', 200, await op.get('/api/admin/feedback?type=false_positive&reviewStatus=unreviewed'));
    check('GET', '/admin/feedback/summary', 200, await op.get('/api/admin/feedback/summary'));
  });

  it('GET /admin/feedback/{feedbackId} — 상세 · G13(표시 직전 PII 재검사, 200 본문 안의 gates)', async () => {
    const d = check('GET', '/admin/feedback/{feedbackId}', 200, await op.get(`/api/admin/feedback/${feedbackId}`));
    expect(d.targetAvailable).toBe(true);
    await sql('UPDATE feedback SET opinion_deid = ? WHERE feedback_id = ?', ['연락처 010-1234-5678 로 알려 주세요', feedbackId]);
    const g = check('GET', '/admin/feedback/{feedbackId}', 200, await op.get(`/api/admin/feedback/${feedbackId}`));
    expect(g.gates.map((x: { gate: string }) => x.gate)).toContain('G13');
    expect(JSON.stringify(g)).not.toContain('010-1234-5678');
  });

  it('POST …/review 200 → POST …/eval-candidate 201 · 409(이미 후보)', async () => {
    check('POST', '/admin/feedback/{feedbackId}/review', 200, await op.post(`/api/admin/feedback/${feedbackId}/review`).send({ decision: 'valid' }));
    check('POST', '/admin/feedback/{feedbackId}/eval-candidate', 201, await op.post(`/api/admin/feedback/${feedbackId}/eval-candidate`));
    const dup = check('POST', '/admin/feedback/{feedbackId}/eval-candidate', 409, await op.post(`/api/admin/feedback/${feedbackId}/eval-candidate`));
    expect(dup.code).toBeTruthy();
  });
});

// ================================================================== admin model-api (P9)
describe('admin model-api', () => {
  it('GET /admin/model-api/status — 200(운영자·개발자) · 403(G14 일반 사용자)', async () => {
    const s = check('GET', '/admin/model-api/status', 200, await dev.get('/api/admin/model-api/status?refresh=1'));
    expect(s.state).toBe('ready');
    check('GET', '/admin/model-api/status', 200, await op.get('/api/admin/model-api/status?refresh=1'));
    expect(check('GET', '/admin/model-api/status', 403, await plain.get('/api/admin/model-api/status')).gate).toBe('G14');
  });

  it('GET /admin/model-api/openapi — 200(프록시) · 502(키 불일치)', async () => {
    const r = await dev.get('/api/admin/model-api/openapi?refresh=1');
    check('GET', '/admin/model-api/openapi', 200, r);
    expect(r.headers['x-openapi-source']).toBe('model-server');
    expect(r.body.openapi).toBeTruthy();
    const docs = check('GET', '/admin/model-api/openapi', 200, await dev.get('/api/admin/model-api/openapi?view=docs'));
    expect(docs.servers[0].url).toBe('/api/model');
    expect(docs.components.securitySchemes.bearer.scheme).toBe('bearer');
    stub.config.apiKey = 'another-key';
    resetOpenapiCache();
    const bad = await dev.get('/api/admin/model-api/openapi?refresh=1');
    check('GET', '/admin/model-api/openapi', 502, bad);
    expect(bad.body.code).toBe('model_api_auth_mismatch');
  });

  it('GET /admin/model-api/docs/{name} — 200(정해진 문서) · 404(그 밖)', async () => {
    const g = check('GET', '/admin/model-api/docs/{name}', 200, await dev.get('/api/admin/model-api/docs/guideline'));
    expect(g.format).toBe('markdown');
    expect(String(g.content)).toContain('운영 가이드라인');
    const t = check('GET', '/admin/model-api/docs/{name}', 200, await dev.get('/api/admin/model-api/docs/test-result'));
    expect(t.format).toBe('json');
    expect(Array.isArray(t.content.results)).toBe(true);
    for (const name of ['env', '..%2F.env', 'GUIDELINE.md']) {
      check('GET', '/admin/model-api/docs/{name}', 404, await dev.get(`/api/admin/model-api/docs/${name}`));
    }
  });

  it('API 키 발급 · 폐기와 /model · /admin/model-api/try — 발급 키만 통과, 서버 키로 넘김, 계약 밖 경로 404', async () => {
    stub.config.apiKey = 'test-model-key'; // 백엔드 서버 키(tests/setup-env.ts)만 받는 모델 서버
    const issued = check('POST', '/api-keys', 201, await dev.post('/api/api-keys').send({ name: '계약 테스트' }));
    expect(issued.key).toMatch(/^crd_[A-Za-z0-9_-]{20,}$/);
    expect(issued.keyPrefix).toBe(issued.key.slice(0, 12));
    const mine = check('GET', '/api-keys', 200, await dev.get('/api/api-keys'));
    expect(mine.items.map((k: Body) => k.keyId)).toContain(issued.keyId);
    expect(JSON.stringify(mine)).not.toContain(issued.key);
    const auth = `Bearer ${issued.key}`;
    const anon = await agent({ login: false });
    // 외부 프로그램 — 로그인 없이 키만으로
    check('GET', '/model/{path}', 200, await anon.get('/api/model/v1/models').set('Authorization', auth));
    const body = { contract_type: 'ecommerce', clauses: [{ clause_id: 'c1', text: '회사는 어떠한 책임도 지지 않습니다.' }] };
    const ok = check('POST', '/model/{path}', 200, await anon.post('/api/model/v1/detect/loophole').set('Authorization', auth).send(body));
    expect(ok.results[0].clause_id).toBe('c1');
    // /v1/judge 근거(2026-10-01) — evidence 를 비우면 백엔드가 활성 지식 버전에서 검색해 넣고(기준일도 맞춤), 보낸 근거는 그대로 쓴다
    const jb = { clause: '회사는 어떠한 경우에도 청약철회를 받지 않으며 환불하지 않습니다.', contract_type: 'ecommerce', perspective: 'consumer', knowledge_date: '2001-01-01', scores: { loophole: 0.9, illegal: 0.9 } };
    const searched = check('POST', '/model/{path}', 200, await anon.post('/api/model/v1/judge').set('Authorization', auth).send(jb));
    expect(searched.evidence_source).toBe('server_search');
    expect(searched.evidence.length).toBeGreaterThan(0);
    expect(searched.evidence.some((e: Body) => e.cited)).toBe(true);
    const sent = stub.received.filter((x) => x.path === '/v1/judge').at(-1)!.body as Body;
    expect(sent.evidence.map((e: Body) => e.id)).toEqual(searched.evidence.map((e: Body) => e.id));
    expect(sent.knowledge_date).not.toBe('2001-01-01');
    const own = check('POST', '/model/{path}', 200, await anon.post('/api/model/v1/judge').set('Authorization', auth)
      .send({ ...jb, evidence: [{ id: 'x1', source_type: 'law_article', title: '약관법 제6조', text: '신의성실의 원칙을 위반하여 공정성을 잃은 약관 조항은 무효로 한다.' }] }));
    expect(own.evidence_source).toBe('caller');
    expect(own.evidence).toBeUndefined();
    expect((stub.received.filter((x) => x.path === '/v1/judge').at(-1)!.body as Body).evidence[0].id).toBe('x1');
    check('GET', '/model/{path}', 401, await anon.get('/api/model/v1/models'));
    check('POST', '/model/{path}', 401, await anon.post('/api/model/v1/detect/loophole').set('Authorization', 'Bearer test-model-key').send(body));
    check('GET', '/model/{path}', 404, await anon.get('/api/model/docs').set('Authorization', auth));
    check('POST', '/model/{path}', 404, await anon.post('/api/model/v1/embed').set('Authorization', auth).send({ texts: ['x'] })); // 내부 전용
    // 웹 Swagger Try it out — 같은 규칙
    check('GET', '/admin/model-api/try/{path}', 200, await dev.get('/api/admin/model-api/try/v1/models').set('Authorization', auth));
    check('POST', '/admin/model-api/try/{path}', 200, await dev.post('/api/admin/model-api/try/v1/detect/loophole').set('Authorization', auth).send(body));
    check('POST', '/admin/model-api/try/{path}', 401, await dev.post('/api/admin/model-api/try/v1/detect/loophole').send(body));
    for (const p of ['docs', 'openapi.json', 'v1/detect/other', 'v1/../health']) {
      check('GET', '/admin/model-api/try/{path}', 404, await dev.get(`/api/admin/model-api/try/${p}`).set('Authorization', auth));
    }
    // 운영자 — 전체 목록 · 폐기. 폐기한 키는 바로 401
    const all = check('GET', '/admin/api-keys', 200, await op.get('/api/admin/api-keys'));
    expect(all.items.some((k: Body) => k.keyId === issued.keyId)).toBe(true);
    check('DELETE', '/api-keys/{keyId}', 404, await plain.delete(`/api/api-keys/${issued.keyId}`)); // 남의 키
    check('DELETE', '/admin/api-keys/{keyId}', 204, await op.delete(`/api/admin/api-keys/${issued.keyId}`));
    check('DELETE', '/admin/api-keys/{keyId}', 404, await op.delete(`/api/admin/api-keys/${issued.keyId}`));
    check('GET', '/model/{path}', 401, await anon.get('/api/model/v1/models').set('Authorization', auth));
    // 사용 중인 키 5개 한도 · 본인 폐기
    const keys: number[] = [];
    for (let i = 0; i < 5; i++) keys.push(check('POST', '/api-keys', 201, await plain.post('/api/api-keys').send({ name: `k${i}` })).keyId);
    check('POST', '/api-keys', 409, await plain.post('/api/api-keys').send({ name: 'k5' }));
    for (const k of keys) check('DELETE', '/api-keys/{keyId}', 204, await plain.delete(`/api/api-keys/${k}`));
    stub.config.apiKey = '';
  });
});

// ================================================================== admin rbac (S10)
describe('admin rbac', () => {
  it('GET · PUT /admin/rbac — 200 · 400 · 403(G14)', async () => {
    const v = check('GET', '/admin/rbac', 200, await op.get('/api/admin/rbac'));
    check('GET', '/admin/rbac', 403, await plain.get('/api/admin/rbac'));
    const saved = check('PUT', '/admin/rbac', 200, await op.put('/api/admin/rbac').send({ matrix: v.matrix }));
    expect(saved.changed).toBe(0);
    check('PUT', '/admin/rbac', 400, await op.put('/api/admin/rbac').send({ matrix: { ...v.matrix, user: ['nope'] } }));
    check('PUT', '/admin/rbac', 403, await plain.put('/api/admin/rbac').send({ matrix: v.matrix }));
  });
});

// ================================================================== coverage
/** 로컬 사업자 모드에서 사라졌지만 계약(openapi)에는 남아 있는 operation(응답 코드 생략) · 응답 코드 */
const LOCAL_MODE_REMOVED: string[] = [
  // 'POST /analyses 429' (G4 무료 한도) — 2026-10-01 계약에서 지움
];

describe('계약 커버리지', () => {
  const doc = YAML.parse(fs.readFileSync(CONTRACT_FILE, 'utf8')) as { paths: Record<string, Record<string, { responses?: Record<string, unknown> }>> };
  const all = Object.entries(doc.paths).flatMap(([p, item]) =>
    (['get', 'post', 'put', 'patch', 'delete'] as const)
      .filter((m) => item[m])
      .map((m) => ({ key: `${m.toUpperCase()} ${p}`, statuses: Object.keys(item[m]!.responses ?? {}).map(Number) })),
  );
  const declared = all
    .filter((d) => !LOCAL_MODE_REMOVED.includes(d.key))
    .map((d) => ({ ...d, statuses: d.statuses.filter((st) => !LOCAL_MODE_REMOVED.includes(`${d.key} ${st}`)) }));

  it('LOCAL_MODE_REMOVED 는 모두 계약에 실제로 있다(계약을 고치면 이 목록도 줄인다)', () => {
    const exists = (x: string) => all.some((d) => d.key === x || d.statuses.some((st) => `${d.key} ${st}` === x));
    expect(LOCAL_MODE_REMOVED.filter((x) => !exists(x))).toEqual([]);
  });

  it('계약의 모든 operation 을 한 번 이상 검증했다', () => {
    expect(all.length).toBe(66);
    expect(declared.length).toBe(66);
    expect(declared.filter((d) => !covered.has(d.key)).map((d) => d.key)).toEqual([]);
    // 이 파일이 계약에 없는 operation 을 검증했다면 check() 의 expectResponse 가 이미 실패했다
    expect([...covered.keys()].filter((k) => !declared.some((d) => d.key === k))).toEqual([]);
  });

  it('계약에 선언된 모든 응답 코드(성공·게이트·오류)를 한 번 이상 검증했다', () => {
    const missing = declared.flatMap((d) => d.statuses.filter((s) => !covered.get(d.key)?.has(s)).map((s) => `${d.key} ${s}`));
    expect(missing).toEqual([]);
  });
});

