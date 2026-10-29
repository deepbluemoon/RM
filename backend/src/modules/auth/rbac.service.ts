// 역할(사용자 유형)별 권한 표 — role_permission(migration 005) 읽기·쓰기와 캐시(rbac.ts) 갱신.
// 권한 관리 화면(S10)이 바꾸면 바로 반영하고, 다른 프로세스가 바꾼 값은 REFRESH_MS 안에 따라잡는다.
import { getPool, select, selectOne } from '../../db/pool.js';
import { withTx } from '../../db/tx.js';
import { logger } from '../../logger.js';
import { ROLES, type Role } from '../../domain/codes.js';
import {
  DEFAULT_ROLE_PERMISSIONS, LOCKED, PERMISSION_META, PERMISSIONS, ROLE_LABEL,
  matrixAgeMs, normalizeMatrix, roleMatrix, setRoleMatrix, type Permission, type RoleMatrix,
} from './rbac.js';

const REFRESH_MS = 30_000;
let inflight: Promise<void> | null = null;

/** DB 에서 다시 읽는다. 행이 없는 칸은 기본값 */
export async function loadRoleMatrix(): Promise<RoleMatrix> {
  const rows = await select<{ role: Role; permission: string; allowed: number }>(getPool(), 'SELECT role, permission, allowed FROM role_permission');
  const m = {} as Record<Role, string[]>;
  for (const role of ROLES) {
    const set = new Set<string>(DEFAULT_ROLE_PERMISSIONS[role]);
    for (const r of rows) if (r.role === role) (r.allowed ? set.add(r.permission) : set.delete(r.permission));
    m[role] = [...set];
  }
  setRoleMatrix(normalizeMatrix(m));
  return roleMatrix();
}

/** 캐시가 오래됐으면 다시 읽는다(요청마다 authenticate 가 부름). 실패하면 직전 값을 계속 쓴다 */
export async function ensureFreshRoleMatrix(): Promise<void> {
  if (matrixAgeMs() < REFRESH_MS) return;
  inflight ??= loadRoleMatrix()
    .then(() => undefined)
    .catch((e: Error) => logger.warn({ err: e.message }, 'role_permission load failed — keep previous'))
    .finally(() => (inflight = null));
  await inflight;
}

export interface RbacView {
  roles: { id: Role; label: string }[];
  permissions: { id: Permission; label: string; uc: string; area: string }[];
  matrix: RoleMatrix;
  defaults: RoleMatrix;
  locked: { role: Role; permission: Permission }[];
  updatedAt: string | null;
}

export async function rbacView(): Promise<RbacView> {
  const matrix = await loadRoleMatrix();
  const last = await selectOne<{ t: Date | null }>(getPool(), 'SELECT MAX(updated_at) AS t FROM role_permission');
  return {
    roles: ROLES.map((id) => ({ id, label: ROLE_LABEL[id] })),
    permissions: PERMISSIONS.map((id) => ({ id, ...PERMISSION_META[id] })),
    matrix,
    defaults: normalizeMatrix(DEFAULT_ROLE_PERMISSIONS),
    locked: LOCKED.map((l) => ({ role: l.role, permission: l.perm })),
    updatedAt: last?.t ? new Date(last.t).toISOString() : null,
  };
}

/** 표 전체를 저장한다(모든 역할 × 모든 권한 행). 잠긴 칸은 항상 켠다. 바뀐 칸 수를 돌려준다 */
export async function saveRoleMatrix(input: Partial<Record<Role, readonly string[]>>, byUserId: number): Promise<number> {
  const next = normalizeMatrix(input);
  const before = await loadRoleMatrix();
  const changes: { role: Role; permission: Permission; allowed: boolean }[] = [];
  for (const role of ROLES)
    for (const p of PERMISSIONS) {
      const now = next[role].includes(p);
      if (now !== before[role].includes(p)) changes.push({ role, permission: p, allowed: now });
    }
  if (changes.length) {
    await withTx(async (conn) => {
      for (const c of changes)
        await conn.query(
          `INSERT INTO role_permission (role, permission, allowed, updated_by) VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE allowed = VALUES(allowed), updated_by = VALUES(updated_by)`,
          [c.role, c.permission, c.allowed ? 1 : 0, byUserId],
        );
    });
    logger.info({ userId: byUserId, changes: changes.map((c) => `${c.role}:${c.permission}=${c.allowed ? 1 : 0}`) }, 'rbac updated');
  }
  await loadRoleMatrix();
  return changes.length;
}
