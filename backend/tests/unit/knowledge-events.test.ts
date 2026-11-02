// #99 지식 갱신 이벤트(옵저버 패턴) — 모든 구독자에 전달, 한 구독자의 실패가 다른 구독자를 막지 않음,
// 이벤트 내기는 구독자를 기다리지 않음, 반영(kv_activated) 뒤 벡터 채우기와 실패 시 계속 동작
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/modules/evidence/embedding.js', () => ({ embedEvidence: vi.fn() }));
const { embedEvidence } = await import('../../src/modules/evidence/embedding.js');
const { drainKnowledgeEvents, emitKnowledgeEvent, onKnowledgeEvent } = await import('../../src/modules/knowledge/events.js');
const { embedOnActivated } = await import('../../src/modules/knowledge/subscribers.js');

const ACTIVATED = { type: 'kv_activated', batchId: 3, kvId: 7, added: 2, closed: 1 } as const;
const offs: (() => void)[] = [];
afterEach(async () => {
  await drainKnowledgeEvents();
  for (const off of offs.splice(0)) off();
  vi.mocked(embedEvidence).mockReset();
});

describe('지식 갱신 이벤트', () => {
  it('구독자 모두에게 전달하고, 한 구독자가 실패해도 다른 구독자는 받는다', async () => {
    const got: string[] = [];
    offs.push(onKnowledgeEvent(() => { throw new Error('구독자 오류'); }));
    offs.push(onKnowledgeEvent((e) => void got.push(`a:${e.type}`)));
    offs.push(onKnowledgeEvent(async (e) => void got.push(`b:${e.type}`)));
    emitKnowledgeEvent({ type: 'no_changes', batchId: 1 });
    await drainKnowledgeEvents();
    expect(got.sort()).toEqual(['a:no_changes', 'b:no_changes']);
  });

  it('해지한 구독자는 받지 않는다', async () => {
    const got: string[] = [];
    const off = onKnowledgeEvent((e) => void got.push(e.type));
    off();
    emitKnowledgeEvent({ type: 'no_changes', batchId: 1 });
    await drainKnowledgeEvents();
    expect(got).toEqual([]);
  });

  it('이벤트 내기는 구독자가 끝날 때까지 기다리지 않는다', async () => {
    let release!: () => void;
    let done = false;
    offs.push(onKnowledgeEvent(() => new Promise<void>((r) => { release = () => { done = true; r(); }; })));
    emitKnowledgeEvent(ACTIVATED);
    await Promise.resolve();
    expect(done).toBe(false);
    release();
    await drainKnowledgeEvents();
    expect(done).toBe(true);
  });
});

describe('반영 뒤 벡터 채우기 구독자', () => {
  it('kv_activated 에만 새 기준일 벡터를 채운다', async () => {
    vi.mocked(embedEvidence).mockResolvedValue({ model: 'bge-m3@test', embedded: 2, remaining: 0 });
    await embedOnActivated({ type: 'review_ready', batchId: 3, units: 2, parseFailed: 0, carried: 0 });
    expect(embedEvidence).not.toHaveBeenCalled();
    await embedOnActivated(ACTIVATED);
    expect(embedEvidence).toHaveBeenCalledWith(7);
  });

  it('임베딩 서버가 없어 실패해도 예외를 내지 않는다(검색은 BM25 로 동작)', async () => {
    vi.mocked(embedEvidence).mockRejectedValue(new Error('model api /v1/embed unavailable 503'));
    await expect(embedOnActivated(ACTIVATED)).resolves.toBeUndefined();
  });
});
