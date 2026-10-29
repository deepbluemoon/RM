// 모델 API 프록시 — 외부 프로그램(/api/model/<경로>)과 Swagger "Try it out"(/api/admin/model-api/try/<경로>) 공용.
// - 2026-09-30: 이용자는 발급받은 API 키(apiKey.service.ts)로 부르고, 백엔드가 확인한 뒤 서버 키(MODEL_API_KEY)로 모델 서버에 넘긴다.
//   서버 키는 응답·화면·로그 어디에도 나가지 않는다(BR-API-02)
// - 조항 본문은 넘기기 전에 백엔드 비식별화(deidentify)를 한 번 더 거친다 — 비식별 전 텍스트를 모델 API 로 보내지 않는다
// - 모델 API 계약의 경로·메서드만 허용한다(그 밖은 404) — 모델 서버의 다른 경로(/docs 등)로 새지 않게
// - 요청·응답 본문은 기록하지 않는다(FR-009)
// - 2026-10-01: POST /v1/judge 에 evidence 가 없거나 빈 배열이면 백엔드가 활성 지식 버전에서 근거를 검색해 채운다(웹 분석과 같은 searchEvidence).
//   knowledge_date 는 그 지식 기준일로 맞추고, 응답에 evidence_source·search_mode·evidence(인용 여부 포함)를 덧붙인다. 호출자가 근거를 보내면 그대로 쓴다
import { env } from '../../config/env.js';
import { logger } from '../../logger.js';
import { asKvId } from '../../domain/types.js';
import { deidentify } from '../deid/deid.service.js';
import { searchEvidence } from '../evidence/search.js';
import { activeKv } from '../knowledge/knowledge.repo.js';
import { evidencePayload } from '../detection/detection.service.js';

const ALLOWED: Array<{ method: 'GET' | 'POST'; re: RegExp }> = [
  { method: 'GET', re: /^\/health$/ },
  { method: 'GET', re: /^\/v1\/models$/ },
  { method: 'POST', re: /^\/v1\/detect\/(loophole|illegal)$/ },
  { method: 'POST', re: /^\/v1\/jobs$/ },
  { method: 'GET', re: /^\/v1\/jobs\/[A-Za-z0-9_-]{1,64}$/ },
  { method: 'POST', re: /^\/v1\/judge$/ },
  { method: 'POST', re: /^\/v1\/summarize$/ },
];

export const TRY_TIMEOUT_MS = 330_000; // 모델 서버 LLM 제한 300초 + 여유

export function isAllowedTry(method: string, path: string): boolean {
  return ALLOWED.some((a) => a.method === method && a.re.test(path));
}

export interface TryResult {
  status: number;
  contentType: string;
  body: string;
}

/** 조항 본문(clauses[].text · clause)을 비식별화한다. 그 밖의 필드는 그대로 */
export function deidentifyBody(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body ?? {};
  const b = { ...(body as Record<string, unknown>) };
  if (typeof b.clause === 'string') b.clause = deidentify(b.clause);
  if (Array.isArray(b.clauses)) {
    b.clauses = b.clauses.map((c) =>
      c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string'
        ? { ...(c as object), text: deidentify((c as { text: string }).text) }
        : c,
    );
  }
  return b;
}

type EvidenceItem = ReturnType<typeof evidencePayload>[number] & { source_url?: string };
export type EvidenceSource = 'caller' | 'server_search' | 'search_failed';
interface Retrieval {
  source: EvidenceSource;
  mode: 'hybrid' | 'bm25' | null;
  items: EvidenceItem[];
}

/** /v1/judge 근거 채우기 — 비식별된 본문을 받아, evidence 가 비었으면 검색해서 넣는다. 검색이 실패해도 판정은 넘기되 search_failed 로 알린다 */
export async function fillJudgeEvidence(b: Record<string, unknown>): Promise<Retrieval> {
  const given = b.evidence;
  if (Array.isArray(given) && given.length > 0) return { source: 'caller', mode: null, items: [] };
  if (typeof b.clause !== 'string' || !b.clause.trim()) return { source: 'caller', mode: null, items: [] }; // 모델 서버가 400 으로 답하게 둔다
  try {
    const kv = await activeKv();
    if (!kv) throw new Error('active knowledge version missing');
    const hits = await searchEvidence(asKvId(kv.kv_id), b.clause);
    const items = evidencePayload(hits);
    b.evidence = items;
    b.knowledge_date = kv.knowledge_date;
    const urls = new Map(hits.map((h) => [String(h.row.evidence_version_id), h.row.source_url]));
    return { source: 'server_search', mode: hits.some((h) => h.rrf !== undefined) ? 'hybrid' : 'bm25', items: items.map((e) => ({ ...e, source_url: urls.get(e.id) })) };
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'external judge evidence search failed — forwarding without evidence');
    b.evidence = [];
    return { source: 'search_failed', mode: null, items: [] };
  }
}

/** 판정 응답(JSON 객체)에 근거 출처를 덧붙인다. 검색한 근거는 응답이 인용했는지(cited)와 함께 싣는다 */
export function annotateJudge(text: string, rt: Retrieval): string {
  let o: unknown;
  try { o = JSON.parse(text); } catch { return text; }
  if (!o || typeof o !== 'object' || Array.isArray(o) || !('risk_class' in o)) return text;
  const out: Record<string, unknown> = { ...(o as Record<string, unknown>), evidence_source: rt.source };
  if (rt.source === 'server_search') {
    const cited = new Set(((out.explanation as Array<{ evidence_ids?: string[] }> | undefined) ?? []).flatMap((x) => x.evidence_ids ?? []));
    out.search_mode = rt.mode;
    out.evidence = rt.items.map((e) => ({ ...e, cited: cited.has(e.id) }));
  }
  return JSON.stringify(out);
}

export async function forwardTry(method: 'GET' | 'POST', path: string, body: unknown): Promise<TryResult> {
  const url = env.MODEL_API_BASE_URL.replace(/\/$/, '') + path;
  const headers: Record<string, string> = { accept: 'application/json', authorization: `Bearer ${env.MODEL_API_KEY}` };
  if (method === 'POST') headers['content-type'] = 'application/json';
  const payload = method === 'POST' ? deidentifyBody(body) : undefined;
  const isJudge = method === 'POST' && path === '/v1/judge' && !!payload && typeof payload === 'object' && !Array.isArray(payload);
  const rt = isJudge ? await fillJudgeEvidence(payload as Record<string, unknown>) : null;
  const r = await fetch(url, {
    method,
    headers,
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(TRY_TIMEOUT_MS),
  });
  const contentType = r.headers.get('content-type') ?? 'application/json';
  const text = await r.text();
  return { status: r.status, contentType, body: rt && r.ok && contentType.includes('json') ? annotateJudge(text, rt) : text };
}
