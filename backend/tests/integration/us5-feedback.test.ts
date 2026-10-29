// T114 — 판정 피드백(P5): 위험 판정엔 오탐만, 정상·분석 불가엔 미탐만(5.2), 의견 미리보기 가림(5.3),
// 저장값 category_at_submit·kv_id·judgment_id 가 대상과 일치(BR-FDB-01 트리거), 브라우저 사용자(user_id)로 저장, 다른 브라우저 결과는 G8
import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentUserId, browserAgent, fixture, resetDb, sql, startStub, teardown, type StubHandle } from './setup.js';
import { analyzeToSaved, startText } from './flow.js';
import { expectResponse } from '../contract/harness.js';
import { getPool, select, selectOne } from '../../src/db/pool.js';

let stub: StubHandle;
const SAMPLE = fs.readFileSync(fixture('contracts/subscription-sample.txt'), 'utf8');

beforeAll(async () => {
  await resetDb();
  stub = await startStub();
});
afterAll(async () => {
  await stub.close();
  await teardown();
});

interface Target {
  assessment_id: number;
  judgment_id: number | null;
  display_category: string;
  kv_id: number;
}
async function targetOf(runId: number, cats: string[]): Promise<Target> {
  const [t] = await select<Target>(
    getPool(),
    `SELECT v.assessment_id, v.judgment_id, v.display_category, r.kv_id FROM v_assessment_display v JOIN analysis_run r ON r.run_id = v.run_id
      WHERE v.run_id = ? AND v.display_category IN (${cats.map(() => '?').join(',')}) ORDER BY v.assessment_id LIMIT 1`,
    [runId, ...cats],
  );
  expect(t, cats.join(',')).toBeTruthy();
  return t!;
}

