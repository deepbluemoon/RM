// 판정 불가 관문 보정·평가(2026-09-30) — npm run abstention:calibrate [-- --frr 0.01]
// 입력: dataset_work/abstention/{valid,invalid}.jsonl (tools/abstention/build_calibration_v1.py)
// 관문 1(규칙) → 관문 2(계약 조항다움 점수, clauseLikeness). 정상 조항 전체에서 두 관문을 합쳐 막는 비율이 목표(기본 1%) 이하가 되는
// 가장 큰 관문 2 기준값을 고르고, 그 기준에서 잘못된 입력 종류별 검출률을 보고한다. 결과: dataset_work/abstention/calibration_v1.json
import fs from 'node:fs';
import path from 'node:path';
import { BACKEND_ROOT } from '../src/config/env.js';
import { closePool, getPool, selectOne } from '../src/db/pool.js';
import { asKvId } from '../src/domain/types.js';
import { clauseLikeness } from '../src/modules/evidence/search.js';
import { ruleCheck } from '../src/modules/abstention/rules.js';

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const target = Number(arg('--frr') ?? 0.01);
const dir = path.resolve(BACKEND_ROOT, '../dataset_work/abstention');
const load = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as { id: string; kind: string; text: string });

async function scoreAll(kv: number, rows: { text: string }[]) {
  const out: (number | null)[] = [];
  for (let i = 0; i < rows.length; i += 32) {
    out.push(...(await clauseLikeness(asKvId(kv), rows.slice(i, i + 32).map((r) => r.text))));
    if (i + 32 < rows.length) await new Promise((r) => setTimeout(r, 1000));   // 대량 임베딩 — 가이드 1.7-7
    if ((i / 32) % 10 === 0) process.stdout.write(`\r임베딩 ${Math.min(i + 32, rows.length)}/${rows.length}   `);
  }
  return out;
}

async function main() {
  const kv = (await selectOne<{ kv_id: number }>(getPool(), "SELECT kv_id FROM knowledge_version WHERE status = 'active'"))!.kv_id;
  const valid = load('valid.jsonl'); const invalid = load('invalid.jsonl');
  const g1v = valid.map((r) => ruleCheck(r.text)); const g1i = invalid.map((r) => ruleCheck(r.text));
  const sv = await scoreAll(kv, valid); const si = await scoreAll(kv, invalid);
  // 관문 2 기준값 후보: 관문 1 을 통과한 정상 조항 점수의 하위 분위
  const passV = valid.map((_, i) => i).filter((i) => !g1v[i] && sv[i] != null);
  const g1Frr = g1v.filter(Boolean).length / valid.length;
  const sorted = passV.map((i) => sv[i]!).sort((a, b) => a - b);
  let tau = -1;
  for (const t of sorted) {
    const blocked = g1v.filter(Boolean).length + passV.filter((i) => sv[i]! < t).length;
    if (blocked / valid.length <= target) tau = t; else break;
  }
  const blockedValid = (i: number) => !!g1v[i] || (sv[i] != null && sv[i]! < tau);
  const blockedInvalid = (i: number) => !!g1i[i] || (si[i] != null && si[i]! < tau);
  const kinds = [...new Set(invalid.map((r) => r.kind))];
  const byKind = Object.fromEntries(kinds.map((k) => {
    const ix = invalid.map((r, i) => (r.kind === k ? i : -1)).filter((i) => i >= 0);
    return [k, { n: ix.length, gate1: ix.filter((i) => g1i[i]).length, gate2_only: ix.filter((i) => !g1i[i] && si[i] != null && si[i]! < tau).length,
      caught: Math.round((ix.filter(blockedInvalid).length / ix.length) * 1000) / 1000 }];
  }));
  const q = (p: number) => sorted[Math.floor(p * (sorted.length - 1))];
  const report = {
    kv_id: kv, target_frr: target, tau: Math.round(tau * 10000) / 10000,
    valid: { n: valid.length, gate1_rejects: g1v.filter(Boolean).length, gate1_frr: Math.round(g1Frr * 10000) / 10000,
      total_frr: Math.round((valid.filter((_, i) => blockedValid(i)).length / valid.length) * 10000) / 10000,
      gate1_codes: g1v.filter(Boolean).reduce<Record<string, number>>((m, v) => ({ ...m, [v!.code]: (m[v!.code] ?? 0) + 1 }), {}),
      score_quantiles: { p001: q(0.001), p01: q(0.01), p05: q(0.05), p50: q(0.5) } },
    invalid: { n: invalid.length, caught: Math.round((invalid.filter((_, i) => blockedInvalid(i)).length / invalid.length) * 1000) / 1000, by_kind: byKind },
    blocked_valid_examples: valid.map((r, i) => ({ r, i })).filter(({ i }) => blockedValid(i)).slice(0, 12)
      .map(({ r, i }) => ({ id: r.id, why: g1v[i]?.code ?? `gate2 ${sv[i]}`, text: r.text.slice(0, 80) })),
    missed_invalid_examples: invalid.map((r, i) => ({ r, i })).filter(({ i }) => !blockedInvalid(i)).slice(0, 12)
      .map(({ r, i }) => ({ kind: r.kind, score: si[i], text: r.text.slice(0, 80) })),
  };
  fs.writeFileSync(path.join(dir, 'calibration_v1.json'), JSON.stringify(report, null, 1));
  process.stdout.write(`\n${JSON.stringify(report, null, 1)}\n`);
}
main().catch((e: Error) => { process.stderr.write(`보정 실패: ${e.message}\n`); process.exitCode = 1; }).finally(() => closePool());
