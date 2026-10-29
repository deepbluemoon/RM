// 통합 테스트 준비(T044): crd_test 초기화 → 마이그레이션 → 지식 seed → policy 로드, 스텁 기동, 로그인한 쿠키 유지 agent(RBAC)
import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import supertest from 'supertest';
import crypto from 'node:crypto';
import { applyMigrations } from '../../scripts/migrate.js';
import { seedKnowledge, type KnowledgeFixture } from '../../src/modules/evidence/seed.js';
import { loadPolicy } from '../../src/config/policy.js';
import { createApp } from '../../src/app.js';
import { closePool, getPool, exec, selectOne } from '../../src/db/pool.js';
import { createStubApp, configFromEnv, type StubConfig } from '../../../tools/model-api-stub/src/server.js';
import { resetStatusCache } from '../../src/modules/modelApi/status.js';
import { drain } from '../../src/jobs/runner.js';
import type { Role } from '../../src/domain/codes.js';
import { loadRoleMatrix } from '../../src/modules/auth/rbac.service.js';
import { fileURLToPath as __f2p } from 'node:url';
const __dirname = path.dirname(__f2p(import.meta.url));

export const fixture = (p: string) => path.resolve(__dirname, '..', 'fixtures', p);

export async function resetDb(): Promise<void> {
  await closePool();
  await applyMigrations(
    { host: process.env.DB_HOST!, port: Number(process.env.DB_PORT), user: process.env.DB_USER!, password: process.env.DB_PASSWORD!, database: process.env.DB_NAME! },
    { reset: true, log: () => undefined },
  );
  const fx = JSON.parse(fs.readFileSync(fixture('knowledge/initial.json'), 'utf8')) as KnowledgeFixture;
  await seedKnowledge(fx);
  await loadPolicy();
  await loadRoleMatrix();
}

export interface StubHandle {
  config: StubConfig;
  received: { path: string; body: unknown }[];
  warm: { M3: boolean; M4: boolean };
  close(): Promise<void>;
}

