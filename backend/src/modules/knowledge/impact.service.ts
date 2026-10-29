// 0.5 영향 결과 식별(T132, UC7 기본흐름 5·A1·A2·A3, FR-034·FR-038, SC-016) → result_impact(H0b). 해소는 v_result_impact_active.
// (가) 새 기준일에서 구간이 닫힌 근거 항목(개정·폐지·표준약관 교체)을 판정 근거로 참조한 기존 결과
// (나) 신규 사례·표준약관 개정 항목과 BM25 관련도가 높은(상위 RELATED_TOP_N, 점수 > 0) 기존 위험 판정 조항의 결과 (data-model §4.4)
import { getPool, exec, select, type Db } from '../../db/pool.js';
import { asKvId, fromStoredDeid } from '../../domain/types.js';
import type { RiskType } from '../../domain/codes.js';
import { searchEvidence } from '../evidence/search.js';
import { logger } from '../../logger.js';

export type ImpactKind = 'amend' | 'repeal' | 'new_case' | 'std_terms_revision';

export interface KvChange {
  evidenceItemId: number;
  changeKind: ImpactKind;
}

/** 관련 신규 사례로 볼 검색 순위 상한 */
export const RELATED_TOP_N = 3;

/** (가) 닫힌 근거를 참조한 결과. 분석 중이던 실행(고정 기준일로 끝나는 FR-039)도 이미 붙은 근거로 함께 표시한다 */
async function referencing(kvId: number, closed: KvChange[], db: Db): Promise<void> {
  for (const c of closed) {
    await exec(
      db,
      `INSERT IGNORE INTO result_impact (run_id, kv_id, evidence_item_id, change_kind)
       SELECT DISTINCT r.run_id, ?, ev.evidence_item_id, ?
         FROM analysis_run r
         JOIN clause_assessment a ON a.run_id = r.run_id
         JOIN judgment_evidence je ON je.judgment_id = a.judgment_id
         JOIN evidence_version ev ON ev.evidence_version_id = je.evidence_version_id
        WHERE r.kv_id <> ? AND r.stage <> 'aborted' AND ev.evidence_item_id = ? AND ev.to_kv_id = ?`,
      [kvId, c.changeKind, kvId, c.evidenceItemId, kvId],
    );
  }
}

/** (나) 새로 들어온 사례·표준약관과 관련도가 높은 기존 위험 조항의 결과(UC7 A1·A2) */
async function related(kvId: number, added: KvChange[], db: Db): Promise<void> {
  const targets = new Map(added.filter((a) => a.changeKind === 'new_case' || a.changeKind === 'std_terms_revision').map((a) => [a.evidenceItemId, a.changeKind]));
  if (!targets.size) return;
  const rows = await select<{ run_id: number; text_hash: string; deid_text: string; risk_type: RiskType | null }>(
    db,
    `SELECT v.run_id, c.text_hash, c.deid_text, v.risk_type
       FROM v_assessment_display v
       JOIN clause c ON c.clause_id = v.clause_id
       JOIN analysis_run r ON r.run_id = v.run_id
      WHERE r.stage = 'saved' AND r.kv_id <> ? AND v.display_category IN ('dispute','unfair','illegal')`,
    [kvId],
  );
  // 같은 조항 원문·위험 유형은 한 번만 검색한다(결정적 — search.ts)
  const groups = new Map<string, { text: string; riskType: RiskType | null; runs: Set<number> }>();
  for (const r of rows) {
    const k = `${r.text_hash}|${r.risk_type ?? ''}`;
    const g = groups.get(k) ?? { text: r.deid_text, riskType: r.risk_type, runs: new Set<number>() };
    g.runs.add(r.run_id);
    groups.set(k, g);
  }
  for (const g of groups.values()) {
    const hits = await searchEvidence(asKvId(kvId), fromStoredDeid(g.text), { riskType: g.riskType });
    for (const h of hits.slice(0, RELATED_TOP_N)) {
      const kind = targets.get(h.row.evidence_item_id);
      if (!kind || h.score <= 0) continue;
      for (const runId of g.runs) {
        await exec(db, 'INSERT IGNORE INTO result_impact (run_id, kv_id, evidence_item_id, change_kind) VALUES (?,?,?,?)', [runId, kvId, h.row.evidence_item_id, kind]);
      }
    }
  }
}

/** 0.5 — 식별 후 아직 해소되지 않은 영향 결과 수(결과 단위)를 돌려준다 */
export async function identifyImpacts(kvId: number, closed: KvChange[], added: KvChange[], db: Db = getPool()): Promise<number> {
  await referencing(kvId, closed, db);
  await related(kvId, added, db);
  const [row] = await select<{ n: number }>(db, 'SELECT COUNT(DISTINCT run_id) AS n FROM v_result_impact_active WHERE kv_id = ?', [kvId]);
  logger.info({ kvId, closed: closed.length, added: added.length, impacted: row?.n ?? 0 }, 'knowledge impact identified');
  return row?.n ?? 0;
}

/**
 * 승인 시점에 아직 판정이 붙지 않았던 실행(고정 기준일로 나중에 끝난 분석, FR-039)의 영향 결과를 보충한다.
 * 결과 저장(3.9) 직후 호출하면 된다 — 실행 기준일 이후 생긴 기준일에서 닫힌 근거를 참조했는지 본다(없으면 아무것도 하지 않음)
 */
export async function identifyImpactsForRun(runId: number, db: Db = getPool()): Promise<number> {
  const res = await exec(
    db,
    `INSERT IGNORE INTO result_impact (run_id, kv_id, evidence_item_id, change_kind)
     SELECT DISTINCT r.run_id, ev.to_kv_id, ev.evidence_item_id,
            CASE WHEN EXISTS (SELECT 1 FROM evidence_version n WHERE n.evidence_item_id = ev.evidence_item_id AND n.from_kv_id = ev.to_kv_id)
                 THEN (CASE ei.source_type WHEN 'std_terms' THEN 'std_terms_revision' WHEN 'ftc_case' THEN 'new_case' ELSE 'amend' END)
                 ELSE 'repeal' END
       FROM analysis_run r
       JOIN clause_assessment a ON a.run_id = r.run_id
       JOIN judgment_evidence je ON je.judgment_id = a.judgment_id
       JOIN evidence_version ev ON ev.evidence_version_id = je.evidence_version_id
       JOIN evidence_item ei ON ei.evidence_item_id = ev.evidence_item_id
      WHERE r.run_id = ? AND ev.to_kv_id IS NOT NULL`,
    [runId],
  );
  return res.affectedRows;
}
