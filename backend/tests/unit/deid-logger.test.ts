// T109 — 로그 비식별 직렬화기: 문자열 필드·메시지·오류 메시지에 deid 탐지기를 적용하고, 모델 API 오류 본문은 남기지 않는다(FR-009)
import { afterAll, describe, expect, it } from 'vitest';
import { logger, setLoggerDestination } from '../../src/logger.js';
import { ModelApiError } from '../../src/modules/modelApi/client.js';

const lines: string[] = [];
setLoggerDestination({ write: (s: string) => void lines.push(s) }, 'debug');
afterAll(() => setLoggerDestination({ write: () => undefined }, 'silent'));

const out = () => lines.join('');

describe('로그 비식별 직렬화기', () => {
  it('중첩 문자열 필드의 개인정보를 가린다', () => {
    logger.info({ a: { phone: '010-1234-5678', list: ['hong.gildong@example.com'] }, account: '국민은행 123-45-678901' }, 'x');
    expect(out()).not.toContain('010-1234-5678');
    expect(out()).not.toContain('hong.gildong@example.com');
    expect(out()).not.toContain('123-45-678901');
    expect(out()).toContain('〔전화번호〕');
  });

  it('메시지 문자열과 오류 메시지·스택도 가린다', () => {
    logger.warn({ err: new Error('failed for 900101-1234567') }, '연락처 010-9999-8888 처리 실패');
    expect(out()).not.toContain('900101-1234567');
    expect(out()).not.toContain('010-9999-8888');
  });

  it('모델 API 오류는 종류·상태·엔드포인트만 — 응답 본문 필드는 버린다', () => {
    const e = new ModelApiError('other', 500, '/v1/judge') as ModelApiError & { body?: unknown; responseBody?: unknown };
    e.body = { detail: '임차인 성명: 홍길동 원문' };
    e.responseBody = '임차인 성명: 홍길동 원문';
    logger.error({ err: e, responseBody: 'raw 홍길동', body: 'raw' }, 'model call failed');
    const text = out();
    expect(text).not.toContain('홍길동');
    expect(text).toContain('/v1/judge');
  });

  it('성명 표지 뒤 이름은 로그에서도 가린다', () => {
    logger.info({ note: '임차인 성명: 김민준' }, 'n');
    expect(out()).not.toContain('김민준');
  });
});
