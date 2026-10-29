// 모델 서버 상태(1.6 G5 판정, C11·S9 표시)와 콜드 스타트 안내. /health 를 10초 캐시한다.
// 공유 Ollama 는 5분 유휴 후 모델을 내린다 — cold 는 호출 가능(G5 아님)하지만 첫 호출에 적재 시간이 든다(model-serving §0.1)
import { modelApi, ModelApiError, type HealthBody } from './client.js';

export type UserState = 'ready' | 'loading' | 'unreachable';
export type AdminState = UserState | 'auth_mismatch' | 'not_implemented';

export interface ServerStatus {
  state: UserState;
  adminState: AdminState;
  httpStatus: number | null;
  checkedAt: string;
  coldStart: boolean;
  warmupEstimateSec: number | null;
  queueDepth: number;
  models: { id: 'M1' | 'M2' | 'M3' | 'M4'; state: 'ready' | 'loading' | 'cold' | 'missing' | 'error'; model?: string; sizeMb?: number | null }[];
  gpu: { usedMb: number; totalMb: number } | null;
  raw: HealthBody | null;
}

let cache: { at: number; value: ServerStatus } | null = null;
const TTL_MS = 10_000;

function toModelState(s: string): ServerStatus['models'][number]['state'] {
  return (['ready', 'loading', 'cold', 'missing', 'error'] as const).find((x) => x === s) ?? 'error';
}

export async function getServerStatus(force = false): Promise<ServerStatus> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const checkedAt = new Date().toISOString();
  let value: ServerStatus;
  try {
    const { status, body } = await modelApi.health();
    const models = (body.models ?? []).map((m) => ({ id: m.id as ServerStatus['models'][number]['id'], state: toModelState(m.state), model: m.model, sizeMb: m.size_mb ?? null }));
    const anyMissing = models.some((m) => m.state === 'missing' || m.state === 'error');
    // M3·M4 가 cold(내려가 있음)이거나 loading(게이트웨이가 적재 중 — 예열 또는 cold 모델 첫 호출)이면 적재 시간이 더해진다
    const coldModels = models.filter((m) => (m.id === 'M3' || m.id === 'M4') && (m.state === 'cold' || m.state === 'loading'));
    // 사용자 상태: 모든 모델 호출 가능(ready/cold)이면 ready, 적재 중이면 loading, 없는 모델이 있으면 unreachable(G5)
    const state: UserState = body.status === 'loading' || status === 503 && !anyMissing ? 'loading' : anyMissing || body.status === 'degraded' ? 'unreachable' : 'ready';
    value = {
      state,
      adminState: state,
      httpStatus: status,
      checkedAt,
      coldStart: coldModels.length > 0,
      warmupEstimateSec: coldModels.length ? (body.warmup_estimate_sec ?? 30) : null,
      queueDepth: body.queue_depth ?? 0,
      models,
      gpu: body.gpu?.total_mb ? { usedMb: body.gpu.used_mb ?? 0, totalMb: body.gpu.total_mb } : null,
      raw: body,
    };
  } catch (e) {
    const err = e as ModelApiError;
    const adminState: AdminState = err.kind === 'auth' ? 'auth_mismatch' : err.kind === 'not_found' ? 'not_implemented' : 'unreachable';
    value = { state: 'unreachable', adminState, httpStatus: err.httpStatus ?? null, checkedAt, coldStart: false, warmupEstimateSec: null, queueDepth: 0, models: [], gpu: null, raw: null };
  }
  cache = { at: Date.now(), value };
  return value;
}

export function resetStatusCache(): void {
  cache = null;
}

/** 특정 모델이 콜드·적재 중인지(진행 화면 안내용) — 캐시만 본다 */
export function isCold(id: 'M3' | 'M4'): { cold: boolean; estimateSec: number | null } {
  const v = cache?.value;
  const m = v?.models.find((x) => x.id === id);
  const cold = m?.state === 'cold' || m?.state === 'loading';
  return { cold, estimateSec: cold ? (v?.warmupEstimateSec ?? 30) : null };
}

export function queueDepth(): number {
  return cache?.value.queueDepth ?? 0;
}
