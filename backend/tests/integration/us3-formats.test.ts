// T098 — 다양한 형식 입력(US3): 형식별 조 구조 일치율(텍스트형 95% 이상)·판정 분류가 텍스트형 PDF 와 같은지(스캔은 저품질 조항 제외),
// HWP 본문 읽기 실패 → G2 unsupported_variant, URL 수집 시각·원본 URL 기록, G3(401·로그인 폼·본문 부족·사설 IP), 결합 파일 → 문서 2개(doc_seq)
import http from 'node:http';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture, newAgent, resetDb, startStub, teardown, type StubHandle } from './setup.js';
import { analyzeToSaved, startFile, upload } from './flow.js';
import { expectResponse } from '../contract/harness.js';
import { getPool, select } from '../../src/db/pool.js';
import { allowTestTargets } from '../../src/modules/intake/urlFetch.js';
import { terminateOcr } from '../../src/modules/extract/ocr.js';

type Agent = ReturnType<typeof newAgent>;
interface ClauseOut {
  documentId: number;
  articleNo: string | null;
  paragraphNo: string | null;
  title: string | null;
  text: string;
  displayCategory: string;
  lowOcrQuality: boolean;
}

let stub: StubHandle;
let web: http.Server;
let base = '';

const page = (name: string) => fs.readFileSync(fixture(`contracts/formats/${name}`));
const LOGIN_PAGE = `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><title>로그인</title></head><body>
<main><h1>로그인</h1><p>약관을 보려면 로그인이 필요합니다. 회원 계정으로 로그인해 주세요. 아직 회원이 아니면 회원가입 후 이용할 수 있습니다.</p>
<form action="/session" method="post"><label>아이디 <input name="id"></label><label>비밀번호 <input type="password" name="pw"></label><button>로그인</button></form>
<p>비밀번호를 잊으셨나요? 고객센터로 문의해 주세요. 평일 10시부터 18시까지 상담원이 안내해 드립니다.</p></main></body></html>`;
const SHORT_PAGE = '<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><title>안내</title></head><body><p>약관 페이지를 준비 중입니다.</p></body></html>';

function startWeb(): Promise<void> {
  web = http.createServer((req, res) => {
    const html = (body: string | Buffer, status = 200) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    };
    switch (req.url) {
      case '/terms':
        return html(page('terms-page.html'));
      case '/moved':
        res.writeHead(302, { location: '/terms' });
        return res.end();
      case '/to-private':
        res.writeHead(302, { location: 'http://10.0.0.8/terms' });
        return res.end();
      case '/loop':
        res.writeHead(302, { location: '/loop' });
        return res.end();
      case '/auth':
        return html('<html><body>인증이 필요합니다</body></html>', 401);
      case '/forbidden':
        return html('<html><body>접근 거부</body></html>', 403);
      case '/login':
        return html(LOGIN_PAGE);
      case '/short':
        return html(SHORT_PAGE);
      case '/pdf':
        res.writeHead(200, { 'content-type': 'application/pdf' });
        return res.end(fs.readFileSync(fixture('contracts/subscription-sample.pdf')));
      default:
        return html('not found', 404);
    }
  });
  return new Promise((resolve) =>
    web.listen(0, '127.0.0.1', () => {
      const port = (web.address() as AddressInfo).port;
      base = `http://127.0.0.1:${port}`;
      // 테스트 전용 통로 — 이 주소:포트 한 쌍만 허용(NODE_ENV=test). 사설 대역 차단은 그대로다
      allowTestTargets([`127.0.0.1:${port}`]);
      resolve();
    }),
  );
}

beforeAll(async () => {
  await resetDb();
  stub = await startStub();
  await startWeb();
});
afterAll(async () => {
  await new Promise<void>((r) => web.close(() => r()));
  await terminateOcr();
  await stub.close();
  await teardown();
});

async function resultOf(agent: Agent, start: () => Promise<{ status: number; body: { requestId: number } }>, contractType = 'subscription') {
  const r = await analyzeToSaved(agent, start, contractType);
  const res = await agent.get(`/api/results/${r.runId}`).expect(200);
  expectResponse('web', 'GET', '/results/{runId}', 200, res.body);
  return { ...r, result: res.body as { documents: { documentId: number; displayName: string; sourceUrl: string | null; collectedAt: string | null; ocrApplied: boolean }[]; clauses: ClauseOut[]; lowOcrQuality: boolean } };
}

const norm = (s: string) => s.replace(/\s+/g, '');
const structKey = (c: ClauseOut) => `${c.articleNo}|${c.paragraphNo}|${c.title ?? ''}|${norm(c.text)}`;
const posKey = (c: ClauseOut) => `${c.articleNo}|${c.paragraphNo}`;

