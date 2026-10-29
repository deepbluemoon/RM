// P0 0.1~0.3 갱신 작업(T133): 수집(4개 기관 병렬, G0) → 전처리(G1 검토 목록) → 반영 대상 확정. 배치 단계는 data-model §4.4.
// 수집은 요청과 분리해 프로세스 안에서 비동기로 돌린다(POST 202 → S0 가 GET 으로 진행을 본다)
import { getPool, exec, select, type Db } from '../../db/pool.js';
import { withTx } from '../../db/tx.js';
import { isRuleViolation } from '../../db/errors.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { logger } from '../../logger.js';
import { recordGate, release } from '../gates/gates.service.js';
import { GateError, openGate, type OpenGate } from '../gates/GateError.js';
import { activeCollectors, AGENCY_LABEL, type Agency, type SinceKv, type SourceDelta } from './collectors/index.js';
import { CollectorError } from './collectors/http.js';
import { preprocess, type ExistingEvidence, type PreparedUnit } from './preprocess.js';
import { applySelection } from './select.js';
import { readStaged, writeStaged } from './staging.js';
import { activeKv, batchById, itemsOf, kvById, listVersions, sourcesOf, toKvDto, type BatchRow } from './knowledge.repo.js';
import { deadlineWarnings } from './deadline.js';

const running = new Map<number, Promise<void>>();

/** 테스트·종료용 — 진행 중 수집이 끝날 때까지 기다린다 */
export async function drainIngest(): Promise<void> {
  while (running.size) await Promise.allSettled([...running.values()]);
}

function track(batchId: number, since: SinceKv | null): void {
  const p = runCollect(batchId, since)
    .catch((e: Error) => logger.error({ batchId, err: e.message }, 'knowledge ingest failed'))
    .finally(() => running.delete(batchId));
  running.set(batchId, p);
}

/** 0.1 개시 — 현재 활성 기준일을 수집 기준으로 새 배치를 만든다(최초 적재는 base NULL) */
export async function startBatch(): Promise<number> {
  const kv = await activeKv();
  const res = await exec(getPool(), "INSERT INTO ingest_batch (base_kv_id, stage) VALUES (?, 'collecting')", [kv?.kv_id ?? null]);
  const batchId = res.insertId;
  logger.info({ batchId, baseKvId: kv?.kv_id ?? null }, 'knowledge ingest started');
  track(batchId, kv ? { kvId: kv.kv_id, knowledgeDate: kv.knowledge_date } : null);
  return batchId;
}

/** G0 해제 — 다시 수집. 수집 실패(또는 재기동으로 멈춘 수집) 배치만 */
export async function retryBatch(batchId: number): Promise<void> {
  const b = await mustBatch(batchId);
  const stuck = (b.stage === 'collecting' || b.stage === 'preprocessing') && !running.has(batchId);
  if (b.stage !== 'collect_failed' && !stuck) throw new HttpError(409, 'not_retryable', '수집 실패 상태의 갱신만 다시 수집할 수 있습니다');
  const since = b.base_kv_id ? await kvById(b.base_kv_id) : null;
  await withTx(async (conn) => {
    // 수집 실패·중단 배치에는 항목이 없다(항목 INSERT 와 selecting 전환은 한 트랜잭션) — 기관별 결과만 지운다
    await exec(conn, 'DELETE FROM ingest_source_status WHERE batch_id = ?', [batchId]);
    const open = await select<{ event_id: number }>(conn, "SELECT event_id FROM gate_event WHERE gate_code = 'G0' AND batch_id = ? AND released_at IS NULL", [batchId]);
    for (const g of open) await release(g.event_id, 'retry_collect', conn);
    await exec(conn, "UPDATE ingest_batch SET stage = 'collecting' WHERE batch_id = ?", [batchId]);
  });
  track(batchId, since ? { kvId: since.kv_id, knowledgeDate: since.knowledge_date } : null);
}

async function mustBatch(batchId: number): Promise<BatchRow> {
  const b = await batchById(batchId);
  if (!b) throw new HttpError(404, 'not_found', '갱신 작업을 찾을 수 없습니다');
  return b;
}

async function existingEvidence(kvId: number | null, db: Db): Promise<ExistingEvidence[]> {
  if (!kvId) return [];
  const rows = await select<{ evidence_item_id: number; source_type: string; source_name: string; identifier: string; excerpt: string }>(
    db, 'SELECT evidence_item_id, source_type, source_name, identifier, excerpt FROM v_evidence_in_force WHERE kv_id = ?', [kvId]);
  return rows.map((r) => ({ evidenceItemId: r.evidence_item_id, sourceType: r.source_type, sourceName: r.source_name, identifier: r.identifier, excerpt: r.excerpt }));
}

