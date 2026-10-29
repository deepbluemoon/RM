import type { PiiType } from '../../domain/codes.js';

export interface PiiHit {
  type: PiiType;
  start: number;
  end: number;
}

export type Detector = (text: string) => PiiHit[];

export function collect(re: RegExp, text: string, type: PiiType, accept?: (m: RegExpExecArray) => boolean, group = 0): PiiHit[] {
  const out: PiiHit[] = [];
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m: RegExpExecArray | null;
  while ((m = g.exec(text))) {
    if (m[0].length === 0) {
      g.lastIndex++;
      continue;
    }
    if (accept && !accept(m)) continue;
    const sub = m[group] ?? m[0];
    const start = m.index + (group ? m[0].indexOf(sub) : 0);
    out.push({ type, start, end: start + sub.length });
  }
  return out;
}

/** 숫자 경계: 앞뒤가 숫자가 아니어야 한다 */
export const NB = '(?<![0-9])';
export const NA = '(?![0-9])';
