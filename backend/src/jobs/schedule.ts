// 정기 작업 — 보관 기한(10분). 근거 수집 cron 은 KNOWLEDGE_CRON 이 있을 때만(US7)
import cron from 'node-cron';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import { runRetention } from './retention.js';
import { startBatch } from '../modules/knowledge/ingest.service.js';

export function startScheduledJobs(): void {
  if (env.NODE_ENV === 'test') return;
  cron.schedule('*/10 * * * *', () => {
    runRetention().catch((e: Error) => logger.error({ err: e.message }, 'retention failed'));
  });
  void runRetention().catch(() => undefined);
  // P0 0.1 정기 수집(선택, T133) — 수집·전처리까지만 자동. 승인(0.4)은 항상 운영자가 S0 에서 한다
  if (env.KNOWLEDGE_CRON) {
    if (!cron.validate(env.KNOWLEDGE_CRON)) {
      logger.warn({ cron: env.KNOWLEDGE_CRON }, 'KNOWLEDGE_CRON 형식 오류 — 정기 수집을 켜지 않습니다');
    } else {
      cron.schedule(env.KNOWLEDGE_CRON, () => {
        startBatch().catch((e: Error) => logger.error({ err: e.message }, 'knowledge ingest (cron) failed'));
      });
    }
  }
}
