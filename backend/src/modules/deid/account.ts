// 계좌번호 — 은행명·"계좌"·"입금" 문맥 창(±20자) 안의 숫자 묶음(2~6자리 하이픈 2~4덩어리 또는 10~14자리)
import { collect, NA, NB, type Detector } from './types.js';

const BANKS =
  '국민|신한|우리|하나|농협|기업|외환|씨티|SC|제일|카카오뱅크|케이뱅크|토스뱅크|새마을|신협|우체국|수협|산업|부산|대구|경남|광주|전북|제주|은행|뱅크';
const CONTEXT = new RegExp(`(${BANKS}|계좌|입금|예금주|송금|이체)`);
const re = new RegExp(`${NB}(?:\\d{2,6}(?:-\\d{2,7}){1,3}|\\d{10,14})${NA}`, 'g');

export const detectAccount: Detector = (text) =>
  collect(re, text, 'account_no', (m) => {
    const before = text.slice(Math.max(0, m.index - 20), m.index);
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 20);
    if (!CONTEXT.test(before) && !CONTEXT.test(after)) return false;
    // 날짜(2026-09-28)·전화번호 형태는 제외 — 전화는 phone 탐지기가 맡는다
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(m[0])) return false;
    if (/^0\d{1,2}-\d{3,4}-\d{4}$/.test(m[0])) return false;
    return true;
  });