/** 직전 승인 배치에서 보류(시행 전)로 남은 단위 — 다음 갱신으로 이월한다(UC7 A4 "시행일 이후 반영") */
async function carriedHolds(batchId: number, db: Db): Promise<PreparedUnit[]> {
  const prev = await select<{ batch_id: number }>(db, 'SELECT batch_id FROM ingest_batch WHERE result_kv_id IS NOT NULL AND batch_id <> ? ORDER BY approved_at DESC, batch_id DESC LIMIT 1', [batchId]);
  if (!prev[0]) return [];
  const staged = await readStaged(prev[0].batch_id);
  if (!staged) return [];
  const held = await select<{ item_id: number }>(
    db,
    `SELECT item_id FROM ingest_item WHERE batch_id = ? AND parse_status = 'ok' AND change_kind <> 'reference'
        AND evidence_version_id IS NULL AND include_flag = FALSE AND effective_date IS NOT NULL AND effective_date > (
          SELECT k.knowledge_date FROM knowledge_version k JOIN ingest_batch b ON b.result_kv_id = k.kv_id WHERE b.batch_id = ?)`,
    [prev[0].batch_id, prev[0].batch_id],
  );
  return held.map((h) => staged.units[String(h.item_id)]).filter((u): u is PreparedUnit => !!u);
}

async function runCollect(batchId: number, since: SinceKv | null): Promise<void> {
  // 0.1 — 4개 기관 병렬 수집. 하나라도 실패하면 G0: 기존 기준일 유지, 실패 기관·사유 기록
  const collectors = activeCollectors();
  const settled = await Promise.allSettled(collectors.map((c) => c.collect(since)));
  const failed: Agency[] = [];
  const deltas: SourceDelta[] = [];
  for (const [i, r] of settled.entries()) {
    const agency = collectors[i]!.agency;
    let reason: string | null = null;
    if (r.status === 'rejected') {
      reason = r.reason instanceof CollectorError ? r.reason.message : '수집 중 오류';
      if (!(r.reason instanceof CollectorError)) logger.warn({ batchId, agency, err: (r.reason as Error)?.name }, 'collector error');
      failed.push(agency);
    } else deltas.push(...r.value.map((d) => ({ ...d, agency })));
    await exec(
      getPool(),
      'INSERT INTO ingest_source_status (batch_id, agency, status, fail_reason) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE status = VALUES(status), fail_reason = VALUES(fail_reason)',
      [batchId, agency, reason ? 'failed' : 'ok', reason?.slice(0, 200) ?? null],
    );
  }
  if (failed.length) {
    await exec(getPool(), "UPDATE ingest_batch SET stage = 'collect_failed' WHERE batch_id = ?", [batchId]);
    await recordGate('G0', 'collect_failed', { batchId }, failed.join(','));
    logger.warn({ batchId, failed }, 'knowledge ingest G0');
    return;
  }

  // 0.2 — 전처리. 분리 실패는 G1 검토 목록(항목별 gate_event)
  await exec(getPool(), "UPDATE ingest_batch SET stage = 'preprocessing' WHERE batch_id = ?", [batchId]);
  const existing = await existingEvidence(since?.kvId ?? null, getPool());
  const { units, stats } = preprocess(deltas, existing);
  units.push(...(await carriedHolds(batchId, getPool())));
  const staged: Record<string, PreparedUnit> = {};
  await withTx(async (conn) => {
    for (const u of units) {
      const r = await exec(
        conn,
        `INSERT INTO ingest_item (batch_id, agency, item_title, change_kind, effective_date, published_date, parse_status, parse_fail_reason, include_flag)
         VALUES (?,?,?,?,?,?,?,?, FALSE)`,
        [batchId, u.agency, u.title.slice(0, 300), u.changeKind, u.effectiveDate, u.publishedDate, u.parseStatus, u.parseFailReason],
      );
      staged[String(r.insertId)] = u;
      if (u.parseStatus === 'failed') await recordGate('G1', 'parse_failed', { batchId, ingestItemId: r.insertId }, u.parseFailReason, conn);
    }
    // 0.3 — 시행 도래 후보·시행 전 보류·폐지 제외(라벨은 v_ingest_item_status)
    await applySelection(batchId, conn);
    await writeStaged({ batchId, stats, units: staged });
    await exec(conn, "UPDATE ingest_batch SET stage = 'selecting' WHERE batch_id = ?", [batchId]);
  });
  logger.info({ batchId, ...stats, carried: units.length - stats.units }, 'knowledge ingest selecting');
}

