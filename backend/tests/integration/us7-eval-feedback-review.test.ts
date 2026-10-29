// T129 — P7 탐지 품질 평가·P8 피드백 검토.
// 적격성 제외(G10: 검수 미완료·인위 변형·학습 중복), 유형별 조항 부족 측정 불가(G12), 전문가 미회신 판정 대기(G11),
// 지표 기록과 sc_confirmed_at 트리거 제약, 서비스 캐시 분리(P-5), 서버 다운 중단(G5).
// 피드백 검토 기록, 타당 → 평가 후보(트리거), 운영 응답 PII 재검사 → 가림 + security_incident + G13, 익명 피드백 조회(FR-041), 운영 화면은 역할 가드 없이 어느 브라우저에나 열림
import fs from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { agentUserId, browserAgent, fixture, newAgent, resetDb, startStub, teardown, sql, waitFor, type StubHandle } from './setup.js';
import { analyzeToSaved, startText } from './flow.js';
import { expectResponse } from '../contract/harness.js';
import { getPool, select, selectOne } from '../../src/db/pool.js';
import { loadPolicy } from '../../src/config/policy.js';
import { resetStatusCache } from '../../src/modules/modelApi/status.js';

type Agent = ReturnType<typeof newAgent>;
interface FxItem { key: string; text: string; gold: string; origin?: string; overlapsTraining?: boolean; contractType?: string }
const FX = JSON.parse(fs.readFileSync(fixture('eval/items.json'), 'utf8')) as Record<'subscription' | 'ecommerce' | 'excluded', FxItem[]>;
const SAMPLE = fs.readFileSync(fixture('contracts/subscription-sample.txt'), 'utf8');
const TIMEOUT_MARK = '평가지연표지';

let stub: StubHandle;
let op: Agent;
let expert: Agent;
let plain: Agent;
const ids: Record<string, number> = {};

