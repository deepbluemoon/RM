// 근거 DB 초기 대량 적재(전체 교체) — 실제 공개 자료 스냅숏으로 새 지식 기준일을 만든다(2026-09-29).
//   npm run knowledge:bootstrap -- --snapshot ../dataset_work/knowledge/evidence_snapshot_v1.json [--dry-run]
// 스냅숏 = tools/knowledge/build_evidence_snapshot_v1.py 산출(법령·고시 조문, 표준약관 조항, 공정위 사례).
//
// 관리자 승인 흐름(approve.service)과 같은 규칙을 지킨다: 활성 기준일 잠금(FOR UPDATE) → 이전 활성 superseded → 새 kv active,
// 기준일 날짜 중복 금지, 커밋 뒤 BM25 인덱스 미리 생성 → 영향 결과 식별(0.5).
// 다른 점: (1) 스냅숏이 전체 근거이므로 현재 열린 근거 버전을 전부 닫는다(가상 픽스처 포함).
//          (2) 한 행씩이 아니라 여러 행 INSERT(500행 단위)로 넣어 트랜잭션을 짧게 한다.
// 법령·고시 조문은 항 단위로 백엔드 splitLaw 로 나눈다(수집 흐름과 같은 식별자·발췌). 나누지 못하면 조 단위로 넣고 보고한다.
// 이후 개정분은 기존 수집 흐름(수집기 → 관리자 승인)이 맡는다.
import fs from 'node:fs';
import path from 'node:path';
import type { PoolConnection } from 'mysql2/promise';
import { BACKEND_ROOT } from '../src/config/env.js';
import { closePool, exec, select, selectOne } from '../src/db/pool.js';
import { withTx } from '../src/db/tx.js';
import { normalizeText, splitCase, splitLaw } from '../src/modules/knowledge/preprocess.js';
import { buildIndexForNewKv } from '../src/modules/evidence/search.js';
import { identifyImpacts, type KvChange } from '../src/modules/knowledge/impact.service.js';
import { asKvId } from '../src/domain/types.js';

type SourceType = 'law_article' | 'ftc_case' | 'std_terms';
interface Delta {
  sourceType: SourceType;
  sourceName: string;
  identifier: string;
  rawText: string;
  split: 'law' | 'std' | 'case';
  caseSections?: { facts: string; judgment: string; basis: string };
  sourceUrl: string;
  effectiveDate: string | null;
  publishedDate: string | null;
}
interface Snapshot { knowledgeDate: string; analysisBasisVersion: string; deltas: Delta[] }
interface Unit {
  sourceType: SourceType; sourceName: string; identifier: string; excerpt: string;
  caseFacts: string | null; caseJudgment: string | null; caseBasis: string | null;
  sourceUrl: string; effectiveDate: string | null; publishedDate: string | null;
}

const EXCERPT_MAX = 2000;  // preprocess.ts 와 같은 발췌 상한
const CHUNK = 500;
const HEADER = /^\s*제\s*\d+\s*조(?:\s*의\s*\d+)?\s*(?:\([^)\n]*\))?\s*/;
class DryRun extends Error {}

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const dryRun = process.argv.includes('--dry-run');
const file = path.resolve(BACKEND_ROOT, arg('--snapshot') ?? '../dataset_work/knowledge/evidence_snapshot_v1.json');

