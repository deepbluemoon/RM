// T098·T102 — URL 수집 SSRF 차단 대역과 테스트 전용 통로의 운영 봉쇄
import { afterEach, describe, expect, it } from 'vitest';
import { allowTestTargets, fetchTermsPage, isBlockedAddress, UrlFetchError } from '../../src/modules/intake/urlFetch.js';

describe('차단 대역', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.10', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'not-an-ip',
  ])('%s 는 차단', (ip) => expect(isBlockedAddress(ip)).toBe(true));
  it.each(['8.8.8.8', '211.249.220.24', '172.32.0.1', '2001:4860:4860::8888'])('%s 는 공인 주소', (ip) => expect(isBlockedAddress(ip)).toBe(false));
});

describe('테스트 전용 통로', () => {
  const env = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = env;
  });

  it('NODE_ENV 가 test 가 아니면 등록할 수 없다', () => {
    process.env.NODE_ENV = 'production';
    expect(() => allowTestTargets(['127.0.0.1:8080'])).toThrow();
  });

  it('등록돼 있어도 운영 모드에서는 무시되어 루프백을 막는다(네트워크 호출 없음)', async () => {
    allowTestTargets(['127.0.0.1:8080']);
    process.env.NODE_ENV = 'production';
    const e = await fetchTermsPage('http://127.0.0.1:8080/terms').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(UrlFetchError);
    expect((e as UrlFetchError).reason).toBe('blocked_address');
    expect((e as UrlFetchError).detail).toBe('접근 차단');
  });

  it('URL 안 계정정보·비 http 스킴·허용 외 포트는 막는다', async () => {
    for (const [u, code] of [
      ['http://user:pw@example.com/', 'invalid_url'],
      ['ftp://example.com/terms', 'invalid_url'],
      ['http://93.184.215.14:22/', 'blocked_port'],
      ['not a url', 'invalid_url'],
    ] as const) {
      const e = await fetchTermsPage(u).catch((x: unknown) => x);
      expect((e as UrlFetchError).reason, u).toBe(code);
    }
  });
});
