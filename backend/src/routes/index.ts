// 기능 라우트 등록 — 스토리별 라우터를 여기서 붙인다
import type { Router } from 'express';
import { intakeRouter } from '../modules/intake/intake.routes.js';
import { analysisRouter } from '../modules/analysis/analysis.routes.js';
import { resultsRouter } from '../modules/results/results.routes.js';
import { historyRouter } from '../modules/history/history.routes.js';
import { feedbackRouter } from '../modules/feedback/feedback.routes.js';
import { adminKnowledgeRouter } from './admin.knowledge.routes.js';
import { adminModelApiRouter } from './admin.modelApi.routes.js';
import { adminEvalRouter } from './admin.eval.routes.js';
import { adminFeedbackRouter } from './admin.feedback.routes.js';
import { adminRbacRouter } from './admin.rbac.routes.js';

export function mountFeatureRoutes(api: Router): void {
  api.use(intakeRouter);
  api.use(analysisRouter);
  api.use(resultsRouter);
  api.use(historyRouter);
  api.use(feedbackRouter);
  api.use(adminKnowledgeRouter);
  api.use(adminModelApiRouter);
  api.use(adminEvalRouter);
  api.use(adminFeedbackRouter);
  api.use(adminRbacRouter);
}
