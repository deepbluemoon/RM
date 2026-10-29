// 앱 조립(T035): 요청 ID → logger → 보안 헤더 → 세션 → authenticate(계정·역할) → authorize(RBAC, rbac.ts) → routes → errorHandler. 접두사 /api
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { logger } from './logger.js';
import { requestId } from './middleware/requestId.js';
import { sessionMiddleware } from './middleware/session.js';
import { authenticate, authorize } from './middleware/auth.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { metaRouter } from './routes/meta.routes.js';
import { mountFeatureRoutes } from './routes/index.js';
import { rateLimits } from './middleware/rateLimit.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 'loopback');
  app.disable('x-powered-by');
  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request).id,
      // 요청·응답 본문·쿼리 문자열은 기록하지 않는다(FR-009)
      serializers: {
        req: (r: { id: string; method: string; url: string }) => ({ id: r.id, method: r.method, path: r.url.split('?')[0] }),
        res: (r: { statusCode: number }) => ({ status: r.statusCode }),
      },
      autoLogging: { ignore: (req) => req.url === '/api/model-server/status' },
    }),
  );
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json({ limit: '3mb' }));
  const api = express.Router();
  api.use(sessionMiddleware());
  api.use(authenticate);
  rateLimits(api);
  api.use(authorize);
  api.use(authRouter);
  api.use(metaRouter);
  mountFeatureRoutes(api);
  api.use(notFound);
  app.use('/api', api);
  app.use(errorHandler);
  return app;
}
