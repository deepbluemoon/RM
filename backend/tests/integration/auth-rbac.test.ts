// 인증·RBAC — 소셜 로그인 세션(dev 제공자로 검증) + 역할별 접근(modules/auth/rbac.ts).
// 비로그인 = 공개 경로만(G8 401), 권한 없는 경로 = G14 403, 소유가 다른 기록 = G8 403.
import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentUserId, browserAgent, fixture, newAgent, resetDb, setRole, startStub, teardown, type StubHandle } from './setup.js';
import { analyzeToSaved, startText } from './flow.js';
import { getPool, selectOne } from '../../src/db/pool.js';
import { DEFAULT_ROLE_PERMISSIONS } from '../../src/modules/auth/rbac.js';

let stub: StubHandle;
const SAMPLE = fs.readFileSync(fixture('contracts/subscription-sample.txt'), 'utf8');

beforeAll(async () => {
  await resetDb();
  stub = await startStub();
});
afterAll(async () => {
  await stub.close();
  await teardown();
});

describe('비로그인', () => {
  const anon = newAgent({ login: false });

  it('세션 조회는 로그인 안 됨·사용 가능한 제공자를 준다', async () => {
    const r = await anon.get('/api/session').expect(200);
    expect(r.body).toMatchObject({ loggedIn: false, user: null, permissions: [] });
    expect(r.body.authProviders).toContain('dev');
  });

  it('공개 경로(코드 사전·개인정보 고지·모델 상태)는 열리고 나머지는 401', async () => {
    await anon.get('/api/meta/codes').expect(200);
    await anon.get('/api/meta/privacy-notice').expect(200);
    for (const path of ['/api/history', '/api/results/1', '/api/admin/feedback', '/api/admin/model-api/status', '/api/no-such-path']) {
      const r = await anon.get(path);
      expect(r.status, path).toBe(401);
      expect(r.body).toMatchObject({ gate: 'G8', reason: '로그인이 필요합니다', nextActions: [{ id: 'login' }] });
    }
    expect((await anon.post('/api/analyses').send({ perspective: 'business', source: { kind: 'text', text: SAMPLE } })).status).toBe(401);
  });
});

describe('로그인(dev 제공자)', () => {
  it('start → callback 이 세션을 만들고 returnTo 로 돌려보낸다. 첫 로그인 계정은 user', async () => {
    const a = newAgent({ login: false });
    const s = await a.get('/api/auth/dev/start?devSubject=rbac-login&returnTo=/history').redirects(0).ok(() => true);
    expect(s.status).toBe(302);
    expect(s.headers.location).toMatch(/^\/api\/auth\/dev\/callback\?code=dev%3Arbac-login&state=/);
    const cb = await a.get(s.headers.location!).redirects(0).ok(() => true);
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toBe('/history');
    const sess = await a.get('/api/session').expect(200);
    expect(sess.body).toMatchObject({ loggedIn: true, user: { role: 'user', provider: 'dev' } });
    expect(sess.body.permissions).toEqual([...DEFAULT_ROLE_PERMISSIONS.user]);
    const u = await selectOne<{ email: string; role: string }>(
      getPool(),
      "SELECT u.email, u.role FROM app_user u JOIN auth_identity a ON a.user_id = u.user_id WHERE a.provider = 'dev' AND a.provider_subject = 'rbac-login'",
    );
    expect(u).toMatchObject({ role: 'user' });
    expect(u!.email).toMatch(/@social\.invalid$/);

    // 로그아웃하면 다시 401
    await a.post('/api/auth/logout').expect(204);
    expect((await a.get('/api/history')).status).toBe(401);
  });

  it('state 가 맞지 않으면 로그인하지 않는다(400)', async () => {
    const a = newAgent({ login: false });
    const r = await a.get('/api/auth/dev/callback?code=dev:x&state=forged');
    expect(r.status).toBe(400);
    expect((await a.get('/api/session')).body.loggedIn).toBe(false);
  });

  it('returnTo 는 앱 내부 경로만(오픈 리다이렉트 방지)', async () => {
    const a = newAgent({ login: false });
    const s = await a.get('/api/auth/dev/start?devSubject=rbac-rt&returnTo=//evil.example').redirects(0).ok(() => true);
    const cb = await a.get(s.headers.location!).redirects(0).ok(() => true);
    expect(cb.headers.location).toBe('/');
  });
});

