// 인증·인가(RBAC). authenticate = 세션(crd.sid) → 사용자·역할(매 요청 DB 에서 다시 읽어 역할 변경·삭제를 바로 반영),
// authorize = modules/auth/rbac.ts 의 경로 규칙으로 로그인(G8 401)·권한(G14 403)을 확인한다.
// 기록 소유(req.owner)는 로그인 계정이다 — 업로드·URL 토큰의 소유 키(deviceKey)도 계정 번호에서 만든다.
import type { NextFunction, Request, Response } from 'express';
import { getPool, selectOne } from '../db/pool.js';
import type { Role } from '../domain/codes.js';
import type { Owner } from '../domain/types.js';
import { raise } from '../modules/gates/gates.service.js';
import { GateError } from '../modules/gates/GateError.js';
import { permissionsOf, requirementOf, type Permission } from '../modules/auth/rbac.js';
import { ensureFreshRoleMatrix } from '../modules/auth/rbac.service.js';

export interface AuthContext {
  userId: number;
  role: Role;
  permissions: readonly Permission[];
}

declare module 'express-serve-static-core' {
  interface Request {
    /** 로그인하지 않았으면 undefined */
    auth?: AuthContext;
    /** 로그인한 요청에서만 채워진다(authorize 가 공개 경로 외에는 로그인을 요구) */
    owner: Owner & { userId: number };
  }
}

export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.session?.userId;
    if (userId) {
      const u = await selectOne<{ role: Role }>(getPool(), 'SELECT role FROM app_user WHERE user_id = ?', [userId]);
      if (!u) {
        // 계정이 지워졌다 — 세션을 버린다
        await new Promise<void>((resolve) => req.session.destroy(() => resolve()));
      } else {
        if (req.session.role !== u.role) req.session.role = u.role;
        // 역할별 권한 표(role_permission)는 권한 관리 화면에서 바뀐다 — 캐시가 오래됐으면 다시 읽는다
        await ensureFreshRoleMatrix();
        req.auth = { userId, role: u.role, permissions: permissionsOf(u.role) };
        req.owner = { userId, sessionId: null, deviceKey: `user-${userId}` };
      }
    }
    next();
  } catch (e) {
    next(e);
  }
}

export async function authorize(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const need = requirementOf(req.method, req.path);
    if (need.kind === 'public') return next();
    if (!req.auth) {
      // 비로그인은 대상 행이 없고 화면 폴링마다 생길 수 있어 gate_event 에 남기지 않는다(G14 는 남긴다)
      throw new GateError('G8', {
        status: 401,
        params: { what: '이 기능을 쓸', detail: '로그인이 필요합니다', how: '로그인' },
        nextActions: [{ id: 'login', label: '로그인' }],
      });
    }
    if (need.kind === 'perm' && !req.auth.permissions.includes(need.perm)) {
      await raise('G14', `forbidden:${need.perm}`.slice(0, 40), { userId: req.auth.userId }, {
        status: 403,
        detail: { permission: need.perm, role: req.auth.role },
      });
    }
    next();
  } catch (e) {
    next(e);
  }
}