function toUnits(snap: Snapshot, report: Record<string, unknown>): Unit[] {
  const units: Unit[] = [];
  const fallback: string[] = [];
  for (const d of snap.deltas) {
    const base = { sourceType: d.sourceType, sourceName: d.sourceName.slice(0, 200), sourceUrl: d.sourceUrl.slice(0, 500),
      effectiveDate: d.effectiveDate, publishedDate: d.publishedDate, caseFacts: null, caseJudgment: null, caseBasis: null };
    if (d.split === 'case') {
      const s = splitCase({ rawText: d.rawText, caseSections: d.caseSections });
      units.push({ ...base, identifier: d.identifier.slice(0, 200), excerpt: s.judgment.slice(0, EXCERPT_MAX),
        caseFacts: s.facts, caseJudgment: s.judgment, caseBasis: s.basis });
    } else if (d.split === 'std') {
      const body = normalizeText(d.rawText).replace(HEADER, '').trim();
      units.push({ ...base, identifier: d.identifier.slice(0, 200), excerpt: body.slice(0, EXCERPT_MAX) });
    } else {
      try {
        for (const p of splitLaw(d.identifier, d.rawText)) units.push({ ...base, identifier: p.identifier, excerpt: p.excerpt });
      } catch (e) {
        fallback.push(`${d.sourceName} ${d.identifier}: ${(e as Error).message}`);
        units.push({ ...base, identifier: d.identifier.slice(0, 200), excerpt: normalizeText(d.rawText).replace(HEADER, '').trim().slice(0, EXCERPT_MAX) });
      }
    }
  }
  // 같은 근거 키가 두 번 나오면 뒤의 것을 버린다(evidence_item 유일 키)
  const seen = new Set<string>();
  const out = units.filter((u) => {
    const k = `${u.sourceType}|${u.sourceName}|${u.identifier}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return u.excerpt.length >= 5;
  });
  report.split_fallback_article_level = fallback.length;
  report.split_fallback_examples = fallback.slice(0, 10);
  report.duplicate_units_dropped = units.length - out.length;
  report.units_by_type = out.reduce<Record<string, number>>((m, u) => ({ ...m, [u.sourceType]: (m[u.sourceType] ?? 0) + 1 }), {});
  return out;
}

async function load(conn: PoolConnection, snap: Snapshot, units: Unit[], report: Record<string, unknown>) {
  // 1) 활성 기준일 잠금 — 동시 승인·다른 적재와 직렬화
  const prev = await selectOne<{ kv_id: number; knowledge_date: string }>(conn,
    "SELECT kv_id, DATE_FORMAT(knowledge_date, '%Y-%m-%d') AS knowledge_date FROM knowledge_version WHERE status = 'active' FOR UPDATE");
  const taken = await selectOne<{ kv_id: number }>(conn, 'SELECT kv_id FROM knowledge_version WHERE knowledge_date >= ?', [snap.knowledgeDate]);
  if (taken) throw new Error(`기준일 ${snap.knowledgeDate} 이후의 지식 기준일이 이미 있습니다(kv_id=${taken.kv_id})`);
  // 2) 이전 활성 → superseded, 새 kv → active (유일 활성 제약 순서)
  if (prev) await exec(conn, "UPDATE knowledge_version SET status = 'superseded' WHERE kv_id = ?", [prev.kv_id]);
  const seq = (await selectOne<{ s: number }>(conn, 'SELECT COALESCE(MAX(kv_seq), 0) + 1 AS s FROM knowledge_version'))!.s;
  const kvId = (await exec(conn, "INSERT INTO knowledge_version (kv_seq, knowledge_date, analysis_basis_version, status) VALUES (?, ?, ?, 'active')",
    [seq, snap.knowledgeDate, snap.analysisBasisVersion.slice(0, 20)])).insertId;
  // 3) 전체 교체: 열린 근거 버전을 모두 닫는다(가상 픽스처 포함). 한 문장, 기본키 순서로 잠근다
  const closedRows = await select<{ evidence_item_id: number }>(conn,
    'SELECT evidence_item_id FROM evidence_version WHERE to_kv_id IS NULL ORDER BY evidence_version_id FOR UPDATE');
  const closedRes = await exec(conn, 'UPDATE evidence_version SET to_kv_id = ? WHERE to_kv_id IS NULL AND from_kv_id <> ?', [kvId, kvId]);
  // 4) 근거 항목: 여러 행 upsert(이미 있으면 그대로) → 유일 키로 id 회수
  const idOf = new Map<string, number>();
  for (let i = 0; i < units.length; i += CHUNK) {
    const part = units.slice(i, i + CHUNK);
    await exec(conn, `INSERT INTO evidence_item (source_type, source_name, identifier) VALUES ${part.map(() => '(?,?,?)').join(',')}
                      ON DUPLICATE KEY UPDATE evidence_item_id = evidence_item_id`, part.flatMap((u) => [u.sourceType, u.sourceName, u.identifier]));
    const rows = await select<{ evidence_item_id: number; source_type: string; source_name: string; identifier: string }>(conn,
      `SELECT evidence_item_id, source_type, source_name, identifier FROM evidence_item
        WHERE (source_type, source_name, identifier) IN (${part.map(() => '(?,?,?)').join(',')})`, part.flatMap((u) => [u.sourceType, u.sourceName, u.identifier]));
    for (const r of rows) idOf.set(`${r.source_type}|${r.source_name}|${r.identifier}`, r.evidence_item_id);
  }
  // 5) 새 근거 버전: 여러 행 INSERT
  let inserted = 0;
  for (let i = 0; i < units.length; i += CHUNK) {
    const part = units.slice(i, i + CHUNK);
    const res = await exec(conn, `INSERT INTO evidence_version (evidence_item_id, from_kv_id, excerpt, source_url, effective_date, published_date,
                                  case_facts, case_judgment, case_basis) VALUES ${part.map(() => '(?,?,?,?,?,?,?,?,?)').join(',')}`,
      part.flatMap((u) => [idOf.get(`${u.sourceType}|${u.sourceName}|${u.identifier}`), kvId, u.excerpt, u.sourceUrl, u.effectiveDate, u.publishedDate,
        u.caseFacts, u.caseJudgment, u.caseBasis]));
    inserted += res.affectedRows;
  }
  const inForce = (await selectOne<{ n: number }>(conn, 'SELECT COUNT(*) AS n FROM v_evidence_in_force WHERE kv_id = ?', [kvId]))!.n;
  Object.assign(report, { prev_kv_id: prev?.kv_id ?? null, new_kv_id: kvId, kv_seq: seq, closed_versions: closedRes.affectedRows,
    inserted_versions: inserted, in_force_at_new_kv: inForce, not_yet_effective: inserted - inForce });
  const closed: KvChange[] = [...new Set(closedRows.map((r) => r.evidence_item_id))].map((id) => ({ evidenceItemId: id, changeKind: 'repeal' }));
  const kindOf = (t: SourceType) => (t === 'ftc_case' ? 'new_case' : t === 'std_terms' ? 'std_terms_revision' : 'amend') as KvChange['changeKind'];
  const added: KvChange[] = units.map((u) => ({ evidenceItemId: idOf.get(`${u.sourceType}|${u.sourceName}|${u.identifier}`)!, changeKind: kindOf(u.sourceType) }));
  if (dryRun) throw new DryRun();
  return { kvId, closed, added };
}

async function main() {
  const snap = JSON.parse(fs.readFileSync(file, 'utf8')) as Snapshot;
  const report: Record<string, unknown> = { snapshot: file, knowledge_date: snap.knowledgeDate, dry_run: dryRun, deltas: snap.deltas.length };
  const units = toUnits(snap, report);
  report.units = units.length;
  let r: Awaited<ReturnType<typeof load>> | null = null;
  const t0 = Date.now();
  try {
    r = await withTx((conn) => load(conn, snap, units, report));
  } catch (e) {
    if (!(e instanceof DryRun)) throw e;
  }
  report.tx_ms = Date.now() - t0;
  if (r) {
    // 커밋 뒤(트랜잭션 밖): 새 기준일 BM25 인덱스 → 영향 결과 식별(approve.service 와 같은 순서)
    report.index_docs = await buildIndexForNewKv(asKvId(r.kvId));
    report.impacted_results = await identifyImpacts(r.kvId, r.closed, r.added);
  }
  const out = path.resolve(BACKEND_ROOT, `../dataset_work/knowledge/bootstrap_${dryRun ? 'dryrun' : 'applied'}_report.json`);
  fs.writeFileSync(out, JSON.stringify(report, null, 1));
  process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
}

main()
  .catch((e: Error) => {
    process.stderr.write(`bootstrap 실패: ${e.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => closePool());
