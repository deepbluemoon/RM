// T140 — P9 API 활용 안내·서버 상태: /admin/model-api/status(9.5 상태 사상 503·504·401, 모델별 적재 상태·크기·예상 적재 시간·대기열,
// 미설치 모델 준비 안내), 모델 교체 감지(9.6, H7 저장 없음), /admin/model-api/openapi(9.7 프록시), 역할 가드(G14 — 운영자·개발자만), API 키 비노출(BR-API-02)
import fs from 'node:fs';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fixture, newAgent, resetDb, startStub, teardown, type StubHandle } from './setup.js';
import type { Role } from '../../src/domain/codes.js';
import { analyzeToSaved, startText } from './flow.js';
import { expectResponse } from '../contract/harness.js';
import { exec, getPool, selectOne } from '../../src/db/pool.js';
import { modelApi } from '../../src/modules/modelApi/client.js';
import { resetStatusCache } from '../../src/modules/modelApi/status.js';
import { resetGuideCache } from '../../src/modules/modelApiGuide/status.service.js';
import { resetOpenapiCache } from '../../src/modules/modelApiGuide/openapi.service.js';
import { provisioningHint } from '../../src/modules/modelApiGuide/provisioning.js';

type Agent = ReturnType<typeof newAgent>;
const KEY = process.env.MODEL_API_KEY!;
let stub: StubHandle;
let dev: Agent;
let op: Agent;
let plain: Agent;

/** listen(0) 완료 전 첫 요청이면 supertest 가 서버를 다시 listen·close 한다 — 먼저 기다린다 */
async function agent(role: Role = 'user'): Promise<Agent> {
  const a = newAgent({ role });
  const srv = (a as unknown as { app: Server }).app;
  if (!srv.listening) await once(srv, 'listening');
  return a;
}

function resetCaches() {
  resetStatusCache();
  resetGuideCache();
  resetOpenapiCache();
}

async function status(a: Agent = dev) {
  const r = await a.get('/api/admin/model-api/status?refresh=1');
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expectResponse('web', 'GET', '/admin/model-api/status', 200, r.body);
  expect(JSON.stringify(r.body)).not.toContain(KEY); // BR-API-02
  return r.body;
}

beforeAll(async () => {
  await resetDb();
  stub = await startStub();
  dev = await agent('developer');
  op = await agent('operator');
  plain = await agent();
});

afterEach(() => {
  Object.assign(stub.config, { health: 'ready', apiKey: '' });
  stub.warm.M3 = true;
  stub.warm.M4 = true;
  vi.restoreAllMocks();
  resetCaches();
});

afterAll(async () => {
  await stub.close();
  await teardown();
});

describe('접근(RBAC — 안내·OpenAPI 는 modelApi.view, 서버 상태·운영 문서는 modelApi.manage)', () => {
  it('일반 사용자는 OpenAPI 는 열고 서버 상태·운영 문서는 G14, 개발자는 모두 조회할 수 있다', async () => {
    resetCaches();
    expect((await plain.get('/api/admin/model-api/openapi')).status).toBe(200);
    for (const p of ['/api/admin/model-api/status', '/api/admin/model-api/docs/guideline']) {
      resetCaches();
      const u = await plain.get(p);
      expect(u.status, `${p} ${JSON.stringify(u.body).slice(0, 200)}`).toBe(403);
      expect(u.body.gate).toBe('G14');
      resetCaches();
      const a = await (await agent('developer')).get(p);
      expect(a.status, p).toBe(200);
    }
  });

  it('운영자·개발자 모두 조회할 수 있다', async () => {
    await status(op);
    await status(dev);
  });
});

