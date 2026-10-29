// GET /api/history·/api/history/{requestId}·DELETE /api/history/{requestId}·POST …/reanalyses·GET /api/results/{runId}/impacts (US4 T110, US5 T115·T116)
import { Router } from 'express';
import { z } from 'zod';
import { ah, assertOwner, assertRunOwner } from '../../middleware/guards.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { cancel as cancelJob } from '../../jobs/runner.js';
import { assertSaved } from '../results/results.service.js';
import { historyDetail, listHistory, parseCursor, resultImpacts } from './history.service.js';
import { startReanalysis } from './reanalysis.service.js';
import { deleteRequest } from './delete.service.js';

export const historyRouter = Router();
const idParam = (v: string | undefined) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(404, 'not_found', '기록을 찾을 수 없습니다');
  return n;
};

/** 6.1 기록 목록 — 로그인 계정으로 만든 기록 */
historyRouter.get(
  '/history',
  ah(async (req, res) => {
    const limitRaw = Number(req.query.limit ?? 20);
    const limit = Number.isInteger(limitRaw) ? Math.min(100, Math.max(1, limitRaw)) : 20;
    res.json(await listHistory(req.owner.userId, parseCursor(req.query.cursor), limit));
  }),
);

/** 6.2 기록 열람 — 본인 확인(UC5 E4, G8) */
historyRouter.get(
  '/history/:requestId',
  ah(async (req, res) => {
    const id = idParam(req.params.requestId);
    await assertOwner(req, id, '기록을 열');
    res.json(await historyDetail(req, id));
  }),
);

/** 6.4 기록 삭제(FR-008) — 진행 중 작업은 먼저 멈춘다 */
historyRouter.delete(
  '/history/:requestId',
  ah(async (req, res) => {
    const id = idParam(req.params.requestId);
    await assertOwner(req, id, '기록을 삭제할');
    cancelJob(id);
    if (!(await deleteRequest(id))) throw new HttpError(404, 'not_found', '기록을 찾을 수 없습니다');
    res.status(204).end();
  }),
);

/** 6.5~6.6 재분석 — G5 만 확인, 한도 미차감(FR-034·035(e)) */
historyRouter.post(
  '/history/:requestId/reanalyses',
  ah(async (req, res) => {
    const id = idParam(req.params.requestId);
    await assertOwner(req, id, '재분석할');
    const body = z.object({ prevRunId: z.number().int().positive() }).safeParse(req.body);
    if (!body.success) throw new HttpError(400, 'invalid_body', '재분석할 결과를 지정해 주세요');
    res.status(202).json(await startReanalysis(req, id, body.data.prevRunId));
  }),
);

/** 6.3 변경 내용 — 개정·폐지 근거와 신규 관련 사례 */
historyRouter.get(
  '/results/:runId/impacts',
  ah(async (req, res) => {
    const runId = idParam(req.params.runId);
    await assertRunOwner(req, runId, '변경 내용을 볼');
    await assertSaved(runId);
    res.json(await resultImpacts(runId));
  }),
);
