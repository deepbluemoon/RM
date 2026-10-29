// T144 — SC-009 전 흐름 성능(30쪽 텍스트형 문서, 95백분위 ≤ 3분). 실모델(로컬 모델 서버 게이트웨이 + 공유 Ollama)로만 돈다.
//   PERF_REAL_MODEL=1 TEST_DB_NAME=crd_test_perf npx vitest run tests/perf/sc009.test.ts
//   PERF_SAMPLES=20(기본) · PERF_CONDITIONS=solo,pair(기본)
// 공유 서버라 사용자가 적은 시간대에 돌린다. 문서마다 문장을 조금씩 바꿔 판정 캐시가 적중하지 않게 한다.
// 측정 구간 = 분석 요청 → 실행 completed. 계약 유형 확인(사용자 대기)은 곧바로 확정해 사람 시간을 빼고 잰다.
// 결과는 tests/perf/results/sc009-*.json 에 남기고, model-serving.md §8 에 옮겨 적는다.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture, newAgent, resetDb, teardown, waitFor } from '../integration/setup.js';
import { startText, status } from '../integration/flow.js';
import { fileURLToPath } from 'node:url';

const REAL = process.env.PERF_REAL_MODEL === '1';
const N = Number(process.env.PERF_SAMPLES ?? 20);
const CONDITIONS = (process.env.PERF_CONDITIONS ?? 'solo,pair').split(',').map((s) => s.trim());
const LIMIT_SEC = 180;
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'results');

/** 표본 40조를 100조(약 30쪽)로 늘리고, 표본 번호 k 로 문장을 바꿔 캐시 적중을 막는다 */
export function thirtyPageSample(k: number): string {
  const src = fs.readFileSync(fixture('contracts/subscription-sample.txt'), 'utf8');
  const [title, ...rest] = src.split('\n');
  const body = rest.join('\n');
  const articles = body.split(/\n(?=제\d+조\()/u).map((a) => a.trim()).filter((a) => /^제\d+조\(/u.test(a));
  const out: string[] = [`${title} (표본 ${k})`, ''];
  for (let i = 0; i < 100; i++) {
    const a = articles[i % articles.length]!;
    const round = Math.floor(i / articles.length) + 1;
    out.push(a.replace(/^제\d+조/u, `제${i + 1}조`) + ` 이 조는 ${k}번 표본의 ${round}차 부속 조건에도 적용한다.`);
  }
  return out.join('\n');
}

function p95(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]!;
}

async function oneRun(k: number): Promise<{ k: number; sec: number; clauses: number; unanalyzable: number }> {
  const agent = newAgent();
  const t0 = Date.now();
  const r = await startText(agent, thirtyPageSample(k));
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const id = r.body.requestId as number;
  const st = await waitFor(() => status(agent, id), (x) => ['awaiting_type', 'stopped'].includes(x.requestStage), 600_000, 500);
  expect(st.requestStage).toBe('awaiting_type');
  for (const d of st.documents as { documentId: number }[]) {
    await agent.put(`/api/analyses/${id}/documents/${d.documentId}/contract-type`).send({ contractType: 'subscription' }).expect(200);
  }
  const done = await waitFor(() => status(agent, id), (x) => !!x.run && ['completed', 'aborted'].includes(x.run.stage), 900_000, 1000);
  const sec = (Date.now() - t0) / 1000;
  expect(done.run.stage).toBe('completed');
  const save = await agent.post(`/api/analyses/${id}/runs/${done.run.runId}/save`);
  const view = save.status === 200 ? (await agent.get(`/api/results/${done.run.runId}`)).body : null;
  const unanalyzable = view ? Number(view.counts?.unanalyzable ?? 0) : -1;
  return { k, sec: Math.round(sec * 10) / 10, clauses: done.run.clauseTotal, unanalyzable };
}

describe.skipIf(!REAL)('SC-009 실모델 성능(T144)', () => {
  const results: Record<string, { runs: Awaited<ReturnType<typeof oneRun>>[]; p95: number; pass: boolean }> = {};

  beforeAll(async () => {
    await resetDb();
  }, 300_000);
  afterAll(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const file = path.join(OUT, `sc009-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, JSON.stringify({ samples: N, limitSec: LIMIT_SEC, results }, null, 2));
    process.stdout.write(`${JSON.stringify(Object.fromEntries(Object.entries(results).map(([c, v]) => [c, { p95: v.p95, pass: v.pass, n: v.runs.length }])))}\n→ ${file}\n`);
    await teardown();
  });

  it.runIf(CONDITIONS.includes('solo'))('단독: 한 번에 1건', async () => {
    const runs = [];
    for (let k = 0; k < N; k++) runs.push(await oneRun(1000 + k));
    const v = p95(runs.map((r) => r.sec));
    results.solo = { runs, p95: v, pass: v <= LIMIT_SEC };
    expect(runs.length).toBe(N);
  }, 24 * 3600_000);

  it.runIf(CONDITIONS.includes('pair'))('2건 동시', async () => {
    const runs = [];
    for (let k = 0; k < N; k += 2) {
      const pair = await Promise.all([oneRun(2000 + k), ...(k + 1 < N ? [oneRun(2000 + k + 1)] : [])]);
      runs.push(...pair);
    }
    const v = p95(runs.map((r) => r.sec));
    results.pair = { runs, p95: v, pass: v <= LIMIT_SEC };
    expect(runs.length).toBe(N);
  }, 24 * 3600_000);
});
