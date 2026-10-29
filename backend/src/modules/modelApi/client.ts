// 모델 API 클라이언트(T029) — contracts/model-api.openapi.yaml 7개 엔드포인트.
// 텍스트 인자는 DeidentifiedText 만 받는다(BR-MDL-01). 로그에는 요청 ID·엔드포인트·지연·상태만 남긴다.
// 타임아웃: 탐지(M1·M2) = policy MODEL_TIMEOUT_SEC, LLM(M3·M4) = env MODEL_LLM_TIMEOUT_SEC(공유 Ollama 대기·적재 포함)
import { env } from '../../config/env.js';
import { policyOrNull } from '../../config/policy.js';
import { logger } from '../../logger.js';
import type { DeidentifiedText } from '../../domain/types.js';

export type ModelErrorKind = 'timeout' | 'unavailable' | 'auth' | 'bad_request' | 'not_found' | 'too_large' | 'other';

export class ModelApiError extends Error {
  constructor(public readonly kind: ModelErrorKind, public readonly httpStatus: number | null, public readonly endpoint: string) {
    super(`model api ${endpoint} ${kind}${httpStatus ? ` ${httpStatus}` : ''}`);
    this.name = 'ModelApiError';
  }
}

export interface ClauseIn {
  clause_id: string;
  text: DeidentifiedText;
  article_no?: string | null;
  title?: string | null;
}

export interface DetectScore {
  label?: string;
  type?: string | null;
  related_laws?: string[];
  score: number;
}

export interface HealthBody {
  status: 'ready' | 'loading' | 'degraded';
  models: { id: string; state: string; model?: string; size_mb?: number | null }[];
  gpu?: { used_mb?: number; total_mb?: number };
  model_version?: string;
  knowledge_date?: string | null;
  warmup_estimate_sec?: number | null;
  queue_depth?: number;
}

export interface JobStatus {
  job_id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  total: number;
  done: number;
  results: { clause_id: string; loophole?: DetectScore; illegal?: DetectScore; error?: 'timeout' | null }[];
  model_versions?: { M1?: string; M2?: string };
}

export interface JudgeRequest {
  clause: DeidentifiedText;
  contract_type: string;
  perspective: 'consumer' | 'business';
  knowledge_date: string;
  scores: { loophole?: number; illegal?: number };
  evidence: { id: string; source_type: string; title: string; text: DeidentifiedText | string }[];
}

export interface JudgeResponse {
  risk_class: string;
  risk_type?: string | null;
  risk_level?: string | null;
  confidence?: string | null;
  explanation: { claim: string; evidence_ids: string[] }[];
  model_version: string;
  knowledge_date: string;
}

interface CallOpts {
  method?: 'GET' | 'POST';
  body?: unknown;
  timeoutMs: number;
  retries: number;
  /** 4xx 이외의 상태도 본문을 돌려받는다(/health 503 등) */
  acceptStatus?: number[];
  /** 사용자 취소 — 연결을 끊으면 게이트웨이·Ollama 도 생성을 멈춘다(docs/ollama-guide.md 1.7-9) */
  signal?: AbortSignal;
}

const detectTimeoutMs = () => (policyOrNull('MODEL_TIMEOUT_SEC') ?? 30) * 1000;
const llmTimeoutMs = () => env.MODEL_LLM_TIMEOUT_SEC * 1000;
const retries = () => policyOrNull('MODEL_RETRY') ?? 1;

const RETRYABLE: ModelErrorKind[] = ['timeout', 'unavailable'];

function kindOf(status: number): ModelErrorKind {
  if (status === 401) return 'auth';
  if (status === 400) return 'bad_request';
  if (status === 404) return 'not_found';
  if (status === 413) return 'too_large';
  if (status === 504) return 'timeout';
  if (status === 500) return 'other';  // 게이트웨이 고장 — 다시 불러도 같다(재시도 안 함). 503 = 준비 안 됨
  if (status >= 500) return 'unavailable';
  return 'other';
}

