// 외부 이용자 시뮬레이션 — 가상의 외부 업체(유클마켓)가 자기 회원가입 화면에 계약위험탐지 API 를 붙인 상황.
// 실제 외부 업체처럼 "자기 서버"가 발급 키(crd_…)를 들고 공개 주소(https://p2.sumzip.com/api/model)를 부른다.
//  - 우리 API 에는 CORS 가 없다 → 브라우저가 직접 부르지 않고 이 서버의 /partner-api/* 를 거친다
//  - 키는 이 서버만 안다: 환경변수 CRD_API_KEY 또는 이 폴더의 .env(CRD_API_KEY=crd_CkyEnu_6CZaC2zaZvkfexNYuj963PCV0). 브라우저로는 보내지도 받지도 않는다
//  - 요청·응답 본문은 기록하지 않는다(로그 = 경로·코드·지연)
// 실행: node tools/external-api-demo/server.mjs   (Node 20, 의존성 없음)
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DEMO_PORT || 9596);
const BASE = (process.env.CRD_API_BASE || 'https://p2.sumzip.com/api/model').replace(/\/$/, '');
// .env(선택) — 이미 있는 환경변수가 우선. 값은 출력하지 않는다
try {
  for (const line of (await fs.readFile(path.join(HERE, '.env'), 'utf8')).split('\n')) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
} catch {}
const API_KEY = (process.env.CRD_API_KEY || '').trim();
// 발급 키 형식 = crd_ + 영문·숫자·-_ (공개 API 와 같은 규칙). 안내문의 「crd_…」를 그대로 붙여 넣은 경우 등을 기동 때 바로 알린다
const KEY_OK = /^crd_[A-Za-z0-9_-]{20,64}$/.test(API_KEY);

// 공개 API 가 받는 경로만 넘긴다(그 밖은 우리 쪽에서 404)
const ALLOWED = [
  ['GET', /^\/health$/],
  ['GET', /^\/v1\/models$/],
  ['POST', /^\/v1\/detect\/(loophole|illegal)$/],
  ['POST', /^\/v1\/jobs$/],
  ['GET', /^\/v1\/jobs\/[A-Za-z0-9_-]{1,64}$/],
  ['POST', /^\/v1\/judge$/],
  ['POST', /^\/v1\/summarize$/],
];

const send = (res, status, obj, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(obj));
};

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 3 * 1024 * 1024) throw new Error('too_large');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function proxy(req, res, apiPath) {
  const method = req.method;
  if (!ALLOWED.some(([m, re]) => m === method && re.test(apiPath))) {
    return send(res, 404, { code: 'demo_path_not_allowed', message: '데모 서버가 넘기지 않는 경로입니다' });
  }
  if (!API_KEY) {
    return send(res, 503, { code: 'demo_key_missing', message: '업체 서버에 API 키(CRD_API_KEY)가 설정되지 않았습니다' });
  }
  if (!KEY_OK) {
    return send(res, 503, { code: 'demo_key_malformed', message: 'CRD_API_KEY 형식이 발급 키(crd_ + 영문·숫자)와 다릅니다 — 안내문의 「…」 등이 섞였는지 확인하세요' });
  }
  const headers = { accept: 'application/json', authorization: `Bearer ${API_KEY}` };
  if (req.headers['x-request-id']) headers['x-request-id'] = String(req.headers['x-request-id']);
  let body;
  if (method === 'POST') {
    try {
      body = await readBody(req);
    } catch {
      return send(res, 413, { code: 'demo_body_too_large', message: '본문은 3MB 까지입니다(공개 API 한도와 같음)' });
    }
    headers['content-type'] = 'application/json';
  }
  const t0 = performance.now();
  try {
    const r = await fetch(BASE + apiPath, { method, headers, body, signal: AbortSignal.timeout(330_000) });
    const text = await r.text();
    const ms = Math.round(performance.now() - t0);
    res.writeHead(r.status, {
      'content-type': r.headers.get('content-type') || 'application/json',
      'x-upstream-ms': String(ms),
      'x-upstream-request-id': r.headers.get('x-request-id') || '',
      'x-upstream-ratelimit': r.headers.get('ratelimit') || '', // draft-7: limit=60, remaining=…, reset=…
    });
    res.end(text);
    console.log(`${new Date().toISOString()} ${method} ${apiPath} → ${r.status} ${ms}ms`); // 경로·코드만
  } catch (e) {
    const timeout = e?.name === 'TimeoutError';
    send(res, timeout ? 504 : 502, {
      code: timeout ? 'demo_upstream_timeout' : 'demo_upstream_unreachable',
      message: timeout ? 'API 응답이 330초 안에 오지 않았습니다' : `API 서버(${BASE})에 연결할 수 없습니다`,
    });
  }
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/demo-config') {
      return send(res, 200, { apiBase: BASE, keyConfigured: Boolean(API_KEY), keyFormatOk: KEY_OK });
    }
    if (url.pathname.startsWith('/partner-api/')) {
      return proxy(req, res, url.pathname.slice('/partner-api'.length) + (url.search || ''));
    }
    const file = url.pathname === '/' ? 'index.html' : url.pathname === '/developers' ? 'developers.html' : url.pathname.slice(1);
    if (!/^[A-Za-z0-9_.-]+$/.test(file)) return send(res, 404, { code: 'not_found' });
    try {
      const data = await fs.readFile(path.join(HERE, 'public', file));
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(data);
    } catch {
      send(res, 404, { code: 'not_found' });
    }
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`파트너 데모: http://127.0.0.1:${PORT}  →  API ${BASE}  (API 키: ${!API_KEY ? '없음 — 실행 방법은 tools/external-api-demo/README.md (코드 파일에는 넣지 않음)' : KEY_OK ? '설정됨' : `형식 오류 — crd_ 뒤에 영문·숫자만 와야 합니다(지금 ${API_KEY.length}자, 「…」·한글·공백 등 포함). 발급받은 키를 그대로 붙여 넣으세요`})`);
  });