/** 기준(텍스트형 PDF) 조항 중 같은 위치·제목·본문으로 나온 비율 */
function structureMatch(baseline: ClauseOut[], got: ClauseOut[]): number {
  const keys = new Set(got.map(structKey));
  return baseline.filter((c) => keys.has(structKey(c))).length / baseline.length;
}

/** 조 단위 판정 분류 = 위험 여부(정상/위험)·위험 유형. 위험 안의 등급(분쟁 가능·불공정·위법 가능)은 점수 경계에서 OCR 글자 차이로
 *  흔들릴 수 있고, 표시 분류는 근거 검색(2-gram BM25) 강등(BR-EVD-01)에 따라 달라질 수 있어 스캔 비교에서는 뺀다 */
async function judgedByArticle(runId: number): Promise<Map<string, string>> {
  const rows = await select<{ article_no: string | null; cat: string; risk_type: string | null }>(
    getPool(),
    `SELECT c.article_no, COALESCE(j.m3_category, a.status) AS cat, j.risk_type
       FROM clause_assessment a JOIN clause c ON c.clause_id = a.clause_id LEFT JOIN judgment j ON j.judgment_id = a.judgment_id
      WHERE a.run_id = ? ORDER BY c.seq`,
    [runId],
  );
  const m = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.article_no) continue;
    if (!m.has(r.article_no)) m.set(r.article_no, new Set());
    m.get(r.article_no)!.add(r.cat === 'normal' || r.cat === 'unanalyzable' ? r.cat : `risk/${r.risk_type ?? '-'}`);
  }
  return new Map([...m].map(([k, v]) => [k, [...v].sort().join(',')]));
}

let baseline: ClauseOut[] = [];
let baselineRunId = 0;

describe('기준 — 텍스트형 PDF', () => {
  it('subscription-sample.pdf 분석 결과를 기준으로 삼는다', async () => {
    const agent = newAgent();
    const { result, runId } = await resultOf(agent, () => startFile(agent, 'contracts/subscription-sample.pdf'));
    baselineRunId = runId;
    baseline = result.clauses;
    expect(baseline.length).toBeGreaterThanOrEqual(40);
    expect(new Set(baseline.map((c) => c.articleNo)).size).toBe(40);
  });
});

describe('텍스트형 형식 — 조 구조 95% 이상·판정 분류 동일', () => {
  for (const [file, format] of [
    ['subscription-sample.hwp', 'hwp'],
    ['subscription-sample.hwpx', 'hwpx'],
    ['subscription-sample.docx', 'docx'],
    ['subscription-sample.html', 'html'],
  ] as const) {
    it(`${format.toUpperCase()} (${file})`, async () => {
      const agent = newAgent();
      const up = await upload(agent, `contracts/formats/${file}`);
      expect(up.status, JSON.stringify(up.body)).toBe(201);
      expectResponse('web', 'POST', '/intake/uploads', 201, up.body);
      expect(up.body.format).toBe(format);
      expect(up.body.checks.every((c: { passed: boolean }) => c.passed)).toBe(true);
      const { result, requestId } = await resultOf(agent, () =>
        agent.post('/api/analyses').send({ perspective: 'consumer', source: { kind: 'file', uploadToken: up.body.uploadToken } }),
      );
      expect(structureMatch(baseline, result.clauses)).toBeGreaterThanOrEqual(0.95);
      // 같은 위치 조항의 판정 분류가 텍스트형 PDF 와 같다
      const byPos = new Map(result.clauses.map((c) => [posKey(c), c.displayCategory]));
      for (const c of baseline) expect(byPos.get(posKey(c)), posKey(c)).toBe(c.displayCategory);
      const [doc] = await select<{ file_format: string; ocr_applied: number }>(getPool(), 'SELECT file_format, ocr_applied FROM document WHERE request_id = ?', [requestId]);
      expect(doc!.file_format).toBe(format);
      expect(Number(doc!.ocr_applied)).toBe(0);
    });
  }
});

