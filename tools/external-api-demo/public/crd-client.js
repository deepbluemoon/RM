// [실제 기능] 계약위험탐지 공개 API 클라이언트 — 회원가입 화면(terms-analysis.js)과 개발자 화면(developers.html)이 함께 쓴다.
// 브라우저는 업체 서버(server.mjs)의 /partner-api/* 만 부르고, 업체 서버가 키를 붙여 https://p2.sumzip.com/api/model 로 넘긴다.
// 이 파일에는 API 키가 없다. mock 결과도 없다 — 모든 값은 API 응답 그대로다.

const listeners = new Set();
/** 호출마다 { method, path, status, ms, rateLimit } 를 알린다(개발자 화면 호출 기록용) */
export const onApiCall = (fn) => listeners.add(fn);

export async function call(method, path, body) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const t0 = performance.now();
  let r;
  try {
    r = await fetch('/partner-api' + path, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  } catch {
    const res = { status: 0, ok: false, data: { message: '업체 서버에 연결할 수 없습니다' }, ms: null };
    listeners.forEach((f) => f({ method, path, status: 0, ms: Math.round(performance.now() - t0) }));
    return res;
  }
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  const ms = Number(r.headers.get('x-upstream-ms')) || Math.round(performance.now() - t0);
  const rateLimit = r.headers.get('x-upstream-ratelimit') || '';
  listeners.forEach((f) => f({ method, path, status: r.status, ms, rateLimit }));
  return { status: r.status, ok: r.ok, data, ms, reqId: r.headers.get('x-upstream-request-id'), rateLimit };
}

export class ApiFailure extends Error {
  constructor(r) { super(errorMessage(r)); this.status = r.status; this.data = r.data; }
}

/** 개발자용 상세 메시지 */
export function errorMessage(r) {
  const d = r.data || {};
  const m = typeof d === 'string' ? d.slice(0, 200) : d.message || (typeof d.detail === 'string' ? d.detail : JSON.stringify(d.detail ?? d));
  return `${r.status || '연결 실패'} ${d.code ? `(${d.code}) ` : ''}${m}`;
}

/** 일반 사용자용 안내 문구 — ApiFailure(또는 { status, data }) 를 받는다 */
export function friendlyError(e) {
  const status = e?.status ?? 0, code = e?.data?.code;
  if (code === 'demo_key_malformed') return '분석 서비스 연결 설정이 잘못됐어요 (업체 서버의 API 키 형식 오류 — 기다려도 나오지 않아요).';
  if (code === 'demo_key_missing') return '분석 서비스 연결이 설정되지 않았어요 (업체 서버에 API 키가 없어요 — 기다려도 나오지 않아요).';
  if (status === 429) return '지금 분석 요청이 많아요. 1분쯤 뒤에 다시 눌러 주세요.';
  if (status === 503 || status === 504) return 'AI 분석 서버가 준비 중이에요. 잠시 뒤 다시 시도해 주세요.';
  if (status === 401 || status === 403) return '분석 서비스 연결 설정에 문제가 있어요 (API 키가 맞지 않아요).';
  if (status === 0 || status >= 500) return '분석 서버에 연결하지 못했어요. 잠시 뒤 다시 시도해 주세요.';
  return '분석 요청을 처리하지 못했어요.';
}

/** GET /health 60초 캐시 — 공유 서버 상태 조회 규칙(폴링 금지, 60초 캐시). 실패하면 null */
let healthCache = null;
export async function healthCached() {
  if (healthCache && Date.now() - healthCache.at < 60_000) return healthCache.data;
  try { const d = await health(); healthCache = { at: Date.now(), data: d }; return d; } catch { return null; }
}

