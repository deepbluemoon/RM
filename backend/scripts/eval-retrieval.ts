// 근거 검색 품질 평가(하이브리드 RAG) — npm run knowledge:eval-retrieval [-- --master <path>] [--limit N] [--out <name>]
// 정답셋: Master 의 공정위 문제조항 → 공정위가 인용한 법조(관련조문: 법률명·조문). 조 단위로 맞으면 정답.
// 누수 방지: 평가 조항과 같은 사건의 공정위 사례 근거는 후보에서 뺀다(exclude).
// 설정 조합(2026-09-30): BM25 / H0 동일가중 RRF / H1 +코사인 가중 / H2 +사례 근거 법조 확장 / H3 +법령 최소 2(기본) / H4 H3·코사인 가중 3
// 지표: (가) 법령 순위 — 같은 사건 사례만 뺀 전체 후보에서 법령만 순서대로 본 recall@3·MRR@10
//       (나) 서비스 출력 — 상위 5(유형별 최대 3)에 정답 조문이 드는 비율, 상위 5 중 법령 평균 개수
import fs from 'node:fs';
import path from 'node:path';
import { BACKEND_ROOT } from '../src/config/env.js';
import { closePool, getPool, select, selectOne } from '../src/db/pool.js';
import { asKvId } from '../src/domain/types.js';
import { indexFor, searchEvidence, type SearchTuning } from '../src/modules/evidence/search.js';
import type { EvidenceRow } from '../src/modules/evidence/evidence.repo.js';

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const masterPath = path.resolve(BACKEND_ROOT, arg('--master') ?? '../workspace/05_master_dataset/master/master_dataset.jsonl');
const limit = arg('--limit') ? Number(arg('--limit')) : Infinity;
const outName = arg('--out') ?? 'retrieval_eval_v2';
// --strict: 같은 사건뿐 아니라 문제 조항(case_facts)이 질의와 거의 같은(4-gram 포함률 ≥ 0.8) 다른 사건의 사례도 뺀다
// (같은 회사가 여러 해에 같은 조항으로 시정된 경우 — 사례 근거 확장이 사실상 같은 정답을 빌려 오는 누수 방지)
const strict = process.argv.includes('--strict');
// --dump: 질의별 법령 순위(상위 10, "법령명|제N조")를 jsonl 로 남긴다(구체 조문·조문별 recall 사후 분석용)
const dump = process.argv.includes('--dump');
const dumpRows: string[] = [];
const grams = (t: string) => { const x = t.replace(/\s+/g, ''); const g = new Set<string>(); for (let i = 0; i + 4 <= x.length; i++) g.add(x.slice(i, i + 4)); return g; };
const containment = (a: Set<string>, b: Set<string>) => { if (!a.size || !b.size) return 0; let n = 0; for (const x of a) if (b.has(x)) n++; return n / Math.min(a.size, b.size); };

interface Gold { id: string; caseId: string; text: string; laws: { law: string; article: string }[] }

