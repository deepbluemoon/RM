// T042 — 8종 가상 개인정보는 모두 가려지고, 계약 조문 숫자는 가려지지 않는다(SC-013)
import { describe, expect, it } from 'vitest';
import { deidentify, deidentifyDetailed, deidentifyDocument, detectPii, maskForLog } from '../../src/modules/deid/deid.service.js';
import { CONTRACT_NUMBERS, CONTRACT_PHRASES, PII_SAMPLES } from '../fixtures/pii/samples.js';
import { PII_CONTRACT_TEXT, PII_SECRETS } from '../fixtures/pii/contract-with-pii.js';
import { PII_LABEL } from '../../src/domain/codes.js';

describe('비식별화 8종', () => {
  it.each(PII_SAMPLES)('$type: $text', ({ type, text, secret }) => {
    const r = deidentifyDetailed(text);
    expect(r.text).not.toContain(secret);
    expect(r.text).toContain(`〔${PII_LABEL[type as keyof typeof PII_LABEL]}〕`);
  });

  it('8종 모두 표본이 있다', () => {
    expect(new Set(PII_SAMPLES.map((s) => s.type)).size).toBe(8);
  });

  it('대괄호 [ ] 가림 표기를 쓰지 않는다(SD_02 C8)', () => {
    const out = deidentify('연락처 010-1234-5678');
    expect(out).not.toMatch(/\[|\]/);
  });

  it.each(CONTRACT_NUMBERS)('오탐 없음: %s', (t) => {
    expect(detectPii(t)).toEqual([]);
    expect(deidentify(t)).toBe(t);
  });

  it.each(CONTRACT_PHRASES)('이름 오탐 없음: %s', (t) => {
    expect(deidentify(t)).toBe(t);
  });

  it('표본 계약서(T105) — 본문·표시명에 원문 값이 남지 않는다', () => {
    const r = deidentifyDocument(PII_CONTRACT_TEXT, deidentify('김민준_피트니스_이용계약서.pdf'));
    for (const s of PII_SECRETS) {
      expect(r.text, s.value).not.toContain(s.value);
      expect(r.displayName, s.value).not.toContain(s.value);
    }
    // 조문은 그대로 남는다
    expect(r.text).toContain('제5조(중도 해지)');
  });

  it('접수 직후 파일명만 있어도 이름을 가린다(A14)', () => {
    expect(deidentify('김민준_피트니스_이용계약서.pdf')).toBe('〔이름〕_피트니스_이용계약서.pdf');
  });

  it('한 번 확정된 이름은 문서 전체와 표시명에서 치환된다(A14)', () => {
    const doc = '임차인 성명: 홍길동\n제5조 홍길동은 월세를 낸다. 홍길동의 연락처는 따로 둔다.';
    const r = deidentifyDocument(doc, '홍길동_임대차계약서.pdf');
    expect(r.text).not.toContain('홍길동');
    expect(r.displayName).not.toContain('홍길동');
    expect(r.displayName).toContain('〔이름〕');
  });

  it('로그 직렬화용 가림', () => {
    expect(maskForLog('user phone 010-2222-3333')).not.toContain('010-2222-3333');
    expect(maskForLog('ok')).toBe('ok');
  });
});
