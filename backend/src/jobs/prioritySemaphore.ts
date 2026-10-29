// 우선순위 세마포어 — 먼저 시작한 실행의 작업을 먼저 배정한다(선입 우선, research R-04)
export class PrioritySemaphore {
  private active = 0;
  private waiting: { prio: number; sub: number; seq: number; resolve: () => void }[] = [];
  private seq = 0;

  constructor(private readonly limit: number) {}

  get queued(): number {
    return this.waiting.length;
  }

  get running(): number {
    return this.active;
  }

  /** prio 가 같으면 sub(작을수록 먼저) → 도착 순서. sub 는 같은 실행 안의 순서(예: 위험 점수 순위) */
  async run<T>(prio: number, fn: () => Promise<T>, sub = 0): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => {
        this.waiting.push({ prio, sub, seq: this.seq++, resolve });
        this.waiting.sort((a, b) => a.prio - b.prio || a.sub - b.sub || a.seq - b.seq);
      });
    } else {
      this.active++;
    }
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next.resolve();
      else this.active--;
    }
  }
}
