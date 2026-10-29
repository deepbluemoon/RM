// 운영 화면 응답 직전 비식별 재검사(A11, UC9 E2, BR-PRV-04) — P8 피드백 상세와 P7 평가 데이터가 함께 쓴다.
// 발견하면 (1) security_incident 에 필드·유형만 기록(원문 금지) (2) G13 게이트 기록(피드백일 때) (3) 저장된 텍스트를 가림 처리
// (4) masked_at 기록·G13 해제("가림 처리 후 표시 재개"). 이번 응답에는 가린 텍스트와 G13(부분 차단)을 싣는다
import type { PoolConnection } from 'mysql2/promise';
import { withTx } from '../../db/tx.js';
import { logger } from '../../logger.js';
import { PII_LABEL, type PiiType } from '../../domain/codes.js';
import { rescan } from '../deid/deid.service.js';
import { recordGate, release } from '../gates/gates.service.js';
import { openGate, type OpenGate } from '../gates/GateError.js';

export type PiiField = 'opinion' | 'clause';
const FIELD_LABEL: Record<PiiField, string> = { opinion: '의견', clause: '조항' };

/** 응답에 실을 텍스트 1개 — 발견 시 저장 텍스트를 가린 값으로 바꾸는 persist 를 함께 준다 */
export interface Presentable {
  field: PiiField;
  text: string | null;
  persist: (conn: PoolConnection, masked: string) => Promise<unknown>;
}

export interface Presented {
  /** 입력 순서대로 가린(또는 그대로인) 텍스트 */
  texts: (string | null)[];
  gate: OpenGate | null;
  types: PiiType[];
}

async function insertIncidents(conn: PoolConnection, feedbackId: number | null, field: PiiField, types: PiiType[]): Promise<number[]> {
  const ids: number[] = [];
  for (const t of types) {
    const [r] = await conn.query<import('mysql2').ResultSetHeader>('INSERT INTO security_incident (feedback_id, detected_field, pii_type) VALUES (?, ?, ?)', [feedbackId, field, t]);
    ids.push(r.insertId);
  }
  return ids;
}

/**
 * 재검사 → 사고 기록 → 가림 저장 → 해제를 한 트랜잭션에서.
 * feedbackId 가 있으면 G13 을 남긴다(gate_event G13 은 피드백 대상 필수 — chk_ge_subject)
 */
export async function present(items: Presentable[], feedbackId: number | null = null): Promise<Presented> {
  const scans = items.map((i) => (i.text ? rescan(i.text) : null));
  const found = items.map((i, k) => ({ item: i, scan: scans[k] })).filter((x) => x.scan && !x.scan.clean);
  if (!found.length) return { texts: items.map((i) => i.text), gate: null, types: [] };

  const fields = [...new Set(found.map((x) => x.item.field))];
  const types = [...new Set(found.flatMap((x) => x.scan!.types))];
  const eventId = await withTx(async (conn) => {
    const incidentIds: number[] = [];
    for (const f of fields) {
      const t = [...new Set(found.filter((x) => x.item.field === f).flatMap((x) => x.scan!.types))];
      incidentIds.push(...(await insertIncidents(conn, feedbackId, f, t)));
    }
    const ev = feedbackId ? await recordGate('G13', 'pii_unmasked', { feedbackId }, fields.join(','), conn) : null;
    for (const x of found) await x.item.persist(conn, x.scan!.masked);
    await conn.query(`UPDATE security_incident SET masked_at = CURRENT_TIMESTAMP WHERE incident_id IN (${incidentIds.map(() => '?').join(',')})`, incidentIds);
    if (ev) await release(ev, 'masked', conn);
    return ev;
  });
  // 로그에는 필드·유형만(원문 금지)
  logger.warn({ feedbackId, fields, types }, 'G13 운영 응답 재검사에서 비식별 누락 발견 — 가림 처리');
  const gate = feedbackId
    ? openGate('G13', { field: fields.map((f) => FIELD_LABEL[f]).join('·'), types: types.map((t) => PII_LABEL[t]).join('·') }, eventId ?? undefined)
    : null;
  return { texts: items.map((i, k) => (scans[k] && !scans[k]!.clean ? scans[k]!.masked : i.text)), gate, types };
}
