// 단정 표현 필터(T074, FR-029, A7·A8) — 사전은 저장소 루트 shared/assertion-terms.json 하나(모델 서버 postfilter 와 공유).
// 3.5 저장과 4.8 조회에서 함께 쓴다. 모든 주장이 제외되면 g9=true 를 돌려준다.
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../../config/env.js';

interface Dict {
  patterns: string[];
  allowedHedges: string[];
}

let compiled: RegExp[] | null = null;

function patterns(): RegExp[] {
  if (!compiled) {
    const dict = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'shared', 'assertion-terms.json'), 'utf8')) as Dict;
    compiled = dict.patterns.map((p) => new RegExp(p, 'iu'));
  }
  return compiled;
}

export function containsAssertion(text: string): boolean {
  return patterns().some((re) => re.test(text));
}

export interface ClaimIn {
  claim: string;
  evidenceIds: number[];
}

export interface FilterResult<T> {
  kept: T[];
  droppedAssertion: number;
  droppedEvidence: number;
  /** 입력 주장이 있었는데 모두 제외됨 → G9 */
  g9: boolean;
}

/** 단정 표현이 있거나 근거 집합 밖 근거만 가리키는 주장을 뺀다. 주장의 근거는 허용 집합 안의 것만 남긴다 */
export function filterClaims<T extends ClaimIn>(claims: T[], allowedEvidenceIds: Iterable<number>): FilterResult<T> {
  const allowed = new Set(allowedEvidenceIds);
  let droppedAssertion = 0;
  let droppedEvidence = 0;
  const kept: T[] = [];
  for (const c of claims) {
    if (containsAssertion(c.claim)) {
      droppedAssertion++;
      continue;
    }
    const ev = c.evidenceIds.filter((id) => allowed.has(id));
    if (!ev.length) {
      droppedEvidence++;
      continue;
    }
    kept.push({ ...c, evidenceIds: ev });
  }
  return { kept, droppedAssertion, droppedEvidence, g9: claims.length > 0 && kept.length === 0 };
}

/** 요약 등 자유 문장에서 단정 문장만 뺀다(SC-005) */
export function stripAssertiveSentences(text: string): string {
  return text
    .split(/(?<=[.。!?])\s+/)
    .filter((s) => !containsAssertion(s))
    .join(' ')
    .trim();
}
