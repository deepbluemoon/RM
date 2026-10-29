// 0.4 새 지식 기준일 생성(T132, UC7 기본흐름 4·E4, BR-KNW-01, BR-ANL-05, FR-037·FR-039) → 0.5 영향 결과 → 0.6 반영 기한.
// 0.4 는 한 트랜잭션(data-model §4.4): 이전 활성 superseded → 새 kv active(uq_kv_single_active) → 반영 항목별 evidence_version 추가·
// 이전 구간 닫기 → ingest_batch.approved_at·result_kv_id. 이미 기준일을 고정한 분석은 이전 kv 로 끝난다(구간 [from, to) 는 과거 kv 에서 그대로 유효)
import type { PoolConnection } from 'mysql2/promise';
import { exec, getPool, select, selectOne } from '../../db/pool.js';
import { withTx } from '../../db/tx.js';
import { isDuplicate } from '../../db/errors.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { logger } from '../../logger.js';
import { asKvId } from '../../domain/types.js';
import { release } from '../gates/gates.service.js';
import { GateError } from '../gates/GateError.js';
import { buildIndexForNewKv } from '../evidence/search.js';
import { AGENCY_LABEL } from './collectors/index.js';
import { activeKv, batchById, kvById, sourcesOf, toKvDto } from './knowledge.repo.js';
import { readStaged } from './staging.js';
import { identifyImpacts, type ImpactKind, type KvChange } from './impact.service.js';
import { deadlineWarnings } from './deadline.js';
import type { PreparedUnit } from './preprocess.js';

const IMPACT_KIND: Record<string, ImpactKind> = { amend: 'amend', new_law: 'amend', repeal: 'repeal', new_case: 'new_case', std_terms_revision: 'std_terms_revision' };

interface Reflected {
  kvId: number;
  closed: KvChange[];
  added: KvChange[];
  heldItemIds: number[];
}

async function findItem(conn: PoolConnection, u: PreparedUnit): Promise<number | null> {
  const row = await selectOne<{ evidence_item_id: number }>(conn, 'SELECT evidence_item_id FROM evidence_item WHERE source_type = ? AND source_name = ? AND identifier = ?', [u.sourceType, u.sourceName, u.identifier]);
  return row?.evidence_item_id ?? null;
}

