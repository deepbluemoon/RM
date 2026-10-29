import { describe, expect, it } from 'vitest';
import { PrioritySemaphore } from '../../src/jobs/prioritySemaphore.js';

describe('PrioritySemaphore', () => {
  it('prio 가 같으면 sub(위험 순위) 작은 것부터, 다르면 prio(먼저 시작한 실행) 우선', async () => {
    const g = new PrioritySemaphore(1);
    const order: string[] = [];
    let release!: () => void;
    const first = g.run(100, () => new Promise<void>((r) => { release = r; }));
    // 대기열에 도착 순서를 섞어 넣는다
    const jobs = [
      g.run(100, async () => { order.push('run100-rank2'); }, 2),
      g.run(200, async () => { order.push('run200-rank0'); }, 0),
      g.run(100, async () => { order.push('run100-rank0'); }, 0),
      g.run(100, async () => { order.push('run100-rank1'); }, 1),
    ];
    release();
    await Promise.all([first, ...jobs]);
    expect(order).toEqual(['run100-rank0', 'run100-rank1', 'run100-rank2', 'run200-rank0']);
  });
});