async function call<T>(endpoint: string, o: CallOpts): Promise<{ status: number; body: T }> {
  const url = env.MODEL_API_BASE_URL.replace(/\/$/, '') + endpoint;
  let last = new ModelApiError('other', null, endpoint);
  for (let attempt = 0; attempt <= o.retries; attempt++) {
    const t0 = Date.now();
    let res: Response;
    try {
      res = await fetch(url, {
        method: o.method ?? 'GET',
        headers: { Authorization: `Bearer ${env.MODEL_API_KEY}`, ...(o.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
        signal: o.signal ? AbortSignal.any([o.signal, AbortSignal.timeout(o.timeoutMs)]) : AbortSignal.timeout(o.timeoutMs),
      });
    } catch (e) {
      if (o.signal?.aborted) throw e;
      const name = (e as Error).name;
      last = new ModelApiError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unavailable', null, endpoint);
      logger.debug({ endpoint, kind: last.kind, ms: Date.now() - t0, attempt }, 'model api error');
      continue;
    }
    logger.debug({ endpoint, status: res.status, ms: Date.now() - t0, attempt }, 'model api');
    if (res.ok || o.acceptStatus?.includes(res.status)) return { status: res.status, body: (await res.json()) as T };
    // 오류 본문은 읽지도 로그에 남기지도 않는다(T109)
    await res.body?.cancel().catch(() => undefined);
    last = new ModelApiError(kindOf(res.status), res.status, endpoint);
    if (!RETRYABLE.includes(last.kind)) throw last;
  }
  throw last;
}

export const modelApi = {
  async health(timeoutMs = 5000): Promise<{ status: number; body: HealthBody }> {
    return call<HealthBody>('/health', { timeoutMs, retries: 0, acceptStatus: [503] });
  },
  async models(): Promise<{ models: { id: string; name: string; model_version: string; trained_data_date?: string | null; base?: string }[]; model_version: string }> {
    return (await call<{ models: { id: string; name: string; model_version: string; trained_data_date?: string | null }[]; model_version: string }>('/v1/models', { timeoutMs: 10_000, retries: retries() })).body;
  },
  async summarize(clauses: ClauseIn[]): Promise<{ summary: string; contract_type_candidates: { label: string; score: number }[]; model_version: string }> {
    return (await call<{ summary: string; contract_type_candidates: { label: string; score: number }[]; model_version: string }>('/v1/summarize', { method: 'POST', body: { clauses }, timeoutMs: llmTimeoutMs(), retries: retries() })).body;
  },
  async detect(kind: 'loophole' | 'illegal', clauses: ClauseIn[], contractType: string): Promise<{ results: (DetectScore & { clause_id: string })[]; model_version: string }> {
    return (await call<{ results: (DetectScore & { clause_id: string })[]; model_version: string }>(`/v1/detect/${kind}`, { method: 'POST', body: { clauses, contract_type: contractType }, timeoutMs: detectTimeoutMs(), retries: retries() })).body;
  },
  /** 문서 단위 M1∥M2 작업 — 관점 인자를 두지 않는다(A3, UC4) */
  async createDetectJob(clauses: ClauseIn[], contractType: string): Promise<string> {
    const r = await call<{ job_id: string }>('/v1/jobs', { method: 'POST', body: { clauses, contract_type: contractType }, timeoutMs: detectTimeoutMs(), retries: retries(), acceptStatus: [202] });
    return r.body.job_id;
  },
  async getJob(jobId: string): Promise<JobStatus> {
    return (await call<JobStatus>(`/v1/jobs/${encodeURIComponent(jobId)}`, { timeoutMs: detectTimeoutMs(), retries: retries() })).body;
  },
  async judge(req: JudgeRequest, signal?: AbortSignal): Promise<JudgeResponse> {
    return (await call<JudgeResponse>('/v1/judge', { method: 'POST', body: req, timeoutMs: llmTimeoutMs(), retries: retries(), ...(signal ? { signal } : {}) })).body;
  },
  /** 근거·조항 임베딩(하이브리드 RAG). 한 번에 32개까지 — 묶음 사이 휴식은 호출자가 지킨다(공유 Ollama 가이드 1.7-7) */
  async embed(texts: string[]): Promise<{ model_version: string; dim: number; embeddings: number[][] }> {
    return (await call<{ model_version: string; dim: number; embeddings: number[][] }>('/v1/embed', { method: 'POST', body: { texts }, timeoutMs: llmTimeoutMs(), retries: retries() })).body;
  },
  async openapi(): Promise<unknown> {
    return (await call<unknown>('/openapi.json', { timeoutMs: 10_000, retries: 0 })).body;
  },
};
