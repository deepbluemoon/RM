// 지식 갱신 이벤트 구독자(#99) — 서버 기동 때 한 번 등록한다(server.ts).
// 받는 곳을 추가하려면 여기 구독자를 하나 더 등록한다(예: 팀 채널 알림 — 채널이 정해지면).
import { env } from '../../config/env.js';
import { logger } from '../../logger.js';
import { asKvId } from '../../domain/types.js';
import { embedEvidence } from '../evidence/embedding.js';
import { onKnowledgeEvent, type KnowledgeEvent } from './events.js';

/** 결과를 운영 로그에 남긴다 — 수집 실패는 warn */
export function logKnowledgeEvent(e: KnowledgeEvent): void {
  if (e.type === 'collect_failed') logger.warn({ ...e }, 'knowledge event');
  else logger.info({ ...e }, 'knowledge event');
}

/** 새 기준일이 활성되면 그 근거의 벡터를 채운다(하이브리드 검색). 실패해도 검색은 BM25 로 동작한다 */
export async function embedOnActivated(e: KnowledgeEvent): Promise<void> {
  if (e.type !== 'kv_activated' || env.RAG_HYBRID !== 'on') return;
  try {
    const r = await embedEvidence(asKvId(e.kvId));
    logger.info({ kvId: e.kvId, model: r.model, embedded: r.embedded, remaining: r.remaining }, 'knowledge vectors filled after activation');
  } catch (err) {
    logger.warn({ kvId: e.kvId, err: (err as Error).message }, '새 기준일 근거 벡터를 채우지 못함 — 새 근거는 BM25 로 검색된다(embed-evidence 로 다시 채울 수 있음)');
  }
}

let registered: (() => void)[] | null = null;

export function registerKnowledgeSubscribers(): void {
  if (registered) return;
  registered = [onKnowledgeEvent(logKnowledgeEvent), onKnowledgeEvent(embedOnActivated)];
}

/** 테스트용 */
export function unregisterKnowledgeSubscribers(): void {
  for (const off of registered ?? []) off();
  registered = null;
}