/** 반영 포함 여부 — 분리 실패 항목은 DB(chk_ii_g1)가 거부 → G1 */
export async function setItemInclude(batchId: number, itemId: number, include: boolean) {
  const b = await mustBatch(batchId);
  const items = await itemsOf(batchId);
  const item = items.find((i) => i.item_id === itemId);
  if (!item) throw new HttpError(404, 'not_found', '항목을 찾을 수 없습니다');
  if (b.stage !== 'selecting') throw new HttpError(409, 'batch_not_selecting', '반영 대상 확정 단계에서만 바꿀 수 있습니다');
  try {
    await exec(getPool(), 'UPDATE ingest_item SET include_flag = ? WHERE item_id = ? AND batch_id = ?', [include, itemId, batchId]);
  } catch (e) {
    if (!isRuleViolation(e)) throw e;
    // 이미 열린 G1 이벤트가 있으므로 새로 기록하지 않고 차단 응답만 만든다
    throw new GateError('G1', { status: 409, params: { n: 1, item: item.item_title } });
  }
  return { itemId, include, decisionLabel: item.decision_label };
}

function g1Gate(fails: { title: string; eventId: number | undefined }[]): OpenGate | null {
  if (!fails.length) return null;
  const item = fails.length > 1 ? `${fails[0]!.title} 외 ${fails.length - 1}건` : fails[0]!.title;
  return openGate('G1', { n: fails.length, item }, fails[0]!.eventId);
}

/** S0 화면 본문(IngestBatch 계약) + 검토 목록·전처리 통계·반영 결과 */
export async function batchDto(batchId: number) {
  const b = await mustBatch(batchId);
  const [sources, items, base, result, staged] = await Promise.all([
    sourcesOf(batchId),
    itemsOf(batchId),
    b.base_kv_id ? kvById(b.base_kv_id) : null,
    b.result_kv_id ? kvById(b.result_kv_id) : null,
    readStaged(batchId),
  ]);
  const gates = await select<{ event_id: number; gate_code: string; ingest_item_id: number | null; batch_id: number | null }>(
    getPool(),
    `SELECT event_id, gate_code, ingest_item_id, batch_id FROM v_gate_open
      WHERE (gate_code = 'G0' AND batch_id = ?) OR (gate_code = 'G1' AND ingest_item_id IN (SELECT item_id FROM ingest_item WHERE batch_id = ?))
      ORDER BY event_id`,
    [batchId, batchId],
  );
  const openGates: OpenGate[] = [];
  const g0 = gates.find((g) => g.gate_code === 'G0');
  const failedAgencies = sources.filter((s) => s.status === 'failed').map((s) => AGENCY_LABEL[s.agency]);
  if (g0 || b.stage === 'collect_failed') openGates.push(openGate('G0', { agency: failedAgencies.join('·') || '외부 기관' }, g0?.event_id));
  const g1Ev = new Map(gates.filter((g) => g.gate_code === 'G1').map((g) => [g.ingest_item_id, g.event_id]));
  const fails = items.filter((i) => i.parse_status === 'failed');
  const g1 = g1Gate(fails.filter((f) => g1Ev.has(f.item_id) || !b.approved_at).map((f) => ({ title: f.item_title, eventId: g1Ev.get(f.item_id) })));
  if (g1) openGates.push(g1);

  const impacted = result
    ? (await select<{ n: number }>(getPool(), 'SELECT COUNT(DISTINCT run_id) AS n FROM v_result_impact_active WHERE kv_id = ?', [result.kv_id]))[0]?.n ?? 0
    : null;
  return {
    batchId: b.batch_id,
    stage: b.stage,
    startedAt: new Date(b.started_at).toISOString(),
    approvedAt: b.approved_at ? new Date(b.approved_at).toISOString() : null,
    ...(base ? { baseKv: toKvDto(base) } : {}),
    ...(result ? { resultKv: toKvDto(result) } : {}),
    running: running.has(batchId),
    sources: sources.map((s) => ({ agency: s.agency, status: s.status, failReason: s.fail_reason })),
    items: items.map((i) => ({
      itemId: i.item_id,
      agency: i.agency,
      itemTitle: i.item_title,
      changeKind: i.change_kind,
      decisionLabel: i.decision_label,
      include: Boolean(i.include_flag),
      elapsedDays: i.elapsed_days,
      effectiveDate: i.effective_date,
      publishedDate: i.published_date,
      parseFailReason: i.parse_fail_reason,
      reflected: i.evidence_item_id !== null,
    })),
    openGates,
    // G1 검토 목록(UC7 E2) — 정정 후 다음 갱신에 다시 반영
    reviewList: fails.map((f) => ({ itemId: f.item_id, agency: f.agency, itemTitle: f.item_title, reason: f.parse_fail_reason ?? '' })),
    preprocessStats: staged?.stats ?? null,
    impactedResultCount: impacted,
    deadlineWarnings: await deadlineWarnings(batchId),
  };
}

export async function versionsDto() {
  return (await listVersions()).map(toKvDto);
}