describe('US5 판정 피드백', () => {
  const me = browserAgent();
  let runId = 0;
  let userId = 0;
  let risk: Target;
  let normal: Target;

  it('준비 — 브라우저 A 분석·저장', async () => {
    const r = await analyzeToSaved(me, () => startText(me, SAMPLE));
    runId = r.runId;
    userId = await agentUserId(me);
    const q = await selectOne<{ user_id: number }>(getPool(), 'SELECT user_id FROM analysis_request WHERE request_id = ?', [r.requestId]);
    expect(q!.user_id).toBe(userId);
    risk = await targetOf(runId, ['dispute', 'unfair', 'illegal']);
    normal = await targetOf(runId, ['normal']);
  });

  it('조항 상세는 허용 유형을 알려 준다', async () => {
    const d1 = await me.get(`/api/results/${runId}/clauses/${risk.assessment_id}`).expect(200);
    expect(d1.body.feedbackTypeAllowed).toBe('false_positive');
    const d2 = await me.get(`/api/results/${runId}/clauses/${normal.assessment_id}`).expect(200);
    expect(d2.body.feedbackTypeAllowed).toBe('false_negative');
  });

  it('의견 미리보기 — 개인정보가 가려지고 유형 목록이 온다(5.3)', async () => {
    const r = await me.post('/api/feedback/preview').send({ opinion: '제 이름은 김민준입니다. 010-2345-6789 로 연락 주세요. 메일 minjun.kim@example.com' }).expect(200);
    expectResponse('web', 'POST', '/feedback/preview', 200, r.body);
    expect(r.body.opinionDeid).not.toContain('김민준');
    expect(r.body.opinionDeid).not.toContain('010-2345-6789');
    expect(r.body.opinionDeid).not.toContain('minjun.kim@example.com');
    expect(r.body.maskedTypes).toEqual(expect.arrayContaining(['person_name', 'phone', 'email']));
    const clean = await me.post('/api/feedback/preview').send({ opinion: '위약금이 과도하지 않다고 봅니다' }).expect(200);
    expect(clean.body.opinionDeid).toBe('위약금이 과도하지 않다고 봅니다');
    expect(clean.body.maskedTypes).toEqual([]);
    expect((await me.post('/api/feedback/preview').send({ opinion: 'x'.repeat(2001) })).status).toBe(400);
  });

  it('위험 판정에 미탐, 정상 조항에 오탐은 400', async () => {
    const a = await me.post('/api/feedback').send({ assessmentId: risk.assessment_id, feedbackType: 'false_negative' });
    expect(a.status).toBe(400);
    expectResponse('web', 'POST', '/feedback', 400, a.body);
    const b = await me.post('/api/feedback').send({ assessmentId: normal.assessment_id, feedbackType: 'false_positive' });
    expect(b.status).toBe(400);
    expect(await selectOne<{ n: number }>(getPool(), 'SELECT COUNT(*) AS n FROM feedback').then((x) => Number(x!.n))).toBe(0);
  });

  it('위험 판정 오탐 — 대상 판정·기준일·표시 분류가 연결되고 의견은 비식별 저장(브라우저 사용자)', async () => {
    const r = await me.post('/api/feedback').send({ assessmentId: risk.assessment_id, feedbackType: 'false_positive', opinion: '담당자 정우성 님과 통화했고 010-1111-2222 입니다' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expectResponse('web', 'POST', '/feedback', 201, r.body);
    expect(r.body.notice).toContain('운영자가 검토');
    const f = await selectOne<Record<string, unknown>>(getPool(), 'SELECT * FROM feedback WHERE feedback_id = ?', [r.body.feedbackId]);
    expect(f).toMatchObject({
      assessment_id: risk.assessment_id,
      judgment_id: risk.judgment_id,
      kv_id: risk.kv_id,
      category_at_submit: risk.display_category,
      feedback_type: 'false_positive',
      user_id: userId,
      session_id: null,
      review_status: 'unreviewed',
      review_decision: null,
    });
    expect(String(f!.opinion_deid)).not.toContain('정우성');
    expect(String(f!.opinion_deid)).not.toContain('010-1111-2222');
  });

  it('정상 조항 미탐 — 판정 행이 없으므로 judgment_id NULL, 의견 생략 가능', async () => {
    const r = await me.post('/api/feedback').send({ assessmentId: normal.assessment_id, feedbackType: 'false_negative' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const f = await selectOne<Record<string, unknown>>(getPool(), 'SELECT * FROM feedback WHERE feedback_id = ?', [r.body.feedbackId]);
    expect(f).toMatchObject({ judgment_id: null, category_at_submit: 'normal', feedback_type: 'false_negative', opinion_deid: null });
  });

  it('분석 불가 조항 미탐', async () => {
    const [n] = await select<{ assessment_id: number }>(
      getPool(),
      "SELECT assessment_id FROM clause_assessment WHERE run_id = ? AND status = 'normal' AND assessment_id <> ? ORDER BY assessment_id LIMIT 1",
      [runId, normal.assessment_id],
    );
    await sql("UPDATE clause_assessment SET status = 'unanalyzable', unanalyzable_reason = 'timeout' WHERE assessment_id = ?", [n!.assessment_id]);
    expect((await me.post('/api/feedback').send({ assessmentId: n!.assessment_id, feedbackType: 'false_positive' })).status).toBe(400);
    const r = await me.post('/api/feedback').send({ assessmentId: n!.assessment_id, feedbackType: 'false_negative' });
    expect(r.status).toBe(201);
    const f = await selectOne<{ category_at_submit: string }>(getPool(), 'SELECT category_at_submit FROM feedback WHERE feedback_id = ?', [r.body.feedbackId]);
    expect(f!.category_at_submit).toBe('unanalyzable');
  });

  it('BR-FDB-01 트리거 — 대상과 다른 분류·기준일은 DB 가 거부한다', async () => {
    await expect(
      sql("INSERT INTO feedback (assessment_id, judgment_id, kv_id, category_at_submit, feedback_type, user_id) VALUES (?, NULL, ?, 'normal', 'false_negative', ?)", [
        risk.assessment_id, risk.kv_id, userId,
      ]),
    ).rejects.toThrow(/BR-FDB-01/);
  });

  it('다른 브라우저는 403 G8, 없는 조항은 404 G8', async () => {
    const stranger = browserAgent();
    const r = await stranger.post('/api/feedback').send({ assessmentId: risk.assessment_id, feedbackType: 'false_positive' });
    expect(r.status).toBe(403);
    expect(r.body.gate).toBe('G8');
    const m = await me.post('/api/feedback').send({ assessmentId: 99_999_999, feedbackType: 'false_positive' });
    expect(m.status).toBe(404);
    expectResponse('web', 'POST', '/feedback', 404, m.body);
    expect(m.body.gate).toBe('G8');
  });

  it('잘못된 본문은 400', async () => {
    expect((await me.post('/api/feedback').send({ assessmentId: risk.assessment_id, feedbackType: 'wrong' })).status).toBe(400);
    expect((await me.post('/api/feedback').send({ assessmentId: risk.assessment_id, feedbackType: 'false_positive', opinion: 'x'.repeat(2001) })).status).toBe(400);
  });

  it('DB 규칙(migration 004): 제출엔 소유자 필수, 익명화는 대상 연결까지 함께 끊을 때만', async () => {
    await expect(
      sql(
        `INSERT INTO feedback (assessment_id, judgment_id, kv_id, category_at_submit, feedback_type)
         VALUES (?, ?, ?, ?, 'false_positive')`,
        [risk.assessment_id, risk.judgment_id, risk.kv_id, risk.display_category],
      ),
    ).rejects.toThrow(/owner/);
    const [f] = await select<{ feedback_id: number }>(getPool(), 'SELECT feedback_id FROM feedback WHERE assessment_id IS NOT NULL ORDER BY feedback_id LIMIT 1');
    expect(f).toBeTruthy();
    await expect(sql('UPDATE feedback SET user_id = NULL, session_id = NULL WHERE feedback_id = ?', [f!.feedback_id])).rejects.toThrow(/FR-008/);
  });
});
