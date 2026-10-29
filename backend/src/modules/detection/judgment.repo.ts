// 판정 캐시(judgment) 조회·저장 — 캐시 키 5필드 UNIQUE(BR-MDL-04, research R-11). text_hash 는 DB 생성 컬럼만 쓴다
import type { PoolConnection } from 'mysql2/promise';
import { getPool, selectOne, type Db } from '../../db/pool.js';
import { isDuplicate } from '../../db/errors.js';
import { withTx } from '../../db/tx.js';
import type { ModelJudgeResult } from '../../domain/types.js';
import { filterClaims } from '../results/explanation.filter.js';
import { deidentify } from '../deid/deid.service.js';

export interface CacheKey {
  clauseId: number;
  contractType: string;
  perspective: string;
  kvId: number;
  m3Version: string;
  origin?: 'service' | 'evaluation';
}

export async function findCached(k: CacheKey, db: Db = getPool()): Promise<number | null> {
  const r = await selectOne<{ judgment_id: number }>(
    db,
    `SELECT j.judgment_id FROM judgment j JOIN clause c ON c.text_hash = j.text_hash
      WHERE c.clause_id = ? AND j.contract_type = ? AND j.perspective = ? AND j.kv_id = ? AND j.m3_model_version = ? AND j.origin = ?`,
    [k.clauseId, k.contractType, k.perspective, k.kvId, k.m3Version.slice(0, 40), k.origin ?? 'service'],
  );
  return r?.judgment_id ?? null;
}

async function insertClaims(conn: PoolConnection, judgmentId: number, claims: { claim: string; evidenceIds: number[] }[]): Promise<number> {
  let seq = 0;
  for (const c of claims) {
    seq++;
    await conn.query('INSERT INTO explanation_claim (judgment_id, seq, claim_text, evidence_version_id) VALUES (?, ?, ?, ?)', [judgmentId, seq, deidentify(c.claim), c.evidenceIds[0]]);
  }
  return seq;
}

/**
 * M3 판정 저장 — judgment + judgment_evidence(표시 순서) + explanation_claim(개별 INSERT).
 * 근거 집합 밖 주장·단정 표현 주장은 버린다(A7·A8). 경합(1062)이면 기존 행을 돌려준다
 */
export async function saveJudgment(k: CacheKey, result: ModelJudgeResult, evidenceIds: number[]): Promise<{ judgmentId: number; claimCount: number; allClaimsDropped: boolean }> {
  try {
    return await withTx(async (conn) => {
      const [ins] = await conn.query<import('mysql2').ResultSetHeader>(
        `INSERT INTO judgment (text_hash, contract_type, perspective, kv_id, m3_model_version, m3_category, risk_type, risk_level, confidence, origin)
         SELECT text_hash, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM clause WHERE clause_id = ?`,
        [k.contractType, k.perspective, k.kvId, k.m3Version.slice(0, 40), result.category, result.riskType, result.riskLevel, result.confidence, k.origin ?? 'service', k.clauseId],
      );
      const judgmentId = ins.insertId;
      let claimCount = 0;
      let allClaimsDropped = false;
      if (result.category !== 'normal') {
        let rank = 0;
        for (const id of evidenceIds) await conn.query('INSERT INTO judgment_evidence (judgment_id, evidence_version_id, display_rank) VALUES (?, ?, ?)', [judgmentId, id, ++rank]);
        const f = filterClaims(result.claims, evidenceIds);
        claimCount = await insertClaims(conn, judgmentId, f.kept);
        allClaimsDropped = f.g9;
      }
      return { judgmentId, claimCount, allClaimsDropped };
    });
  } catch (e) {
    if (isDuplicate(e)) {
      const id = await findCached(k);
      if (id) return { judgmentId: id, claimCount: -1, allClaimsDropped: false };
    }
    throw e;
  }
}

/** 설명 재생성(4.8, UC3 E3) — 설명 필드만 바꾼다. 재생성 횟수 0→1 (트리거가 판정 불변을 강제) */
export async function replaceClaims(judgmentId: number, claims: { claim: string; evidenceIds: number[] }[]): Promise<number> {
  return withTx(async (conn) => {
    await conn.query('DELETE FROM explanation_claim WHERE judgment_id = ?', [judgmentId]);
    const n = await insertClaims(conn, judgmentId, claims);
    await conn.query('UPDATE judgment SET explanation_regen_count = 1 WHERE judgment_id = ?', [judgmentId]);
    return n;
  });
}
