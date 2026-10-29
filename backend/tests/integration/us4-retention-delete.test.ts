// T107 — 원본 24시간 삭제(SC-014, FR-007), 결과 삭제(FR-008, A16), 옛 비회원 세션 행 정리(purgeExpiredAnon — 로컬 모드 이전 데이터).
// 시계 조작: DB 가 CURRENT_TIMESTAMP 로 판정하므로, 저장된 기한 시각을 24시간(+1분) 앞으로 당겨 "24시간 뒤"를 만든다
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browserAgent, newAgent, resetDb, sql, startStub, teardown, type StubHandle } from './setup.js';
import { analyzeToSaved, startFile } from './flow.js';
import { getPool, select, selectOne } from '../../src/db/pool.js';
import { rawExists } from '../../src/modules/intake/rawStore.js';
import { purgeExpiredAnon, purgeOverdueRaw } from '../../src/jobs/retention.js';

let stub: StubHandle;
const count = async (q: string, p: unknown[] = []) => Number((await selectOne<{ n: number }>(getPool(), q, p))!.n);

beforeAll(async () => {
  await resetDb();
  stub = await startStub();
});
afterAll(async () => {
  await stub.close();
  await teardown();
});

/** 실행의 판정 행 하나에 피드백을 직접 넣는다(BR-FDB-01 트리거를 통과하는 값으로) */
async function insertFeedback(runId: number, kind: 'risk' | 'normal', owner: { userId: number | null; sessionId: string | null }) {
  const [a] = await select<{ assessment_id: number; judgment_id: number | null; display_category: string; kv_id: number }>(
    getPool(),
    `SELECT v.assessment_id, v.judgment_id, v.display_category, r.kv_id FROM v_assessment_display v JOIN analysis_run r ON r.run_id = v.run_id
      WHERE v.run_id = ? AND ${kind === 'risk' ? "v.display_category IN ('dispute','unfair','illegal')" : "v.display_category = 'normal'"} ORDER BY v.assessment_id LIMIT 1`,
    [runId],
  );
  expect(a, `${kind} 판정 행`).toBeTruthy();
  const r = await sql(
    `INSERT INTO feedback (assessment_id, judgment_id, kv_id, category_at_submit, feedback_type, opinion_deid, user_id, session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [a!.assessment_id, a!.judgment_id, a!.kv_id, a!.display_category, kind === 'risk' ? 'false_positive' : 'false_negative', `의견 ${kind}`, owner.userId, owner.sessionId],
  );
  return { feedbackId: r.insertId, category: a!.display_category, kvId: a!.kv_id };
}

describe('원본 파일 24시간 삭제(SC-014)', () => {
  const agent = newAgent();
  let requestId = 0;
  let ref = '';

  it('분석 완료 직후 원본은 남아 있고, 삭제 예약은 지금부터 24시간 이내', async () => {
    const r = await analyzeToSaved(agent, () => startFile(agent, 'contracts/subscription-sample.pdf'));
    requestId = r.requestId;
    const [d] = await select<{ raw_file_ref: string; within: number }>(
      getPool(),
      `SELECT d.raw_file_ref, d.raw_delete_due_at <= CURRENT_TIMESTAMP + INTERVAL 24 HOUR AS within FROM document d WHERE d.request_id = ?`,
      [requestId],
    );
    ref = d!.raw_file_ref;
    expect(ref).toBeTruthy();
    expect(Number(d!.within)).toBe(1);
    expect(rawExists(ref)).toBe(true);
    // 기한 전에는 지우지 않는다
    await purgeOverdueRaw();
    expect(rawExists(ref)).toBe(true);
  });

  it('24시간이 지나면 원본 파일과 raw_file_ref 가 삭제된다', async () => {
    await sql('UPDATE document SET raw_delete_due_at = raw_delete_due_at - INTERVAL 24 HOUR - INTERVAL 1 MINUTE WHERE request_id = ?', [requestId]);
    expect(await count('SELECT COUNT(*) AS n FROM v_raw_retention_overdue')).toBe(1);
    expect(await purgeOverdueRaw()).toBe(1);
    expect(rawExists(ref)).toBe(false);
    const [d] = await select<{ raw_file_ref: string | null; raw_deleted_at: Date | null }>(getPool(), 'SELECT raw_file_ref, raw_deleted_at FROM document WHERE request_id = ?', [requestId]);
    expect(d!.raw_file_ref).toBeNull();
    expect(d!.raw_deleted_at).not.toBeNull();
    expect(await count('SELECT COUNT(*) AS n FROM v_raw_retention_overdue')).toBe(0);
  });

  it('원본이 지워져도 결과는 그대로 열린다', async () => {
    const run = await selectOne<{ run_id: number }>(getPool(), "SELECT run_id FROM analysis_run WHERE request_id = ? AND stage = 'saved'", [requestId]);
    await agent.get(`/api/results/${run!.run_id}`).expect(200);
  });
});

describe('결과 삭제(FR-008) — 만든 브라우저만', () => {
  const owner = browserAgent();
  const stranger = browserAgent();
  let requestId = 0;
  let runId = 0;
  let userId = 0;
  let chargeId = 0;
  const fbs: { feedbackId: number; category: string; kvId: number }[] = [];

  it('준비 — 분석·저장, 피드백 2건(위험·정상)', async () => {
    const r = await analyzeToSaved(owner, () => startFile(owner, 'contracts/subscription-sample.pdf'));
    requestId = r.requestId;
    runId = r.runId;
    const q = await selectOne<{ user_id: number; session_id: string | null }>(getPool(), 'SELECT user_id, session_id FROM analysis_request WHERE request_id = ?', [requestId]);
    userId = q!.user_id;
    expect(q!.session_id).toBeNull();
    const c = await selectOne<{ charge_id: number }>(getPool(), 'SELECT charge_id FROM usage_charge WHERE run_id = ?', [runId]);
    chargeId = c!.charge_id;
    fbs.push(await insertFeedback(runId, 'risk', { userId, sessionId: null }));
    fbs.push(await insertFeedback(runId, 'normal', { userId, sessionId: null }));
  });

  it('다른 브라우저는 삭제할 수 없다 — 403 G8, 행은 그대로', async () => {
    const r = await stranger.delete(`/api/history/${requestId}`);
    expect(r.status).toBe(403);
    expect(r.body.gate).toBe('G8');
    expect(await count('SELECT COUNT(*) AS n FROM analysis_request WHERE request_id = ?', [requestId])).toBe(1);
  });

  it('소유자 삭제 → 204', async () => {
    const r = await owner.delete(`/api/history/${requestId}`);
    expect(r.status).toBe(204);
  });

  it('결과 조회는 404, 문서·조항·실행·조항 판정 행은 없다', async () => {
    const r = await owner.get(`/api/results/${runId}`);
    expect(r.status).toBe(404);
    expect(await count('SELECT COUNT(*) AS n FROM analysis_request WHERE request_id = ?', [requestId])).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM document WHERE request_id = ?', [requestId])).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM analysis_run WHERE request_id = ?', [requestId])).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM clause_assessment WHERE run_id = ?', [runId])).toBe(0);
    const again = await owner.delete(`/api/history/${requestId}`);
    expect(again.status).toBe(404);
  });

  it('결과 보기 원장(usage_charge)은 남는다(run_id 만 NULL)', async () => {
    const c = await selectOne<{ run_id: number | null; user_id: number }>(getPool(), 'SELECT run_id, user_id FROM usage_charge WHERE charge_id = ?', [chargeId]);
    expect(c).toBeTruthy();
    expect(c!.run_id).toBeNull();
    expect(c!.user_id).toBe(userId);
  });

  it('피드백은 익명화해 보존 — 연결·소유자는 NULL, 유형·분류·기준일·의견은 남는다(A16)', async () => {
    for (const f of fbs) {
      const row = await selectOne<Record<string, unknown>>(getPool(), 'SELECT * FROM feedback WHERE feedback_id = ?', [f.feedbackId]);
      expect(row, 'feedback row').toBeTruthy();
      expect(row!.user_id).toBeNull();
      expect(row!.session_id).toBeNull();
      expect(row!.judgment_id).toBeNull();
      expect(row!.assessment_id).toBeNull();
      expect(row!.category_at_submit).toBe(f.category);
      expect(Number(row!.kv_id)).toBe(f.kvId);
      expect(['false_positive', 'false_negative']).toContain(row!.feedback_type);
      expect(String(row!.opinion_deid)).toMatch(/^의견 /);
    }
  });
});

describe('옛 비회원 세션 행 — 만료되면 정리(purgeExpiredAnon)', () => {
  // 로컬 모드는 anon_session 을 만들지 않는다. 이전 데이터가 남은 DB 를 흉내 내려고 저장된 요청의 소유를 SQL 로 옛 세션으로 옮긴다
  const agent = newAgent();
  let requestId = 0;
  let runId = 0;
  const sessionId = '00000000-0000-4000-8000-000000000a01';

  it('준비 — 저장된 결과를 옛 비회원 세션(만료 전) 소유로 바꾼다. 만료 전에는 지우지 않는다', async () => {
    const r = await analyzeToSaved(agent, () => startFile(agent, 'contracts/subscription-sample.pdf'));
    requestId = r.requestId;
    runId = r.runId;
    await sql("INSERT INTO anon_session (session_id, device_key, expires_at) VALUES (?, 'legacy-device', CURRENT_TIMESTAMP + INTERVAL 12 HOUR)", [sessionId]);
    await sql('UPDATE analysis_request SET user_id = NULL, session_id = ? WHERE request_id = ?', [sessionId, requestId]);
    const res = await purgeExpiredAnon();
    expect(res.requests).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM analysis_request WHERE request_id = ?', [requestId])).toBe(1);
  });

  it('만료된 세션의 요청·결과는 삭제되고 피드백은 익명으로 남는다', async () => {
    const fb = await insertFeedback(runId, 'risk', { userId: null, sessionId });
    await sql('UPDATE anon_session SET expires_at = CURRENT_TIMESTAMP - INTERVAL 1 MINUTE WHERE session_id = ?', [sessionId]);
    const res = await purgeExpiredAnon();
    expect(res.requests).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM analysis_request WHERE request_id = ?', [requestId])).toBe(0);
    const r = await agent.get(`/api/results/${runId}`);
    expect(r.status).toBe(404);
    const row = await selectOne<{ session_id: string | null; assessment_id: number | null; feedback_type: string }>(
      getPool(),
      'SELECT session_id, assessment_id, feedback_type FROM feedback WHERE feedback_id = ?',
      [fb.feedbackId],
    );
    expect(row!.session_id).toBeNull();
    expect(row!.assessment_id).toBeNull();
    expect(row!.feedback_type).toBe('false_positive');
  });
});
