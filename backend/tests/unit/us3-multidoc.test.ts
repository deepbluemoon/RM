// T098·T103 — 결합된 복수 계약 분리(UC1 A5): 제1조 재시작·약관 제목 재등장이면 새 문서, 부칙의 제1조는 같은 문서
import { describe, expect, it } from 'vitest';
import { splitDocuments } from '../../src/modules/structuring/multiDoc.js';
import { isTitleLine } from '../../src/modules/structuring/splitter.js';

const arts = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `제${i + from}조(조${i + from}) 회원은 ${i + from}번째 사항을 따른다.`);

describe('복수 문서 분리', () => {
  it('제목 없이 제1조가 다시 시작되면 나눈다', () => {
    const docs = splitDocuments(['갑 서비스 이용약관', ...arts(4), ...arts(3)].join('\n'));
    expect(docs.map((d) => d.articles.map((a) => a.articleNo))).toEqual([
      ['제1조', '제2조', '제3조', '제4조'],
      ['제1조', '제2조', '제3조'],
    ]);
    expect(docs[0]!.title).toBe('갑 서비스 이용약관');
    expect(docs[1]!.title).toBeNull();
  });

  it('약관 제목이 다시 나오면 그 줄부터 새 문서 — 제목은 새 문서 표시명이 된다', () => {
    const docs = splitDocuments(['갑 서비스 이용약관', ...arts(3), '을 쇼핑몰 이용약관', ...arts(3)].join('\n'));
    expect(docs).toHaveLength(2);
    expect(docs.map((d) => d.title)).toEqual(['갑 서비스 이용약관', '을 쇼핑몰 이용약관']);
    expect(docs[1]!.clauses[0]!.articleNo).toBe('제1조');
  });

  it('부칙의 제1조 재시작은 나누지 않는다', () => {
    const docs = splitDocuments(['갑 이용약관', ...arts(5), '부칙', '제1조(시행일) 이 약관은 공포한 날부터 시행한다.', '제2조(경과조치) 종전 가입자에게도 적용한다.'].join('\n'));
    expect(docs).toHaveLength(1);
    expect(docs[0]!.articles.slice(-2).map((a) => a.articleNo)).toEqual(['부칙 제1조', '부칙 제2조']);
  });

  it('조가 3개 미만인 조각은 앞 문서에 붙인다(인용·별지 오검출 방지)', () => {
    const docs = splitDocuments([...arts(4), '별지 계약서', '제1조(서식) 별지 서식을 따른다.'].join('\n'));
    expect(docs).toHaveLength(1);
  });

  it('본문 인용("제1조에 따라")은 재시작이 아니다', () => {
    const docs = splitDocuments([...arts(4), '제1조에 따라 회사는 통지한다.', ...arts(2, 5)].join('\n'));
    expect(docs).toHaveLength(1);
    expect(docs[0]!.articles).toHaveLength(6);
  });

  it('조 번호 없는 문서는 한 문서로 둔다', () => {
    const docs = splitDocuments('이 약관은 회원에게 적용된다.\n\n회사는 서비스를 제공한다.');
    expect(docs).toHaveLength(1);
    expect(docs[0]!.method).toBe('semantic');
  });
});

describe('약관 제목 줄 판정', () => {
  it.each([
    ['가상마켓 쇼핑몰 이용약관', true],
    ['주택임대차 표준계약서', true],
    ['서비스 이용약관 (2026.9.1 개정)', true],
    ['이 약관은 회원에게 적용된다.', false],
    ['제1조(목적) 이 약관은 목적을 정한다', false],
    ['회원은 이 계약', false],
  ])('%s → %s', (line, want) => {
    expect(isTitleLine(line)).toBe(want);
  });
});
