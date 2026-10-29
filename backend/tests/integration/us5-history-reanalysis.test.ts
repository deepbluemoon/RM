// T113 — 분석 기록(6.1·6.2)·변경 내용(6.3)·재분석(6.5~6.7). 기록은 로그인 없이 브라우저별로 보이고, 재분석은 G5 만 확인하며,
// M4 를 부르지 않으며(UC5 A5), 저장되면 v_result_impact_active 에서 빠지고, 도중 G5 면 기존 결과가 보존된다
import fs from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { browserAgent, fixture, resetDb, sql, startStub, teardown, waitFor, type StubHandle } from './setup.js';
import { analyzeToSaved, startText, status } from './flow.js';
import { expectResponse } from '../contract/harness.js';
import { getPool, select, selectOne } from '../../src/db/pool.js';
import { resetStatusCache } from '../../src/modules/modelApi/status.js';

let stub: StubHandle;
const SAMPLE = fs.readFileSync(fixture('contracts/subscription-sample.txt'), 'utf8');
const count = async (q: string, p: unknown[] = []) => Number((await selectOne<{ n: number }>(getPool(), q, p))!.n);

/** 새 지식 기준일을 활성으로 만든다(기존 근거 버전은 열린 구간이라 그대로 유효) */
async function activateNewKv(date: string, seq: number): Promise<number> {
  await sql("UPDATE knowledge_version SET status = 'superseded' WHERE status = 'active'");
  const r = await sql("INSERT INTO knowledge_version (kv_seq, knowledge_date, analysis_basis_version, status) VALUES (?, ?, ?, 'active')", [seq, date, `v1.${seq}`]);
  return r.insertId;
}

beforeAll(async () => {
  await resetDb();
  stub = await startStub({ recordBodies: true });
});
afterAll(async () => {
  await stub.close();
  await teardown();
});
beforeEach(() => {
  Object.assign(stub.config, { health: 'ready', judgeDelayMs: 0 });
  resetStatusCache();
});