/** 항목 1건 반영 — 폐지는 열린 구간만 닫고, 개정·신규는 닫고 새 버전을 연다 */
async function reflect(conn: PoolConnection, kvId: number, itemId: number, u: PreparedUnit, out: Reflected): Promise<void> {
  if (u.changeKind === 'reference' || !u.sourceType) return;
  let ei = await findItem(conn, u);
  if (u.changeKind === 'repeal') {
    if (ei === null) return;
    const c = await exec(conn, 'UPDATE evidence_version SET to_kv_id = ? WHERE evidence_item_id = ? AND to_kv_id IS NULL AND from_kv_id <> ?', [kvId, ei, kvId]);
    await exec(conn, 'UPDATE ingest_item SET evidence_item_id = ? WHERE item_id = ?', [ei, itemId]);
    if (c.affectedRows) out.closed.push({ evidenceItemId: ei, changeKind: 'repeal' });
    return;
  }
  if (ei === null) {
    ei = (await exec(conn, 'INSERT INTO evidence_item (source_type, source_name, identifier) VALUES (?,?,?)', [u.sourceType, u.sourceName, u.identifier])).insertId;
  }
  const c = await exec(conn, 'UPDATE evidence_version SET to_kv_id = ? WHERE evidence_item_id = ? AND to_kv_id IS NULL AND from_kv_id <> ?', [kvId, ei, kvId]);
  const ev = await exec(
    conn,
    `INSERT INTO evidence_version (evidence_item_id, from_kv_id, excerpt, source_url, effective_date, published_date, case_facts, case_judgment, case_basis)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [ei, kvId, u.excerpt, u.sourceUrl.slice(0, 500), u.effectiveDate, u.publishedDate, u.caseFacts, u.caseJudgment, u.caseBasis],
  );
  await exec(conn, 'UPDATE ingest_item SET evidence_item_id = ?, evidence_version_id = ? WHERE item_id = ?', [ei, ev.insertId, itemId]);
  const kind = IMPACT_KIND[u.changeKind] ?? 'amend';
  (c.affectedRows ? out.closed : out.added).push({ evidenceItemId: ei, changeKind: kind });
}

export interface ApproveOptions {
  analysisBasisVersion?: string | null;
  operatorUserId?: number | null;
}

export async function approveBatch(batchId: number, opts: ApproveOptions = {}) {
  const staged = await readStaged(batchId);
  let r: Reflected;
  try {
    r = await withTx(async (conn) => {
      const b = await batchById(batchId, conn, true);
      if (!b) throw new HttpError(404, 'not_found', '갱신 작업을 찾을 수 없습니다');
      if (b.stage === 'collect_failed') {
        // G0 는 수집 때 기록됐다 — 승인 차단 응답만 만든다
        const failed = (await sourcesOf(batchId, conn)).filter((s) => s.status === 'failed').map((s) => AGENCY_LABEL[s.agency]);
        const ev = await selectOne<{ event_id: number }>(conn, "SELECT event_id FROM gate_event WHERE gate_code = 'G0' AND batch_id = ? AND released_at IS NULL ORDER BY event_id DESC LIMIT 1", [batchId]);
        throw new GateError('G0', { params: { agency: failed.join('·') || '외부 기관' }, ...(ev ? { eventId: ev.event_id } : {}) });
      }
      if (b.approved_at) throw new HttpError(409, 'already_approved', '이미 새 지식 기준일을 만든 갱신입니다');
      if (b.stage !== 'selecting') throw new HttpError(409, 'batch_not_ready', '반영 대상 확정 단계에서 승인할 수 있습니다');
      if (!staged) throw new HttpError(409, 'staging_missing', '수집 결과가 없습니다 - 새 갱신을 시작하세요');
      const prev = await activeKv(conn, true);
      if ((prev?.kv_id ?? null) !== b.base_kv_id) throw new HttpError(409, 'stale_batch', '그 사이 지식 기준일이 바뀌었습니다 - 새 갱신을 시작하세요');
      const today = (await selectOne<{ d: string }>(conn, "SELECT DATE_FORMAT(CURRENT_DATE, '%Y-%m-%d') AS d"))!.d;
      const taken = await selectOne<{ kv_id: number }>(conn, 'SELECT kv_id FROM knowledge_version WHERE knowledge_date >= ?', [today]);
      if (taken) throw new HttpError(409, 'kv_date_taken', '오늘 날짜의 지식 기준일이 이미 있습니다 - 내일 다시 승인하세요');

      // 이전 활성 → superseded, 새 kv → active (BR-KNW-01 단일 활성)
      if (prev) await exec(conn, "UPDATE knowledge_version SET status = 'superseded' WHERE kv_id = ?", [prev.kv_id]);
      const seq = (await selectOne<{ s: number }>(conn, 'SELECT COALESCE(MAX(kv_seq), 0) + 1 AS s FROM knowledge_version'))!.s;
      const basis = (opts.analysisBasisVersion ?? prev?.analysis_basis_version ?? 'v1.0').slice(0, 20);
      const kvId = (await exec(conn, "INSERT INTO knowledge_version (kv_seq, knowledge_date, analysis_basis_version, status) VALUES (?, ?, ?, 'active')", [seq, today, basis])).insertId;

      const out: Reflected = { kvId, closed: [], added: [], heldItemIds: [] };
      const items = await select<{ item_id: number; effective_date: string | null }>(
        conn, "SELECT item_id, DATE_FORMAT(effective_date, '%Y-%m-%d') AS effective_date FROM ingest_item WHERE batch_id = ? AND include_flag = TRUE ORDER BY item_id", [batchId]);
      for (const it of items) {
        const u = staged.units[String(it.item_id)];
        if (!u) throw new HttpError(409, 'staging_missing', '수집 결과 일부가 없습니다 - 새 갱신을 시작하세요');
        // 시행 전(UC7 A4)은 포함해도 지금 근거로 넣지 않는다 — 보관만 하고 다음 갱신에서 시행일 이후 반영
        if (it.effective_date && it.effective_date > today) {
          await exec(conn, 'UPDATE ingest_item SET include_flag = FALSE WHERE item_id = ?', [it.item_id]);
          out.heldItemIds.push(it.item_id);
          continue;
        }
        await reflect(conn, kvId, it.item_id, u, out);
      }
      await exec(conn, "UPDATE ingest_batch SET approved_at = CURRENT_TIMESTAMP, result_kv_id = ?, stage = 'kv_created' WHERE batch_id = ?", [kvId, batchId]);
      // 분리 실패 항목은 이번 반영에서 제외 확정 — G1 해제(다음 갱신에서 정정 후 다시 반영)
      const g1 = await select<{ event_id: number }>(conn, "SELECT g.event_id FROM gate_event g JOIN ingest_item i ON i.item_id = g.ingest_item_id WHERE g.gate_code = 'G1' AND i.batch_id = ? AND g.released_at IS NULL", [batchId]);
      for (const g of g1) await release(g.event_id, 'excluded_from_kv', conn);
      return out;
    });
  } catch (e) {
    if (isDuplicate(e)) throw new HttpError(409, 'kv_conflict', '다른 승인과 겹쳤습니다 - 다시 확인하세요');
    throw e;
  }
  logger.info({ batchId, kvId: r.kvId, closed: r.closed.length, added: r.added.length, held: r.heldItemIds.length, operator: opts.operatorUserId ?? null }, 'knowledge version created');

  // 새 기준일 BM25 인덱스를 미리 만든다(이전 기준일 인덱스는 그대로 — 진행 중 분석용)
  await buildIndexForNewKv(asKvId(r.kvId));
  // 0.5
  const impactedResultCount = await identifyImpacts(r.kvId, r.closed, r.added);
  await exec(getPool(), "UPDATE ingest_batch SET stage = 'impact_identified' WHERE batch_id = ?", [batchId]);
  // 0.6
  const warnings = await deadlineWarnings(batchId);
  await exec(getPool(), "UPDATE ingest_batch SET stage = 'deadline_checked' WHERE batch_id = ?", [batchId]);

  const kv = (await kvById(r.kvId))!;
  return {
    knowledgeVersion: toKvDto(kv),
    impactedResultCount,
    deadlineWarnings: warnings,
    heldItemIds: r.heldItemIds,
    reflected: { closed: r.closed.length, added: r.added.length },
  };
}
