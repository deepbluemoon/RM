import type { GateErrorBody, Problem } from './types'

/** 게이트 차단(GateError 본문)을 타입 있는 예외로 바꾼 것. C2 블록이 그대로 받는다. */
export class GateApiError extends Error {
  readonly status: number
  readonly body: GateErrorBody & { checks?: unknown[] }
  constructor(status: number, body: GateErrorBody & { checks?: unknown[] }) {
    super(`${body.gate} ${body.title}`)
    this.name = 'GateApiError'
    this.status = status
    this.body = body
  }
  get gate(): string {
    return this.body.gate
  }
}

/** 게이트가 아닌 실패(Problem 또는 알 수 없는 오류). 화면은 "다시 시도" 문구로만 표현한다. */
export class ApiError extends Error {
  readonly status: number
  readonly problem: Problem | null
  constructor(status: number, problem: Problem | null) {
    super(problem?.message ?? `HTTP ${status}`)
    this.name = 'ApiError'
    this.status = status
    this.problem = problem
  }
}

export function isGateBody(v: unknown): v is GateErrorBody {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { gate?: unknown }).gate === 'string' &&
    /^G([0-9]|1[0-4])$/.test((v as { gate: string }).gate) &&
    typeof (v as { title?: unknown }).title === 'string'
  )
}

export const API_BASE = '/api'

/** 401(G8 로그인 필요) 응답을 받으면 window 로 알린다 */
export const AUTH_REQUIRED_EVENT = 'crd:auth-required'

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

async function request<T>(method: Method, path: string, body?: unknown, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  let payload: BodyInit | undefined
  if (body instanceof FormData) {
    payload = body
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  const res = await fetch(API_BASE + path, {
    method,
    headers,
    body: payload,
    credentials: 'include', // 로그인 세션 쿠키(crd.sid)
    ...init,
  })
  if (res.status === 204) return undefined as T
  const text = await res.text()
  let data: unknown = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = null
    }
  }
  if (!res.ok) {
    // 로그인 만료·로그아웃 — 앱 셸이 로그인 화면으로 보낸다(App.vue)
    if (res.status === 401 && isGateBody(data)) window.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT))
    if (isGateBody(data)) throw new GateApiError(res.status, data as GateErrorBody)
    throw new ApiError(res.status, (data as Problem | null) ?? null)
  }
  return data as T
}

export const http = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {}),
  del: <T = void>(path: string) => request<T>('DELETE', path),
}

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const u = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v))
  const s = u.toString()
  return s ? `?${s}` : ''
}
