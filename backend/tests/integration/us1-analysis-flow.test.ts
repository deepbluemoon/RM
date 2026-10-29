// T061 — 업로드 → POST /analyses → 폴링 → 유형 확정 → 완료 → save → GET /results/{runId}
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newAgent, resetDb, startStub, teardown, sql, type StubHandle } from './setup.js';
import { analyzeToSaved, startFile } from './flow.js';
import { expectResponse } from '../contract/harness.js';
import { getPool, select } from '../../src/db/pool.js';

let stub: StubHandle;
beforeAll(async () => {
  await resetDb();
  stub = await startStub();
});
afterAll(async () => {
  await stub.close();
  await teardown();
});

describe('US1 전체 흐름', () => {
  const agent = newAgent();
  let requestId = 0;
  let runId = 0;

  it('첫 진입 — 로그인 세션(crd.sid)으로 들어오고 기기 쿠키(crd_device)는 없다', async () => {
    const s = await agent.get('/api/meta/privacy-notice').expect(200);
    expectResponse('web', 'GET', '/meta/privacy-notice', 200, s.body);
    expect(String(s.headers['set-cookie'] ?? '')).not.toContain('crd_device=');
    expect(s.body).not.toHaveProperty('anonRetentionHours');
    expect((await agent.get('/api/session').expect(200)).body).toMatchObject({ loggedIn: true, user: { role: 'user' } });
  });

  it('업로드 → 분석 → 유형 확정 → 완료 → 저장', async () => {
    const r = await analyzeToSaved(agent, () => startFile(agent, 'contracts/subscription-sample.pdf'));
    requestId = r.requestId;
    runId = r.runId;
    expect(r.status.documents[0].contractTypeCandidate).toBe('subscription');
    expect(r.status.rail.map((x: { step: string }) => x.step)).toEqual(['received', 'deidentify', 'structure', 'detect', 'search', 'explain']);
    expect(typeof r.status.elapsedSec).toBe('number');
  });

  it('진행 상태 — 위험 후보·판정 수와 판정된 위험 조항(판정 순서 = 위험 점수 높은 순, 2026-09-30)', async () => {
    const st = await agent.get(`/api/analyses/${requestId}`).expect(200);
    expectResponse('web', 'GET', '/analyses/{requestId}', 200, st.body);
    const run = st.body.run;
    expect(run.riskTotal).toBeGreaterThan(0);
    expect(run.judgedCount).toBe(run.riskTotal);
    expect(run.judged.length + run.judgedNormalCount).toBeLessThanOrEqual(run.riskTotal);
    for (const j of run.judged) expect(['dispute', 'unfair', 'illegal']).toContain(j.category);
    // 판정 순서가 위험 점수 내림차순인지 — 판정 행(assessment_id)이 점수 높은 순으로 쌓인다
    const rows = await select<{ s: number }>(getPool(),
      `SELECT GREATEST(COALESCE(score_loophole, 0), COALESCE(score_illegal, 0)) AS s FROM clause_assessment
        WHERE run_id = ? AND status = 'judged' ORDER BY assessment_id`, [runId]);
    const scores = rows.map((r) => Number(r.s));
    expect(scores).toEqual([...scores].sort((x, y) => y - x));
  });

  it('저장하면 결과 보기 기록(usage_charge) 1건', async () => {
    const uc = await select<{ n: number }>(getPool(), 'SELECT COUNT(*) AS n FROM usage_charge WHERE run_id = ?', [runId]);
    expect(Number(uc[0]!.n)).toBe(1);
  });

  it('저장은 멱등 — 두 번째 save 는 기록을 늘리지 않는다', async () => {
    await agent.post(`/api/analyses/${requestId}/runs/${runId}/save`).expect(200);
    const uc = await select<{ n: number }>(getPool(), 'SELECT COUNT(*) AS n FROM usage_charge');
    expect(Number(uc[0]!.n)).toBe(1);
  });

  it('결과 — 고지·지식 기준일·위험도별 개수·원문 구조·위험도순 목록', async () => {
    const r = await agent.get(`/api/results/${runId}`).expect(200);
    expectResponse('web', 'GET', '/results/{runId}', 200, r.body);
    expect(r.body.disclaimer).toContain('법률 자문이 아니며');
    expect(r.body.knowledgeDate).toBe('2026-09-15');
    const c = r.body.counts;
    expect(c.high + c.mid + c.low).toBeGreaterThan(0);
    expect(r.body.clauses.length).toBeGreaterThanOrEqual(40);
    expect(r.body.riskOrder.length).toBeGreaterThan(0);
    // 표본의 불공정 조항(제12·15·18·22·27조)은 위험으로 표시된다
    const risky = new Set(r.body.clauses.filter((x: { displayCategory: string }) => x.displayCategory !== 'normal').map((x: { articleNo: string }) => x.articleNo));
    for (const a of ['제12조', '제15조', '제18조', '제22조', '제27조']) expect(risky.has(a), a).toBe(true);
  });

  it('불공정·위법 가능 조항마다 근거 1개 이상, 근거는 6항목', async () => {
    const r = await agent.get(`/api/results/${runId}`).expect(200);
    for (const id of r.body.riskOrder as number[]) {
      const d = await agent.get(`/api/results/${runId}/clauses/${id}`).expect(200);
      expectResponse('web', 'GET', '/results/{runId}/clauses/{assessmentId}', 200, d.body);
      if (['unfair', 'illegal'].includes(d.body.displayCategory)) {
        expect(d.body.evidence.length).toBeGreaterThanOrEqual(1);
        for (const e of d.body.evidence) {
          for (const k of ['sourceType', 'sourceName', 'identifier', 'excerpt', 'sourceUrl']) expect(e[k], k).toBeTruthy();
          expect(e.effectiveDate ?? e.publishedDate).toBeTruthy();
          const ev = await agent.get(`/api/evidence/${e.evidenceVersionId}`).expect(200);
          expectResponse('web', 'GET', '/evidence/{evidenceVersionId}', 200, ev.body);
        }
      }
    }
  });

  it('근거 없는 불공정·위법 판정은 분쟁 가능(근거 미확인)으로 강등된다', async () => {
    const r = await agent.get(`/api/results/${runId}`).expect(200);
    let target: number | null = null;
    for (const id of r.body.riskOrder as number[]) {
      const d = await agent.get(`/api/results/${runId}/clauses/${id}`);
      if (['unfair', 'illegal'].includes(d.body.displayCategory)) {
        target = id;
        break;
      }
    }
    expect(target).not.toBeNull();
    const [a] = await select<{ judgment_id: number }>(getPool(), 'SELECT judgment_id FROM clause_assessment WHERE assessment_id = ?', [target]);
    // 판정은 캐시라 다른 결과와 공유될 수 있다 — 이 테스트는 근거 행만 지워 뷰의 강등을 확인한다
    await sql('DELETE FROM judgment_evidence WHERE judgment_id = ?', [a!.judgment_id]);
    const d = await agent.get(`/api/results/${runId}/clauses/${target}`).expect(200);
    expect(d.body.displayCategory).toBe('dispute');
    expect(d.body.evidenceUnconfirmed).toBe(true);
  });

  it('같은 조항을 다시 분석하면 판정 캐시가 적중한다(M3 재호출 없음)', async () => {
    const judgeCallsBefore = stub.received.filter((x) => x.path === '/v1/judge').length;
    await analyzeToSaved(agent, () => startFile(agent, 'contracts/subscription-sample.pdf'));
    const judgeCallsAfter = stub.received.filter((x) => x.path === '/v1/judge').length;
    // 앞 테스트에서 근거를 지운 판정 1건도 캐시 행은 남아 있으므로 새 호출은 없다
    expect(judgeCallsAfter).toBe(judgeCallsBefore);
  });

  it('/v1/jobs 요청 본문에 관점 필드가 없다(A3)', () => {
    const jobs = stub.received.filter((x) => x.path === '/v1/jobs');
    expect(jobs.length).toBeGreaterThan(0);
    for (const j of jobs) expect(Object.keys(j.body as object)).not.toContain('perspective');
  });

  it('모델 서버 상태(C11) — 계약 스키마', async () => {
    const s = await agent.get('/api/model-server/status?refresh=1').expect(200);
    expectResponse('web', 'GET', '/model-server/status', 200, s.body);
    expect(s.body.state).toBe('ready');
  });
});
