// 0.6 반영 기한 점검(T132, UC7 E3, SC-015, BR-KNW-03). 경과일은 v_ingest_item_status.elapsed_days(공개일 또는 시행일부터) 한 곳에서.
// 경고 시점은 policy REFLECT_WARN_DAYS(미확정이면 KNW_REFLECT_DAYS = 7일). 경고이며 게이트가 아니다(SD_02 §14 비승격 목록)
import { getPool, select, type Db } from '../../db/pool.js';
import { policyOrNull } from '../../config/policy.js';

export interface DeadlineWarning {
  itemId: number;
  itemTitle: string;
  elapsedDays: number;
  limitDays: number;
  overdue: boolean;
  included: boolean;
}

export async function deadlineWarnings(batchId: number, db: Db = getPool()): Promise<DeadlineWarning[]> {
  const rows = await select<{ item_id: number; item_title: string; elapsed_days: number; reflect_limit_days: number | null; include_flag: number }>(
    db,
    `SELECT item_id, item_title, elapsed_days, reflect_limit_days, include_flag FROM v_ingest_item_status
      WHERE batch_id = ? AND change_kind <> 'reference' AND elapsed_days IS NOT NULL ORDER BY elapsed_days DESC, item_id`,
    [batchId],
  );
  const out: DeadlineWarning[] = [];
  for (const r of rows) {
    const limit = Number(r.reflect_limit_days ?? policyOrNull('KNW_REFLECT_DAYS') ?? 7);
    const warnAt = policyOrNull('REFLECT_WARN_DAYS') ?? limit;
    if (r.elapsed_days < warnAt) continue;
    out.push({ itemId: r.item_id, itemTitle: r.item_title, elapsedDays: r.elapsed_days, limitDays: limit, overdue: r.elapsed_days > limit, included: Boolean(r.include_flag) });
  }
  return out;
}