/** GET /health — 화면을 열 때·사용자가 누를 때만(주기적 폴링 금지) */
export async function health() {
  const r = await call('GET', '/health');
  if (!r.data || !r.data.models) throw new ApiFailure(r);
  return r.data;
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/** POST /v1/jobs → GET /v1/jobs/{id} — 처음엔 0.3초부터 촘촘히, 이후 1.5초 간격(공개 API 한도 1분 60번 안). onProgress({done,total,status}) */
export async function detectJob(contractType, clauses, onProgress = () => {}) {
  const c = await call('POST', '/v1/jobs', { contract_type: contractType, clauses });
  if (c.status !== 202 && !c.ok) throw new ApiFailure(c);
  const id = c.data.job_id;
  const WAIT = [300, 300, 400, 500, 1000];   // 작업은 보통 0.3초 안에 끝난다 — 처음엔 촘촘히, 이후 1.5초(1분 60번 한도 안)
  for (let i = 0; i < 85; i++) {
    await sleep(WAIT[i] ?? 1500);
    const g = await call('GET', `/v1/jobs/${encodeURIComponent(id)}`);
    if (!g.ok) throw new ApiFailure(g);
    onProgress(g.data);
    if (g.data.status === 'done') return g.data;
    if (g.data.status === 'failed') throw new ApiFailure({ status: 500, data: { message: '탐지 작업 실패' } });
  }
  throw new ApiFailure({ status: 504, data: { message: `작업 ${id} 가 2분 안에 끝나지 않음` } });
}

/** POST /v1/judge — 조항 1건. 공유 모델이라 동시에 1건만 부른다(호출하는 쪽이 순서대로)
 *  evidence 를 빼면 서버가 지식 DB(법령·공정위 사례·표준약관)에서 근거를 검색해 넣고, 응답에 evidence(인용 여부 cited 포함)를 돌려준다 */
export async function judge({ clause, contractType, perspective, scores, evidence }) {
  const body = { clause, contract_type: contractType, perspective, knowledge_date: new Date().toISOString().slice(0, 10), scores };
  if (evidence?.length) body.evidence = evidence;
  const r = await call('POST', '/v1/judge', body);
  if (!r.ok) throw new ApiFailure(r);
  return r.data;
}

/** POST /v1/summarize */
export async function summarize(clauses) {
  const r = await call('POST', '/v1/summarize', { clauses });
  if (!r.ok) throw new ApiFailure(r);
  return r.data;
}

/** 「제N조(제목) 본문」 단위로 나눈다. 조 표시가 없으면 줄 단위 */
export function splitClauses(text) {
  // 장 제목(제1장 …)·부칙은 조항이 아니므로 뺀다
  const t = text.replace(/\r/g, '').replace(/^\s*제\s*\d+\s*장.*$/gm, '').replace(/^\s*부\s*칙[\s\S]*$/m, '').trim();
  if (!t) return [];
  const parts = /제\s*\d+\s*조/.test(t) ? t.split(/\n?(?=^제\s*\d+\s*조(?:의\s*\d+)?\s*[(（])/m) : t.split(/\n\s*\n|\n/);
  return parts.map((s) => s.trim()).filter((s) => /^제\s*\d+\s*조/.test(s) || !/제\s*\d+\s*조/.test(t)).slice(0, 2000).map((s, i) => {
    const m = /^제\s*(\d+)\s*조(?:의\s*\d+)?\s*[(（]([^)）]{1,40})[)）]\s*/.exec(s);
    const c = { clause_id: `c${i + 1}`, text: (m ? s.slice(m[0].length).trim() || s : s).replace(/\s*\n\s*/g, ' ') };
    if (m) { c.article_no = `제${m[1]}조`; c.title = m[2]; }
    return c;
  });
}

// 판단(M3) 요청에 함께 보낼 수 있는 참고 법령 — 조문 발췌(…는 생략 표시).
// 직접 근거를 보내고 싶을 때의 예시(전자상거래법 제17조, 약관법 제6·7·8·9·10·14조 발췌). 데모 화면은 보내지 않고 서버 검색을 쓴다(2026-10-01)
export const EVIDENCE = [
  { id: 'law-ecom-17', source_type: 'law_article', title: '전자상거래 등에서의 소비자보호에 관한 법률 제17조 제1항(청약철회등)', text: '통신판매업자와 재화등의 구매에 관한 계약을 체결한 소비자는 다음 각 호의 기간(거래당사자가 다음 각 호의 기간보다 긴 기간으로 약정한 경우에는 그 기간을 말한다) 이내에 해당 계약에 관한 청약철회등을 할 수 있다. 1. 제13조제2항에 따른 계약내용에 관한 서면을 받은 날부터 7일. …' },
  { id: 'law-terms-6', source_type: 'law_article', title: '약관의 규제에 관한 법률 제6조(일반원칙)', text: '① 신의성실의 원칙을 위반하여 공정성을 잃은 약관 조항은 무효이다. ② 약관의 내용 중 다음 각 호의 어느 하나에 해당하는 내용을 정하고 있는 조항은 공정성을 잃은 것으로 추정된다. 1. 고객에게 부당하게 불리한 조항 …' },
  { id: 'law-terms-7', source_type: 'law_article', title: '약관의 규제에 관한 법률 제7조(면책조항의 금지)', text: '계약 당사자의 책임에 관하여 정하고 있는 약관의 내용 중 다음 각 호의 어느 하나에 해당하는 내용을 정하고 있는 조항은 무효로 한다. 1. 사업자, 이행 보조자 또는 피고용자의 고의 또는 중대한 과실로 인한 법률상의 책임을 배제하는 조항 …' },
  { id: 'law-terms-8', source_type: 'law_article', title: '약관의 규제에 관한 법률 제8조(손해배상액의 예정)', text: '고객에게 부당하게 과중한 지연 손해금 등의 손해배상 의무를 부담시키는 약관 조항은 무효로 한다.' },
  { id: 'law-terms-9', source_type: 'law_article', title: '약관의 규제에 관한 법률 제9조(계약의 해제·해지)', text: '계약의 해제·해지에 관하여 정하고 있는 약관의 내용 중 다음 각 호의 어느 하나에 해당되는 내용을 정하고 있는 조항은 무효로 한다. 1. 법률에 따른 고객의 해제권 또는 해지권을 배제하거나 그 행사를 제한하는 조항 …' },
  { id: 'law-terms-10', source_type: 'law_article', title: '약관의 규제에 관한 법률 제10조(채무의 이행)', text: '채무의 이행에 관하여 정하고 있는 약관의 내용 중 다음 각 호의 어느 하나에 해당하는 내용을 정하고 있는 조항은 무효로 한다. 1. 상당한 이유 없이 급부(給付)의 내용을 사업자가 일방적으로 결정하거나 변경할 수 있도록 권한을 부여하는 조항 …' },
  { id: 'law-terms-14', source_type: 'law_article', title: '약관의 규제에 관한 법률 제14조(소송 제기의 금지 등)', text: '소송 제기 등과 관련된 약관의 내용 중 다음 각 호의 어느 하나에 해당하는 조항은 무효로 한다. 1. 고객에게 부당하게 불리한 소송 제기 금지 조항 또는 재판관할의 합의 조항 …' },
];

// 근거 조문의 쉬운 설명 — 유클마켓이 미리 써 둔 문장(API 응답 아님). 화면에서 조문 원문 아래에 붙인다.
// judge 요청의 evidence 에는 넣지 않는다(계약에 없는 필드). 약관법 제7~10·14조는 「무효로 한다」(현행 조문, law.go.kr 확인 2026-10-01) = 효력이 없어요, 제6조 ②는 「추정된다」= 효력이 없을 수 있어요
export const EVIDENCE_PLAIN = {
  'law-ecom-17': '온라인으로 산 물건은 계약 내용을 받은 날부터 7일 안에 청약을 철회(취소·환불)할 수 있어요.',
  'law-terms-6': '고객에게 부당하게 불리한 조항은 공정하지 않은 것으로 보아 효력이 없을 수 있어요.',
  'law-terms-7': '회사가 고의나 큰 잘못으로 생긴 책임까지 지지 않겠다는 조항은 효력이 없어요.',
  'law-terms-8': '고객에게 지나치게 큰 위약금·손해배상을 물리는 조항은 효력이 없어요.',
  'law-terms-9': '법이 보장하는 계약 해지·해제 권리를 막거나 줄이는 조항은 효력이 없어요.',
  'law-terms-10': '정당한 이유 없이 회사 마음대로 상품·서비스 내용을 정하거나 바꿀 수 있게 한 조항은 효력이 없어요.',
  'law-terms-14': '고객에게 부당하게 불리한 재판 관할(예: 회사 근처 법원만)을 정한 조항은 효력이 없어요.',
};

// 서버 검색 근거는 id 가 DB 번호라 EVIDENCE_PLAIN 의 id 와 맞지 않는다 → 법 이름 + 조(+ 항)로 찾는다.
// 미리 쓴 설명이 특정 항(예: 전자상거래법 제17조 제1항)에 대한 것이면 항까지 같아야 붙인다 — 제2항(철회 제한)에 제1항 설명이 붙으면 뜻이 반대가 된다
const lawRef = (title) => {
  const m = /^(.+?)\s*제\s*(\d+)\s*조(?:\s*의\s*(\d+))?(?:\s*제\s*(\d+)\s*항)?/.exec(String(title || ''));
  return m ? { art: `${m[1].trim()}|${m[2]}${m[3] ? `-${m[3]}` : ''}`, para: m[4] ?? null } : null;
};
const PLAIN_BY_ARTICLE = {};   // art → { para(null = 조 전체), text }
for (const e of EVIDENCE) {
  const r = lawRef(e.title);
  if (r && EVIDENCE_PLAIN[e.id]) PLAIN_BY_ARTICLE[r.art] = { para: r.para, text: EVIDENCE_PLAIN[e.id] };
}
/** 근거의 쉬운 설명 — 미리 써 둔 법령 조문에만 있다(없으면 null) */
export function plainFor(e) {
  if (EVIDENCE_PLAIN[e.id]) return EVIDENCE_PLAIN[e.id];
  if (e.source_type !== 'law_article') return null;
  const r = lawRef(e.title), hit = r && PLAIN_BY_ARTICLE[r.art];
  if (!hit) return null;
  return hit.para === null || hit.para === r.para ? hit.text : null;
}
/** 근거 원문 주소 — https 만 허용(링크로 쓰기 전에 거른다) */
export function safeUrl(u) {
  try { const x = new URL(String(u || '')); return x.protocol === 'https:' ? x.href : null; } catch { return null; }
}
/** 화면용 근거 제목 — 공정위 사건 식별번호(FTC-…)는 숨긴다(본 서비스와 같은 원칙) */
export function displayTitle(title) {
  return String(title || '').replace(/\s*\(FTC-[^)]*\)/g, '').replace(/\s*FTC-[A-Za-z0-9-]+/g, '').trim();
}

// 응답 값 → 화면 이름 — 본 서비스(frontend/src/lib/labels.ts, SD_02 §3-3)와 같은 표기
export const TYPE_KO = { rights_limit: '소비자 권리 제한', liability_avoid: '책임 회피', refund_cancel_limit: '환불·해지 제한', unilateral_change: '일방적 변경', excessive_penalty: '과도한 위약금', vague: '모호한 표현', other: '기타' };
export const CLASS_KO = { normal: '정상', dispute: '분쟁 가능', unfair: '불공정 가능', illegal: '위법 가능', unanalyzable: '판단 어려움' };
export const RISK_SYMBOL = { high: '●', mid: '◐', low: '○' };   // 위험도 = 글자 + 기호(본 서비스 C5 판정 배지와 같음)
export const LEVEL_KO = { high: '높음', mid: '중간', low: '낮음' };
export const CONFIDENCE_KO = { high: '높음', medium: '보통', low: '낮음' };
export const CT_KO = { ecommerce: '전자상거래', subscription: '구독', installment: '할부', door_to_door: '방문판매', general_consumer: '일반 소비자 거래', out_of_scope: '범위 밖' };
