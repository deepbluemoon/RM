// P0 저장소 조회(T133) — 기준일 목록·배치·기관별 수집 결과·항목(판정 라벨은 v_ingest_item_status)
import { getPool, select, selectOne, type Db } from '../../db/pool.js';
import type { Agency, ChangeKind } from './collectors/index.js';
import type { DecisionLabel } from './select.js';

export interface KvRow {
  kv_id: number;
  kv_seq: number;
  knowledge_date: string;
  analysis_basis_version: string;
  status: 'active' | 'superseded';
  created_at: Date;
}

export const toKvDto = (k: KvRow) => ({
  kvId: k.kv_id,
  kvSeq: k.kv_seq,
  knowledgeDate: k.knowledge_date,
  analysisBasisVersion: k.analysis_basis_version,
  status: k.status,
  createdAt: new Date(k.created_at).toISOString(),
});

const KV_COLS = "kv_id, kv_seq, DATE_FORMAT(knowledge_date, '%Y-%m-%d') AS knowledge_date, analysis_basis_version, status, created_at";

export async function listVersions(db: Db = getPool()): Promise<KvRow[]> {
  return select<KvRow>(db, `SELECT ${KV_COLS} FROM knowledge_version ORDER BY kv_seq DESC`);
}

export async function kvById(kvId: number, db: Db = getPool()): Promise<KvRow | null> {
  return selectOne<KvRow>(db, `SELECT ${KV_COLS} FROM knowledge_version WHERE kv_id = ?`, [kvId]);
}

export async function activeKv(db: Db = getPool(), forUpdate = false): Promise<KvRow | null> {
  return selectOne<KvRow>(db, `SELECT ${KV_COLS} FROM knowledge_version WHERE status = 'active'${forUpdate ? ' FOR UPDATE' : ''}`);
}

export type BatchStage = 'collecting' | 'collect_failed' | 'preprocessing' | 'selecting' | 'kv_created' | 'impact_identified' | 'deadline_checked';

export interface BatchRow {
  batch_id: number;
  base_kv_id: number | null;
  stage: BatchStage;
  started_at: Date;
  approved_at: Date | null;
  result_kv_id: number | null;
}

export async function batchById(batchId: number, db: Db = getPool(), forUpdate = false): Promise<BatchRow | null> {
  return selectOne<BatchRow>(db, `SELECT batch_id, base_kv_id, stage, started_at, approved_at, result_kv_id FROM ingest_batch WHERE batch_id = ?${forUpdate ? ' FOR UPDATE' : ''}`, [batchId]);
}

export interface SourceRow {
  agency: Agency;
  status: 'ok' | 'failed';
  fail_reason: string | null;
}

export async function sourcesOf(batchId: number, db: Db = getPool()): Promise<SourceRow[]> {
  return select<SourceRow>(db, "SELECT agency, status, fail_reason FROM ingest_source_status WHERE batch_id = ? ORDER BY FIELD(agency, 'law_center', 'ftc', 'data_portal', 'kca')", [batchId]);
}

export interface ItemRow {
  item_id: number;
  agency: Agency;
  item_title: string;
  change_kind: ChangeKind;
  effective_date: string | null;
  published_date: string | null;
  parse_status: 'ok' | 'failed';
  parse_fail_reason: string | null;
  include_flag: number;
  evidence_item_id: number | null;
  evidence_version_id: number | null;
  decision_label: DecisionLabel;
  elapsed_days: number | null;
  reflect_limit_days: number | null;
}

export async function itemsOf(batchId: number, db: Db = getPool()): Promise<ItemRow[]> {
  return select<ItemRow>(
    db,
    `SELECT i.item_id, i.agency, i.item_title, i.change_kind,
            DATE_FORMAT(i.effective_date, '%Y-%m-%d') AS effective_date, DATE_FORMAT(i.published_date, '%Y-%m-%d') AS published_date,
            i.parse_status, i.parse_fail_reason, i.include_flag, i.evidence_item_id, i.evidence_version_id,
            v.decision_label, v.elapsed_days, v.reflect_limit_days
       FROM ingest_item i JOIN v_ingest_item_status v ON v.item_id = i.item_id
      WHERE i.batch_id = ? ORDER BY i.item_id`,
    [batchId],
  );
}