describe('서버 상태(9.5)', () => {
  it('정상: /health + /v1/models 를 모델별로 합쳐 싣고 조회 시각을 붙인다', async () => {
    const b = await status();
    expect(b.state).toBe('ready');
    expect(b.httpStatus).toBe(200);
    expect(Number.isNaN(Date.parse(b.checkedAt))).toBe(false);
    expect(b.models.map((m: { id: string }) => m.id)).toEqual(['M1', 'M2', 'M3', 'M4']);
    expect(b.models[0]).toMatchObject({ name: 'loophole-stub', loadState: 'ready', modelVersion: 'stub-m1@1', trainedDataDate: '2026-09-01', servedModel: 'stub-m1', sizeMb: 440 });
    const health = (await modelApi.health()).body;
    const m3h = health.models.find((m) => m.id === 'M3')!;
    expect(b.models[2]).toMatchObject({ modelVersion: 'stub-m3@1', servedModel: m3h.model, sizeMb: m3h.size_mb });
    expect(b.models[2].sizeGb).toBe(Math.round((m3h.size_mb! / 1024) * 10) / 10);
    expect(b.sharedChatModel).toBe(m3h.model === health.models.find((m) => m.id === 'M4')!.model);
    expect(b.gpuMemory).toEqual({ usedMb: 0, totalMb: 131072 });
    expect(b.queueDepth).toBe(0);
    expect(b.bundleVersion).toBe('stub-bundle@1');
    expect(b.provisioning).toBeNull();
    expect(b.modelChanged).toBeNull();
  });

  it('cold(공유 Ollama 유휴 언로드): 호출 가능 + 예상 적재 시간 안내', async () => {
    stub.warm.M3 = false;
    stub.warm.M4 = false;
    const est = (await modelApi.health()).body.warmup_estimate_sec!;
    expect(est).toBeGreaterThan(0);
    const b = await status();
    expect(b.state).toBe('ready');
    expect(b.coldStart).toBe(true);
    expect(b.warmupEstimateSec).toBe(est);
    expect(b.models.filter((m: { loadState: string }) => m.loadState === 'cold').map((m: { id: string }) => m.id)).toEqual(['M3', 'M4']);
    expect(b.loadNotice).toContain(`${est}초`);
  });

  it('503 → 모델 로딩 중(E3)', async () => {
    stub.config.health = 'loading';
    const b = await status();
    expect(b).toMatchObject({ state: 'loading', httpStatus: 503 });
    expect(b.models.every((m: { loadState: string }) => m.loadState === 'loading')).toBe(true);
  });

  it('연결 끊김 → 연결 불가(E2), 모델을 미설치로 단정하지 않는다', async () => {
    stub.config.health = 'down';
    const spy = vi.spyOn(modelApi, 'models');
    const b = await status();
    expect(b.state).toBe('unreachable');
    expect(b.models.every((m: { loadState: string }) => m.loadState === 'error')).toBe(true);
    expect(b.provisioning).toBeNull();
    expect(spy).not.toHaveBeenCalled(); // 응답 없는 서버에 /v1/models 헛호출을 하지 않는다
  });

  it('504 → 연결 불가(E2), httpStatus 504', async () => {
    vi.spyOn(modelApi, 'health').mockRejectedValue(new (await import('../../src/modules/modelApi/client.js')).ModelApiError('timeout', 504, '/health'));
    const b = await status();
    expect(b).toMatchObject({ state: 'unreachable', httpStatus: 504 });
  });

  it('401 → API 키 불일치(E4), 키 값은 응답에 없다', async () => {
    stub.config.apiKey = 'another-key';
    const b = await status();
    expect(b).toMatchObject({ state: 'auth_mismatch', httpStatus: 401 });
    expect(b.note).toContain('MODEL_API_KEY');
  });

  it('미설치(missing) 모델: 수동 준비 절차·단계별 예상 소요·10GB 규칙을 싣는다', async () => {
    vi.spyOn(modelApi, 'health').mockResolvedValue({
      status: 503,
      body: {
        status: 'degraded',
        models: [
          { id: 'M1', state: 'ready', model: 'm1', size_mb: 440 },
          { id: 'M2', state: 'ready', model: 'm2', size_mb: 440 },
          { id: 'M3', state: 'missing', model: 'pioneer2-crd-m3:v1', size_mb: null },
          { id: 'M4', state: 'missing', model: 'pioneer2-crd-m3:v1', size_mb: null },
        ],
        warmup_estimate_sec: null,
        queue_depth: 2,
      },
    });
    const b = await status();
    expect(b.state).toBe('unreachable'); // 사용자 화면은 G5
    expect(b.sharedChatModel).toBe(true);
    expect(b.queueDepth).toBe(2);
    expect(b.provisioning.missing).toEqual(['M3', 'M4']);
    expect(b.provisioning.llm.customSteps.map((s: { command: string }) => s.command).join('\n')).toContain('provision_models.sh');
    expect(b.provisioning.llm.customSteps.every((s: { estimate: string }) => s.estimate.length > 0)).toBe(true);
    expect(b.provisioning.rules.join('\n')).toContain('10GB');
    expect(b.provisioning.classifiers).toBeNull();
  });

  it('provisioningHint 단위: 분류기만 없으면 분류기 절차만', () => {
    const h = provisioningHint([{ id: 'M1', loadState: 'missing' }, { id: 'M2', loadState: 'ready' }, { id: 'M3', loadState: 'cold' }, { id: 'M4', loadState: 'cold' }]);
    expect(h!.llm).toBeNull();
    expect(h!.classifiers!.missing).toEqual(['M1']);
    expect(provisioningHint([{ id: 'M1', loadState: 'ready' }])).toBeNull();
  });

  it('/health 는 캐시한다 — refresh 없이 연달아 열어도 모델 서버를 다시 부르지 않는다', async () => {
    await dev.get('/api/admin/model-api/status').expect(200);
    const h = vi.spyOn(modelApi, 'health');
    const m = vi.spyOn(modelApi, 'models');
    await dev.get('/api/admin/model-api/status').expect(200);
    await dev.get('/api/admin/model-api/status').expect(200);
    expect(h).not.toHaveBeenCalled();
    expect(m).not.toHaveBeenCalled();
  });
});

