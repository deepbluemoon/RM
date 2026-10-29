// 비식별화 서비스(T028, INC2). DeidentifiedText 브랜드는 이 파일만 만든다(CLAUDE.md).
// 적용 지점: P2 2.3(추출 직후·분할 전), 문서 표시명, 피드백 의견(5.3), 로그 직렬화기, 운영 화면 재검사(G13)
import { PII_LABEL, type PiiType } from '../../domain/codes.js';
import type { DeidentifiedText } from '../../domain/types.js';
import { detectRrn } from './rrn.js';
import { detectForeignerNo } from './foreignerNo.js';
import { detectCard } from './card.js';
import { detectAccount } from './account.js';
import { detectPhone } from './phone.js';
import { detectEmail } from './email.js';
import { detectAddress } from './address.js';
import { detectKnownNames, detectNameMarkers } from './personName.js';
import type { PiiHit } from './types.js';

export const maskToken = (t: PiiType): string => `〔${PII_LABEL[t]}〕`;

/** 겹치는 구간은 먼저 시작하고 더 긴 것 하나로 합친다 */
function merge(hits: PiiHit[]): PiiHit[] {
  const sorted = [...hits].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: PiiHit[] = [];
  for (const h of sorted) {
    const last = out[out.length - 1];
    if (last && h.start < last.end) {
      if (h.end > last.end) last.end = h.end;
      continue;
    }
    out.push({ ...h });
  }
  return out;
}

function structuredHits(text: string): PiiHit[] {
  // 순서가 우선순위 — 주민·외국인 번호가 카드·계좌보다 먼저 잡혀야 한다
  return [
    ...detectRrn(text),
    ...detectForeignerNo(text),
    ...detectEmail(text),
    ...detectCard(text),
    ...detectPhone(text),
    ...detectAccount(text),
    ...detectAddress(text),
  ];
}

export function detectPii(text: string, knownNames?: Set<string>): PiiHit[] {
  const names = new Set(knownNames ?? []);
  for (const h of detectNameMarkers(text)) names.add(text.slice(h.start, h.end));
  return merge([...structuredHits(text), ...detectKnownNames(text, names)]);
}

function apply(text: string, hits: PiiHit[]): string {
  let out = '';
  let pos = 0;
  for (const h of hits) {
    out += text.slice(pos, h.start) + maskToken(h.type);
    pos = h.end;
  }
  return out + text.slice(pos);
}

export interface DeidResult {
  text: DeidentifiedText;
  maskedTypes: PiiType[];
  counts: Partial<Record<PiiType, number>>;
  /** 문서에서 확정된 이름 — 같은 문서의 표시명 등 다른 필드에도 적용한다 */
  names: Set<string>;
}

export function deidentifyDetailed(raw: string, knownNames?: Set<string>): DeidResult {
  const names = new Set(knownNames ?? []);
  for (const h of detectNameMarkers(raw)) names.add(raw.slice(h.start, h.end));
  const hits = merge([...structuredHits(raw), ...detectKnownNames(raw, names)]);
  const counts: Partial<Record<PiiType, number>> = {};
  for (const h of hits) counts[h.type] = (counts[h.type] ?? 0) + 1;
  return {
    text: apply(raw, hits) as DeidentifiedText,
    maskedTypes: Object.keys(counts) as PiiType[],
    counts,
    names,
  };
}

/** 원문 → 비식별 텍스트. 이 함수(와 deidentifyDetailed)만 DeidentifiedText 를 만든다 */
export function deidentify(raw: string, knownNames?: Set<string>): DeidentifiedText {
  return deidentifyDetailed(raw, knownNames).text;
}

/**
 * 문서 단위 비식별화 — 본문에서 확정한 이름을 표시명(파일명)에도 적용한다(A14, T108).
 * 표시명에서만 보이는 이름 패턴(파일명 "홍길동_계약서")은 구분자 앞 2~4자 한글 이름 표지를 추가로 본다.
 */
export function deidentifyDocument(raw: string, displayName: string): { text: DeidentifiedText; displayName: DeidentifiedText; counts: Partial<Record<PiiType, number>> } {
  const body = deidentifyDetailed(raw);
  const nameInFile = /(?:^|[_\s-])([가-힣]{2,4})(?=[_\s-])/g;
  const fileNames = new Set(body.names);
  let m: RegExpExecArray | null;
  while ((m = nameInFile.exec(displayName))) {
    if (body.names.has(m[1]!)) fileNames.add(m[1]!);
  }
  return { text: body.text, displayName: deidentify(displayName, fileNames), counts: body.counts };
}

/** 로그 직렬화용 — 짧은 문자열 빠른 경로. 구조화 탐지기만 쓴다(이름 표지는 포함) */
export function maskForLog(s: string): string {
  if (s.length < 6 || !/[0-9@가-힣]/.test(s)) return s;
  const hits = detectPii(s);
  return hits.length ? apply(s, hits) : s;
}

/** 응답 직전 재검사(G13 방어선) — 발견 유형 목록과 가린 텍스트 */
export function rescan(text: string): { clean: boolean; masked: string; types: PiiType[] } {
  const hits = detectPii(text);
  return { clean: hits.length === 0, masked: apply(text, hits), types: [...new Set(hits.map((h) => h.type))] };
}
