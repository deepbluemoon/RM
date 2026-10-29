// /api/admin/rbac (권한 관리 S10) — 역할(사용자 유형) × 권한(유스케이스) 표 조회·저장. RBAC rbac.manage(초기값: 운영자)
import { Router } from 'express';
import { z } from 'zod';
import { ah } from '../middleware/guards.js';
import { HttpError } from '../middleware/errorHandler.js';
import { ROLES } from '../domain/codes.js';
import { PERMISSIONS } from '../modules/auth/rbac.js';
import { rbacView, saveRoleMatrix } from '../modules/auth/rbac.service.js';

export const adminRbacRouter = Router();

const PermList = z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length);
const PutBody = z.object({ matrix: z.object(Object.fromEntries(ROLES.map((r) => [r, PermList])) as Record<(typeof ROLES)[number], typeof PermList>).strict() });

adminRbacRouter.get('/admin/rbac', ah(async (_req, res) => void res.json(await rbacView())));

adminRbacRouter.put(
  '/admin/rbac',
  ah(async (req, res) => {
    const b = PutBody.safeParse(req.body);
    if (!b.success) throw new HttpError(400, 'bad_request', '역할별 권한 표 형식이 올바르지 않습니다');
    const changed = await saveRoleMatrix(b.data.matrix, req.owner.userId);
    res.json({ ...(await rbacView()), changed });
  }),
);
