// 프로세스 내 작업 실행기(T032, research R-06). 진행 상태는 DB 에만 기록한다.
// 요청별 AbortController 로 사용자 취소(T076)·서버 다운 중단을 전달한다.
import pLimit from 'p-limit';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import { PrioritySemaphore } from './prioritySemaphore.js';

const limit = pLimit(Math.max(1, env.ANALYSIS_CONCURRENCY));
/** M3 /v1/judge 전역 제한기 — 공유 Ollama 는 동시 1건(model-serving §0) */
export const judgeGate = new PrioritySemaphore(Math.max(1, env.JUDGE_CONCURRENCY));

const controllers = new Map<number, AbortController>();
const running = new Set<Promise<unknown>>();

export class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new CancelledError();
}

export function enqueue(requestId: number, label: string, fn: (signal: AbortSignal) => Promise<void>): void {
  const ctrl = controllers.get(requestId) ?? new AbortController();
  controllers.set(requestId, ctrl);
  const p = limit(async () => {
    if (ctrl.signal.aborted) return;
    try {
      await fn(ctrl.signal);
    } catch (e) {
      if (!(e instanceof CancelledError)) logger.error({ requestId, label, err: (e as Error).message, stack: (e as Error).stack }, 'job failed');
    }
  }).finally(() => {
    running.delete(p);
  });
  running.add(p);
}

/** 사용자 취소 — 진행 중 작업에 중단 신호를 보낸다 */
export function cancel(requestId: number): void {
  controllers.get(requestId)?.abort();
}

export function release(requestId: number): void {
  controllers.delete(requestId);
}

export const queuedCount = (): number => limit.pendingCount;

/** 테스트·종료용 — 진행 중 작업이 끝날 때까지 기다린다 */
export async function drain(): Promise<void> {
  while (running.size) await Promise.allSettled([...running]);
}
