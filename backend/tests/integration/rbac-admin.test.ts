// 권한 관리(S10) — 역할(사용자 유형)별 기능 사용 여부 표를 운영자가 바꾸면 다음 요청부터 모든 사용자에게 적용된다.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentUserId, browserAgent, resetDb, startStub, teardown, type StubHandle } from './setup.js';
import { expectResponse } from '../contract/harness.js';
import { getPool, selectOne } from '../../src/db/pool.js';
import { DEFAULT_ROLE_PERMISSIONS } from '../../src/modules/auth/rbac.js';

let stub: StubHandle;
beforeAll(async () => {
  await resetDb();
  stub = await startStub();
});
afterAll(async () => {
  await stub.close();
  await teardown();
});

describe('권한 관리 /admin/rbac', () => {
  const op = browserAgent({ role: 'operator' });
  const user = browserAgent();
  const dev = browserAgent({ role: 'developer' });
  const expert = browserAgent({ role: 'legal_expert' });

  it('운영자만 연다 — 사용자·개발자·법률 전문가는 G14', async () => {
    const r = await op.get('/api/admin/rbac').expect(200);
    expectResponse('web', 'GET', '/admin/rbac', 200, r.body);
    expect(r.body.matrix).toEqual(DEFAULT_ROLE_PERMISSIONS);
    expect(r.body.locked).toEqual([{ role: 'operator', permission: 'rbac.manage' }]);
    expect(r.body.roles.map((x: { id: string }) => x.id)).toEqual(['user', 'operator', 'developer', 'legal_expert']);
    for (const a of [user, dev, expert]) {
      const g = await a.get('/api/admin/rbac');
      expect(g.status).toBe(403);
      expect(g.body).toMatchObject({ gate: 'G14', detail: { permission: 'rbac.manage' } });
    }
  });

  it('칸을 켜고 끄면 바로 적용된다(재로그인 불필요)', async () => {
    expect((await dev.get('/api/history')).status).toBe(403);
    const matrix = {
      ...DEFAULT_ROLE_PERMISSIONS,
      developer: [...DEFAULT_ROLE_PERMISSIONS.developer, 'history.manage'],
      user: DEFAULT_ROLE_PERMISSIONS.user.filter((p) => p !== 'feedback.submit'),
    };
    const r = await op.put('/api/admin/rbac').send({ matrix }).expect(200);
    expectResponse('web', 'PUT', '/admin/rbac', 200, r.body);
    expect(r.body.changed).toBe(2);
    expect(r.body.matrix.developer).toEqual(['history.manage', 'modelApi.view', 'modelApi.manage']);

    await dev.get('/api/history').expect(200);
    const s = await user.get('/api/session').expect(200);
    expect(s.body.permissions).not.toContain('feedback.submit');
    const f = await user.post('/api/feedback/preview').send({});
    expect(f.status).toBe(403);
    expect(f.body).toMatchObject({ gate: 'G14', detail: { permission: 'feedback.submit' } });

    const row = await selectOne<{ allowed: number; updated_by: number }>(getPool(), "SELECT allowed, updated_by FROM role_permission WHERE role = 'developer' AND permission = 'history.manage'");
    expect(row).toMatchObject({ allowed: 1, updated_by: await agentUserId(op) });
  });

  it('운영자의 권한 관리는 끌 수 없다(잠김 방지)', async () => {
    const r = await op.put('/api/admin/rbac').send({ matrix: { ...DEFAULT_ROLE_PERMISSIONS, operator: [] } }).expect(200);
    expect(r.body.matrix.operator).toEqual(['rbac.manage']);
    await op.get('/api/admin/rbac').expect(200);
    // 운영 화면 권한은 꺼졌다
    expect((await op.get('/api/admin/feedback')).status).toBe(403);
  });

  it('모르는 역할·권한은 400', async () => {
    expect((await op.put('/api/admin/rbac').send({ matrix: { ...DEFAULT_ROLE_PERMISSIONS, user: ['root'] } })).status).toBe(400);
    expect((await op.put('/api/admin/rbac').send({ matrix: { ...DEFAULT_ROLE_PERMISSIONS, admin: [] } })).status).toBe(400);
    expect((await op.put('/api/admin/rbac').send({})).status).toBe(400);
  });

  it('초기값으로 되돌린다', async () => {
    const r = await op.put('/api/admin/rbac').send({ matrix: DEFAULT_ROLE_PERMISSIONS }).expect(200);
    expect(r.body.matrix).toEqual(DEFAULT_ROLE_PERMISSIONS);
    await op.get('/api/admin/feedback').expect(200);
    expect((await dev.get('/api/history')).status).toBe(403);
  });
});
