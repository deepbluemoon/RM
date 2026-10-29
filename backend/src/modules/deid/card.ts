// 카드번호 — 13~19자리(4자리 묶음 표기 포함) + Luhn
import { collect, NA, NB, type Detector } from './types.js';

export function luhn(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

const re = new RegExp(`${NB}(?:\\d{4}[- ]){3}\\d{1,7}${NA}|${NB}\\d{13,19}${NA}`, 'g');

export const detectCard: Detector = (text) =>
  collect(re, text, 'card_no', (m) => {
    const d = m[0].replace(/\D/g, '');
    return d.length >= 13 && d.length <= 19 && luhn(d);
  });
