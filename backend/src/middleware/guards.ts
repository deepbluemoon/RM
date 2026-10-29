// 소유 확인(T026) — 소유 구분은 로그인 계정(req.owner.userId, middleware/auth.ts).
// 역할·권한(G14)은 이보다 먼저 authorize(RBAC, modules/auth/rbac.ts)가 확인한다.
import type { NextFunction, Request, Response } from 'express';
import { getPool, selectOne } from '../db/pool.js';
import { raise } from '../modules/gates/gates.service.js';

type Handler = (req: Request, res: Response, next: NextFunction) => Promise<void> | void;
export const ah = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req, res, next)).catch(next);

const subjectOf = (req: Request) => ({ userId: req.owner?.userId ?? null, sessionId: null });

export interface OwnedRequest {
  request_id: number;
  user_id: number | null;
  session_id: string | null;
}

/** 요청 소유 확인 — 같은 계정으로 만든 요청만. 없거나 다른 계정 것이면 G8 */
export async function assertOwner(req: Request, requestId: number, what = '결과를 볼'): Promise<OwnedRequest> {
  const row = await selectOne<OwnedRequest>(getPool(), 'SELECT request_id, user_id, session_id FROM analysis_request WHERE request_id = ?', [requestId]);
  if (!row) {
    return raise('G8', 'not_found_or_expired', subjectOf(req), {
      status: 404,
      params: { what, detail: '기록을 찾을 수 없습니다', how: '새 분석' },
      nextActions: [{ id: 'new_analysis', label: '새 분석 시작' }],
    });
  }
  if (row.user_id !== null && row.user_id === req.owner.userId) return row;
  return raise('G8', 'not_owner', subjectOf(req), {
    status: 403,
    params: { what, detail: '다른 계정으로 만든 기록입니다', how: '기록을 만든 계정' },
    nextActions: [{ id: 'my_history', label: '내 기록으로' }],
  });
}

export async function assertRunOwner(req: Request, runId: number, what = '결과를 볼'): Promise<OwnedRequest & { run_id: number }> {
  const run = await selectOne<{ request_id: number }>(getPool(), 'SELECT request_id FROM analysis_run WHERE run_id = ?', [runId]);
  if (!run) {
    return raise('G8', 'not_found_or_expired', subjectOf(req), {
      status: 404,
      params: { what, detail: '기록을 찾을 수 없습니다', how: '새 분석' },
      nextActions: [{ id: 'new_analysis', label: '새 분석 시작' }],
    });
  }
  const owned = await assertOwner(req, run.request_id, what);
  return { ...owned, run_id: runId };
}