function loadGold(): Gold[] {
  const out: Gold[] = [];
  for (const line of fs.readFileSync(masterPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const m = JSON.parse(line) as { 데이터ID: string; 조항원문: string; 관련조문?: { 법률명: string; 조문: string }[] | null };
    if (!m.관련조문?.length || !m.데이터ID.startsWith('FTC-V1-FTC-')) continue;
    const caseId = /^FTC-V1-(FTC-\d{4}-\d{2}-\d{2}-\d+)/.exec(m.데이터ID)?.[1];
    if (!caseId) continue;
    const laws = m.관련조문.filter((x) => x.법률명 && x.조문).map((x) => ({ law: x.법률명, article: x.조문.replace(/\s+/g, '') }));
    if (laws.length) out.push({ id: m.데이터ID, caseId, text: m.조항원문.replace(/\s*\/\s*/g, '\n'), laws });
  }
  return out.slice(0, limit);
}

const isGold = (g: Gold, r: EvidenceRow) =>
  r.source_type === 'law_article' && g.laws.some((l) => r.source_name === l.law && r.identifier.replace(/\s+/g, '').startsWith(l.article));

type Cfg = { name: string; hybrid: boolean; tuning: Partial<SearchTuning> };
const CFGS: Cfg[] = [
  { name: 'BM25', hybrid: false, tuning: {} },
  { name: 'H0 동일가중 RRF', hybrid: true, tuning: { denseWeight: 1, caseExpand: false, minLaw: 0, perArticleMax: 99 } },
  { name: 'H3 사례별 가산(상위5)', hybrid: true, tuning: { denseWeight: 2, caseExpand: true, caseExpandMode: 'rank', caseExpandTop: 5, minLaw: 2, perArticleMax: 99 } },
  { name: 'R10+P1', hybrid: true, tuning: { denseWeight: 2, caseExpand: true, caseExpandMode: 'rank', caseExpandTop: 10, minLaw: 2, perArticleMax: 1 } },
  { name: 'R15+P1', hybrid: true, tuning: { denseWeight: 2, caseExpand: true, caseExpandMode: 'rank', caseExpandTop: 15, minLaw: 2, perArticleMax: 1 } },
  { name: 'R20+P1', hybrid: true, tuning: { denseWeight: 2, caseExpand: true, caseExpandMode: 'rank', caseExpandTop: 20, minLaw: 2, perArticleMax: 1 } },
];

async function main() {
  const kv = (await selectOne<{ kv_id: number }>(getPool(), "SELECT kv_id FROM knowledge_version WHERE status = 'active'"))!.kv_id;
  const kvId = asKvId(kv);
  const idx = await indexFor(kvId);
  const gold = loadGold();
  const acc = CFGS.map(() => ({ r3: 0, rr: 0, top5: 0, lawIn5: 0, hybridUsed: 0 }));
  const facts = strict ? new Map((await select<{ evidence_version_id: number; case_facts: string }>(getPool(),
    `SELECT v.evidence_version_id, ev.case_facts FROM v_evidence_in_force v JOIN evidence_version ev ON ev.evidence_version_id = v.evidence_version_id
      WHERE v.kv_id = ? AND v.source_type = 'ftc_case' AND ev.case_facts IS NOT NULL`, [kv])).map((r) => [r.evidence_version_id, grams(r.case_facts)])) : new Map<number, Set<string>>();
  let nearExcluded = 0;
  const t0 = Date.now();
  for (const [i, g] of gold.entries()) {
    const qg = strict ? grams(g.text) : null;
    const near = new Set<number>();
    if (qg) for (const [id, fg] of facts) if (containment(qg, fg) >= 0.8) near.add(id);
    const exclude = (r: EvidenceRow) => r.source_type === 'ftc_case' && (r.source_name.includes(`(${g.caseId})`) || near.has(r.evidence_version_id));
    nearExcluded += [...near].length;
    for (const [c, cfg] of CFGS.entries()) {
      // (가) 법령 순위: 넓게 뽑아 법령만 순서대로
      const wide = await searchEvidence(kvId, g.text, { exclude, hybrid: cfg.hybrid, tuning: { ...cfg.tuning, topK: 80, maxPerSource: 80, minLaw: 0 } });
      const laws = wide.filter((h) => h.row.source_type === 'law_article').map((h) => h.row);
      const k = laws.findIndex((r) => isGold(g, r));
      if (dump) dumpRows.push(JSON.stringify({ id: g.id, config: cfg.name, gold: g.laws.map((l) => `${l.law}|${l.article}`),
        laws: [...new Set(laws.map((r) => `${r.source_name}|${(/^\s*(제\s*\d+\s*조(?:의\s*\d+)?)/.exec(r.identifier)?.[1] ?? r.identifier).replace(/\s+/g, '')}`))].slice(0, 10) }));
      acc[c]!.r3 += k >= 0 && k < 3 ? 1 : 0;
      acc[c]!.rr += k >= 0 && k < 10 ? 1 / (k + 1) : 0;
      // (나) 서비스 출력
      const top5 = await searchEvidence(kvId, g.text, { exclude, hybrid: cfg.hybrid, tuning: cfg.tuning });
      acc[c]!.top5 += top5.some((h) => isGold(g, h.row)) ? 1 : 0;
      acc[c]!.lawIn5 += top5.filter((h) => h.row.source_type === 'law_article').length;
      acc[c]!.hybridUsed += top5.some((h) => h.dense !== undefined) ? 1 : 0;
    }
    if ((i + 1) % 50 === 0) process.stdout.write(`\r${i + 1}/${gold.length} (${Math.round((Date.now() - t0) / 1000)}s)   `);
  }
  const n = gold.length;
  const f = (x: number) => Math.round((x / n) * 1000) / 1000;
  const report = {
    kv_id: kv, strict, near_duplicate_cases_excluded_avg: Math.round((nearExcluded / Math.max(1, gold.length)) * 100) / 100, vec_model: idx.vecModel, vectors: idx.vec.size, docs: idx.docs.length, cases_with_basis: idx.caseLaw.size, queries: n,
    results: CFGS.map((cfg, c) => ({ config: cfg.name, tuning: cfg.tuning,
      law_recall_at_3: f(acc[c]!.r3), law_mrr_at_10: f(acc[c]!.rr), service_top5_has_gold_law: f(acc[c]!.top5),
      service_top5_avg_laws: Math.round((acc[c]!.lawIn5 / n) * 100) / 100, hybrid_used: f(acc[c]!.hybridUsed) })),
    elapsed_sec: Math.round((Date.now() - t0) / 1000),
  };
  const out = path.resolve(BACKEND_ROOT, `../dataset_work/knowledge/${outName}.json`);
  fs.writeFileSync(out, JSON.stringify(report, null, 1));
  if (dump) fs.writeFileSync(out.replace(/\.json$/, '_rankings.jsonl'), dumpRows.join('\n') + '\n');
  process.stdout.write(`\n${JSON.stringify(report, null, 1)}\n`);
}

main().catch((e: Error) => { process.stderr.write(`평가 실패: ${e.message}\n`); process.exitCode = 1; }).finally(() => closePool());
