// /api/admin/eval/* (US7 P7 T136) — 11개 operation. 역할(research R-10·R-15 U-2):
// 운영자 = 실행·기록·확정·비교, 법률 전문가 = 평가 데이터 검수(채택)·근거 적합성 판정(운영자 대리 입력 허용). 경로별 권한은 RBAC(eval.run·eval.review, modules/auth/rbac.ts)
import { Router, type Request } from 'express';
import { z } from 'zod';
import { ah } from '../middleware/guards.js';
import { HttpError } from '../middleware/errorHandler.js';
import { CONTRACT_TYPES, RISK_CATEGORIES } from '../domain/codes.js';
import { listItems, registerItem, reviewItem } from '../modules/evaluation/items.service.js';
import { compareRuns, confirmRun, evidenceReviews, overview, putEvidenceReview, recordRun, runView, startRun } from '../modules/evaluation/run.service.js';

export const adminEvalRouter = Router();

const int = (v: string | undefined) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(404, 'not_found', '찾을 수 없습니다');
  return n;
};
function parse<T>(schema: z.ZodType<T>, v: unknown): T {
  const r = schema.safeParse(v);
  if (!r.success) throw new HttpError(400, 'bad_request', '요청 형식이 올바르지 않습니다');
  return r.data;
}
const userId = (req: Request) => req.owner.userId;

const ItemsQuery = z.object({
  reviewStatus: z.enum(['pending', 'accepted', 'rejected']).optional(),
  contractType: z.enum(CONTRACT_TYPES).optional(),
});
const RegisterBody = z.object({
  clauseTextDeid: z.string().max(5000),
  contractType: z.enum(CONTRACT_TYPES),
  goldCategory: z.enum(RISK_CATEGORIES),
  origin: z.enum(['new_label', 'feedback_candidate', 'synthetic']),
  candidateId: z.number().int().positive().optional(),
  goldEvidenceItemIds: z.array(z.number().int().positive()).max(20).optional(),
  // 학습 데이터 중복 여부 — 등록자가 학습 데이터 목록과 대조해 표시한다(G10 해제 불가 사유)
  overlapsTraining: z.boolean().optional(),
});
const ReviewBody = z.object({ decision: z.enum(['accepted', 'rejected']) });
const RunBody = z.object({ evalItemIds: z.array(z.number().int().positive()).max(5000).optional() });
const VerdictBody = z.object({ verdict: z.enum(['relevant', 'irrelevant']) });

// 7.1
adminEvalRouter.get('/admin/eval/overview', ah(async (_req, res) => void res.json(await overview())));

// 7.2 목록·등록·검수
adminEvalRouter.get('/admin/eval/items', ah(async (req, res) => void res.json(await listItems(parse(ItemsQuery, req.query)))));
adminEvalRouter.post(
  '/admin/eval/items',
  ah(async (req, res) => {
    res.status(201).json(await registerItem(parse(RegisterBody, req.body)));
  }),
);
adminEvalRouter.post(
  '/admin/eval/items/:evalItemId/review',
  ah(async (req, res) => {
    const b = parse(ReviewBody, req.body);
    res.json(await reviewItem(int(req.params.evalItemId), b.decision, userId(req)));
  }),
);

// 7.4~7.6 시작(202 — 추론은 작업 실행기에서) · 진행·지표 조회
adminEvalRouter.post(
  '/admin/eval/runs',
  ah(async (req, res) => {
    const b = parse(RunBody, req.body ?? {});
    res.status(202).json(await startRun(userId(req), b.evalItemIds));
  }),
);
adminEvalRouter.get('/admin/eval/runs/:evalRunId', ah(async (req, res) => void res.json(await runView(int(req.params.evalRunId)))));

// 7.7 근거 적합성
adminEvalRouter.get('/admin/eval/runs/:evalRunId/evidence-reviews', ah(async (req, res) => void res.json(await evidenceReviews(int(req.params.evalRunId)))));
adminEvalRouter.put(
  '/admin/eval/runs/:evalRunId/evidence-reviews/:evalItemId/:evidenceVersionId',
  ah(async (req, res) => {
    const b = parse(VerdictBody, req.body);
    res.json(await putEvidenceReview(int(req.params.evalRunId), int(req.params.evalItemId), int(req.params.evidenceVersionId), b.verdict, userId(req)));
  }),
);

// 7.9 기록·확정
adminEvalRouter.post('/admin/eval/runs/:evalRunId/record', ah(async (req, res) => void res.json(await recordRun(int(req.params.evalRunId)))));
adminEvalRouter.post('/admin/eval/runs/:evalRunId/confirm', ah(async (req, res) => void res.json(await confirmRun(int(req.params.evalRunId)))));

// 7.3 비교만 수행
adminEvalRouter.get(
  '/admin/eval/compare',
  ah(async (req, res) => {
    const q = parse(z.object({ a: z.coerce.number().int().positive(), b: z.coerce.number().int().positive() }), req.query);
    res.json(await compareRuns(q.a, q.b));
  }),
);
