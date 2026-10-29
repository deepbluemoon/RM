// 0.2 전처리(T131, UC7 기본흐름 2·E2, BR-KNW-02, FR-036·FR-038): 법령은 조·항·호, 사례는 사실관계·판단·근거로 나누고
// 중복·노이즈를 제거한다. 나누지 못한 항목은 parse_status='failed' + 사유 → G1 검토 목록(반영 제외는 DB chk_ii_g1 이 강제).
// 결과 단위 1개 = ingest_item 1행 = 근거 항목(evidence_item) 1개. 폐지·개정으로 없어지는 기존 항목도 단위로 만든다
import type { Agency, ChangeKind, SourceDelta } from './collectors/index.js';

export interface ExistingEvidence {
  evidenceItemId: number;
  sourceType: string;
  sourceName: string;
  identifier: string;
  excerpt: string;
}

export interface PreparedUnit {
  agency: Agency;
  changeKind: ChangeKind;
  sourceType: 'law_article' | 'ftc_case' | 'std_terms' | null;
  sourceName: string;
  identifier: string;
  title: string;
  excerpt: string;
  caseFacts: string | null;
  caseJudgment: string | null;
  caseBasis: string | null;
  sourceUrl: string;
  effectiveDate: string | null;
  publishedDate: string | null;
  parseStatus: 'ok' | 'failed';
  parseFailReason: string | null;
  /** 전처리 시점에 대응한 기존 근거 항목(표시용 — 승인 때 다시 찾는다) */
  evidenceItemId: number | null;
}

export interface PreprocessStats {
  deltas: number;
  units: number;
  duplicates: number;
  noise: number;
  unchanged: number;
  parseFailed: number;
}

class ParseFail extends Error {}

const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
const EXCERPT_MAX = 2000;
const MIN_TEXT = 5;

/** 태그·엔티티·개정 이력 주석(<개정 …>, [본조신설 …])을 걷어내고 줄 단위 공백을 정리한다(노이즈 제거) */
export function normalizeText(raw: string): string {
  return raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|li|tr|span|b|strong|em|font|table|tbody|td|th)[^>]*>/gi, '\n')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/<\s*(개정|신설|삭제|타법개정|전문개정|본조신설|제목개정)[^>]*>/g, '')
    .replace(/\[\s*(본조신설|전문개정|제목개정|본조삭제|종전|시행일|제\s*\d+\s*조[^\]]*에서 이동)[^\]]*\]/g, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t 　]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

const squash = (s: string) => s.replace(/\s+/g, '');

/** "제 6 조의 2 제1항" → "제6조의2" */
export function articleKey(identifier: string): string | null {
  const m = /^\s*제\s*(\d+)\s*조(?:\s*의\s*(\d+))?/.exec(identifier);
  return m ? `제${m[1]}조${m[2] ? `의${m[2]}` : ''}` : null;
}

