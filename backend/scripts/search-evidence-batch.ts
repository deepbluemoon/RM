// 근거 일괄 검색(평가 도구용, 2026-09-29) — 서비스와 같은 searchEvidence(명시 참조 + BM25 + bge-m3 하이브리드)를 쓴다.
//   npm run knowledge:search-batch -- --in queries.jsonl --out results.jsonl [--bm25-only]
// 입력 한 줄: {"id": "...", "text": "비식별 조항", "riskType": "refund_cancel_limit"|null, "relatedLaws": [...], "excludeCaseIds": ["FTC-..."]}
// 출력 한 줄: {"id", "kv_id", "knowledge_date", "mode": "hybrid"|"bm25", "evidence": [M3 요청 형식], "hits": [{evidence_version_id, source_type, score, dense, rrf, explicit}]}
// excludeCaseIds: 평가 누수 방지 — 해당 사건의 공정위 사례 근거를 후보에서 뺀다(서비스 분석에서는 쓰지 않는다).
import fs from 'node:fs';
import { closePool, getPool, selectOne } from '../src/db/pool.js';
import { asKvId } from '../src/domain/types.js';
import type { RiskType } from '../src/domain/codes.js';
import { searchEvidence } from '../src/modules/evidence/search.js';
import { evidencePayload } from '../src/modules/detection/detection.service.js';

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };

async function main() {
  const inPath = arg('--in'); const outPath = arg('--out');
  if (!inPath || !outPath) throw new Error('--in, --out 이 필요합니다');
  const bm25Only = process.argv.includes('--bm25-only');
  const kv = await selectOne<{ kv_id: number; d: string }>(getPool(),
    "SELECT kv_id, DATE_FORMAT(knowledge_date, '%Y-%m-%d') AS d FROM knowledge_version WHERE status = 'active'");
  if (!kv) throw new Error('활성 지식 기준일이 없습니다');
  const lines = fs.readFileSync(inPath, 'utf8').split('\n').filter((l) => l.trim());
  const out: string[] = [];
  for (const l of lines) {
    const q = JSON.parse(l) as { id: string; text: string; riskType?: RiskType | null; relatedLaws?: string[]; excludeCaseIds?: string[] };
    const ex = (q.excludeCaseIds ?? []).map((c) => `(${c})`);
    const hits = await searchEvidence(asKvId(kv.kv_id), q.text, {
      riskType: q.riskType ?? null, relatedLaws: q.relatedLaws ?? [],
      ...(ex.length ? { exclude: (r) => r.source_type === 'ftc_case' && ex.some((s) => r.source_name.includes(s)) } : {}),
      ...(bm25Only ? { hybrid: false } : {}),
    });
    out.push(JSON.stringify({
      id: q.id, kv_id: kv.kv_id, knowledge_date: kv.d, mode: hits.some((h) => h.dense !== undefined) ? 'hybrid' : 'bm25',
      evidence: evidencePayload(hits),
      hits: hits.map((h) => ({ evidence_version_id: h.row.evidence_version_id, source_type: h.row.source_type, score: h.score, dense: h.dense ?? null, rrf: h.rrf ?? null, explicit: h.explicit })),
    }));
  }
  fs.writeFileSync(outPath, out.join('\n') + '\n');
  process.stdout.write(`검색 ${out.length}건 → ${outPath} (kv ${kv.kv_id})\n`);
}
main().catch((e: Error) => { process.stderr.write(`일괄 검색 실패: ${e.message}\n`); process.exitCode = 1; }).finally(() => closePool());
