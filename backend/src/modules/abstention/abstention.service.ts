// 판정 불가 선별(2026-09-30) — 분석 3.1 전에 조항마다 관문 1(규칙)·관문 2(계약 조항다움)를 본다.
// 걸린 조항은 M1·M2·M3 를 부르지 않고 clause_abstention 에 사유를 남긴다(migration 008). 기준값은 정상 조항 오차단 1% 로 보정
// (scripts/calibrate-abstention.ts, 실제 약관 2,752 조항 0.98% · 다른 업종 518 조항 0.77% · 잘못된 입력 500건 100% 검출).
// 관문 2 는 벡터·임베딩이 없으면 판단을 보류한다(판정 불가로 만들지 않음) — 장애가 정상 조항을 막지 않게.
import { env } from '../../config/env.js';
import { exec, getPool, select } from '../../db/pool.js';
import type { KvId } from '../../domain/types.js';
import { logger } from '../../logger.js';
import { clauseLikeness } from '../evidence/search.js';
import { ruleCheck, type AbstentionReason } from './rules.js';

export interface Abstained {
  clauseId: number;
  reason: AbstentionReason;
  code: string;
  gate: 1 | 2;
  score: number | null;
}

export const ABSTENTION_LABEL: Record<AbstentionReason, string> = {
  invalid_input: '조항 내용을 읽을 수 없습니다',
  not_clause: '계약 조항으로 보기 어렵습니다',
  prompt_injection: '분석할 수 없는 지시 문장이 들어 있습니다',
};

/** 조항 목록 → 판정 불가 조항(나머지는 정상 흐름). texts 는 비식별 조항 원문 */
export async function screenClauses(kvId: KvId, clauses: { clauseId: number; text: string }[]): Promise<Abstained[]> {
  if (env.ABSTAIN_ENABLED !== 'on') return [];
  const out: Abstained[] = [];
  const rest: { clauseId: number; text: string }[] = [];
  for (const c of clauses) {
    const v = ruleCheck(c.text);
    if (v) out.push({ clauseId: c.clauseId, reason: v.reason, code: v.code, gate: 1, score: null });
    else rest.push(c);
  }
  if (rest.length) {
    try {
      const scores = await clauseLikeness(kvId, rest.map((c) => c.text));
      rest.forEach((c, i) => {
        const s = scores[i];
        if (s != null && s < env.ABSTAIN_LIKENESS_MIN) out.push({ clauseId: c.clauseId, reason: 'not_clause', code: 'low_likeness', gate: 2, score: s });
      });
    } catch (e) {
      logger.warn({ err: (e as Error).message }, 'abstention gate 2 skipped');
    }
  }
  return out;
}

export async function recordAbstentions(runId: number, list: Abstained[]): Promise<void> {
  if (!list.length) return;
  await exec(getPool(),
    `INSERT INTO clause_abstention (run_id, clause_id, reason, code, gate, score) VALUES ${list.map(() => '(?,?,?,?,?,?)').join(',')}
     ON DUPLICATE KEY UPDATE reason = VALUES(reason), code = VALUES(code), gate = VALUES(gate), score = VALUES(score)`,
    list.flatMap((a) => [runId, a.clauseId, a.reason, a.code, a.gate, a.score]));
  // 모델을 부르지 않으므로 평가 상태는 정상으로 닫는다(DDL: unanalyzable 사유는 장애 2종뿐). 화면은 clause_abstention 을 겹쳐 판정 불가로 보인다
  await exec(getPool(),
    `UPDATE clause_assessment SET screen_result = 'normal_candidate', status = 'normal'
      WHERE run_id = ? AND status = 'pending' AND clause_id IN (${list.map(() => '?').join(',')})`,
    [runId, ...list.map((a) => a.clauseId)]);
}

export async function abstentionsOf(runId: number): Promise<Map<number, { reason: AbstentionReason; code: string; gate: number }>> {
  const rows = await select<{ clause_id: number; reason: AbstentionReason; code: string; gate: number }>(getPool(),
    'SELECT clause_id, reason, code, gate FROM clause_abstention WHERE run_id = ?', [runId]);
  return new Map(rows.map((r) => [r.clause_id, { reason: r.reason, code: r.code, gate: r.gate }]));
}