async function register(item: FxItem, contractType: string) {
  const r = await op.post('/api/admin/eval/items').send({
    clauseTextDeid: item.text,
    contractType,
    goldCategory: item.gold,
    origin: item.origin ?? 'new_label',
    ...(item.overlapsTraining ? { overlapsTraining: true } : {}),
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  ids[item.key] = r.body.evalItemId;
  return r.body.evalItemId as number;
}

async function getRun(id: number) {
  const r = await op.get(`/api/admin/eval/runs/${id}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expectResponse('web', 'GET', '/admin/eval/runs/{evalRunId}', 200, r.body);
  return r.body;
}
const settled = (id: number) => waitFor(() => getRun(id), (b) => ['awaiting_expert', 'result', 'aborted', 'recorded'].includes(b.stage), 30_000, 200);

beforeAll(async () => {
  await resetDb();
  // 미해결 5(측정 불가 최소 조항 수)는 DDL 기본이 NULL — 테스트에서는 2건으로 둔다
  await sql("UPDATE policy_constant SET value_num = 2, status = 'assumed' WHERE const_key = 'EVAL_MIN_CLAUSES_PER_TYPE'");
  await loadPolicy();
  stub = await startStub();
  op = browserAgent({ role: 'operator' });
  expert = browserAgent({ role: 'legal_expert' });
  plain = browserAgent();
});
afterAll(async () => {
  await stub.close();
  await teardown();
});
beforeEach(() => {
  Object.assign(stub.config, { health: 'ready', timeoutMatch: '', judgeDelayMs: 0 });
  resetStatusCache();
});

describe('운영 화면 — RBAC(G14)', () => {
  it('일반 사용자는 평가·피드백 검토 API 에 G14, 운영자는 200', async () => {
    for (const path of ['/api/admin/eval/overview', '/api/admin/eval/items', '/api/admin/feedback', '/api/admin/feedback/summary']) {
      const r = await plain.get(path);
      expect(r.status, `${path} ${JSON.stringify(r.body)}`).toBe(403);
      expect(r.body.gate).toBe('G14');
      await op.get(path).expect(200);
    }
  });

  it('법률 전문가는 검수 경로만 — 피드백 검토·평가 실행은 G14', async () => {
    await expert.get('/api/admin/eval/items').expect(200);
    expect((await expert.get('/api/admin/feedback')).body.gate).toBe('G14');
    expect((await expert.post('/api/admin/eval/runs').send({})).body.gate).toBe('G14');
  });
});

describe('P7 평가 데이터 등록·검수(7.2)', () => {
  it('등록하면 pending, 검수(채택)하면 accepted 와 검수자·시각이 남는다', async () => {
    for (const it of FX.subscription) await register(it, 'subscription');
    for (const it of FX.ecommerce) await register(it, 'ecommerce');
    for (const it of FX.excluded) await register(it, it.contractType!);

    const list = await op.get('/api/admin/eval/items?reviewStatus=pending').expect(200);
    expectResponse('web', 'GET', '/admin/eval/items', 200, list.body);
    expect(list.body.length).toBe(FX.subscription.length + FX.ecommerce.length + FX.excluded.length);

    for (const k of [...FX.subscription, ...FX.ecommerce].map((x) => x.key)) {
      const r = await expert.post(`/api/admin/eval/items/${ids[k]}/review`).send({ decision: 'accepted' });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    const row = await selectOne<{ review_status: string; reviewer_user_id: number | null; reviewed_at: Date | null }>(getPool(), 'SELECT review_status, reviewer_user_id, reviewed_at FROM eval_item WHERE eval_item_id = ?', [ids.liability]);
    expect(row!.review_status).toBe('accepted');
    expect(row!.reviewer_user_id).not.toBeNull();
    expect(row!.reviewed_at).not.toBeNull();
  });

  it('인위적 변형·학습 중복 조항은 채택할 수 없다 — 409 G10(해제 불가)', async () => {
    for (const k of ['synthetic', 'overlap']) {
      const r = await expert.post(`/api/admin/eval/items/${ids[k]}/review`).send({ decision: 'accepted' });
      expect(r.status, JSON.stringify(r.body)).toBe(409);
      expect(r.body.gate).toBe('G10');
      const s = await selectOne<{ review_status: string }>(getPool(), 'SELECT review_status FROM eval_item WHERE eval_item_id = ?', [ids[k]]);
      expect(s!.review_status).toBe('pending');
    }
  });

  it('평가 데이터 응답 전에 비식별을 재검사한다(BR-PRV-04)', async () => {
    // 등록 입력도 비식별화한다
    const leak = await register({ key: 'leak', text: '담당자 연락처 010-2345-6789 로 해지를 신청한다.', gold: 'normal' }, 'installment');
    const stored = await selectOne<{ clause_text_deid: string }>(getPool(), 'SELECT clause_text_deid FROM eval_item WHERE eval_item_id = ?', [leak]);
    expect(stored!.clause_text_deid).not.toContain('010-2345-6789');
    // 저장 뒤에 새어 들어간 개인정보(비식별화 누락)는 응답 직전 재검사에서 가리고 유형만 기록한다
    await sql('UPDATE eval_item SET clause_text_deid = ? WHERE eval_item_id = ?', ['담당자 이메일 lee.staff@example.com 으로 해지를 신청한다.', leak]);
    const list = await op.get('/api/admin/eval/items?contractType=installment').expect(200);
    const it = list.body.find((x: { evalItemId: number }) => x.evalItemId === leak);
    expect(JSON.stringify(list.body)).not.toContain('lee.staff@example.com');
    expect(it.clauseTextDeid).toContain('〔이메일〕');
    const inc = await select<{ detected_field: string; pii_type: string }>(getPool(), 'SELECT detected_field, pii_type FROM security_incident WHERE feedback_id IS NULL');
    expect(inc).toEqual([expect.objectContaining({ detected_field: 'clause', pii_type: 'email' })]);
    await expert.post(`/api/admin/eval/items/${leak}/review`).send({ decision: 'rejected' }).expect(200);
  });
});

describe('P7 평가 실행(7.4~7.9)', () => {
  let run1 = 0;

  it('모델 서버가 다운이면 평가를 시작하지 않는다 — 503 G5', async () => {
    stub.config.health = 'down';
    resetStatusCache();
    const r = await op.post('/api/admin/eval/runs').send({});
    expect(r.status).toBe(503);
    expect(r.body.gate).toBe('G5');
  });

  it('평가 시작은 202 로 바로 돌아오고 추론은 뒤에서 진행한다(서비스 캐시와 분리 — P-5)', async () => {
    stub.config.timeoutMatch = TIMEOUT_MARK;
    const beforeJudgments = (await selectOne<{ n: number }>(getPool(), 'SELECT COUNT(*) AS n FROM judgment'))!.n;
    const r = await op.post('/api/admin/eval/runs').send({});
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expectResponse('web', 'POST', '/admin/eval/runs', 202, r.body);
    run1 = r.body.evalRunId;
    const first = await getRun(run1);
    expect(['eligibility', 'inferring', 'awaiting_expert', 'result']).toContain(first.stage);
    expect(first.progress).toBeTruthy();

    const done = await settled(run1);
    expect(done.stage).toBe('awaiting_expert');
    // 평가 판정은 서비스 판정 캐시에 들어가지 않는다
    const afterJudgments = (await selectOne<{ n: number }>(getPool(), 'SELECT COUNT(*) AS n FROM judgment'))!.n;
    expect(afterJudgments).toBe(beforeJudgments);
    expect(stub.received.some((x) => x.path === '/v1/judge')).toBe(true);
    const run = await selectOne<{ m3_model_version: string; m1_model_version: string }>(getPool(), 'SELECT m1_model_version, m3_model_version FROM eval_run WHERE eval_run_id = ?', [run1]);
    expect(run!.m3_model_version).toBe('stub-m3@1');
    expect(run!.m1_model_version).toBe('stub-m1@1');
  });

  it('G10 — 검수 미완료·인위적 변형·학습 중복 조항은 제외된다', async () => {
    const b = await getRun(run1);
    expect(b.excluded).toEqual({ unreviewed: 1, synthetic: 1, trainingOverlap: 1 });
    const g10 = b.openGates.find((g: { gate: string }) => g.gate === 'G10');
    expect(g10.title).toBe('평가에서 제외된 조항 3건');
    const rows = await select<{ eligibility: string; n: number }>(getPool(), 'SELECT eligibility, COUNT(*) AS n FROM eval_run_item WHERE eval_run_id = ? GROUP BY eligibility', [run1]);
    const m = Object.fromEntries(rows.map((r) => [r.eligibility, Number(r.n)]));
    expect(m).toMatchObject({ included: 6, excluded_unreviewed: 1, excluded_synthetic: 1, excluded_training_overlap: 1 });
    const ev = await select(getPool(), "SELECT event_id FROM gate_event WHERE gate_code = 'G10' AND eval_run_id = ?", [run1]);
    expect(ev.length).toBe(3);
  });

  it('유형별 재현율·정밀도 — 타임아웃 조항은 지표에서 빠지고 건수만 보인다', async () => {
    const b = await getRun(run1);
    const sub = b.metrics.find((m: { contractType: string }) => m.contractType === 'subscription');
    expect(sub.clauseCount).toBe(4);
    expect(sub.timeoutExcluded).toBe(1);
    expect(sub.measurable).toBe(true);
    expect(sub.recallPct).toBe(100);
    expect(typeof sub.precisionPct).toBe('number');
    const pred = await select<{ eval_item_id: number; predicted_category: string | null; timed_out: number }>(getPool(), 'SELECT eval_item_id, predicted_category, timed_out FROM eval_run_item WHERE eval_run_id = ?', [run1]);
    const p = (k: string) => pred.find((x) => x.eval_item_id === ids[k])!;
    expect(p('normal').predicted_category).toBe('normal');
    expect(p('timeout').timed_out).toBe(1);
    expect(p('timeout').predicted_category).toBeNull();
    expect(p('liability').predicted_category).not.toBe('normal');
  });

  it('G12 — 조항이 부족한 유형은 측정 불가, 지표를 내지 않는다', async () => {
    const b = await getRun(run1);
    const ecom = b.metrics.find((m: { contractType: string }) => m.contractType === 'ecommerce');
    expect(ecom.measurable).toBe(false);
    expect(ecom.recallPct).toBeNull();
    expect(ecom.precisionPct).toBeNull();
    expect(ecom.evidenceFitPct).toBeNull();
    const g12 = b.openGates.find((g: { gate: string }) => g.gate === 'G12');
    expect(g12.title).toBe('전자상거래 측정 불가');
    const ev = await select(getPool(), "SELECT event_id FROM gate_event WHERE gate_code = 'G12' AND eval_run_id = ? AND contract_type = 'ecommerce'", [run1]);
    expect(ev.length).toBe(1);
  });

  it('G11 — 전문가 미회신이면 근거 적합률은 판정 대기, 성공 기준 확정은 거부된다', async () => {
    const b = await getRun(run1);
    const sub = b.metrics.find((m: { contractType: string }) => m.contractType === 'subscription');
    expect(sub.evidenceFitPct).toBeNull();
    const g11 = b.openGates.find((g: { gate: string }) => g.gate === 'G11');
    expect(g11.title).toBe('근거 적합률 판정 대기');
    expect(b.confirmable).toBe(false);

    const c = await op.post(`/api/admin/eval/runs/${run1}/confirm`);
    expect(c.status).toBe(409);
    expect(c.body.gate).toBe('G11');
    // 트리거가 최종 방어선 — 앱을 거치지 않은 UPDATE 도 거부된다
    await expect(sql('UPDATE eval_run SET sc_confirmed_at = CURRENT_TIMESTAMP WHERE eval_run_id = ?', [run1])).rejects.toMatchObject({ sqlState: '45000' });
    const r = await selectOne<{ sc_confirmed_at: Date | null }>(getPool(), 'SELECT sc_confirmed_at FROM eval_run WHERE eval_run_id = ?', [run1]);
    expect(r!.sc_confirmed_at).toBeNull();
  });

  it('평가 기록(H6) — 판정 대기 상태로도 기록하고, 두 번 기록하지 않는다', async () => {
    const r = await op.post(`/api/admin/eval/runs/${run1}/record`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const metrics = await select<{ contract_type: string; measurable: number; recall_pct: number | null; evidence_fit_pct: number | null }>(getPool(), 'SELECT contract_type, measurable, recall_pct, evidence_fit_pct FROM eval_metric WHERE eval_run_id = ?', [run1]);
    expect(metrics.find((m) => m.contract_type === 'subscription')!.recall_pct).toBe(100);
    expect(metrics.find((m) => m.contract_type === 'subscription')!.evidence_fit_pct).toBeNull();
    expect(metrics.find((m) => m.contract_type === 'ecommerce')!.measurable).toBe(0);
    const b = await getRun(run1);
    expect(b.stage).toBe('recorded');
    const again = await op.post(`/api/admin/eval/runs/${run1}/record`);
    expect(again.status).toBe(409);
  });

  it('전문가가 근거 적합성을 회신하면 G11 이 풀리고 적합률이 계산된다 — 측정 불가(G12)가 남으면 확정은 여전히 거부', async () => {
    const list = await expert.get(`/api/admin/eval/runs/${run1}/evidence-reviews`).expect(200);
    expect(list.body.length).toBeGreaterThan(0);
    for (const s of list.body) {
      expect(s.clauseTextDeid).toBeTruthy();
      expect(s.evidence.evidenceVersionId).toBe(s.evidenceVersionId);
      expect(s.verdict).toBeNull();
    }
    for (const s of list.body) {
      const r = await expert.put(`/api/admin/eval/runs/${run1}/evidence-reviews/${s.evalItemId}/${s.evidenceVersionId}`).send({ verdict: 'relevant' });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    const b = await getRun(run1);
    expect(b.openGates.some((g: { gate: string }) => g.gate === 'G11')).toBe(false);
    const sub = b.metrics.find((m: { contractType: string }) => m.contractType === 'subscription');
    expect(sub.evidenceFitPct).toBe(100);
    const open = await select(getPool(), "SELECT event_id FROM gate_event WHERE gate_code = 'G11' AND eval_run_id = ? AND released_at IS NULL", [run1]);
    expect(open.length).toBe(0);

    const c = await op.post(`/api/admin/eval/runs/${run1}/confirm`);
    expect(c.status).toBe(409);
    expect(c.body.gate).toBe('G12');
  });

  it('측정 불가·판정 대기가 없으면 성공 기준을 확정한다(이전 적합성 판정 재사용 — UC8 A3)', async () => {
    const keys = ['liability', 'refund', 'change', 'normal'];
    const r = await op.post('/api/admin/eval/runs').send({ evalItemIds: keys.map((k) => ids[k]) });
    expect(r.status).toBe(202);
    const run2 = r.body.evalRunId as number;
    const done = await settled(run2);
    expect(done.stage).toBe('result');
    expect(done.confirmable).toBe(true);
    expect(done.openGates.filter((g: { gate: string }) => ['G10', 'G11', 'G12'].includes(g.gate))).toEqual([]);
    const c = await op.post(`/api/admin/eval/runs/${run2}/confirm`);
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    const after = await getRun(run2);
    expect(after.scConfirmedAt).toBeTruthy();

    // 7.3 비교만 수행 — 기록된 두 평가
    await op.post(`/api/admin/eval/runs/${run2}/record`).expect(200);
    const cmp = await op.get(`/api/admin/eval/compare?a=${run1}&b=${run2}`);
    expect(cmp.status, JSON.stringify(cmp.body)).toBe(200);
    expect(cmp.body.a.evalRunId).toBe(run1);
    expect(cmp.body.rows.find((x: { contractType: string }) => x.contractType === 'subscription')).toBeTruthy();

    const ov = await op.get('/api/admin/eval/overview').expect(200);
    expect(ov.body.modelVersions.m3).toBe('stub-m3@1');
    expect(ov.body.recordedRuns.map((x: { evalRunId: number }) => x.evalRunId)).toEqual(expect.arrayContaining([run1, run2]));
  });

  it('추론 중 서버가 다운되면 평가를 중단(G5)하고 기록하지 않는다', async () => {
    stub.config.judgeDelayMs = 800;
    const r = await op.post('/api/admin/eval/runs').send({ evalItemIds: ['liability', 'refund', 'change'].map((k) => ids[k]) });
    expect(r.status).toBe(202);
    const id = r.body.evalRunId as number;
    stub.config.health = 'down';
    const done = await settled(id);
    expect(done.stage).toBe('aborted');
    expect(done.openGates.some((g: { gate: string }) => g.gate === 'G5')).toBe(true);
    stub.config.health = 'ready';
    const rec = await op.post(`/api/admin/eval/runs/${id}/record`);
    expect(rec.status).toBe(409);
    const n = await select(getPool(), 'SELECT 1 FROM eval_metric WHERE eval_run_id = ?', [id]);
    expect(n.length).toBe(0);
  });
});

describe('P8 피드백 검토(8.1~8.6)', () => {
  let owner: Agent;
  let runId = 0;
  interface Disp { assessment_id: number; judgment_id: number | null; display_category: string; clause_id: number }
  let risky: Disp[] = [];
  let kvId = 0;
  const fb: Record<string, number> = {};

  async function insertFeedback(d: Disp, opinion: string | null, userId: number): Promise<number> {
    const type = d.display_category === 'normal' || d.display_category === 'unanalyzable' ? 'false_negative' : 'false_positive';
    const r = await sql(
      'INSERT INTO feedback (assessment_id, judgment_id, kv_id, category_at_submit, feedback_type, opinion_deid, user_id) VALUES (?,?,?,?,?,?,?)',
      [d.assessment_id, d.judgment_id, kvId, d.display_category, type, opinion, userId],
    );
    return r.insertId;
  }

  beforeAll(async () => {
    owner = browserAgent();
    const a = await analyzeToSaved(owner, () => startText(owner, SAMPLE));
    runId = a.runId;
    kvId = (await selectOne<{ kv_id: number }>(getPool(), 'SELECT kv_id FROM analysis_run WHERE run_id = ?', [runId]))!.kv_id;
    risky = await select<Disp>(getPool(), "SELECT assessment_id, judgment_id, display_category, clause_id FROM v_assessment_display WHERE run_id = ? AND display_category IN ('dispute','unfair','illegal') ORDER BY assessment_id", [runId]);
    expect(risky.length).toBeGreaterThanOrEqual(3);
    const uid = await agentUserId(owner);
    fb.pii = await insertFeedback(risky[0]!, '확인 부탁드립니다 연락처 010-1234-5678', uid);
    fb.valid = await insertFeedback(risky[1]!, '위험하지 않은 일반 조항입니다', uid);
    fb.invalid = await insertFeedback(risky[2]!, null, uid);

    // 결과 삭제 후 익명 보존(FR-041) — 다른 요청을 만들고 지운다
    const b = await analyzeToSaved(owner, () => startText(owner, SAMPLE));
    const d = await selectOne<Disp>(getPool(), "SELECT assessment_id, judgment_id, display_category, clause_id FROM v_assessment_display WHERE run_id = ? AND display_category IN ('dispute','unfair','illegal') ORDER BY assessment_id LIMIT 1", [b.runId]);
    fb.anon = await insertFeedback(d!, '삭제 전 남긴 의견', uid);
    // 결과 삭제 시 익명 보존(FR-008, migration 004) — 소유자·대상 연결을 비우고 요청을 지운다
    await sql('UPDATE feedback SET user_id = NULL, session_id = NULL, judgment_id = NULL, assessment_id = NULL WHERE feedback_id = ?', [fb.anon]);
    await sql('DELETE FROM analysis_request WHERE request_id = ?', [b.requestId]);
  });

  it('목록·필터(8.1·8.2)와 기준일별 현황(8.6)', async () => {
    const all = await op.get('/api/admin/feedback');
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    expectResponse('web', 'GET', '/admin/feedback', 200, all.body);
    expect(all.body.length).toBe(4);
    const fp = await op.get(`/api/admin/feedback?type=false_positive&reviewStatus=unreviewed&kvId=${kvId}`).expect(200);
    expect(fp.body.every((r: { feedbackType: string; reviewStatus: string }) => r.feedbackType === 'false_positive' && r.reviewStatus === 'unreviewed')).toBe(true);
    const sum = await op.get('/api/admin/feedback/summary').expect(200);
    const row = sum.body.find((x: { kvId: number }) => x.kvId === kvId);
    expect(row).toMatchObject({ unreviewedCnt: 4, falsePositiveCnt: 4, falseNegativeCnt: 0 });
    expect(row.knowledgeDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('의견에 가려지지 않은 개인정보 → 표시 전 가림 + security_incident(유형만) + G13', async () => {
    const r = await op.get(`/api/admin/feedback/${fb.pii}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expectResponse('web', 'GET', '/admin/feedback/{feedbackId}', 200, r.body);
    expect(JSON.stringify(r.body)).not.toContain('010-1234-5678');
    expect(r.body.opinionDeid).toContain('〔전화번호〕');
    const g13 = r.body.gates.find((g: { gate: string }) => g.gate === 'G13');
    expect(g13.title).toBe('비식별화되지 않은 개인정보가 발견되었습니다');
    expect(g13.reason).toContain('전화번호');
    const inc = await select<{ detected_field: string; pii_type: string; masked_at: Date | null }>(getPool(), 'SELECT detected_field, pii_type, masked_at FROM security_incident WHERE feedback_id = ?', [fb.pii]);
    expect(inc).toEqual([expect.objectContaining({ detected_field: 'opinion', pii_type: 'phone' })]);
    expect(inc[0]!.masked_at).not.toBeNull();
    const ge = await select(getPool(), "SELECT event_id FROM gate_event WHERE gate_code = 'G13' AND feedback_id = ?", [fb.pii]);
    expect(ge.length).toBe(1);
    // 저장된 의견도 가려졌다 — 다시 열면 표시가 재개된다
    const stored = await selectOne<{ opinion_deid: string }>(getPool(), 'SELECT opinion_deid FROM feedback WHERE feedback_id = ?', [fb.pii]);
    expect(stored!.opinion_deid).not.toContain('010-1234-5678');
    const again = await op.get(`/api/admin/feedback/${fb.pii}`).expect(200);
    expect(again.body.gates.some((g: { gate: string }) => g.gate === 'G13')).toBe(false);
  });

  it('조항 원문에 남은 개인정보도 가리고 사고로 기록한다', async () => {
    await sql("UPDATE clause SET deid_text = CONCAT(deid_text, ' 문의 담당 kim.manager@example.com') WHERE clause_id = ?", [risky[1]!.clause_id]);
    const r = await op.get(`/api/admin/feedback/${fb.valid}`).expect(200);
    expect(JSON.stringify(r.body)).not.toContain('kim.manager@example.com');
    expect(r.body.clause.text).toContain('〔이메일〕');
    expect(r.body.gates.map((g: { gate: string }) => g.gate)).toContain('G13');
    const inc = await select<{ detected_field: string; pii_type: string }>(getPool(), 'SELECT detected_field, pii_type FROM security_incident WHERE feedback_id = ?', [fb.valid]);
    expect(inc).toEqual([expect.objectContaining({ detected_field: 'clause', pii_type: 'email' })]);
  });

  it('상세(8.3) — 대상 조항·당시 판정·근거', async () => {
    const r = await op.get(`/api/admin/feedback/${fb.invalid}`).expect(200);
    expectResponse('web', 'GET', '/admin/feedback/{feedbackId}', 200, r.body);
    expect(r.body.targetAvailable).toBe(true);
    expect(r.body.clause.assessmentId).toBe(risky[2]!.assessment_id);
    expect(r.body.judgment.displayCategory).toBe(risky[2]!.display_category);
    expect(r.body.judgment.evidence.length).toBeGreaterThan(0);
    expect(typeof r.body.evidenceChangedSince).toBe('boolean');
    expect(r.body.gates).toEqual([]);
  });

  it('결과가 삭제된 익명 피드백은 조항 원문 없이 분류·기준일로 조회된다(FR-041, UC9 E1)', async () => {
    const row = await selectOne<{ assessment_id: number | null }>(getPool(), 'SELECT assessment_id FROM feedback WHERE feedback_id = ?', [fb.anon]);
    expect(row!.assessment_id).toBeNull();
    const r = await op.get(`/api/admin/feedback/${fb.anon}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expectResponse('web', 'GET', '/admin/feedback/{feedbackId}', 200, r.body);
    expect(r.body.targetAvailable).toBe(false);
    expect(r.body.clause).toBeUndefined();
    expect(r.body.judgment).toBeUndefined();
    expect(r.body.categoryAtSubmit).toBeTruthy();
    expect(r.body.knowledgeDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const list = await op.get('/api/admin/feedback').expect(200);
    expect(list.body.find((x: { feedbackId: number }) => x.feedbackId === fb.anon)).toMatchObject({ targetAvailable: false, anonymous: true });
    // 익명 피드백도 검토 기록은 남길 수 있다
    await op.post(`/api/admin/feedback/${fb.anon}/review`).send({ decision: 'needs_expert' }).expect(200);
    const cand = await op.post(`/api/admin/feedback/${fb.anon}/eval-candidate`);
    expect(cand.status).toBe(409);
  });

  it('검토 기록(8.4) → 타당이면 평가 후보(8.5), 아니면 트리거가 거부한다', async () => {
    const inv = await op.post(`/api/admin/feedback/${fb.invalid}/review`).send({ decision: 'invalid' });
    expect(inv.status, JSON.stringify(inv.body)).toBe(200);
    const bad = await op.post(`/api/admin/feedback/${fb.invalid}/eval-candidate`);
    expect(bad.status).toBe(409);
    expect(bad.body.code).toBeTruthy();

    await op.post(`/api/admin/feedback/${fb.valid}/review`).send({ decision: 'valid' }).expect(200);
    const s = await selectOne<{ review_status: string; review_decision: string }>(getPool(), 'SELECT review_status, review_decision FROM feedback WHERE feedback_id = ?', [fb.valid]);
    expect(s).toEqual({ review_status: 'reviewed', review_decision: 'valid' });
    const c = await op.post(`/api/admin/feedback/${fb.valid}/eval-candidate`);
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const cand = await selectOne<{ clause_text_deid: string; contract_type: string }>(getPool(), 'SELECT clause_text_deid, contract_type FROM eval_candidate WHERE feedback_id = ?', [fb.valid]);
    expect(cand!.contract_type).toBe('subscription');
    expect(cand!.clause_text_deid).not.toContain('@example.com');
    const dup = await op.post(`/api/admin/feedback/${fb.valid}/eval-candidate`);
    expect(dup.status).toBe(409);

    // 후보는 전문가 검수 전에는 평가 데이터가 아니다 — 등록하면 pending
    const reg = await op.post('/api/admin/eval/items').send({ clauseTextDeid: '', contractType: 'subscription', goldCategory: 'normal', origin: 'feedback_candidate', candidateId: c.body.candidateId });
    expect(reg.status, JSON.stringify(reg.body)).toBe(201);
    const item = await selectOne<{ review_status: string; candidate_id: number; clause_text_deid: string }>(getPool(), 'SELECT review_status, candidate_id, clause_text_deid FROM eval_item WHERE eval_item_id = ?', [reg.body.evalItemId]);
    expect(item).toMatchObject({ review_status: 'pending', candidate_id: c.body.candidateId, clause_text_deid: cand!.clause_text_deid });

    const summary = await op.get('/api/admin/feedback/summary').expect(200);
    expect(summary.body.find((x: { kvId: number }) => x.kvId === kvId).unreviewedCnt).toBe(1);
  });

  it('검토 기록은 판정을 바꾸지 않는다(UC9 사후조건 2)', async () => {
    const j = await selectOne<{ m3_category: string }>(getPool(), 'SELECT m3_category FROM judgment WHERE judgment_id = ?', [risky[2]!.judgment_id]);
    const v = await selectOne<{ display_category: string }>(getPool(), 'SELECT display_category FROM v_assessment_display WHERE assessment_id = ?', [risky[2]!.assessment_id]);
    expect(v!.display_category).toBe(risky[2]!.display_category);
    expect(j!.m3_category).toBeTruthy();
  });
});
