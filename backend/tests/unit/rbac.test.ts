// RBAC 규칙표(modules/auth/rbac.ts) — 유스케이스 영역별 역할·경로 사상
import { describe, expect, it } from 'vitest';
import { can, DEFAULT_ROLE_PERMISSIONS, isLocked, normalizeMatrix, PERMISSION_META, PERMISSIONS, requirementOf } from '../../src/modules/auth/rbac.js';
import { ROLES } from '../../src/domain/codes.js';

const perm = (method: string, path: string) => {
  const r = requirementOf(method, path);
  return r.kind === 'perm' ? r.perm : r.kind;
};

describe('rbac', () => {
  it('모든 역할이 정의되어 있고, 모든 권한은 어느 역할엔가 속한다', () => {
    expect(Object.keys(DEFAULT_ROLE_PERMISSIONS).sort()).toEqual([...ROLES].sort());
    const granted = new Set(Object.values(DEFAULT_ROLE_PERMISSIONS).flat());
    for (const p of PERMISSIONS) expect(granted.has(p), p).toBe(true);
  });

  it('사용자 영역 경로 → UC1~UC6 권한', () => {
    expect(perm('POST', '/analyses')).toBe('analysis.request');
    expect(perm('POST', '/intake/uploads')).toBe('analysis.request');
    expect(perm('GET', '/analyses/3')).toBe('analysis.request');
    expect(perm('GET', '/results/3')).toBe('result.view');
    expect(perm('POST', '/results/3/clauses/9/rejudge')).toBe('result.view');
    expect(perm('GET', '/evidence/5')).toBe('result.view');
    expect(perm('GET', '/results/3/clauses/9/explanation')).toBe('explanation.view');
    expect(perm('GET', '/results/3/clauses/9/comparison')).toBe('explanation.view');
    expect(perm('GET', '/results/3/impacts')).toBe('history.manage');
    expect(perm('DELETE', '/history/3')).toBe('history.manage');
    expect(perm('POST', '/feedback/preview')).toBe('feedback.submit');
  });

  it('운영 영역 경로 → UC7~UC10 권한, 전문가 검수 경로는 eval.review', () => {
    expect(perm('POST', '/admin/knowledge/ingest-batches')).toBe('knowledge.manage');
    expect(perm('GET', '/admin/eval/overview')).toBe('eval.review');
    expect(perm('GET', '/admin/eval/items')).toBe('eval.review');
    expect(perm('POST', '/admin/eval/items')).toBe('eval.run');
    expect(perm('POST', '/admin/eval/items/4/review')).toBe('eval.review');
    expect(perm('PUT', '/admin/eval/runs/1/evidence-reviews/2/3')).toBe('eval.review');
    expect(perm('POST', '/admin/eval/runs/1/confirm')).toBe('eval.run');
    expect(perm('GET', '/admin/eval/compare')).toBe('eval.run');
    expect(perm('GET', '/admin/feedback/summary')).toBe('feedback.review');
    expect(perm('POST', '/admin/model-api/try/v1/judge')).toBe('modelApi.view');
    expect(perm('GET', '/admin/rbac')).toBe('rbac.manage');
    expect(perm('PUT', '/admin/rbac')).toBe('rbac.manage');
  });

  it('공개 경로·규칙 없는 경로', () => {
    expect(perm('GET', '/session')).toBe('public');
    expect(perm('GET', '/auth/kakao/start')).toBe('public');
    expect(perm('GET', '/meta/codes')).toBe('public');
    expect(perm('GET', '/model-server/status')).toBe('public');
    expect(perm('GET', '/something-else')).toBe('login');
    // 접두사가 닮은 경로가 규칙을 빌려 가지 않는다
    expect(perm('GET', '/historyx')).toBe('login');
    expect(perm('GET', '/admin/evaluation')).toBe('login');
  });

  it('역할 사상 = 유스케이스 주액터', () => {
    expect(can('user', 'analysis.request')).toBe(true);
    expect(can('user', 'feedback.review')).toBe(false);
    expect(can('operator', 'feedback.review')).toBe(true);
    expect(can('operator', 'analysis.request')).toBe(false);
    expect(can('legal_expert', 'eval.review')).toBe(true);
    expect(can('legal_expert', 'eval.run')).toBe(false);
    expect(can('developer', 'modelApi.view')).toBe(true);
    expect(can('developer', 'eval.review')).toBe(false);
  });

  it('모든 권한에 화면 표시 정보가 있다', () => {
    for (const p of PERMISSIONS) expect(PERMISSION_META[p].label, p).toBeTruthy();
  });

  it('표 정리 — 권한 순서 고정, 모르는 값 제거, 잠긴 칸(운영자 권한 관리)은 항상 켠다', () => {
    const m = normalizeMatrix({ user: ['history.manage', 'analysis.request', 'nope'], operator: [] });
    expect(m.user).toEqual(['analysis.request', 'history.manage']);
    expect(m.operator).toEqual(['rbac.manage']);
    expect(m.developer).toEqual([]);
    expect(isLocked('operator', 'rbac.manage')).toBe(true);
    expect(isLocked('user', 'rbac.manage')).toBe(false);
  });
});
