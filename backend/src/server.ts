// 기동(T035): policy·역할별 권한 표 로드 → 재기동 복구 → 원본 보관 기한 작업 → listen
import { env } from './config/env.js';
import { loadPolicy } from './config/policy.js';
import { createApp } from './app.js';
import { logger } from './logger.js';
import { recoverInterrupted } from './jobs/recovery.js';
import { startScheduledJobs } from './jobs/schedule.js';
import { closePool } from './db/pool.js';
import { loadRoleMatrix } from './modules/auth/rbac.service.js';

async function main() {
  await loadPolicy();
  await loadRoleMatrix();
  await recoverInterrupted();
  startScheduledJobs();
  const app = createApp();
  const server = app.listen(env.PORT, '127.0.0.1', () => logger.info({ port: env.PORT, env: env.NODE_ENV }, 'crd backend listening'));
  // Nginx upstream keep-alive(기본 60초)보다 길게 — 유휴 연결 종료 경합 방지
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  const stop = () => {
    server.close(() => void closePool().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((e: Error) => {
  logger.fatal({ err: e.message }, 'startup failed');
  process.exit(1);
});
