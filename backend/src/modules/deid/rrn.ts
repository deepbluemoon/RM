// 주민등록번호 — YYMMDD-[1-4]XXXXXX. 2020-10 이후 번호는 체크섬이 없으므로 하이픈 표기는 날짜·성별 자리만 검사하고,
// 하이픈 없는 13자리는 체크섬 또는 "주민" 문맥이 있을 때만 가린다(오탐 방지 — 계약 금액 등).
import { collect, NA, NB, type Detector } from './types.js';

export function validBirth(yymmdd: string): boolean {
  const mm = Number(yymmdd.slice(2, 4));
  const dd = Number(yymmdd.slice(4, 6));
  return mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31;
}

export function rrnChecksum(d13: string): boolean {
  const w = [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5];
  let s = 0;
  for (let i = 0; i < 12; i++) s += Number(d13[i]) * w[i]!;
  return (11 - (s % 11)) % 10 === Number(d13[12]);
}

export function makeIdDetector(genderClass: string, type: 'rrn' | 'foreigner_no', contextWord: RegExp): Detector {
  const hyphen = new RegExp(`${NB}(\\d{6})\\s?[-–]\\s?(${genderClass}\\d{6})${NA}`, 'g');
  const plain = new RegExp(`${NB}(\\d{6})(${genderClass}\\d{6})${NA}`, 'g');
  return (text) => [
    ...collect(hyphen, text, type, (m) => validBirth(m[1]!)),
    ...collect(plain, text, type, (m) => {
      if (!validBirth(m[1]!)) return false;
      const ctx = text.slice(Math.max(0, m.index - 20), m.index);
      return rrnChecksum(m[1]! + m[2]!) || contextWord.test(ctx);
    }),
  ];
}

export const detectRrn: Detector = makeIdDetector('[1-4]', 'rrn', /주민/);
