// T059 — 조·항·호 계층, 조 3개 미만이면 의미 단위, 위치 보존, 표본 조 구조 일치율 95% 이상(SC-006)
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { splitClauses, joinWrappedLines } from '../../src/modules/structuring/splitter.js';
import { classifyContract } from '../../src/modules/structuring/classifier.js';
import { extractPdf } from '../../src/modules/extract/pdfText.js';
import { fixture } from '../integration/setup.js';

describe('조항 분할', () => {
  it('조·항·호 계층을 읽는다', () => {
    const text = [
      '제1조(목적) 이 약관은 목적을 정한다.',
      '제2조(정의)',
      '① "회원"이란 가입한 자를 말한다.',
      '② "회사"란 다음 각 호를 말한다.',
      '1. 서비스를 제공하는 자',
      '2. 그 대리인',
      '제3조(효력) 이 약관은 게시한 날부터 효력이 생긴다.',
    ].join('\n');
    const r = splitClauses(text);
    expect(r.method).toBe('article');
    expect(r.articles.map((a) => a.articleNo)).toEqual(['제1조', '제2조', '제3조']);
    expect(r.articles[1]!.paragraphs.map((p) => p.paragraphNo)).toEqual(['①', '②']);
    expect(r.articles[1]!.paragraphs[1]!.items.map((i) => i.itemNo)).toEqual(['1', '2']);
    expect(r.clauses.map((c) => [c.seq, c.articleNo, c.paragraphNo])).toEqual([
      [1, '제1조', null],
      [2, '제2조', '①'],
      [3, '제2조', '②'],
      [4, '제3조', null],
    ]);
    expect(r.clauses[2]!.text).toContain('1. 서비스를 제공하는 자');
    expect(r.clauses[0]!.title).toBe('목적');
  });

  it('본문 속 조 인용은 조 머리말로 보지 않는다', () => {
    const r = splitClauses('제1조(가) 가.\n제2조(나) 제1조에 따라 처리한다.\n제3조(다) 다.\n제4조(라) 라.');
    expect(r.articles).toHaveLength(4);
  });

  it('조 번호가 3개 미만이면 의미 단위로 나눈다', () => {
    const r = splitClauses('서비스 이용 안내\n\n회원은 매월 이용료를 낸다. 해지는 언제든 가능하다.\n\n1. 환불은 7일 이내에 신청한다\n2. 위약금은 없다');
    expect(r.method).toBe('semantic');
    expect(r.clauses.length).toBeGreaterThanOrEqual(2);
    expect(r.clauses.every((c) => c.articleNo === null)).toBe(true);
  });

  it('PDF 줄바꿈으로 끊긴 문장을 잇는다', () => {
    expect(joinWrappedLines('제1조(목적) 이 약관은\n서비스 이용을 정한다.')).toEqual(['제1조(목적) 이 약관은 서비스 이용을 정한다.']);
  });

  it('부칙의 조는 같은 문서에 "부칙 제N조"로 둔다', () => {
    const r = splitClauses('제1조(가) 가.\n제2조(나) 나.\n제3조(다) 다.\n부칙\n제1조(시행일) 이 약관은 공포한 날부터 시행한다.');
    expect(r.articles.map((a) => a.articleNo)).toEqual(['제1조', '제2조', '제3조', '부칙 제1조']);
  });

  it('표본 PDF 조 구조 일치율 95% 이상(SC-006)', async () => {
    const labels = JSON.parse(fs.readFileSync(fixture('contracts/subscription-sample.labels.json'), 'utf8'));
    const pdf = await extractPdf(fs.readFileSync(fixture('contracts/subscription-sample.pdf')));
    const r = splitClauses(pdf.pages.map((p) => p.text).join('\n'));
    const expected = Array.from({ length: labels.articleCount }, (_, i) => `제${i + 1}조`);
    const got = new Set(r.articles.map((a) => a.articleNo));
    const matched = expected.filter((a) => got.has(a)).length;
    expect(matched / expected.length).toBeGreaterThanOrEqual(0.95);
    expect(r.articles.length).toBe(labels.articleCount);
    // 원문 위치(순서) 보존
    expect(r.clauses.map((c) => c.seq)).toEqual(r.clauses.map((_, i) => i + 1));
  });

  it('계약서 판별 — 약관은 계약서, 영수증은 아님', async () => {
    const pdf = await extractPdf(fs.readFileSync(fixture('non-contract/receipt.pdf')));
    expect(classifyContract(pdf.pages.map((p) => p.text).join('\n')).isContract).toBe(false);
    expect(classifyContract(fs.readFileSync(fixture('contracts/subscription-sample.txt'), 'utf8')).isContract).toBe(true);
  });
});