describe('모델 교체 감지(9.6, H7)', () => {
  it('최근 저장 결과의 M3 버전과 다르면 교체 감지, 새 버전 평가 기록이 있으면 해소. DB 에 쓰지 않는다', async () => {
    const owner = await agent();
    const sample = fs.readFileSync(fixture('contracts/subscription-sample.txt'), 'utf8');
    const { runId } = await analyzeToSaved(owner, () => startText(owner, sample));
    expect((await status()).modelChanged).toBeNull();

    // 모델 서버의 M3 가 새 버전(new-m3@2)으로 바뀐 상황 — /v1/models 만 바꿔 준다
    const real = await modelApi.models();
    vi.spyOn(modelApi, 'models').mockResolvedValue({ ...real, models: real.models.map((m) => (m.id === 'M3' ? { ...m, model_version: 'new-m3@2' } : m)) });
    const count = async () => (await selectOne<{ n: number }>(getPool(), 'SELECT (SELECT COUNT(*) FROM gate_event) + (SELECT COUNT(*) FROM eval_run) AS n'))!.n;
    const before = await count();
    const b = await status();
    expect(b.modelChanged).toMatchObject({ currentM3: 'new-m3@2', recentResultM3: 'stub-m3@1', recentRunId: runId });
    expect(await count()).toBe(before);

    const kv = (await selectOne<{ kv_id: number }>(getPool(), "SELECT kv_id FROM knowledge_version WHERE status = 'active'"))!.kv_id;
    await exec(getPool(), "INSERT INTO eval_run (kv_id, m1_model_version, m2_model_version, m3_model_version, stage, recorded_at) VALUES (?, 'stub-m1@1', 'stub-m2@1', 'new-m3@2', 'recorded', CURRENT_TIMESTAMP)", [kv]);
    expect((await status()).modelChanged).toBeNull();
  });
});

describe('OpenAPI 문서(9.7)', () => {
  it('모델 서버 /openapi.json 을 프록시한다(키 비노출)', async () => {
    const r = await dev.get('/api/admin/model-api/openapi?refresh=1');
    expect(r.status).toBe(200);
    expect(r.headers['x-openapi-source']).toBe('model-server');
    expect(r.body.openapi).toBe('3.0.3');
    expect(JSON.stringify(r.body)).not.toContain(KEY);
  });

  it('모델 서버에 문서가 없으면(404) 계약 원본을 준다', async () => {
    vi.spyOn(modelApi, 'openapi').mockRejectedValue(new (await import('../../src/modules/modelApi/client.js')).ModelApiError('not_found', 404, '/openapi.json'));
    const r = await dev.get('/api/admin/model-api/openapi?refresh=1');
    expect(r.status).toBe(200);
    expect(r.headers['x-openapi-source']).toBe('contract');
    expect(r.body.paths['/health']).toBeTruthy();
  });

  it('연결 불가·키 불일치는 502', async () => {
    stub.config.apiKey = 'another-key';
    const r = await dev.get('/api/admin/model-api/openapi?refresh=1');
    expect(r.status).toBe(502);
    expect(r.body.code).toBe('model_api_auth_mismatch');
    stub.config.apiKey = '';
    stub.config.health = 'down';
    const d = await dev.get('/api/admin/model-api/openapi?refresh=1');
    expect(d.status).toBe(502);
    expect(d.body.code).toBe('model_server_unreachable');
  });
});
