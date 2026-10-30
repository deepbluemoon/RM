// S9 운영 안내(T140) — 미설치(missing) 모델의 수동 준비 절차와 단계별 예상 소요, 적재(콜드 스타트) 시간.
// 원천: model-server/README.md "모델 준비"·"적재 처리", model-serving.md §0·§0.1·§0.2, docs/ollama-guide.md 1.5~1.7.
// 서비스 런타임은 모델을 받거나 만들지 않는다(pull·create·rm 호출 없음) — 여기 명령은 운영자가 모델 서버 머신에서 1회 실행한다
export type ModelId = 'M1' | 'M2' | 'M3' | 'M4';

export interface ProvisionStep {
  step: string;
  command: string;
  estimate: string;
}

export interface ProvisioningHint {
  missing: ModelId[];
  /** M3·M4(LLM) — 공유 Ollama 채팅 모델 1개를 함께 쓴다 */
  llm: { missing: ModelId[]; defaultModel: string; sharedModelNote: string; customSteps: ProvisionStep[] } | null;
  /** M1·M2(분류기) — 파인튜닝 결과 배치 */
  classifiers: { missing: ModelId[]; steps: ProvisionStep[] } | null;
  rules: string[];
  estimatedTotal: string;
}

/** 공용 기본 모델(model-serving §0) */
export const SHARED_CHAT_MODEL = 'qwen3:4b-instruct-2507-q4_K_M';

/** bf16 커스텀(관리자 협의 시) 수동 준비 — model-server/README.md 표 그대로 */
export const LLM_CUSTOM_STEPS: ProvisionStep[] = [
  { step: '1 원본 받기', command: 'uv sync --extra tools && uv run python scripts/fetch_models.py', estimate: 'M3 8.1GB·M4 3.4GB — 회선에 따라 수 분~수십 분' },
  { step: '2 bf16 변환', command: 'LLAMA_CPP=~/src/llama.cpp uv run python scripts/convert_bf16.py', estimate: 'M3 3~5분, M4 1~2분 (+ SHA-256)' },
  { step: '3 공유 Ollama 에 등록', command: './scripts/provision_models.sh   # DRY_RUN=1 로 점검만 가능', estimate: 'M3 1~3분, M4 30초~1분' },
  { step: '4 검증(스크립트가 1회 호출 — 첫 적재 포함)', command: '(3 단계에 포함)', estimate: 'M3 20~40초, M4 10~20초' },
  { step: '5 게이트웨이 재시작', command: 'uv run uvicorn app.main:app --host 127.0.0.1 --port 9542 --workers 1', estimate: '수 초 + 첫 호출 적재 10~30초' },
];

export const CLASSIFIER_STEPS: ProvisionStep[] = [
  { step: '1 분류기 의존성', command: 'uv sync --extra classifiers', estimate: '약 1~3분' },
  { step: '2 학습 결과 배치', command: '{MODEL_ROOT}/m1-evasion-klue-roberta/ · m2-illegal-klue-roberta/ (+ model_card.json) — training/README.md', estimate: '복사 수 초(학습 자체는 training/README.md)' },
  { step: '3 게이트웨이 재시작', command: 'uv run uvicorn app.main:app --host 127.0.0.1 --port 9542 --workers 1', estimate: '수 초 + CPU 적재 수 초' },
];

export const PROVISION_RULES = [
  '모델 크기는 10GB 이하 — 넘으면 공유 서버 관리자와 협의한다(docs/ollama-guide.md 1.5)',
  '직접 만드는 모델 이름은 <계정명>-<서비스>:<버전> (예: pioneer2-crd-m3:v1). provision_models.sh 가 크기·접두사·중복(ollama list)을 검사한다',
  '서비스 런타임은 모델을 받거나 만들지 않는다(pull·create·rm 없음) — 배포 전 수동 1회',
  'M3·M4 는 채팅 모델 1개를 함께 쓴다 — OLLAMA_M3_MODEL·OLLAMA_M4_MODEL 을 같은 이름으로 둔다(가이드 1.7-4)',
  '새 버전은 :v2 로 만들고 env 의 모델 이름만 바꾼다 — model_version 이 바뀌어 판정 캐시가 분리되고 이 화면에 "모델 교체 감지"가 뜬다',
  '공유 Ollama 는 5분 동안 쓰지 않은 모델을 내린다 — 다음 첫 호출에 적재 10~30초(bf16 4B 는 더 걸릴 수 있음). 상태 확인은 이 화면 새로고침으로만(/api/ps 폴링 금지)',
];

const LLM: ModelId[] = ['M3', 'M4'];

export function provisioningHint(models: { id: ModelId; loadState: string }[]): ProvisioningHint | null {
  const missing = models.filter((m) => m.loadState === 'missing').map((m) => m.id);
  if (!missing.length) return null;
  const llmMissing = missing.filter((id) => LLM.includes(id));
  const clsMissing = missing.filter((id) => !LLM.includes(id));
  return {
    missing,
    llm: llmMissing.length
      ? {
          missing: llmMissing,
          defaultModel: SHARED_CHAT_MODEL,
          sharedModelNote: `기본 구성은 서버에 이미 설치된 공용 ${SHARED_CHAT_MODEL} 을 쓴다 — missing 이면 모델 서버에서 ollama list 로 설치 여부를 확인하고 공유 서버 관리자에게 알린다(공용 모델은 직접 지우거나 다시 받지 않는다). bf16 커스텀을 쓰기로 협의한 경우에만 아래 절차를 1회 실행한다`,
          customSteps: LLM_CUSTOM_STEPS,
        }
      : null,
    classifiers: clsMissing.length ? { missing: clsMissing, steps: CLASSIFIER_STEPS } : null,
    rules: PROVISION_RULES,
    estimatedTotal: llmMissing.length
      ? '다운로드를 빼면 약 5~10분(변환 4~7분 + 등록 2~4분 + 검증·재시작 1분) + 다운로드 수 분~수십 분'
      : '약 2~5분(의존성 설치 + 재시작)',
  };
}
