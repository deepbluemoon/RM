// POST /api/feedback/preview·POST /api/feedback (US5 T117, P5 5.3·5.4). 비로그인 세션 피드백도 받는다(UC6)
import { Router } from 'express';
import { z } from 'zod';
import { ah } from '../../middleware/guards.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { deidOpinion, submitFeedback } from './feedback.service.js';

export const feedbackRouter = Router();

const OPINION = z.string().max(2000);

/** 5.3 의견 비식별화 미리보기 — 저장하지 않는다. 원문은 응답·로그에 싣지 않는다 */
feedbackRouter.post(
  '/feedback/preview',
  ah(async (req, res) => {
    const body = z.object({ opinion: OPINION }).safeParse(req.body);
    if (!body.success) throw new HttpError(400, 'invalid_body', '의견은 2,000자 이내로 입력해 주세요');
    const r = deidOpinion(body.data.opinion);
    res.json({ opinionDeid: r.opinionDeid ?? '', maskedTypes: r.maskedTypes });
  }),
);

/** 5.4 피드백 저장 — 실패하면 클라이언트는 입력을 그대로 두고 다시 시도한다(UC6 E3) */
feedbackRouter.post(
  '/feedback',
  ah(async (req, res) => {
    const body = z
      .object({ assessmentId: z.number().int().positive(), feedbackType: z.enum(['false_positive', 'false_negative']), opinion: OPINION.optional() })
      .safeParse(req.body);
    if (!body.success) throw new HttpError(400, 'invalid_body', '피드백 유형과 대상을 확인해 주세요(의견은 2,000자 이내)');
    res.status(201).json(await submitFeedback(req, body.data));
  }),
);
