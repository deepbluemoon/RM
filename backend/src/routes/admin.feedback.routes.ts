// /api/admin/feedback/* (US7 P8 T138) — 5개 operation. 운영자만(RBAC feedback.review, UC9). 판정 수정 경로 없음(U6)
import { Router } from 'express';
import { z } from 'zod';
import { ah } from '../middleware/guards.js';
import { HttpError } from '../middleware/errorHandler.js';
import { feedbackDetail, feedbackSummary, listFeedback, makeEvalCandidate, recordReview } from '../modules/feedbackReview/feedbackReview.service.js';

export const adminFeedbackRouter = Router();

const id = (v: string | undefined) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(404, 'not_found', '피드백을 찾을 수 없습니다');
  return n;
};

const ListQuery = z.object({
  type: z.enum(['false_positive', 'false_negative']).optional(),
  kvId: z.coerce.number().int().positive().optional(),
  reviewStatus: z.enum(['unreviewed', 'reviewed']).optional(),
});
const ReviewBody = z.object({ decision: z.enum(['valid', 'invalid', 'needs_expert']) });

function parse<T>(schema: z.ZodType<T>, v: unknown): T {
  const r = schema.safeParse(v);
  if (!r.success) throw new HttpError(400, 'bad_request', '요청 형식이 올바르지 않습니다');
  return r.data;
}

// 8.1·8.2
adminFeedbackRouter.get(
  '/admin/feedback',
  ah(async (req, res) => {
    res.json(await listFeedback(parse(ListQuery, req.query)));
  }),
);

// 8.6
adminFeedbackRouter.get(
  '/admin/feedback/summary',
  ah(async (_req, res) => {
    res.json(await feedbackSummary());
  }),
);

// 8.3 (G13 재검사)
adminFeedbackRouter.get(
  '/admin/feedback/:feedbackId',
  ah(async (req, res) => {
    res.json(await feedbackDetail(id(req.params.feedbackId)));
  }),
);

// 8.4
adminFeedbackRouter.post(
  '/admin/feedback/:feedbackId/review',
  ah(async (req, res) => {
    const b = parse(ReviewBody, req.body);
    res.json(await recordReview(id(req.params.feedbackId), b.decision));
  }),
);

// 8.5
adminFeedbackRouter.post(
  '/admin/feedback/:feedbackId/eval-candidate',
  ah(async (req, res) => {
    res.status(201).json(await makeEvalCandidate(id(req.params.feedbackId)));
  }),
);
