// P9 9.5 서버 상태·9.6 모델 교체 감지(T140, UC10 기본흐름 5·A2·A3·E2~E4, BR-API-02·BR-MDL-02).
// 9.5 는 표시다 — 503·504·401 이어도 200 으로 상태만 싣는다(SD_01 §12-3: P1 1.6 의 G5 게이트와 성격이 다르다).
// /health 는 modelApi/status.ts 의 10초 캐시를, /v1/models 는 여기서 60초 캐시를 쓴다(자동 새로고침 없음 — 탭 열 때 + 수동).
// API 키 값은 어떤 경로로도 응답에 싣지 않는다(BR-API-02). H7(모델 교체 감지)은 저장하지 않는다
import { getPool, selectOne } from '../../db/pool.js';
import { modelApi, type ModelApiError } from '../modelApi/client.js';
import { getServerStatus, type ServerStatus } from '../modelApi/status.js';
import { provisioningHint, type ModelId } from './provisioning.js';

const IDS: ModelId[] = ['M1', 'M2', 'M3', 'M4'];
const MODELS_TTL_MS = 60_000;

interface ModelsBody {
  models: { id: string; name: string; model_version: string; trained_data_date?: string | null; base?: string }[];
  model_version: string;
}

let modelsCache: { at: number; value: ModelsBody | null; error: number | null } | null = null;

export function resetGuideCache(): void {
  modelsCache = null;
}

/** /v1/models — 서버가 응답하지 않거나 키가 틀리면 부르지 않는다(헛호출 방지) */
async function modelsInfo(s: ServerStatus, refresh: boolean): Promise<{ value: ModelsBody | null; error: number | null }> {
  if (s.adminState === 'auth_mismatch') return { value: null, error: 401 };
  if (s.adminState === 'unreachable' && s.raw === null) return { value: null, error: s.httpStatus };
  if (!refresh && modelsCache && Date.now() - modelsCache.at < MODELS_TTL_MS) return modelsCache;
  try {
    modelsCache = { at: Date.now(), value: await modelApi.models(), error: null };
  } catch (e) {
    modelsCache = { at: Date.now(), value: null, error: (e as ModelApiError).httpStatus ?? null };
  }
  return modelsCache;
}

/** 9.6 — 최근 저장 결과의 M3 model_version 과 현재 M3 가 다르면 교체 감지. 새 버전 평가 기록(H6)이 있으면 해소 */
export async function detectModelChange(currentM3: string | null, detectedAt: string) {
  if (!currentM3) return null;
  const recent = await selectOne<{ m3_model_version: string; run_id: number }>(
    getPool(),
    `SELECT j.m3_model_version, r.run_id
       FROM analysis_run r JOIN clause_assessment a ON a.run_id = r.run_id JOIN judgment j ON j.judgment_id = a.judgment_id
      WHERE r.stage = 'saved' AND j.origin = 'service'
      ORDER BY r.saved_at DESC, r.run_id DESC, a.assessment_id LIMIT 1`,
  );
  if (!recent || recent.m3_model_version === currentM3) return null;
  const evaluated = await selectOne<{ eval_run_id: number }>(getPool(), 'SELECT eval_run_id FROM eval_run WHERE m3_model_version = ? AND recorded_at IS NOT NULL LIMIT 1', [currentM3]);
  if (evaluated) return null;
  return {
    currentM3,
    recentResultM3: recent.m3_model_version,
    recentRunId: recent.run_id,
    detectedAt,
    recommendation: '모델 교체됨 - 탐지 품질 평가(UC8) 권장',
  };
}

const ADMIN_NOTE: Record<string, string> = {
  unreachable: '모델 API 서버가 응답하지 않습니다(연결 불가·시간 초과). 문서 열람은 계속할 수 있습니다',
  loading: '모델을 메모리에 올리는 중입니다(503). 보통 10~30초면 끝납니다',
  auth_mismatch: 'API 키 불일치(401) — 백엔드 환경변수 MODEL_API_KEY 와 모델 서버 키를 확인하세요(화면에 키를 표시하지 않습니다)',
  not_implemented: '모델 서버가 /health 를 제공하지 않습니다 — 매뉴얼의 헬스체크 명령으로 확인하세요',
};

export async function modelApiStatus(refresh = false) {
  const s = await getServerStatus(refresh);
  const info = await modelsInfo(s, refresh);
  const reachable = s.raw !== null;
  const models = IDS.map((id) => {
    const h = s.models.find((m) => m.id === id);
    const v = info.value?.models.find((m) => m.id === id);
    const sizeMb = h?.sizeMb ?? null;
    return {
      id,
      name: v?.name ?? h?.model ?? id,
      // 서버가 응답했는데 목록에 없으면 미설치, 서버가 응답하지 않으면 오류(미설치로 단정하지 않는다)
      loadState: h?.state ?? (reachable ? 'missing' : 'error'),
      modelVersion: v?.model_version ?? '',
      trainedDataDate: v?.trained_data_date ?? null,
      servedModel: h?.model ?? null,
      base: v?.base ?? null,
      sizeMb,
      sizeGb: sizeMb === null ? null : Math.round((sizeMb / 1024) * 10) / 10,
    };
  });
  const m3 = models.find((m) => m.id === 'M3')!;
  const m4 = models.find((m) => m.id === 'M4')!;
  const cold = models.filter((m) => m.loadState === 'cold').map((m) => m.id);
  return {
    state: s.adminState,
    httpStatus: s.httpStatus,
    checkedAt: s.checkedAt,
    note: s.adminState === 'unreachable' && reachable
      ? '일부 모델이 준비되지 않았습니다(degraded) — 사용자 화면은 분석 일시 불가(G5)입니다. 아래 모델별 상태와 준비 절차를 확인하세요'
      : ADMIN_NOTE[s.adminState] ?? null,
    coldStart: s.coldStart,
    warmupEstimateSec: s.warmupEstimateSec,
    queueDepth: s.queueDepth,
    // 공유 Ollama 규칙: M3·M4 가 같은 채팅 모델 1개(model-serving §0)
    sharedChatModel: !!m3.servedModel && m3.servedModel === m4.servedModel,
    loadNotice: cold.length
      ? `${cold.join('·')} 는 대기(유휴 5분 후 언로드) 상태입니다 — 첫 호출에 적재 약 ${s.warmupEstimateSec ?? 30}초가 더 듭니다(10~30초, bf16 4B 는 더 걸릴 수 있음). 호출은 가능합니다(G5 아님)`
      : null,
    models,
    // 계약상 object — 모를 때는 싣지 않는다
    ...(s.gpu ? { gpuMemory: s.gpu } : {}),
    bundleVersion: info.value?.model_version ?? s.raw?.model_version ?? null,
    modelsError: info.error,
    modelChanged: await detectModelChange(info.value?.models.find((m) => m.id === 'M3')?.model_version ?? null, s.checkedAt),
    provisioning: provisioningHint(models),
  };
}
