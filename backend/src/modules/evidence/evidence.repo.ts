// 근거 저장소(T033). 기준일별 유효 집합은 DB 뷰 v_evidence_in_force 한 곳에서 판정한다(BR-EVD-03)
import { getPool, select, selectOne, type Db } from '../../db/pool.js';
import type { KvId } from '../../domain/types.js';
import type { SourceType } from '../../domain/codes.js';

export interface EvidenceRow {
  evidence_version_id: number;
  evidence_item_id: number;
  source_type: SourceType;
  source_name: string;
  identifier: string;
  excerpt: string;
  source_url: string;
  effective_date: string | null;
  published_date: string | null;
}

export interface EvidenceDetail extends EvidenceRow {
  case_facts: string | null;
  case_judgment: string | null;
  case_basis: string | null;
  from_kv_id: number;
  to_kv_id: number | null;
}

export async function evidenceInForce(kvId: KvId, db: Db = getPool()): Promise<EvidenceRow[]> {
  return select<EvidenceRow>(
    db,
    `SELECT evidence_version_id, evidence_item_id, source_type, source_name, identifier, excerpt, source_url,
            DATE_FORMAT(effective_date, '%Y-%m-%d') AS effective_date, DATE_FORMAT(published_date, '%Y-%m-%d') AS published_date
       FROM v_evidence_in_force WHERE kv_id = ? ORDER BY evidence_version_id`,
    [kvId],
  );
}

export async function evidenceVersion(id: number, db: Db = getPool()): Promise<EvidenceDetail | null> {
  return selectOne<EvidenceDetail>(
    db,
    `SELECT ev.evidence_version_id, ev.evidence_item_id, ei.source_type, ei.source_name, ei.identifier, ev.excerpt, ev.source_url,
            DATE_FORMAT(ev.effective_date, '%Y-%m-%d') AS effective_date, DATE_FORMAT(ev.published_date, '%Y-%m-%d') AS published_date,
            ev.case_facts, ev.case_judgment, ev.case_basis, ev.from_kv_id, ev.to_kv_id
       FROM evidence_version ev JOIN evidence_item ei ON ei.evidence_item_id = ev.evidence_item_id
      WHERE ev.evidence_version_id = ?`,
    [id],
  );
}

/** 판정에 붙은 근거(표시 순서) */
export async function evidenceOfJudgment(judgmentId: number, db: Db = getPool()): Promise<EvidenceDetail[]> {
  return select<EvidenceDetail>(
    db,
    `SELECT ev.evidence_version_id, ev.evidence_item_id, ei.source_type, ei.source_name, ei.identifier, ev.excerpt, ev.source_url,
            DATE_FORMAT(ev.effective_date, '%Y-%m-%d') AS effective_date, DATE_FORMAT(ev.published_date, '%Y-%m-%d') AS published_date,
            ev.case_facts, ev.case_judgment, ev.case_basis, ev.from_kv_id, ev.to_kv_id
       FROM judgment_evidence je
       JOIN evidence_version ev ON ev.evidence_version_id = je.evidence_version_id
       JOIN evidence_item ei ON ei.evidence_item_id = ev.evidence_item_id
      WHERE je.judgment_id = ? ORDER BY je.display_rank`,
    [judgmentId],
  );
}

export interface KnowledgeVersionRow {
  kv_id: number;
  kv_seq: number;
  knowledge_date: string;
  analysis_basis_version: string;
  status: 'active' | 'superseded';
  created_at: Date;
}

export async function activeKnowledgeVersion(db: Db = getPool()): Promise<KnowledgeVersionRow | null> {
  return selectOne<KnowledgeVersionRow>(db, "SELECT kv_id, kv_seq, DATE_FORMAT(knowledge_date, '%Y-%m-%d') AS knowledge_date, analysis_basis_version, status, created_at FROM knowledge_version WHERE status = 'active'");
}

export async function knowledgeVersion(kvId: number, db: Db = getPool()): Promise<KnowledgeVersionRow | null> {
  return selectOne<KnowledgeVersionRow>(db, "SELECT kv_id, kv_seq, DATE_FORMAT(knowledge_date, '%Y-%m-%d') AS knowledge_date, analysis_basis_version, status, created_at FROM knowledge_version WHERE kv_id = ?", [kvId]);
}

export const toEvidenceDto = (e: EvidenceDetail | EvidenceRow, changedSinceAnalysis = false) => {
  const d = e as EvidenceDetail;
  return {
    evidenceVersionId: e.evidence_version_id,
    sourceType: e.source_type,
    sourceName: e.source_name,
    identifier: e.identifier,
    excerpt: e.excerpt,
    sourceUrl: e.source_url,
    effectiveDate: e.effective_date,
    publishedDate: e.published_date,
    caseFacts: d.case_facts ?? null,
    caseJudgment: d.case_judgment ?? null,
    caseBasis: d.case_basis ?? null,
    changedSinceAnalysis,
  };
};