export async function startStub(overrides: Partial<StubConfig> = {}): Promise<StubHandle> {
  const stub = createStubApp({ ...configFromEnv({}), recordBodies: true, coldDelayMs: 0, ...overrides });
  const server: Server = await new Promise((resolve) => {
    const s = stub.app.listen(Number(process.env.TEST_STUB_PORT ?? 18611), '127.0.0.1', () => resolve(s));
  });
  resetStatusCache();
  return {
    config: stub.config,
    received: stub.received,
    warm: stub.warm,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const servers: Server[] = [];
let sharedApp: ReturnType<typeof createApp> | null = null;

type Agent = ReturnType<typeof supertest.agent>;
export interface AgentOptions {
  /** 로그인 역할(기본 user). 역할은 로그인 뒤 DB 에서 바꾼다 — 자가 가입은 user 만 */
  role?: Role;
  /** false 면 로그인하지 않은 브라우저 */
  login?: boolean;
}
interface LoginState {
  subject: string;
  ready: () => Promise<void>;
}
const loginOf = new WeakMap<object, LoginState>();
let seq = 0;
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'del', 'head'] as const;

/**
 * 에이전트마다 서버 하나를 계속 띄운다 — supertest 의 요청별 임시 서버는 keep-alive 재사용과 부딪혀 socket hang up 이 난다.
 * 기본은 dev 제공자로 로그인한 새 계정(역할 opts.role). 로그인은 첫 요청 직전에 한 번 한다(동기 생성 유지)
 */
export function newAgent(opts: AgentOptions = {}) {
  sharedApp ??= createApp();
  // 호스트를 주면 bind 가 비동기(dns.lookup)라 첫 요청 때 address() 가 null → supertest 가 다시 listen 해
  // 요청이 다른 로컬 프로세스로 새는 경합이 있었다. 호스트 없이 listen 하면 즉시 bind 된다(테스트 프로세스 동안만)
  const server = sharedApp.listen(0);
  if (!server.address()) throw new Error('test server did not bind synchronously');
  // Node 20+ 기본 에이전트는 keep-alive — 서버가 유휴 5초에 연결을 닫는 순간과 겹치면 socket hang up 이 난다
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 121_000;
  servers.push(server);
  const agent = supertest.agent(server);
  if (opts.login === false) return agent;

  const raw = Object.fromEntries(METHODS.map((m) => [m, (agent as any)[m].bind(agent)])) as Record<(typeof METHODS)[number], (url: string) => any>;
  const subject = `t${process.pid}-${++seq}-${crypto.randomBytes(3).toString('hex')}`;
  let pending: Promise<void> | null = null;
  const ready = () => (pending ??= devLogin(raw.get, subject, opts.role));
  loginOf.set(agent, { subject, ready });
  // 요청을 보내기 직전(end)에 로그인을 끝내고, 그 사이 받은 세션 쿠키를 다시 싣는다
  for (const m of METHODS) {
    (agent as any)[m] = (...args: [string]) => {
      const t = raw[m](...args);
      const end = t.end.bind(t);
      t.end = (cb: (err: unknown, res?: unknown) => void) => {
        ready().then(
          () => {
            (agent as any)._attachCookies(t);
            end(cb);
          },
          (e) => cb(e),
        );
        return t;
      };
      return t;
    };
  }
  return agent;
}

/** 새 브라우저 = 로그인한 다른 계정(기본 user) — 의도를 드러내려는 이름 */
export function browserAgent(opts: AgentOptions = {}): Agent {
  return newAgent(opts);
}

/** dev 제공자 로그인(start → callback). get 은 로그인 가드를 거치지 않는 원래 agent.get */
async function devLogin(get: (url: string) => any, subject: string, role?: Role): Promise<void> {
  const start = await get(`/api/auth/dev/start?devSubject=${subject}`).redirects(0).ok(() => true);
  if (start.status !== 302) throw new Error(`dev login start ${start.status}`);
  const cb = await get(start.headers.location).redirects(0).ok(() => true);
  if (cb.status !== 302) throw new Error(`dev login callback ${cb.status} ${JSON.stringify(cb.body)}`);
  if (role && role !== 'user') await setRoleBySubject(subject, role);
}

/** 직접 만든 supertest agent(예: 응답을 가로채는 앱)를 dev 계정으로 로그인시킨다 */
export async function loginAs(agent: Agent, subject: string, role?: Role): Promise<void> {
  await devLogin((url) => agent.get(url), subject, role);
}

async function setRoleBySubject(subject: string, role: Role): Promise<void> {
  await exec(getPool(), "UPDATE app_user u JOIN auth_identity a ON a.user_id = u.user_id SET u.role = ? WHERE a.provider = 'dev' AND a.provider_subject = ?", [role, subject]);
}

function stateOf(agent: object): LoginState {
  const st = loginOf.get(agent);
  if (!st) throw new Error('로그인하지 않은 agent');
  return st;
}

/** 로그인한 agent 의 역할을 바꾼다 — 다음 요청부터 적용(authenticate 가 매 요청 DB 를 읽음) */
export async function setRole(agent: object, role: Role): Promise<void> {
  const st = stateOf(agent);
  await st.ready();
  await setRoleBySubject(st.subject, role);
}

/** agent 의 로그인 계정 → 사용자 번호(auth_identity dev/<subject>) */
export async function agentUserId(agent: object): Promise<number> {
  const st = stateOf(agent);
  await st.ready();
  const row = await selectOne<{ user_id: number }>(getPool(), 'SELECT user_id FROM auth_identity WHERE provider = ? AND provider_subject = ?', ['dev', st.subject]);
  if (!row) throw new Error('login user not found');
  return row.user_id;
}

export async function waitFor<T>(fn: () => Promise<T>, pred: (v: T) => boolean, timeoutMs = 20_000, stepMs = 100): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (pred(v)) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor timeout; last=${JSON.stringify(v).slice(0, 400)}`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export async function teardown(): Promise<void> {
  await drain();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  sharedApp = null;
  await closePool();
}

export async function sql(q: string, params: unknown[] = []) {
  return exec(getPool(), q, params);
}