describe('US5 분석 기록·재분석', () => {
  let owner: ReturnType<typeof browserAgent>;
  let other: ReturnType<typeof browserAgent>;
  const saved: { requestId: number; runId: number }[] = [];
  let kv2 = 0;
  const kv2Date = '2026-09-25';
  let reRunId = 0;

  it('준비 — 브라우저 A 가 두 건 분석, 브라우저 B 가 한 건 분석', async () => {
    owner = browserAgent();
    other = browserAgent();
    saved.push(await analyzeToSaved(owner, () => startText(owner, SAMPLE)));
    saved.push(await analyzeToSaved(owner, () => startText(owner, SAMPLE)));
    await analyzeToSaved(other, () => startText(other, SAMPLE));
  });

  it('기록 목록 — 본인 것만, 최신순, 계약 스키마', async () => {
    const r = await owner.get('/api/history').expect(200);
    expectResponse('web', 'GET', '/history', 200, r.body);
    expect(r.body.items.map((i: { requestId: number }) => i.requestId)).toEqual([saved[1]!.requestId, saved[0]!.requestId]);
    const it0 = r.body.items[0];
    expect(it0.latestRunId).toBe(saved[1]!.runId);
    expect(it0.knowledgeDate).toBe('2026-09-15');
    expect(it0.evidenceChanged).toBe(false);
    expect(typeof it0.displayName).toBe('string');
    expect(it0.counts).toHaveProperty('high');
    expect(r.body.nextCursor).toBeNull();
    // 한 건씩 넘기기
    const p1 = await owner.get('/api/history?limit=1').expect(200);
    expect(p1.body.items).toHaveLength(1);
    expect(p1.body.nextCursor).toBeTruthy();
    const p2 = await owner.get(`/api/history?limit=1&cursor=${encodeURIComponent(p1.body.nextCursor)}`).expect(200);
    expect(p2.body.items[0].requestId).toBe(saved[0]!.requestId);
  });

  it('로그인 없이 기록이 열린다 — 각 브라우저는 자기 기록만(UC5 E1 없음)', async () => {
    const b = await other.get('/api/history').expect(200);
    expectResponse('web', 'GET', '/history', 200, b.body);
    expect(b.body.items).toHaveLength(1);
    expect(b.body.items.map((i: { requestId: number }) => i.requestId)).not.toContain(saved[0]!.requestId);
    const fresh = await browserAgent().get('/api/history').expect(200);
    expect(fresh.body.items).toHaveLength(0);
  });

  it('타인 기록 열람은 G8(403)', async () => {
    const r = await other.get(`/api/history/${saved[0]!.requestId}`);
    expect(r.status).toBe(403);
    expectResponse('web', 'GET', '/history/{requestId}', 403, r.body);
    expect(r.body.gate).toBe('G8');
    const re = await other.post(`/api/history/${saved[0]!.requestId}/reanalyses`).send({ prevRunId: saved[0]!.runId });
    expect(re.status).toBe(403);
  });

  it('기록 열람 — 실행 목록과 당시 기준일, 결과(P4 형식)', async () => {
    const r = await owner.get(`/api/history/${saved[0]!.requestId}`).expect(200);
    expectResponse('web', 'GET', '/history/{requestId}', 200, r.body);
    expect(r.body.runs).toHaveLength(1);
    expect(r.body.runs[0]).toMatchObject({ runId: saved[0]!.runId, runKind: 'analysis', prevRunId: null, knowledgeDate: '2026-09-15', evidenceChanged: false });
    expect(r.body.result.runId).toBe(saved[0]!.runId);
    expect(r.body.result.knowledgeDate).toBe('2026-09-15');
    expect(r.body).not.toHaveProperty('quota');
  });

  it('새 기준일에서 근거가 바뀌면(result_impact) 변경 표시·변경 내용이 보인다', async () => {
    kv2 = await activateNewKv(kv2Date, 2);
    const [ei] = await select<{ evidence_item_id: number }>(getPool(), 'SELECT evidence_item_id FROM evidence_item ORDER BY evidence_item_id LIMIT 1');
    await sql("INSERT INTO result_impact (run_id, kv_id, evidence_item_id, change_kind) VALUES (?, ?, ?, 'amend')", [saved[0]!.runId, kv2, ei!.evidence_item_id]);
    const list = await owner.get('/api/history');
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const item = list.body.items.find((i: { requestId: number }) => i.requestId === saved[0]!.requestId);
    expect(item.evidenceChanged).toBe(true);
    const res = await owner.get(`/api/results/${saved[0]!.runId}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.impactNotice).toMatchObject({ amend: 1 });
    const im = await owner.get(`/api/results/${saved[0]!.runId}/impacts`);
    expect(im.status, JSON.stringify(im.body)).toBe(200);
    expectResponse('web', 'GET', '/results/{runId}/impacts', 200, im.body);
    expect(im.body).toHaveLength(1);
    expect(im.body[0]).toMatchObject({ kvId: kv2, knowledgeDate: kv2Date, changeKind: 'amend', evidenceItemId: ei!.evidence_item_id });
    expect(im.body[0].sourceName).toBeTruthy();
    expect(im.body[0].identifier).toBeTruthy();
    const detail = await owner.get(`/api/history/${saved[0]!.requestId}`);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(detail.body.runs[0].evidenceChanged).toBe(true);
    // 타인은 변경 내용도 볼 수 없다
    expect((await other.get(`/api/results/${saved[0]!.runId}/impacts`)).status).toBe(403);
  });

  it('재분석 사전검증 G5 — 서버가 준비되지 않으면 503, 실행 행 없음', async () => {
    stub.config.health = 'loading';
    resetStatusCache();
    const before = await count('SELECT COUNT(*) AS n FROM analysis_run WHERE request_id = ?', [saved[0]!.requestId]);
    const r = await owner.post(`/api/history/${saved[0]!.requestId}/reanalyses`).send({ prevRunId: saved[0]!.runId });
    expect(r.status).toBe(503);
    expectResponse('web', 'POST', '/history/{requestId}/reanalyses', 503, r.body);
    expect(r.body.gate).toBe('G5');
    expect(await count('SELECT COUNT(*) AS n FROM analysis_run WHERE request_id = ?', [saved[0]!.requestId])).toBe(before);
  });

  it('재분석이 시작된다 — 새 기준일, M4 미호출, usage_charge 증가 없음', async () => {
    const chargesBefore = await count('SELECT COUNT(*) AS n FROM usage_charge');
    const summarizeBefore = stub.received.filter((x) => x.path === '/v1/summarize').length;
    const r = await owner.post(`/api/history/${saved[0]!.requestId}/reanalyses`).send({ prevRunId: saved[0]!.runId });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expectResponse('web', 'POST', '/history/{requestId}/reanalyses', 202, r.body);
    expect(r.body.knowledgeDate).toBe(kv2Date);
    reRunId = r.body.runId;
    const run = await selectOne<{ run_kind: string; prev_run_id: number; kv_id: number }>(getPool(), 'SELECT run_kind, prev_run_id, kv_id FROM analysis_run WHERE run_id = ?', [reRunId]);
    expect(run).toMatchObject({ run_kind: 'reanalysis', prev_run_id: saved[0]!.runId, kv_id: kv2 });

    const done = await waitFor(() => status(owner, saved[0]!.requestId), (x) => x.run?.runId === reRunId && ['completed', 'aborted'].includes(x.run.stage), 30_000);
    expect(done.run.stage).toBe('completed');
    expect(done.run.runKind).toBe('reanalysis');
    // 비식별·구조화 단계는 재사용 표시
    expect(done.rail.filter((x: { state: string }) => x.state === 'reused').map((x: { step: string }) => x.step)).toEqual(['received', 'deidentify', 'structure']);
    expect(stub.received.filter((x) => x.path === '/v1/summarize').length).toBe(summarizeBefore);

    const save = await owner.post(`/api/analyses/${saved[0]!.requestId}/runs/${reRunId}/save`);
    expect(save.status, JSON.stringify(save.body)).toBe(200);
    expect(await count('SELECT COUNT(*) AS n FROM usage_charge')).toBe(chargesBefore);
  });

  it('재분석 결과 — 같은 조항 재사용, 요약·유형 유지, 새 기준일로 표시', async () => {
    const prev = await owner.get(`/api/results/${saved[0]!.runId}`).expect(200);
    const cur = await owner.get(`/api/results/${reRunId}`).expect(200);
    expect(cur.body.runKind).toBe('reanalysis');
    expect(cur.body.prevRunId).toBe(saved[0]!.runId);
    expect(cur.body.knowledgeDate).toBe(kv2Date);
    expect(cur.body.clauses.map((c: { clauseId: number }) => c.clauseId)).toEqual(prev.body.clauses.map((c: { clauseId: number }) => c.clauseId));
    expect(cur.body.documents.map((d: { contractType: string; summary: string | null }) => [d.contractType, d.summary])).toEqual(
      prev.body.documents.map((d: { contractType: string; summary: string | null }) => [d.contractType, d.summary]),
    );
    // 옛 결과는 당시 기준일 그대로
    expect(prev.body.knowledgeDate).toBe('2026-09-15');
  });

  it('재분석 저장 뒤 v_result_impact_active 에서 빠지고 변경 표시가 사라진다', async () => {
    expect(await count('SELECT COUNT(*) AS n FROM v_result_impact_active WHERE run_id = ?', [saved[0]!.runId])).toBe(0);
    const list = await owner.get('/api/history').expect(200);
    const item = list.body.items.find((i: { requestId: number }) => i.requestId === saved[0]!.requestId);
    expect(item.latestRunId).toBe(reRunId);
    expect(item.knowledgeDate).toBe(kv2Date);
    expect(item.evidenceChanged).toBe(false);
    const d = await owner.get(`/api/history/${saved[0]!.requestId}`).expect(200);
    expect(d.body.runs.map((r: { runKind: string }) => r.runKind)).toEqual(['analysis', 'reanalysis']);
    expect(d.body.runs[1].prevRunId).toBe(saved[0]!.runId);
  });

  it('재분석 도중 G5(서버 다운) — 새 실행은 aborted, 기존 결과는 보존된다', async () => {
    const kv3Date = '2026-09-27';
    await activateNewKv(kv3Date, 3);
    const req = saved[1]!;
    const before = await owner.get(`/api/results/${req.runId}`).expect(200);
    stub.config.judgeDelayMs = 1500;
    const r = await owner.post(`/api/history/${req.requestId}/reanalyses`).send({ prevRunId: req.runId });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    const runId = r.body.runId as number;
    await waitFor(() => status(owner, req.requestId), (x) => x.run?.runId === runId && x.run.stage === 'explaining', 20_000);
    stub.config.health = 'down';
    // 실행 중단 → G5 기록 순서라 둘 다 보일 때까지 기다린다
    const done = await waitFor(
      () => status(owner, req.requestId),
      (x) => x.run?.runId === runId && (x.run.stage === 'completed' || (x.run.stage === 'aborted' && x.openGates.some((g: { gate: string }) => g.gate === 'G5'))),
      30_000,
    );
    expect(done.run.stage).toBe('aborted');
    stub.config.health = 'ready';
    resetStatusCache();
    // 기존 결과·기록은 그대로
    const after = await owner.get(`/api/results/${req.runId}`).expect(200);
    expect(after.body.clauses).toEqual(before.body.clauses);
    expect(after.body.knowledgeDate).toBe(before.body.knowledgeDate);
    const list = await owner.get('/api/history').expect(200);
    expect(list.body.items.find((i: { requestId: number }) => i.requestId === req.requestId).latestRunId).toBe(req.runId);
    // 중단된 실행은 저장할 수 없다
    expect((await owner.post(`/api/analyses/${req.requestId}/runs/${runId}/save`)).status).toBe(409);
  });

  it('저장되지 않은 실행·다른 요청의 실행을 prevRunId 로 줄 수 없다', async () => {
    const r = await owner.post(`/api/history/${saved[0]!.requestId}/reanalyses`).send({ prevRunId: saved[1]!.runId });
    expect(r.status).toBe(404);
  });
});