describe('역할별 접근(RBAC)', () => {
  const expectG14 = async (agent: ReturnType<typeof newAgent>, method: 'get' | 'post', path: string, perm: string) => {
    const r = await agent[method](path);
    expect(r.status, `${method} ${path} ${JSON.stringify(r.body)}`).toBe(403);
    expect(r.body).toMatchObject({ gate: 'G14', detail: { permission: perm } });
  };
  const expectOpen = async (agent: ReturnType<typeof newAgent>, path: string) => {
    const r = await agent.get(path);
    expect(r.status, `${path} ${JSON.stringify(r.body)}`).toBe(200);
  };

  it('사용자(user) — 사용자 영역(UC1~UC6) + API 활용 안내·키, 서버 상태·운영 문서는 G14', async () => {
    const a = browserAgent();
    await expectOpen(a, '/api/history');
    await expectOpen(a, '/api/api-keys');
    await expectG14(a, 'get', '/api/admin/knowledge/versions', 'knowledge.manage');
    await expectG14(a, 'get', '/api/admin/eval/overview', 'eval.review');
    await expectG14(a, 'post', '/api/admin/eval/runs', 'eval.run');
    await expectG14(a, 'get', '/api/admin/feedback', 'feedback.review');
    await expectG14(a, 'get', '/api/admin/model-api/status', 'modelApi.manage');
    const ev = await selectOne<{ n: number }>(getPool(), "SELECT COUNT(*) AS n FROM gate_event WHERE gate_code = 'G14' AND user_id = ?", [await agentUserId(a)]);
    expect(Number(ev!.n)).toBe(5);
  });

  it('운영자(operator) — 운영 영역(UC7~UC10), 사용자 영역은 G14', async () => {
    const op = browserAgent({ role: 'operator' });
    for (const p of ['/api/admin/knowledge/versions', '/api/admin/eval/overview', '/api/admin/eval/items', '/api/admin/feedback', '/api/admin/feedback/summary', '/api/admin/model-api/status']) await expectOpen(op, p);
    await expectG14(op, 'get', '/api/history', 'history.manage');
    await expectG14(op, 'post', '/api/analyses', 'analysis.request');
  });

  it('법률 전문가(legal_expert) — UC8 검수만', async () => {
    const ex = browserAgent({ role: 'legal_expert' });
    await expectOpen(ex, '/api/admin/eval/overview');
    await expectOpen(ex, '/api/admin/eval/items');
    await expectG14(ex, 'post', '/api/admin/eval/runs', 'eval.run');
    await expectG14(ex, 'get', '/api/admin/feedback', 'feedback.review');
    await expectG14(ex, 'get', '/api/admin/model-api/status', 'modelApi.manage');
    await expectG14(ex, 'get', '/api/history', 'history.manage');
  });

  it('개발자(developer) — UC10 만', async () => {
    const dv = browserAgent({ role: 'developer' });
    await expectOpen(dv, '/api/admin/model-api/status');
    await expectG14(dv, 'get', '/api/admin/eval/items', 'eval.review');
    await expectG14(dv, 'get', '/api/admin/knowledge/versions', 'knowledge.manage');
    await expectG14(dv, 'get', '/api/history', 'history.manage');
  });

  it('역할을 바꾸면 다음 요청부터 바로 적용된다(재로그인 불필요)', async () => {
    const a = browserAgent();
    await expectG14(a, 'get', '/api/admin/feedback', 'feedback.review');
    await setRole(a, 'operator');
    await expectOpen(a, '/api/admin/feedback');
    const sess = await a.get('/api/session').expect(200);
    expect(sess.body.user.role).toBe('operator');
    expect(sess.body.permissions).toEqual([...DEFAULT_ROLE_PERMISSIONS.operator]);
  });
});

describe('기록 소유 = 로그인 계정', () => {
  it('다른 계정은 결과·기록을 열 수 없다(G8), 만든 계정은 열 수 있다', async () => {
    const a = browserAgent();
    const b = browserAgent();
    const saved = await analyzeToSaved(a, () => startText(a, SAMPLE));
    const q = await selectOne<{ user_id: number; session_id: string | null }>(getPool(), 'SELECT user_id, session_id FROM analysis_request WHERE request_id = ?', [saved.requestId]);
    expect(q).toMatchObject({ user_id: await agentUserId(a), session_id: null });

    const res = await b.get(`/api/results/${saved.runId}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ gate: 'G8', reason: expect.stringContaining('다른 계정') });
    expect((await b.get(`/api/history/${saved.requestId}`)).status).toBe(403);
    expect((await b.get('/api/history').expect(200)).body.items).toHaveLength(0);

    await a.get(`/api/results/${saved.runId}`).expect(200);
    await a.get(`/api/history/${saved.requestId}`).expect(200);
  });
});
