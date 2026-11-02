// 지식 갱신 이벤트(옵저버 패턴, #99) — 수집(0.1~0.3)·반영(0.4) 코드는 결과를 이벤트로 내기만 하고,
// 로그·벡터 채우기·(나중에) 알림 같은 반응은 구독자가 한다. 받는 곳을 늘려도 수집·반영 코드는 바뀌지 않는다.
// 구독자는 요청·수집 흐름과 분리해 비동기로 돌고, 하나가 실패해도 다른 구독자와 흐름은 계속된다.
import { logger } from '../../logger.js';
import type { Agency } from './collectors/index.js';

export type KnowledgeEvent =
  /** G0 — 한 기관이라도 받지 못함. 기존 기준일 유지 */
  | { type: 'collect_failed'; batchId: number; agencies: Agency[] }
  /** 반영 대상 확정(selecting) — 운영자 검토 대기. units 는 이번에 만든 항목 수(이월 포함) */
  | { type: 'review_ready'; batchId: number; units: number; parseFailed: number; carried: number }
  /** 수집은 됐지만 새로 반영할 항목이 없음 */
  | { type: 'no_changes'; batchId: number }
  /** 승인 — 새 기준일이 활성 */
  | { type: 'kv_activated'; batchId: number; kvId: number; added: number; closed: number };

export type KnowledgeListener = (e: KnowledgeEvent) => void | Promise<void>;

const listeners = new Set<KnowledgeListener>();
const pending = new Set<Promise<void>>();

/** 구독 — 돌려준 함수를 부르면 해지 */
export function onKnowledgeEvent(listener: KnowledgeListener): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** 이벤트 내기 — 기다리지 않는다(구독자가 오래 걸려도 승인 응답·수집을 막지 않음) */
export function emitKnowledgeEvent(e: KnowledgeEvent): void {
  for (const l of listeners) {
    const p = Promise.resolve()
      .then(() => l(e))
      .catch((err: Error) => logger.warn({ event: e.type, batchId: e.batchId, err: err?.message }, 'knowledge event listener failed'))
      .finally(() => pending.delete(p));
    pending.add(p);
  }
}

/** 테스트·종료용 — 진행 중인 구독자 처리가 끝날 때까지 기다린다 */
export async function drainKnowledgeEvents(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending]);
}
