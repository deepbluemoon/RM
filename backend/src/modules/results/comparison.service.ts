// 4.10 원문 대 법령·표준약관 비교(T091), 4.11 유사 공정위 사례(T092). 판정 근거 집합 안에서만 고른다.
// 사업자 관점이면 표준약관 대비 차이(diffHints = businessDiffNotes)를 싣는다(US6 T125, UC4 기본흐름 5)
import { evidenceOfJudgment, toEvidenceDto, type EvidenceDetail } from '../evidence/evidence.repo.js';
import { getRequest, getRun } from '../analysis/analysis.repo.js';
import { assessmentRow } from './results.service.js';

const UNIT_RE = /(\d+(?:[.,]\d+)?)\s*(영업일|일|개월|년|%|퍼센트|배|분의\s*\d+)/g;

function quantities(text: string): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const x of text.matchAll(UNIT_RE)) {
    const unit = x[2]!.replace(/\s+/g, '');
    m.set(unit, [...(m.get(unit) ?? []), x[1]!]);
  }
  return m;
}

const CONTRAST: [RegExp, RegExp, string][] = [
  [/사전\s*(통지|고지|공지)\s*없이|통지\s*없이|즉시/, /\d+\s*일\s*전|사전에?\s*(알리|공지|통지)/, '표준약관은 변경·중단 전에 미리 알리도록 하지만, 이 조항은 사전 통지 없이 할 수 있게 합니다'],
  [/어떠한\s*경우에도|일체|전액|모든/, /\d+\s*%\s*이내|공제한|일할/, '표준약관은 범위·한도를 두지만, 이 조항은 예외 없이 전부를 정하고 있습니다'],
  [/책임(을)?\s*(지지|지\s*않|없)/, /배상한다|책임을 진다|고의\s*또는\s*과실/, '표준약관은 회사의 고의·과실 책임을 정하지만, 이 조항은 책임을 배제합니다'],
  [/(소송|이의).*(제기할\s*수\s*없|없으며)/, /관할\s*법원|민사소송법/, '표준약관은 법에 따른 관할 법원에서 다투도록 하지만, 이 조항은 다툴 권리를 제한합니다'],
  [/환불(하지|은\s*불가|불가)|반환하지/, /환급|환불한다/, '표준약관은 환급 절차를 두지만, 이 조항은 환불을 막고 있습니다'],
];

export function diffHints(clause: string, std: string): string[] {
  const out: string[] = [];
  for (const [c, s, msg] of CONTRAST) if (c.test(clause) && s.test(std)) out.push(msg);
  const qc = quantities(clause);
  const qs = quantities(std);
  for (const [unit, vals] of qc) {
    const sv = qs.get(unit);
    if (sv && sv.join() !== vals.join()) out.push(`기간·비율 차이: 이 조항 ${vals.join(', ')}${unit} / 표준약관 ${sv.join(', ')}${unit}`);
  }
  return [...new Set(out)];
}

export async function comparison(runId: number, assessmentId: number) {
  const a = await assessmentRow(runId, assessmentId);
  const req = (await getRequest((await getRun(runId))!.request_id))!;
  const ev: EvidenceDetail[] = a.judgment_id ? await evidenceOfJudgment(a.judgment_id) : [];
  const unconfirmed = Boolean(a.evidence_unconfirmed) || !ev.length;
  // 근거 미확인 조항이면 비교를 제공하지 않는다(UC3 A5)
  const law = unconfirmed ? null : (ev.find((e) => e.source_type === 'law_article') ?? null);
  const std = unconfirmed ? null : (ev.find((e) => e.source_type === 'std_terms') ?? null);
  const reasons: Record<string, string> = {};
  if (unconfirmed) reasons.all = '근거가 확인되지 않은 조항이라 비교를 제공하지 않습니다';
  else {
    if (!law) reasons.law = '법령 조문 근거 없음';
    if (!std) reasons.stdTerms = '표준약관 대응 조항 없음';
  }
  return {
    clauseText: a.deid_text,
    available: Boolean(law || std),
    law: law ? toEvidenceDto(law, law.to_kv_id !== null) : null,
    stdTerms: std ? toEvidenceDto(std, std.to_kv_id !== null) : null,
    unavailableReasons: reasons,
    businessDiffNotes: req.perspective === 'business' && std ? diffHints(a.deid_text, std.excerpt) : [],
  };
}

export async function similarCases(runId: number, assessmentId: number) {
  const a = await assessmentRow(runId, assessmentId);
  if (!a.judgment_id) return [];
  const ev = await evidenceOfJudgment(a.judgment_id);
  return ev.filter((e) => e.source_type === 'ftc_case').map((e) => toEvidenceDto(e, e.to_kv_id !== null));
}
