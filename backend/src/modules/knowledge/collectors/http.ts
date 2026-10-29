// 수집기 공통 HTTP 도우미(T130). 요청 URL 에 키가 들어가므로 URL·응답 본문은 로그에 남기지 않는다(CLAUDE.md).
// 실패는 CollectorError(운영자에게 보일 사유 문구, 200자 이하 — ingest_source_status.fail_reason)로만 알린다
import { env } from '../../../config/env.js';

export class CollectorError extends Error {
  constructor(public readonly reason: string) {
    super(reason.slice(0, 200));
    this.name = 'CollectorError';
  }
}

/** 키 미설정이면 네트워크 호출 전에 실패시킨다 — 사유에는 변수 이름만 싣는다(값은 싣지 않는다) */
export function requireKey(value: string | undefined, varName: string): string {
  if (!value) throw new CollectorError(`키 미설정 - ${varName}`);
  return value;
}

export type FetchLike = typeof fetch;

export interface GetOpts {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

async function get(url: string, o: GetOpts): Promise<Response> {
  const f = o.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(url, { signal: AbortSignal.timeout(o.timeoutMs ?? env.KNOWLEDGE_COLLECT_TIMEOUT_SEC * 1000) });
  } catch (e) {
    const name = (e as Error).name;
    throw new CollectorError(name === 'TimeoutError' || name === 'AbortError' ? '응답 시간 초과' : '연결 실패');
  }
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel().catch(() => undefined);
    throw new CollectorError(`인증 실패(${res.status}) - 키 확인 필요`);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new CollectorError(`응답 오류(${res.status})`);
  }
  return res;
}

export async function getJson<T>(url: string, o: GetOpts = {}): Promise<T> {
  const res = await get(url, o);
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    // 공공 API 는 키 오류를 200 + XML 로 돌려주기도 한다
    if (/SERVICE_KEY|키|key/i.test(text.slice(0, 500))) throw new CollectorError('인증 실패 - 키 확인 필요');
    throw new CollectorError('응답 형식 오류(JSON 아님)');
  }
}

/** 배열이 아닌 단일 객체로 오는 공공 API 응답을 배열로 편다 */
export const asArray = <T>(v: T | T[] | null | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

/** 공공 API 날짜("20260915", "2026.09.15", "2026-09-15") → YYYY-MM-DD */
export function ymd(v: unknown): string | null {
  const s = String(v ?? '').replace(/[^0-9]/g, '');
  if (s.length < 8) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

export const after = (date: string | null | undefined, since: string | null | undefined): boolean => !since || (!!date && date > since);
