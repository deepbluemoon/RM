// URL 본문 수집(T102, P1 1.4, FR-004, UC1 A1·E4, research R-05): 공개 약관 게시 페이지만 가져온다.
// - http/https, 포트 80·443·8080·8443, URL 안 계정정보 금지
// - 매 홉마다 DNS 를 해석해 사설·루프백·링크로컬·예약 대역이면 막고(SSRF), 검사한 주소로만 연결한다(재해석 우회 방지)
// - 리다이렉트 5회, 전체 10초, 본문 2MB(압축 해제 후), text/html 만
// - 401·로그인 폼 → "로그인이 필요한 페이지", 403·차단 주소·연결 실패 → "접근 차단", 비 HTML·본문 부족 → "본문 없음" (G3, SD_02 §14-2)
// 수집 본문은 비식별화 전 원문이므로 로그·DB 에 쓰지 않는다(CLAUDE.md)
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import type { Readable } from 'node:stream';
import { htmlToText, decodeHtml } from '../extract/html.js';
import { countArticles } from '../structuring/splitter.js';

export const URL_MAX_REDIRECTS = 5;
export const URL_TIMEOUT_MS = 10_000;
export const URL_MAX_BYTES = 2 * 1024 * 1024;
/** 본문이 이보다 짧으면 "본문 없음" [가정] */
export const URL_MIN_BODY_CHARS = 200;
const ALLOWED_PORTS = new Set([80, 443, 8080, 8443]);

export type G3Kind = 'login' | 'blocked' | 'empty';
export const G3_DETAIL: Record<G3Kind, string> = {
  login: '로그인이 필요한 페이지',
  blocked: '접근 차단',
  empty: '본문 없음',
};

export class UrlFetchError extends Error {
  constructor(
    /** gate_event.reason_code */
    public readonly reason: string,
    public readonly kind: G3Kind,
  ) {
    super(`url fetch ${reason}`);
    this.name = 'UrlFetchError';
  }
  get detail(): string {
    return G3_DETAIL[this.kind];
  }
}

// ------------------------------------------------------------------ SSRF 차단 대역
const blocked = new net.BlockList();
for (const [a, p] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(a, p, 'ipv4');
for (const [a, p] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) blocked.addSubnet(a, p, 'ipv6');

/** 공인 주소가 아니면 true. IPv4 사상 IPv6(::ffff:a.b.c.d)는 IPv4 로 본다 */
export function isBlockedAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return isBlockedAddress(mapped[1]!);
  const fam = net.isIP(ip);
  if (fam === 4) return blocked.check(ip, 'ipv4');
  if (fam === 6) return blocked.check(ip, 'ipv6') || /^::ffff:/i.test(ip);
  return true;
}

// ------------------------------------------------------------------ 테스트 전용 통로
// 통합 테스트는 127.0.0.1 의 임시 HTTP 서버로 페이지를 준다. NODE_ENV==='test' 일 때만, 지정한 "주소:포트" 쌍만 허용한다.
// 운영(NODE_ENV!=='test')에서는 등록 자체가 실패하고, 등록돼 있어도 무시된다.
const testTargets = new Set<string>();
export function allowTestTargets(targets: string[]): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('allowTestTargets is test-only');
  testTargets.clear();
  for (const t of targets) testTargets.add(t);
}
const testAllowed = (ip: string, port: number) => process.env.NODE_ENV === 'test' && testTargets.has(`${ip}:${port}`);

interface Target {
  url: URL;
  address: string;
  family: 4 | 6;
  port: number;
}

/** 한 홉의 URL 검사 + DNS 해석. 해석된 주소 중 하나라도 차단 대역이면 거부한다 */
async function resolveTarget(url: URL): Promise<Target> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UrlFetchError('invalid_url', 'blocked');
  if (url.username || url.password) throw new UrlFetchError('invalid_url', 'blocked');
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addrs: { address: string; family: number }[];
  if (net.isIP(host)) addrs = [{ address: host, family: net.isIP(host) }];
  else {
    try {
      addrs = await dns.lookup(host, { all: true, verbatim: true });
    } catch {
      throw new UrlFetchError('dns_failed', 'blocked');
    }
  }
  if (!addrs.length) throw new UrlFetchError('dns_failed', 'blocked');
  const first = addrs[0]!;
  if (addrs.every((a) => testAllowed(a.address, port))) return { url, address: first.address, family: first.family as 4 | 6, port };
  if (!ALLOWED_PORTS.has(port)) throw new UrlFetchError('blocked_port', 'blocked');
  if (addrs.some((a) => isBlockedAddress(a.address))) throw new UrlFetchError('blocked_address', 'blocked');
  return { url, address: first.address, family: first.family as 4 | 6, port };
}

interface HopResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Readable;
  res: http.IncomingMessage;
}

