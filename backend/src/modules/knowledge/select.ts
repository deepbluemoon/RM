// 0.3 반영 대상 확정(T131, UC7 기본흐름 3·A3·A4, BR-EVD-03): 시행 도래는 근거 후보, 시행 전은 보류, 폐지는 근거 후보에서 제외.
// 판정 라벨은 DB 뷰 v_ingest_item_status 한 곳에서 계산한다(CLAUDE.md) — 여기서는 라벨별 기본 포함 여부만 정한다.
// 폐지는 "근거 후보 제외"이지만 반영(구간 닫기)은 해야 하므로 기본 포함이다. 분리 실패는 DB(chk_ii_g1)가 포함을 거부한다
import { exec, type Db } from '../../db/pool.js';

export type DecisionLabel = 'excluded_parse_fail' | 'excluded_repealed' | 'hold_not_effective' | 'reference_only' | 'candidate';

export const DEFAULT_INCLUDE: Record<DecisionLabel, boolean> = {
  candidate: true,
  excluded_repealed: true,
  hold_not_effective: false,
  reference_only: false,
  excluded_parse_fail: false,
};

/** 배치 항목의 기본 포함 여부를 뷰 라벨로 채운다(운영자가 이후 PATCH 로 바꿀 수 있다) */
export async function applySelection(batchId: number, db: Db): Promise<void> {
  const on = (Object.keys(DEFAULT_INCLUDE) as DecisionLabel[]).filter((k) => DEFAULT_INCLUDE[k]);
  await exec(
    db,
    `UPDATE ingest_item i JOIN v_ingest_item_status v ON v.item_id = i.item_id
        SET i.include_flag = (v.decision_label IN (${on.map(() => '?').join(',')}))
      WHERE i.batch_id = ?`,
    [...on, batchId],
  );
}