const HEADER = /^\s*제\s*\d+\s*조(?:\s*의\s*\d+)?\s*(?:\([^)\n]*\))?\s*/;
const isDeleted = (body: string) => /^\s*삭제\s*(?:[<[(]|$)/.test(body);

/** 호("1. …") 확인 — "다음 각 호"라고 하고 호가 없거나 번호가 이어지지 않으면 분리 실패 */
function checkItems(text: string): void {
  const nums = text.split('\n').map((l) => /^(\d+)\.\s/.exec(l)?.[1]).filter((x): x is string => !!x).map(Number);
  if (/다음\s*각\s*호/.test(text) && nums.length === 0) throw new ParseFail('"다음 각 호"의 호를 나누지 못했습니다');
  nums.forEach((n, i) => {
    if (n !== i + 1) throw new ParseFail('호 번호가 이어지지 않습니다');
  });
}

/** 법령 조문 → 항 단위(항이 없으면 조 단위). 호는 항 발췌 안에 줄로 남긴다 */
export function splitLaw(identifier: string, rawText: string): { identifier: string; excerpt: string }[] {
  const article = articleKey(identifier);
  if (!article || squash(identifier) !== article) throw new ParseFail('조 번호를 알 수 없습니다');
  const body = normalizeText(rawText).replace(HEADER, '').trim();
  if (body.length < MIN_TEXT) throw new ParseFail('조문 본문이 없습니다');
  const marks = [...body.matchAll(/[①-⑳]/g)].filter((m) => m.index === 0 || /[\s\n]/.test(body[m.index! - 1]!));
  if (!marks.length) {
    checkItems(body);
    return [{ identifier: article, excerpt: body.slice(0, EXCERPT_MAX) }];
  }
  if (body.slice(0, marks[0]!.index).trim()) throw new ParseFail('항 앞에 나눌 수 없는 문장이 있습니다');
  return marks.map((m, i) => {
    const n = CIRCLED.indexOf(m[0]) + 1;
    if (n !== i + 1) throw new ParseFail('항 번호가 이어지지 않습니다');
    const text = body.slice(m.index! + 1, i + 1 < marks.length ? marks[i + 1]!.index : undefined).trim();
    if (text.length < MIN_TEXT) throw new ParseFail(`제${n}항 본문이 없습니다`);
    checkItems(text);
    return { identifier: `${article} 제${n}항`, excerpt: text.slice(0, EXCERPT_MAX) };
  });
}

const SECTION: Record<'facts' | 'judgment' | 'basis', RegExp> = {
  facts: /(?:^|\n)\s*(?:\d+\.\s*|[가-하]\.\s*)?(?:사실\s*관계|인정\s*사실|사건\s*개요)\s*[:：]?/,
  judgment: /(?:^|\n)\s*(?:\d+\.\s*|[가-하]\.\s*)?(?:위법성\s*판단|판단|심사\s*결과)\s*[:：]?/,
  basis: /(?:^|\n)\s*(?:\d+\.\s*|[가-하]\.\s*)?(?:법령의\s*적용|근거\s*법령|관련\s*법령|근거)\s*[:：]?/,
};

/** 사례 → 사실관계·판단·근거(UC3 기본흐름 5, FR-036). 원천이 나눠 준 값이 있으면 그대로 쓴다 */
export function splitCase(d: Pick<SourceDelta, 'rawText' | 'caseSections'>): { facts: string; judgment: string; basis: string } {
  const given = d.caseSections;
  if (given?.facts && given.judgment && given.basis) {
    return { facts: normalizeText(given.facts), judgment: normalizeText(given.judgment), basis: normalizeText(given.basis) };
  }
  const text = normalizeText(d.rawText);
  const found = (Object.keys(SECTION) as (keyof typeof SECTION)[])
    .map((k) => {
      const m = SECTION[k].exec(text);
      return m ? { k, start: m.index, end: m.index + m[0].length } : null;
    });
  if (found.some((f) => !f)) throw new ParseFail('사실관계·판단·근거로 나누지 못했습니다');
  const sorted = (found as { k: keyof typeof SECTION; start: number; end: number }[]).sort((a, b) => a.start - b.start);
  const out = {} as Record<keyof typeof SECTION, string>;
  sorted.forEach((f, i) => {
    out[f.k] = text.slice(f.end, i + 1 < sorted.length ? sorted[i + 1]!.start : undefined).trim();
  });
  if (!out.facts || !out.judgment || !out.basis) throw new ParseFail('사실관계·판단·근거 중 빈 항목이 있습니다');
  return out;
}

const KIND_SUFFIX: Partial<Record<ChangeKind, string>> = { amend: '개정', repeal: '폐지', new_law: '신설', new_case: '신규 사례', std_terms_revision: '표준약관 개정' };

function unit(d: SourceDelta, over: Partial<PreparedUnit>): PreparedUnit {
  return {
    agency: d.agency,
    changeKind: d.changeKind,
    sourceType: d.sourceType,
    sourceName: d.sourceName.trim(),
    identifier: d.identifier.trim(),
    title: d.title.trim().slice(0, 300),
    excerpt: '',
    caseFacts: null,
    caseJudgment: null,
    caseBasis: null,
    sourceUrl: d.sourceUrl,
    effectiveDate: d.effectiveDate ?? null,
    publishedDate: d.publishedDate ?? null,
    parseStatus: 'ok',
    parseFailReason: null,
    evidenceItemId: null,
    ...over,
  };
}

const dateOf = (d: SourceDelta) => d.effectiveDate ?? d.publishedDate ?? '';

/**
 * 원천 변경분 → 반영 단위. existing = 기준일(base kv)의 시행 중 근거(v_evidence_in_force).
 * 같은 근거(유형·이름·번호)가 여러 번 오면 날짜가 가장 늦은 것만 남기고(중복), 본문이 비었으면 버리고(노이즈),
 * 현재 근거와 발췌가 같으면 변경이 없으므로 버린다(unchanged)
 */
export function preprocess(deltas: SourceDelta[], existing: ExistingEvidence[]): { units: PreparedUnit[]; stats: PreprocessStats } {
  const stats: PreprocessStats = { deltas: deltas.length, units: 0, duplicates: 0, noise: 0, unchanged: 0, parseFailed: 0 };
  const byKey = new Map<string, SourceDelta>();
  for (const d of deltas) {
    if (d.changeKind !== 'repeal' && normalizeText(d.rawText ?? '').length < MIN_TEXT && !(d.caseSections?.judgment)) {
      stats.noise++;
      continue;
    }
    const k = `${d.sourceType ?? 'ref'}|${squash(d.sourceName)}|${squash(d.identifier)}`;
    const prev = byKey.get(k);
    if (prev) {
      stats.duplicates++;
      if (dateOf(d) > dateOf(prev)) byKey.set(k, d);
    } else byKey.set(k, d);
  }

  const find = (type: string | null, name: string, identifier: string) =>
    existing.find((e) => e.sourceType === type && squash(e.sourceName) === squash(name) && squash(e.identifier) === squash(identifier)) ?? null;
  const sameArticle = (type: string | null, name: string, article: string) =>
    existing.filter((e) => e.sourceType === type && squash(e.sourceName) === squash(name) && articleKey(e.identifier) === article);

  const units: PreparedUnit[] = [];
  const repealUnits = (d: SourceDelta, targets: ExistingEvidence[], why = '폐지') =>
    targets.map((e) => unit(d, { changeKind: 'repeal', identifier: e.identifier, title: `${e.sourceName} ${e.identifier} ${why}`.slice(0, 300), evidenceItemId: e.evidenceItemId }));

  for (const d of byKey.values()) {
    try {
      if (!d.identifier?.trim()) throw new ParseFail('조 번호·사건번호가 없습니다');
      if (d.changeKind !== 'reference' && d.changeKind !== 'repeal' && !d.effectiveDate && !d.publishedDate) throw new ParseFail('시행일·공개일이 없습니다');
      if (d.sourceType === null || d.changeKind === 'reference') {
        units.push(unit(d, { changeKind: 'reference', sourceType: null, excerpt: normalizeText(d.rawText).slice(0, EXCERPT_MAX) }));
        continue;
      }
      if (d.sourceType === 'ftc_case') {
        const s = splitCase(d);
        const ex = find('ftc_case', d.sourceName, d.identifier);
        if (ex && squash(ex.excerpt) === squash(s.judgment)) {
          stats.unchanged++;
          continue;
        }
        units.push(unit(d, { changeKind: 'new_case', excerpt: s.judgment.slice(0, EXCERPT_MAX), caseFacts: s.facts, caseJudgment: s.judgment, caseBasis: s.basis, evidenceItemId: ex?.evidenceItemId ?? null }));
        continue;
      }
      const article = articleKey(d.identifier);
      // 법령·표준약관 폐지 — 같은 조의 기존 근거 항목을 모두 닫는다(UC7 A3)
      const deleted = d.changeKind === 'repeal' || isDeleted(normalizeText(d.rawText).replace(HEADER, ''));
      if (deleted) {
        if (!article) throw new ParseFail('조 번호를 알 수 없습니다');
        const targets = d.sourceType === 'law_article' ? sameArticle('law_article', d.sourceName, article) : [find(d.sourceType, d.sourceName, d.identifier) ?? sameArticle(d.sourceType, d.sourceName, article)[0]].filter((x): x is ExistingEvidence => !!x);
        units.push(...(targets.length ? repealUnits({ ...d, changeKind: 'repeal' }, targets) : [unit(d, { changeKind: 'repeal', identifier: article })]));
        continue;
      }
      if (d.sourceType === 'std_terms') {
        if (!article) throw new ParseFail('표준약관 조항 번호를 알 수 없습니다');
        const body = normalizeText(d.rawText).replace(HEADER, '').trim();
        if (body.length < MIN_TEXT) throw new ParseFail('표준약관 조항 본문이 없습니다');
        checkItems(body);
        const ex = find('std_terms', d.sourceName, d.identifier);
        if (ex && squash(ex.excerpt) === squash(body)) {
          stats.unchanged++;
          continue;
        }
        units.push(unit(d, { changeKind: 'std_terms_revision', excerpt: body.slice(0, EXCERPT_MAX), evidenceItemId: ex?.evidenceItemId ?? null }));
        // 조항 제목이 바뀐 개정 — 같은 조의 옛 항목은 닫는다(A2)
        if (!ex) units.push(...repealUnits(d, sameArticle('std_terms', d.sourceName, article), '(개정으로 대체)'));
        continue;
      }
      // 법령 개정·신설
      const parts = splitLaw(d.identifier, d.rawText);
      const olds = article ? sameArticle('law_article', d.sourceName, article) : [];
      const kind: ChangeKind = d.changeKind === 'amend' && olds.length === 0 ? 'new_law' : d.changeKind;
      for (const p of parts) {
        const ex = find('law_article', d.sourceName, p.identifier);
        if (ex && squash(ex.excerpt) === squash(p.excerpt)) {
          stats.unchanged++;
          continue;
        }
        const title = parts.length === 1 && squash(p.identifier) === squash(d.identifier) ? d.title : `${d.sourceName} ${p.identifier} ${KIND_SUFFIX[kind] ?? ''}`.trim();
        units.push(unit(d, { changeKind: kind, identifier: p.identifier, title: title.slice(0, 300), excerpt: p.excerpt, evidenceItemId: ex?.evidenceItemId ?? null }));
      }
      // 개정으로 없어진 항 — 닫는다
      const kept = new Set(parts.map((p) => squash(p.identifier)));
      units.push(...repealUnits(d, olds.filter((o) => !kept.has(squash(o.identifier))), '(개정으로 삭제)'));
    } catch (e) {
      if (!(e instanceof ParseFail)) throw e;
      stats.parseFailed++;
      units.push(unit(d, { parseStatus: 'failed', parseFailReason: e.message.slice(0, 200) }));
    }
  }
  stats.units = units.length;
  return { units, stats };
}
