// 초기 지식 기준일 적재 — 기준일이 하나도 없을 때만 새 활성 기준일을 만든다(UC1 사전조건 2). 테스트 설정과 seed 스크립트가 함께 쓴다
import type { PoolConnection } from 'mysql2/promise';
import { withTx } from '../../db/tx.js';

export interface KnowledgeFixture {
  knowledgeVersion: { knowledgeDate: string; analysisBasisVersion: string };
  evidence: {
    sourceType: string;
    sourceName: string;
    identifier: string;
    excerpt: string;
    sourceUrl: string;
    effectiveDate?: string | null;
    publishedDate?: string | null;
    caseFacts?: string | null;
    caseJudgment?: string | null;
    caseBasis?: string | null;
  }[];
}

export async function seedKnowledge(fx: KnowledgeFixture): Promise<{ kvId: number; created: boolean; items: number }> {
  return withTx(async (conn: PoolConnection) => {
    const [kv] = await conn.query<import('mysql2').RowDataPacket[]>('SELECT kv_id FROM knowledge_version ORDER BY kv_seq DESC LIMIT 1');
    if (kv.length) return { kvId: kv[0]!.kv_id as number, created: false, items: 0 };
    const [ins] = await conn.query<import('mysql2').ResultSetHeader>(
      "INSERT INTO knowledge_version (kv_seq, knowledge_date, analysis_basis_version, status) VALUES (1, ?, ?, 'active')",
      [fx.knowledgeVersion.knowledgeDate, fx.knowledgeVersion.analysisBasisVersion],
    );
    const kvId = ins.insertId;
    for (const e of fx.evidence) {
      const [item] = await conn.query<import('mysql2').ResultSetHeader>(
        'INSERT INTO evidence_item (source_type, source_name, identifier) VALUES (?, ?, ?)',
        [e.sourceType, e.sourceName, e.identifier],
      );
      await conn.query(
        `INSERT INTO evidence_version (evidence_item_id, from_kv_id, excerpt, source_url, effective_date, published_date, case_facts, case_judgment, case_basis)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [item.insertId, kvId, e.excerpt, e.sourceUrl, e.effectiveDate ?? null, e.publishedDate ?? null, e.caseFacts ?? null, e.caseJudgment ?? null, e.caseBasis ?? null],
      );
    }
    return { kvId, created: true, items: fx.evidence.length };
  });
}