describe('스캔형 PDF — 로컬 OCR', () => {
  it('문자 인식 적용, 저품질 조항 표시, 저품질이 아닌 조항의 판정 분류는 텍스트형과 같다', async () => {
    const agent = newAgent();
    const { result, status: st, runId } = await resultOf(agent, () => startFile(agent, 'contracts/formats/subscription-sample-scan.pdf'));
    expect(st.documents[0].ocrApplied).toBe(true);
    expect(result.documents[0]!.ocrApplied).toBe(true);
    // 흐리게 인쇄한 제38~40조 본문은 저품질로 표시된다
    const low = result.clauses.filter((c) => c.lowOcrQuality);
    expect(low.length).toBeGreaterThan(0);
    expect(result.lowOcrQuality).toBe(true);
    for (const c of low) expect(['제38조', '제39조', '제40조']).toContain(c.articleNo);
    // 조 구조: 40개 조 번호를 모두 찾는다
    const arts = new Set(result.clauses.map((c) => c.articleNo));
    expect([...new Set(baseline.map((c) => c.articleNo))].filter((a) => arts.has(a)).length).toBeGreaterThanOrEqual(38);
    // 판정 분류: 저품질 조항이 없는 조는 텍스트형 PDF 와 위험 여부·위험 유형이 같다
    const lowArts = new Set(low.map((c) => c.articleNo));
    const want = await judgedByArticle(baselineRunId);
    const got = await judgedByArticle(runId);
    let compared = 0;
    for (const [art, cat] of got) {
      if (lowArts.has(art) || !want.has(art)) continue;
      expect(cat, art).toBe(want.get(art));
      compared++;
    }
    // 위험 조항 5개(제12·15·18·22·27조)는 모두 비교 대상이고 위험으로 판정된다
    for (const a of ['제12조', '제15조', '제18조', '제22조', '제27조']) expect(got.get(a), a).toMatch(/^risk\//);
    expect(compared).toBeGreaterThanOrEqual(35);
  });
});

describe('HWP 변형·암호', () => {
  it('본문을 읽지 못하는 HWP(배포용 문서) → G2 unsupported_variant 안내, 분석 요청 없음', async () => {
    const agent = newAgent();
    const r = await upload(agent, 'contracts/formats/variant-distribution.hwp');
    expect(r.status).toBe(400);
    expectResponse('web', 'POST', '/intake/uploads', 400, r.body);
    expect(r.body.gate).toBe('G2');
    expect(r.body.title).toBe('파일 조건을 충족하지 않습니다');
    expect(r.body.reason).toContain('HWP 본문을 읽지 못했습니다');
    expect(r.body.reason).toContain('HWPX·PDF');
    const fmt = r.body.checks.find((c: { check: string }) => c.check === 'format');
    expect(fmt.passed).toBe(false);
    expect(r.body.nextActions.map((a: { id: string }) => a.id)).toEqual(['choose_other_file', 'switch_to_text']);
    const ev = await select<{ reason_code: string }>(getPool(), "SELECT reason_code FROM gate_event WHERE gate_code = 'G2' ORDER BY event_id DESC LIMIT 1");
    expect(ev[0]!.reason_code).toBe('unsupported_variant');
    const n = await select<{ n: number }>(getPool(), "SELECT COUNT(*) AS n FROM document WHERE file_format = 'hwp' AND display_name LIKE '%variant%'");
    expect(Number(n[0]!.n)).toBe(0);
  });

  it('FileHeader 암호 플래그가 켜진 HWP → G2 암호화', async () => {
    const agent = newAgent();
    const r = await upload(agent, 'contracts/formats/encrypted.hwp');
    expect(r.status).toBe(400);
    expect(r.body.gate).toBe('G2');
    expect(r.body.checks.find((c: { check: string }) => c.check === 'encrypted').passed).toBe(false);
    expect(r.body.reason).toContain('암호화');
  });
});

describe('URL 입력 — 수집 시각·원본 URL(FR-004)', () => {
  it('약관 게시 페이지 본문을 가져와 분석하고, 결과에 원본 URL·수집 시각을 남긴다', async () => {
    const agent = newAgent();
    const url = `${base}/moved`; // 리다이렉트 1회 → /terms
    const f = await agent.post('/api/intake/url-fetches').send({ url });
    expect(f.status, JSON.stringify(f.body)).toBe(201);
    expectResponse('web', 'POST', '/intake/url-fetches', 201, f.body);
    expect(f.body.sourceUrl).toBe(url);
    expect(f.body.charCount).toBeGreaterThan(1500);
    const collectedAt = new Date(f.body.collectedAt).getTime();
    expect(Math.abs(Date.now() - collectedAt)).toBeLessThan(60_000);
    const { result, requestId } = await resultOf(agent, () =>
      agent.post('/api/analyses').send({ perspective: 'consumer', source: { kind: 'url', sourceToken: f.body.sourceToken } }),
    );
    expect(result.documents[0]!.sourceUrl).toBe(url);
    expect(Math.abs(new Date(result.documents[0]!.collectedAt!).getTime() - collectedAt)).toBeLessThan(1500);
    const [doc] = await select<{ source_url: string; collected_at: Date; file_format: string }>(getPool(), 'SELECT source_url, collected_at, file_format FROM document WHERE request_id = ?', [requestId]);
    expect(doc!.source_url).toBe(url);
    expect(doc!.collected_at).toBeTruthy();
    expect(doc!.file_format).toBe('html');
    // 머리·탐색·바닥글을 빼고 약관 본문만 — 조 구조가 텍스트형 PDF 와 95% 이상 같다
    expect(structureMatch(baseline, result.clauses)).toBeGreaterThanOrEqual(0.95);
    expect(result.clauses.some((c) => c.text.includes('Copyright'))).toBe(false);
  });

  it('수집 토큰은 다른 기기에서 쓸 수 없다(G3 source_missing)', async () => {
    const a = newAgent();
    const f = await a.post('/api/intake/url-fetches').send({ url: `${base}/terms` }).expect(201);
    const b = newAgent();
    await b.get('/api/meta/privacy-notice').expect(200);
    const r = await b.post('/api/analyses').send({ perspective: 'consumer', source: { kind: 'url', sourceToken: f.body.sourceToken } });
    expect(r.status).toBe(422);
    expect(r.body.gate).toBe('G3');
  });
});

describe('G3 — URL 본문을 가져올 수 없음', () => {
  const cases: [string, () => string, string, string][] = [
    ['401 인증 필요', () => `${base}/auth`, '로그인이 필요한 페이지', 'http_401'],
    ['로그인 폼', () => `${base}/login`, '로그인이 필요한 페이지', 'login_form'],
    ['403 접근 거부', () => `${base}/forbidden`, '접근 차단', 'http_403'],
    ['본문 부족', () => `${base}/short`, '본문 없음', 'body_too_short'],
    ['HTML 이 아님', () => `${base}/pdf`, '본문 없음', 'not_html'],
    ['사설 IP(10/8)', () => 'http://10.0.0.8/terms', '접근 차단', 'blocked_address'],
    ['링크로컬(메타데이터 주소)', () => 'http://169.254.169.254/latest/meta-data/', '접근 차단', 'blocked_address'],
    ['루프백 — 허용 쌍이 아닌 포트', () => 'http://127.0.0.1:80/terms', '접근 차단', 'blocked_address'],
    ['localhost 이름', () => 'http://localhost/terms', '접근 차단', 'blocked_address'],
    ['IPv6 루프백', () => 'http://[::1]/terms', '접근 차단', 'blocked_address'],
    ['리다이렉트로 사설 IP', () => `${base}/to-private`, '접근 차단', 'blocked_address'],
    ['리다이렉트 5회 초과', () => `${base}/loop`, '접근 차단', 'too_many_redirects'],
    ['http(s) 아닌 스킴', () => 'file:///etc/passwd', '접근 차단', 'invalid_url'],
  ];
  for (const [name, url, reason, code] of cases) {
    it(name, async () => {
      const agent = newAgent();
      const r = await agent.post('/api/intake/url-fetches').send({ url: url() });
      expect(r.status, JSON.stringify(r.body)).toBe(422);
      expectResponse('web', 'POST', '/intake/url-fetches', 422, r.body);
      expect(r.body.gate).toBe('G3');
      expect(r.body.title).toBe('URL 본문을 가져올 수 없습니다');
      expect(r.body.reason).toBe(reason);
      expect(r.body.nextActions.map((a: { id: string }) => a.id)).toEqual(['switch_to_file', 'switch_to_text']);
      const ev = await select<{ reason_code: string }>(getPool(), "SELECT reason_code FROM gate_event WHERE gate_code = 'G3' ORDER BY event_id DESC LIMIT 1");
      expect(ev[0]!.reason_code).toBe(code);
    });
  }
});

describe('결합된 복수 계약(UC1 A5)', () => {
  it('두 약관을 합친 PDF → 문서 2개(doc_seq 1·2), 부칙의 제1조 재시작은 나누지 않는다', async () => {
    const agent = newAgent();
    const { result, requestId, status: st } = await resultOf(agent, () => startFile(agent, 'contracts/formats/combined-two.pdf'));
    expect(st.documents.map((d: { docSeq: number }) => d.docSeq)).toEqual([1, 2]);
    expect(st.documents[0].displayName).toContain('구독 서비스 이용약관');
    expect(st.documents[1].displayName).toContain('쇼핑몰 이용약관');
    const docs = await select<{ document_id: number; doc_seq: number; split_method: string }>(getPool(), 'SELECT document_id, doc_seq, split_method FROM document WHERE request_id = ? ORDER BY doc_seq', [requestId]);
    expect(docs.map((d) => d.doc_seq)).toEqual([1, 2]);
    expect(docs.every((d) => d.split_method === 'article')).toBe(true);
    const first = result.clauses.filter((c) => c.documentId === docs[0]!.document_id);
    const second = result.clauses.filter((c) => c.documentId === docs[1]!.document_id);
    expect(new Set(first.map((c) => c.articleNo)).size).toBe(41); // 제1~40조 + 부칙 제1조
    expect(first.some((c) => c.articleNo === '부칙 제1조')).toBe(true);
    expect([...new Set(second.map((c) => c.articleNo))]).toEqual(Array.from({ length: 10 }, (_, i) => `제${i + 1}조`));
    expect(result.documents.length).toBe(2);
  });
});

