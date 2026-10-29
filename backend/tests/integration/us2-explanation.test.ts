// T089 — explanation·comparison·similar-cases 계약 스키마, 재생성(A6), G9, 대응 표준약관 없음·근거 미확인 시 비교 비활성(UC3 A1·A2·A5)
import fs from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fixture, newAgent, resetDb, startStub, teardown, sql, type StubHandle } from './setup.js';
import { analyzeToSaved, startText } from './flow.js';
import { expectResponse } from '../contract/harness.js';
import { getPool, select, selectOne } from '../../src/db/pool.js';
import { resetStatusCache } from '../../src/modules/modelApi/status.js';

let stub: StubHandle;
const SAMPLE = fs.readFileSync(fixture('contracts/subscription-sample.txt'), 'utf8');
const agent = () => shared;
let shared: ReturnType<typeof newAgent>;
let runId = 0;
let risky: number[] = [];

async function detail(id: number) {
  return (await agent().get(`/api/results/${runId}/clauses/${id}`).expect(200)).body;
}
async function judgmentOf(assessmentId: number) {
  return (await selectOne<{ judgment_id: number }>(getPool(), 'SELECT judgment_id FROM clause_assessment WHERE assessment_id = ?', [assessmentId]))!.judgment_id;
}

beforeAll(async () => {
  await resetDb();
  stub = await startStub();
  shared = newAgent();
  const r = await analyzeToSaved(shared, () => startText(shared, SAMPLE));
  runId = r.runId;
  risky = (await shared.get(`/api/results/${runId}`).expect(200)).body.riskOrder;
});
afterAll(async () => {
  await stub.close();
  await teardown();
});
beforeEach(() => {
  Object.assign(stub.config, { unknownLabel: false, perspectiveDiverge: false, health: 'ready' });
  resetStatusCache();
});

describe('쉬운 설명(4.8)', () => {
  it('주장마다 판정 근거 집합 안의 근거가 붙는다', async () => {
    let checked = 0;
    for (const id of risky) {
      const e = await agent().get(`/api/results/${runId}/clauses/${id}/explanation`).expect(200);
      expectResponse('web', 'GET', '/results/{runId}/clauses/{assessmentId}/explanation', 200, e.body);
      if (!e.body.available) continue;
      const d = await detail(id);
      const ids = new Set(d.evidence.map((x: { evidenceVersionId: number }) => x.evidenceVersionId));
      for (const c of e.body.claims) expect(ids.has(c.evidenceVersionId)).toBe(true);
      expect(e.body.focus).toBe('consumer_disadvantage');
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('주장이 모두 빠졌으면 같은 캐시 키로 1회 재생성해 설명만 채운다', async () => {
    const id = risky[0]!;
    const jid = await judgmentOf(id);
    await sql('DELETE FROM explanation_claim WHERE judgment_id = ?', [jid]);
    const before = (await selectOne<{ m3_category: string }>(getPool(), 'SELECT m3_category FROM judgment WHERE judgment_id = ?', [jid]))!;
    const e = await agent().get(`/api/results/${runId}/clauses/${id}/explanation`).expect(200);
    expect(e.body.available).toBe(true);
    const j = (await selectOne<{ m3_category: string; explanation_regen_count: number }>(getPool(), 'SELECT m3_category, explanation_regen_count FROM judgment WHERE judgment_id = ?', [jid]))!;
    expect(j.explanation_regen_count).toBe(1);
    expect(j.m3_category).toBe(before.m3_category);
  });

  it('재생성 결과의 분류가 다르면 폐기하고 G9(부분 차단) — 판정·근거는 계속 제공', async () => {
    const id = risky[1]!;
    const jid = await judgmentOf(id);
    await sql('DELETE FROM explanation_claim WHERE judgment_id = ?', [jid]);
    // 사업자 관점으로 요청하는 척 — 스텁이 관점별 분류를 다르게 내도록
    await sql("UPDATE judgment SET perspective = 'business' WHERE judgment_id = ?", [jid]).catch(() => undefined);
    stub.config.perspectiveDiverge = true;
    await sql("UPDATE judgment SET perspective = 'consumer' WHERE judgment_id = ?", [jid]).catch(() => undefined);
    stub.config.unknownLabel = true; // 라벨 오류도 재생성 실패로 끝난다
    const e = await agent().get(`/api/results/${runId}/clauses/${id}/explanation`).expect(200);
    expect(e.body.available).toBe(false);
    expect(e.body.gate.gate).toBe('G9');
    expect(e.body.gate.title).toBe('설명 제공 불가');
    const d = await detail(id);
    expect(d.explanationAvailable).toBe(false);
    expect(d.evidence.length).toBeGreaterThan(0);
    const open = await select(getPool(), "SELECT event_id FROM v_gate_open WHERE gate_code = 'G9' AND judgment_id = ?", [jid]);
    expect(open).toHaveLength(1);
  });

  it('정상 조항은 설명이 없다(available=false, 게이트 없음)', async () => {
    const r = await agent().get(`/api/results/${runId}`).expect(200);
    const normal = r.body.clauses.find((c: { displayCategory: string }) => c.displayCategory === 'normal');
    const e = await agent().get(`/api/results/${runId}/clauses/${normal.assessmentId}/explanation`).expect(200);
    expect(e.body.available).toBe(false);
    expect(e.body.gate).toBeUndefined();
  });
});

describe('비교 보기(4.10)·유사 사례(4.11)', () => {
  it('원문 대 법령 조문·표준약관을 나란히 준다(계약 스키마)', async () => {
    let withLaw = 0;
    for (const id of risky) {
      const c = await agent().get(`/api/results/${runId}/clauses/${id}/comparison`).expect(200);
      expectResponse('web', 'GET', '/results/{runId}/clauses/{assessmentId}/comparison', 200, c.body);
      expect(c.body.clauseText.length).toBeGreaterThan(0);
      if (c.body.law) {
        expect(c.body.law.sourceType).toBe('law_article');
        withLaw++;
      }
      if (!c.body.stdTerms) expect(c.body.unavailableReasons.stdTerms ?? c.body.unavailableReasons.all).toBeTruthy();
      expect(c.body.businessDiffNotes).toEqual([]);
    }
    expect(withLaw).toBeGreaterThan(0);
  });

  it('근거 미확인 조항이면 비교를 제공하지 않는다(UC3 A5)', async () => {
    const id = risky[risky.length - 1]!;
    await sql('DELETE FROM judgment_evidence WHERE judgment_id = ?', [await judgmentOf(id)]);
    const c = await agent().get(`/api/results/${runId}/clauses/${id}/comparison`).expect(200);
    expect(c.body.available).toBe(false);
    expect(c.body.law).toBeNull();
    expect(c.body.stdTerms).toBeNull();
    expect(c.body.unavailableReasons.all).toContain('근거가 확인되지 않은');
  });

  it('유사 공정위 사례는 사실관계·판단·판단 근거 3구분(없으면 빈 배열)', async () => {
    let cases = 0;
    for (const id of risky) {
      const s = await agent().get(`/api/results/${runId}/clauses/${id}/similar-cases`).expect(200);
      expectResponse('web', 'GET', '/results/{runId}/clauses/{assessmentId}/similar-cases', 200, s.body);
      for (const c of s.body) {
        expect(c.sourceType).toBe('ftc_case');
        expect(c.caseFacts && c.caseJudgment && c.caseBasis).toBeTruthy();
        cases++;
      }
    }
    expect(cases).toBeGreaterThanOrEqual(0);
  });
});