/** 검사한 주소로만 연결한다 — lookup 을 고정해 연결 시점 재해석(DNS rebinding)을 막는다 */
function request(t: Target, signal: AbortSignal): Promise<HopResult> {
  const lib = t.url.protocol === 'https:' ? https : http;
  const lookup = ((_h: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) => {
    if (opts?.all) cb(null, [{ address: t.address, family: t.family }]);
    else cb(null, t.address, t.family);
  }) as unknown as net.LookupFunction;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        protocol: t.url.protocol,
        hostname: t.url.hostname.replace(/^\[|\]$/g, ''),
        port: t.port,
        path: `${t.url.pathname}${t.url.search}`,
        method: 'GET',
        lookup,
        signal,
        agent: false,
        headers: {
          'user-agent': 'CRD-TermsFetcher/1.0 (+contract risk detection; terms page fetch)',
          accept: 'text/html,application/xhtml+xml;q=0.9',
          'accept-encoding': 'gzip, deflate, br',
          'accept-language': 'ko,en;q=0.5',
        },
      },
      (res) => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: res, res }),
    );
    req.on('error', reject);
    req.end();
  });
}

async function readCapped(hop: HopResult): Promise<Buffer> {
  const declared = Number(hop.headers['content-length'] ?? NaN);
  if (Number.isFinite(declared) && declared > URL_MAX_BYTES) {
    hop.res.destroy();
    throw new UrlFetchError('too_large', 'empty');
  }
  const enc = String(hop.headers['content-encoding'] ?? '').toLowerCase().trim();
  let stream: Readable = hop.body;
  if (enc === 'gzip' || enc === 'x-gzip') stream = hop.body.pipe(zlib.createGunzip());
  else if (enc === 'deflate') stream = hop.body.pipe(zlib.createInflate());
  else if (enc === 'br') stream = hop.body.pipe(zlib.createBrotliDecompress());
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of stream) {
    size += (c as Buffer).length;
    // 압축 해제 후 크기로 센다(압축 폭탄 방지)
    if (size > URL_MAX_BYTES) {
      hop.res.destroy();
      throw new UrlFetchError('too_large', 'empty');
    }
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

export interface FetchedPage {
  /** 사용자가 입력한 원본 URL(정규화) — document.source_url */
  sourceUrl: string;
  /** 리다이렉트 후 실제로 본문을 받은 URL */
  finalUrl: string;
  /** 수집 시각(ISO) — document.collected_at */
  collectedAt: string;
  title: string | null;
  /** 비식별화 전 본문 — 메모리에서만 다룬다 */
  text: string;
}

export async function fetchTermsPage(input: string): Promise<FetchedPage> {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new UrlFetchError('invalid_url', 'blocked');
  }
  const sourceUrl = url.toString();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), URL_TIMEOUT_MS);
  try {
    for (let hop = 0; ; hop++) {
      const target = await resolveTarget(url);
      let r: HopResult;
      try {
        r = await request(target, ac.signal);
      } catch {
        throw new UrlFetchError(ac.signal.aborted ? 'timeout' : 'fetch_failed', 'blocked');
      }
      if (r.status >= 300 && r.status < 400 && r.headers.location) {
        r.res.resume();
        if (hop >= URL_MAX_REDIRECTS) throw new UrlFetchError('too_many_redirects', 'blocked');
        try {
          url = new URL(r.headers.location, url);
        } catch {
          throw new UrlFetchError('invalid_redirect', 'blocked');
        }
        continue;
      }
      if (r.status === 401) {
        r.res.resume();
        throw new UrlFetchError('http_401', 'login');
      }
      if (r.status === 403) {
        r.res.resume();
        throw new UrlFetchError('http_403', 'blocked');
      }
      if (r.status < 200 || r.status >= 300) {
        r.res.resume();
        throw new UrlFetchError(`http_${r.status}`.slice(0, 40), 'empty');
      }
      const ctype = String(r.headers['content-type'] ?? '').toLowerCase();
      if (!/^(text\/html|application\/xhtml\+xml)\b/.test(ctype)) {
        r.res.resume();
        throw new UrlFetchError('not_html', 'empty');
      }
      let raw: Buffer;
      try {
        raw = await readCapped(r);
      } catch (e) {
        if (e instanceof UrlFetchError) throw e;
        throw new UrlFetchError(ac.signal.aborted ? 'timeout' : 'fetch_failed', 'blocked');
      }
      const charset = /charset\s*=\s*"?([\w-]+)/.exec(ctype)?.[1] ?? null;
      const page = await htmlToText(decodeHtml(raw, charset), url.toString());
      const compact = page.text.replace(/\s+/g, '');
      // 비밀번호 입력란이 있고 조 구조가 없으면 로그인 화면으로 본다(머리의 로그인 상자만 있는 약관 페이지는 통과)
      if (page.hasPasswordField && countArticles(page.text) < 3) throw new UrlFetchError('login_form', 'login');
      if (compact.length < URL_MIN_BODY_CHARS) throw new UrlFetchError('body_too_short', 'empty');
      return { sourceUrl, finalUrl: url.toString(), collectedAt: new Date().toISOString(), title: page.title, text: page.text };
    }
  } finally {
    clearTimeout(timer);
    if (!ac.signal.aborted) ac.abort();
  }
}
