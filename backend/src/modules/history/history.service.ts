// P6 분석 기록(T115): 6.1 목록(본인·최신순·근거 변경 표시), 6.2 열람(요청의 저장된 실행들 + 당시 기준일 결과를 P4 형식으로),
// 6.3 변경 내용(개정·폐지·신규 사례·표준약관 개정). 근거 변경 여부는 v_result_impact_active 한 곳에서 판정한다(SD_01 §13-1)
import type { Request } from 'express';
import { getPool, select } from '../../db/pool.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { resultView } from '../results/results.service.js';

interface ListRow {
  request_id: number;
  requested_at: Date;
  perspective: 'consumer' | 'business';
  display_name: string | null;
  latest_run_id: number;
  knowledge_date: string;
  evidence_changed: number;
}

export interface HistoryPage {
  items: {
    requestId: number;
    latestRunId: number;
    displayName: string;
    requestedAt: string;
    perspective: 'consumer' | 'business';
    knowledgeDate: string;
    counts: { high: number; mid: number; low: number };
    evidenceChanged: boolean;
  }[];
  nextCursor: string | null;
}

/** 커서 = 마지막으로 받은 request_id(요청 ID 는 접수 순서라 최신순 정렬과 같다) */
export function parseCursor(v: unknown): number | null {
  if (typeof v !== 'string' || !/^\d{1,18}$/.test(v)) return null;
  return Number(v);
}

/** 6.1 — 저장된 결과가 있는 본인 요청만(BR-HIS-02) */
export async function listHistory(userId: number, cursor: number | null, limit: number): Promise<HistoryPage> {
  const rows = await select<ListRow>(
    getPool(),
    `SELECT r.request_id, r.requested_at, r.perspective,
            (SELECT d.display_name FROM document d WHERE d.request_id = r.request_id ORDER BY d.is_contract DESC, d.doc_seq LIMIT 1) AS display_name,
            lr.run_id AS latest_run_id, DATE_FORMAT(kv.knowledge_date, '%Y-%m-%d') AS knowledge_date,
            EXISTS (SELECT 1 FROM v_result_impact_active i WHERE i.run_id = lr.run_id) AS evidence_changed
       FROM analysis_request r
       JOIN analysis_run lr ON lr.run_id = (SELECT MAX(x.run_id) FROM analysis_run x WHERE x.request_id = r.request_id AND x.stage = 'saved')
       JOIN knowledge_version kv ON kv.kv_id = lr.kv_id
      WHERE r.user_id = ? AND (? IS NULL OR r.request_id < ?)
      ORDER BY r.request_id DESC
      LIMIT ?`,
    [userId, cursor, cursor, limit + 1],
  );
  const page = rows.slice(0, limit);
  const counts = new Map<number, { high: number; mid: number; low: number }>();
  if (page.length) {
    const ids = page.map((r) => r.latest_run_id);
    const cs = await select<{ run_id: number; high_cnt: number; mid_cnt: number; low_cnt: number }>(
      getPool(),
      `SELECT run_id, high_cnt, mid_cnt, low_cnt FROM v_run_risk_counts WHERE run_id IN (${ids.map(() => '?').join(',')})`,
      ids,
    );
    for (const c of cs) counts.set(Number(c.run_id), { high: Number(c.high_cnt ?? 0), mid: Number(c.mid_cnt ?? 0), low: Number(c.low_cnt ?? 0) });
  }
  return {
    items: page.map((r) => ({
      requestId: r.request_id,
      latestRunId: r.latest_run_id,
      displayName: r.display_name ?? '',
      requestedAt: new Date(r.requested_at).toISOString(),
      perspective: r.perspective,
      knowledgeDate: r.knowledge_date,
      counts: counts.get(r.latest_run_id) ?? { high: 0, mid: 0, low: 0 },
      evidenceChanged: Boolean(Number(r.evidence_changed)),
    })),
    nextCursor: rows.length > limit ? String(page[page.length - 1]!.request_id) : null,
  };
}

/** 6.2 — 요청의 저장된 실행(최초·재분석)과 각 결과의 당시 기준일. 최신 결과는 P4 형식(result)으로 함께 준다 */
export async function historyDetail(req: Request, requestId: number) {
  const runs = await select<{ run_id: number; run_kind: 'analysis' | 'reanalysis'; prev_run_id: number | null; knowledge_date: string; saved_at: Date; evidence_changed: number }>(
    getPool(),
    `SELECT r.run_id, r.run_kind, r.prev_run_id, DATE_FORMAT(kv.knowledge_date, '%Y-%m-%d') AS knowledge_date, r.saved_at,
            EXISTS (SELECT 1 FROM v_result_impact_active i WHERE i.run_id = r.run_id) AS evidence_changed
       FROM analysis_run r JOIN knowledge_version kv ON kv.kv_id = r.kv_id
      WHERE r.request_id = ? AND r.stage = 'saved' ORDER BY r.run_id`,
    [requestId],
  );
  if (!runs.length) throw new HttpError(404, 'not_saved', '저장된 결과가 없습니다');
  const latest = runs[runs.length - 1]!;
  const result = await resultView(latest.run_id);
  return {
    requestId,
    displayName: result.documents[0]?.displayName ?? '',
    runs: runs.map((r) => ({
      runId: r.run_id,
      runKind: r.run_kind,
      prevRunId: r.prev_run_id,
      knowledgeDate: r.knowledge_date,
      savedAt: new Date(r.saved_at).toISOString(),
      evidenceChanged: Boolean(Number(r.evidence_changed)),
    })),
    result,
  };
}

/** 6.3 — 아직 해소되지 않은(재분석 결과가 저장되지 않은) 영향 목록 */
export async function resultImpacts(runId: number) {
  const rows = await select<{ kv_id: number; knowledge_date: string; change_kind: string; evidence_item_id: number; source_name: string; identifier: string }>(
    getPool(),
    `SELECT i.kv_id, DATE_FORMAT(kv.knowledge_date, '%Y-%m-%d') AS knowledge_date, i.change_kind, i.evidence_item_id, ei.source_name, ei.identifier
       FROM v_result_impact_active i
       JOIN knowledge_version kv ON kv.kv_id = i.kv_id
       JOIN evidence_item ei ON ei.evidence_item_id = i.evidence_item_id
      WHERE i.run_id = ? ORDER BY kv.kv_seq, i.impact_id`,
    [runId],
  );
  return rows.map((r) => ({
    kvId: r.kv_id,
    knowledgeDate: r.knowledge_date,
    changeKind: r.change_kind,
    evidenceItemId: r.evidence_item_id,
    sourceName: r.source_name,
    identifier: r.identifier,
  }));
}
