// 분석 요청·문서·실행 조회 (P1~P3 공용)
import { getPool, select, selectOne, type Db } from '../../db/pool.js';
import type { ContractType, Perspective, RequestStage, RunStage } from '../../domain/codes.js';

export interface RequestRow {
  request_id: number;
  user_id: number | null;
  session_id: string | null;
  input_method: 'file' | 'url' | 'text';
  perspective: Perspective;
  fixed_kv_id: number;
  stage: RequestStage;
  requested_at: Date;
  knowledge_date: string;
  analysis_basis_version: string;
}

export interface DocumentRow {
  document_id: number;
  request_id: number;
  doc_seq: number;
  display_name: string;
  file_format: string | null;
  source_url: string | null;
  collected_at: Date | null;
  ocr_applied: number;
  is_contract: number | null;
  split_method: 'article' | 'semantic' | null;
  raw_file_ref: string | null;
  summary_status: 'ok' | 'unavailable' | null;
  summary_text: string | null;
  contract_type_candidate: ContractType | null;
  contract_type: ContractType | null;
}

export interface RunRow {
  run_id: number;
  request_id: number;
  run_kind: 'analysis' | 'reanalysis';
  prev_run_id: number | null;
  kv_id: number;
  stage: RunStage;
  job_ref: string | null;
  started_at: Date;
  completed_at: Date | null;
  saved_at: Date | null;
}

export const getRequest = (id: number, db: Db = getPool()) =>
  selectOne<RequestRow>(
    db,
    `SELECT r.*, DATE_FORMAT(kv.knowledge_date, '%Y-%m-%d') AS knowledge_date, kv.analysis_basis_version
       FROM analysis_request r JOIN knowledge_version kv ON kv.kv_id = r.fixed_kv_id WHERE r.request_id = ?`,
    [id],
  );

export const getDocuments = (requestId: number, db: Db = getPool()) =>
  select<DocumentRow>(db, 'SELECT * FROM document WHERE request_id = ? ORDER BY doc_seq', [requestId]);

export const getRun = (runId: number, db: Db = getPool()) => selectOne<RunRow>(db, 'SELECT * FROM analysis_run WHERE run_id = ?', [runId]);

export const latestRun = (requestId: number, db: Db = getPool()) =>
  selectOne<RunRow>(db, 'SELECT * FROM analysis_run WHERE request_id = ? ORDER BY run_id DESC LIMIT 1', [requestId]);

export interface ClauseRow {
  clause_id: number;
  document_id: number;
  seq: number;
  article_no: string | null;
  paragraph_no: string | null;
  item_no: string | null;
  title: string | null;
  deid_text: string;
  low_ocr_quality: number;
  contract_type: ContractType | null;
}

export const getClauses = (requestId: number, db: Db = getPool()) =>
  select<ClauseRow>(
    db,
    `SELECT c.clause_id, c.document_id, c.seq, c.article_no, c.paragraph_no, c.item_no, c.title, c.deid_text, c.low_ocr_quality, d.contract_type
       FROM clause c JOIN document d ON d.document_id = c.document_id WHERE d.request_id = ? ORDER BY d.doc_seq, c.seq`,
    [requestId],
  );
