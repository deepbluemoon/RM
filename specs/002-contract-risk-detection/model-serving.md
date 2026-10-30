# 모델 구성·자원 할당 — 로컬 서버 bf16 (확정)

**Feature**: `002-contract-risk-detection` · **Date**: 2026-09-28 · **Plan**: [plan.md](./plan.md) · **계약**: [contracts/model-api.openapi.yaml](./contracts/model-api.openapi.yaml)

**결정 (2026-09-28)**: 모델 4종(M1~M4)과 웹 서비스를 **현재 서버(Mac Studio) 한 대**에서 운영한다. M3·M4는 **공식 원본을 bf16 그대로**(양자화 없음) 쓴다. 외부 GPU 서버는 쓰지 않는다. 이 결정은 `design/UC_00` §1.2의 "외부 GPU 서버"를 대체하며, 이탈 기록은 plan.md Complexity Tracking에 있다.

성능 수치는 **추정**이다. §8의 측정으로 확정한다. `[확인 필요]`는 착수 전에 확인할 항목이다.

> **개정 (2026-09-28, 구현 단계 — 이 절이 §2~§5·§7의 Ollama·모델 관련 값보다 우선한다)**: 이 서버의 Ollama는 모든 계정이 함께 쓰는 **공유 서버 하나**다. 규칙의 원천은 저장소 `docs/ollama-guide.md`(= `/Users/Shared/ollama/ollama-user-guide.md`, 최신)와 `OLLAMA 설정 참조.md` §7·§8이며, 둘이 다르면 유저 가이드를 따른다. 사용자 계정은 `ollama serve`를 실행하거나 포트를 점유할 수 없으므로 서비스 전용 인스턴스(`:11435`, `KEEP_ALIVE=-1`, `NUM_PARALLEL=4`)를 **쓰지 않는다**. 아래 §0이 실제 적용 구성이다.

## 0. 공유 Ollama 적용 구성 (실제 적용)

| 항목 | 기존 계획(§2·§4) | 적용 값 | 근거(유저 가이드) |
|---|---|---|---|
| Ollama 주소 | 서비스 전용 `127.0.0.1:11435` | 공유 `http://127.0.0.1:11434` (`OLLAMA_URL`) | 1.1, 1.3 `serve` 금지 |
| **채팅 모델 수** | M3·M4 별도 2개(bf16 커스텀) | **1개** — M3(판정)·M4(요약)가 같은 모델을 쓴다 | 1.7-4 "채팅 1개 + 임베딩 1개" |
| 모델 | `Qwen3-4B-Instruct-2507` bf16, `Qwen3-1.7B` bf16 | 공용 A등급 **`qwen3:4b-instruct-2507-q4_K_M`**(2.5GB, 이미 설치 — 추가 없음). M3와 같은 계열·같은 instruct 판의 q4 양자화본 | 1.2 A등급, 1.7-3 "이미 설치·상주 모델 우선" |
| 금지 모델 | — | `qwen3:4b`(사고 모드가 꺼지지 않음), `:cloud`, `gemma3:12b`(운영 예약), `-64k`·`-128k` 변형 — 게이트웨이 설정 검증에서 거부 | 1.2 "사용하지 않는 모델" |
| `num_ctx` | M3 8,192 · M4 32,768 | **모든 호출 8,192 고정**(미리 올리기 포함). 긴 문서 요약은 §5.4 절단 규칙을 항상 적용 | 1.3 필수, 1.7-1 |
| `num_predict` | M3 700 · M4 600 | 그대로(상한 1,024 이하) | 1.7-2 |
| `keep_alive` | `-1` | 요청마다 `"5m"` | 1.3, 1.6 |
| 동시 호출 | M3 4슬롯 | 게이트웨이 전체 **1건**(세마포어), 백엔드 `JUDGE_CONCURRENCY=1` | 1.3, 1.7-5 |
| 타임아웃·재시도 | M3 60초 · M4 90초, 재시도 1회 | Ollama 호출 **300초**, 백엔드 LLM 호출 `MODEL_LLM_TIMEOUT_SEC=300`. 연결 오류·시간 초과·5xx만 3초·6초 간격 최대 3회, 4xx는 재시도 안 함 | 1.3, 2.3 |
| 사고 모드 | M4 `think:false` | 모든 호출 `think:false` + `</think>` 앞부분 제거(안전장치) | 1.4, 2.2 |
| 미리 올리기 | 요청마다 예열 | **게이트웨이 기동 시 1회만** | 1.6, 1.7-10 |
| 상태 조회 | `/api/ps` 수시 조회 | Ollama 헬스체크는 `/api/version` **1분 1회 이하**, `/api/tags`·`/api/ps`는 60초 이상 캐시. 상주 여부는 게이트웨이가 마지막 성공 호출 시각 + 5분으로 스스로 추정 | 1.7-6 |
| 취소 | — | 사용자가 분석을 취소하면 백엔드가 진행 중인 판정 요청 연결을 끊고, 게이트웨이는 Ollama 요청을 끊는다(생성 중단) | 1.7-9 |
| 결과 캐시 | 판정 캐시 | 그대로 — 같은 조항·유형·관점·기준일·모델 버전이면 다시 생성하지 않는다 | 1.7-8 |
| 모델 준비 | `ollama create`(서비스 인스턴스) | 기본 구성은 **준비 작업 없음**(공용 모델). bf16 커스텀(`pioneer2-crd-m3:v1`)은 관리자 협의 시의 선택안으로만 남기며, 그때도 채팅 모델은 1개. 서비스 런타임 코드에는 `pull`·`create`·`rm`·`stop`·`serve` 호출이 없다 | 1.5, 2.4 |

**품질 영향**: bf16 → q4_K_M 양자화와 요약 모델 통합은 원래 결정(§2)에서 벗어난다. 판정 캐시 키의 `m3_model_version`이 `ollama:qwen3:4b-instruct-2507-q4_K_M`으로 바뀌어 이전 판정과 섞이지 않는다. §8.2-1(원본 대비 일치율)은 이 모델 기준으로 다시 측정하고, 품질이 부족하면 관리자와 전용 자원(참조 문서 §5)을 협의하는 것을 **팀 결정**으로 올린다.

### 0.1 적재(로딩) 시간을 고려한 동작

공유 서버는 5분 동안 쓰지 않은 모델을 내린다. 그래서 첫 호출에는 적재 시간(참조 §7.4 실측 10~30초, bf16 4B는 더 걸릴 수 있음)이 더해진다.

| 지점 | 동작 |
|---|---|
| 게이트웨이 `/health` | 60초 캐시한 `/api/tags`(설치 여부)·`/api/ps`와 자체 호출 기록(마지막 성공 + 5분)으로 모델별 `ready`·`cold`·`missing`을 보고한다. `/health`를 자주 불러도 Ollama 조회는 늘지 않는다. `cold`는 호출할 수 있으므로 G5가 아니다. `warmup_estimate_sec`(크기 기반 추정, 첫 요청 10~30초)와 `queue_depth`를 함께 싣는다 |
| 예열 | 게이트웨이 기동 시 1회만 빈 프롬프트 `/api/generate`(`keep_alive 5m`, `num_ctx 8192`)로 미리 올린다. M3·M4가 같은 모델이므로 요약 단계에서 올라간 모델을 판정 단계가 그대로 쓴다 |
| 백엔드 진행 상태 | `GET /api/analyses/{id}` 에 `elapsedSec` 와 `modelNotice`(`cold_start`·`queue`·`loading`, 예상 초)를 싣는다 |
| 사용자 화면 | S1 C11에 "모델 대기 중 — 첫 분석은 준비 시간 약 N초 추가". S2·S3 진행 레일 아래에 경과 시간과 적재·대기 안내. 안내는 C1 세부 줄 문구이며 토스트를 쓰지 않는다 |
| 운영 화면 S9 | 모델별 설치·상주 상태와 크기, 미설치 모델의 준비 명령(`provision_models.sh`)과 예상 소요(다운로드·변환·등록 단계별) |

### 0.2 실행 절차

```bash
cd model-server
uv sync                                        # 가상환경(.venv) + uvicorn
uv run uvicorn app.main:app --host 127.0.0.1 --port 9542 --workers 1   # 8000 번은 다른 계정이 사용 중
```

기본 구성은 공용 모델을 쓰므로 모델 추가 절차가 없다. 관리자와 협의해 bf16 커스텀 모델을 쓰기로 하면 `scripts/fetch_models.py` → `convert_bf16.py` → `provision_models.sh`(10GB 이하·`pioneer2-` 접두사 검사, 단계별 소요 시간 출력)를 배포 전 수동으로 1회 실행하고, `OLLAMA_M3_MODEL`·`OLLAMA_M4_MODEL`을 같은 이름 하나로 둔다.

§8의 성능 추정은 동시 4슬롯 기준이다. 동시 1건으로 바뀌었으므로 M3 30건은 **약 150~210초**가 되어 SC-009(3분)를 넘길 수 있다. T144 측정 결과에 따라 판정 캐시 적중률, M3 호출 대상 축소(기준치), 또는 관리자와 전용 인스턴스 협의(참조 §5)를 팀 결정으로 올린다.

---

---

## 1. 서버 사양 (2026-09-28 실측)

| 항목 | 값 | 영향 |
|---|---|---|
| 기종 | Mac Studio, Apple **M1 Ultra** | CUDA가 없으므로 Metal 런타임(Ollama)을 쓴다 |
| CPU | 20코어 (성능 16 + 효율 4) | M1·M2, OCR, Node가 CPU를 나눠 쓴다 |
| GPU | 64코어 Metal, 메모리 대역폭 명목 800GB/s | M3·M4를 실행한다 |
| 메모리 | 통합 **128GB** (CPU·GPU 공유), GPU 사용 상한 = macOS 기본값(`iogpu.wired_limit_mb=0`) | bf16 원본을 모두 올려도 여유가 있다 |
| 디스크 | 여유 약 349GB | 모델 원본·변환본 합계 약 25GB |
| 전원 | 잠자기 방지, 정전 후 자동 재시동(`autorestart 1`) 켜짐 | 서버 운영 기본 조건 충족 |
| Ollama | 0.34.0, 개인용 인스턴스가 앱으로 실행 중 | 서비스용 인스턴스를 **따로** 띄운다(§4) |
| Python | 시스템 3.9.6 | 모델 서버는 3.11을 따로 쓴다(`uv`) |

---

## 2. 구성 요약

| 모델 | 받는 곳 (공식) | 정밀도 | 실행 위치 | 핵심 설정 |
|---|---|---|---|---|
| M1 편법 탐지 | `klue/roberta-base` 팀 파인튜닝 | fp32 | 게이트웨이 프로세스, **CPU** | 6스레드, 배치 16, 최대 512토큰 |
| M2 위법 탐지 | `klue/roberta-base` 팀 파인튜닝 | fp32 | 게이트웨이 프로세스, **CPU** | M1과 같음 |
| M3 최종판정 | `Qwen/Qwen3-4B-Instruct-2507` | **bf16** | 서비스 Ollama, **Metal** | 컨텍스트 8,192, 동시 4, temperature 0, JSON 스키마 강제 |
| M4 요약 | `Qwen/Qwen3-1.7B` | **bf16** | 서비스 Ollama, **Metal** | 컨텍스트 32,768, `think: false`, temperature 0, JSON 스키마 강제 |

---

## 3. 자원 할당

### 3.1 프로세스 배치

```text
                        ┌──────────────── Mac Studio (M1 Ultra · 128GB) ─────────────────┐
 브라우저 ──HTTPS:443──▶ │ Nginx ─▶ Node 백엔드 :9522 (PM2 1개)                            │
                        │              │ HTTP loopback                                   │
                        │              ▼                                                 │
                        │   model-server 게이트웨이 :8000 (FastAPI, uvicorn 워커 1)        │
                        │     ├─ M1·M2  PyTorch CPU (프로세스 안)                         │
                        │     ├─ /v1/judge     ─▶ 서비스 Ollama :11435 ─ M3 (Metal)        │
                        │     └─ /v1/summarize ─▶        〃             ─ M4 (Metal)        │
                        │   (개인용 Ollama :11434 — 서비스와 분리)                         │
                        └───────────────────┬────────────────────────────────────────────┘
                                            └─▶ MariaDB 팀 서버 (원격, 변경 없음)
```

- 외부에 여는 포트는 Nginx 443 하나다. 나머지는 모두 `127.0.0.1`에만 바인드한다.
- 백엔드는 `MODEL_API_BASE_URL=http://127.0.0.1:8000`으로 호출한다. 모델 API 계약(엔드포인트 7종)은 바뀌지 않는다.
- 비식별화된 텍스트도 머신 밖으로 나가지 않는다(BR-MDL-01보다 강한 보호).

### 3.2 메모리 (통합 128GB)

| 구성 요소 | 가중치 | KV 캐시·작업 메모리 | 합계 |
|---|---|---|---|
| M3 Qwen3-4B-Instruct-2507 (bf16) | 약 8.1GB | 8,192토큰 × 4슬롯 × 약 147KB ≈ 4.8GB | **약 13GB** |
| M4 Qwen3-1.7B (bf16) | 약 3.4GB | 32,768토큰 × 4슬롯 × 약 112KB ≈ 14.7GB (§5.4 주석) | **약 18GB** |
| M1 + M2 (fp32, CPU) | 약 0.9GB | 배치 작업 약 0.5GB | **약 1.5GB** |
| 게이트웨이 Python·PyTorch 런타임 | — | — | 약 2GB |
| Node 백엔드 + OCR(tesseract.js 워커 2개) | — | — | 약 3GB |
| **서비스 합계** | | | **약 38GB** |
| 개인용 Ollama 모델(예: 26B급 한 개) | | | 약 17~20GB |
| macOS·기타 | | | 약 10GB |
| **여유** | | | **약 60GB** |

KV 캐시 계산: 레이어 수 × KV 헤드 8 × head_dim 128 × 2(K·V) × 2바이트. Qwen3-4B는 36층, Qwen3-1.7B는 28층이다.

### 3.3 CPU (성능 코어 16개)

| 용도 | 할당 | 설정 |
|---|---|---|
| M1·M2 분류 | 6스레드 | `torch.set_num_threads(6)` |
| OCR (스캔 PDF) | 워커 2개 | tesseract.js worker pool = 2 |
| Node 백엔드 (추출·비식별화·분할·BM25) | 메인 1 + libuv 4 | `UV_THREADPOOL_SIZE=4` |
| Ollama (토큰화·스케줄링) | 자동 | 연산은 GPU |
| 나머지 | OS·Nginx | — |

### 3.4 GPU

Metal에는 하드 분할이 없어서 GPU를 **시간 분할**로 나눠 쓴다. 서비스 인스턴스 안에서는 M3가 동시 4슬롯을 쓰고, M4는 문서당 1회 호출된다. 개인용 Ollama에서 큰 모델을 돌리면 서비스가 그만큼 느려지므로 운영 규칙으로 막는다(§7).

---

## 4. 서비스 Ollama 인스턴스

```bash
# ~/Library/LaunchAgents/kr.crd.ollama.plist → EnvironmentVariables (요지)
OLLAMA_HOST=127.0.0.1:11435          # 서비스 전용, loopback 만
OLLAMA_MODELS=/opt/crd/ollama-models # 개인 모델 저장소와 분리
OLLAMA_NUM_PARALLEL=4                # M3 동시 판정 슬롯
OLLAMA_MAX_LOADED_MODELS=2           # M3 + M4 만 상주
OLLAMA_KEEP_ALIVE=-1                 # 언로드하지 않음 — 첫 요청 지연 없음
OLLAMA_FLASH_ATTENTION=1
OLLAMA_DEBUG=0                       # 프롬프트가 로그에 남지 않게 (BR-MDL-01)
```

```bash
# 공식 원본 받기 (revision 고정) → bf16 GGUF 로 형식만 변환 → 서비스 인스턴스에 등록
huggingface-cli download Qwen/Qwen3-4B-Instruct-2507 --revision <sha> --local-dir /opt/crd/hf/qwen3-4b-instruct-2507
huggingface-cli download Qwen/Qwen3-1.7B             --revision <sha> --local-dir /opt/crd/hf/qwen3-1.7b
python llama.cpp/convert_hf_to_gguf.py /opt/crd/hf/qwen3-4b-instruct-2507 --outtype bf16 --outfile /opt/crd/gguf/m3-bf16.gguf
python llama.cpp/convert_hf_to_gguf.py /opt/crd/hf/qwen3-1.7b             --outtype bf16 --outfile /opt/crd/gguf/m4-bf16.gguf
OLLAMA_HOST=127.0.0.1:11435 ollama create crd-m3 -f model-server/modelfiles/M3.Modelfile
OLLAMA_HOST=127.0.0.1:11435 ollama create crd-m4 -f model-server/modelfiles/M4.Modelfile
```

- **형식 변환은 양자화가 아니다.** `--outtype bf16`은 가중치 값을 그대로 옮긴다. 공식 bf16 GGUF가 배포되어 있으면 그것을 받아 변환 단계를 생략한다[확인 필요].
- 변환본이 원본과 같은지는 §8-1로 확인한다.

```text
# model-server/modelfiles/M3.Modelfile  (Ollama Modelfile)
FROM /opt/crd/gguf/m3-bf16.gguf
PARAMETER temperature 0
PARAMETER top_k 1
PARAMETER seed 0
PARAMETER num_ctx 8192
PARAMETER num_predict 700
```

```text
# model-server/modelfiles/M4.Modelfile
FROM /opt/crd/gguf/m4-bf16.gguf
PARAMETER temperature 0
PARAMETER top_k 1
PARAMETER seed 0
PARAMETER num_ctx 32768
PARAMETER num_predict 600
```

---

## 5. 모델 상세 명세

### 5.1 M1 — 편법 탐지

| 항목 | 값 |
|---|---|
| 역할 | 법 조문을 직접 위반하지는 않지만 소비자에게 불리하게 우회·전가하는 **편법 조항** 점수화 (SD_01 3.1~3.3, 4.5) |
| 베이스 | `klue/roberta-base` (약 1.1억 파라미터, 12층, hidden 768, 최대 512토큰). 라이선스 [확인 필요] |
| 학습 | 팀 파인튜닝. FR-042 규칙(4범주 라벨링, 평가 데이터 분리·전문가 검수, 인위 변형 조항은 학습에만). 학습은 이 서버의 PyTorch **MPS**로 할 수 있다(수만 건 × 3에폭 기준 수십 분~수 시간, 추정) |
| 출력 헤드 | 다중 분류 8클래스: `none` + 위험 유형 7종(`rights_limit`, `liability_avoid`, `refund_cancel_limit`, `unilateral_change`, `excessive_penalty`, `vague`, `other` — data-model §2 코드) |
| 계약 응답 사상 | `score = 1 − P(none)`(소수 4자리), `type` = 확률 최대 유형, `label` = `loophole`/`none` |
| 입력 형식 | `"{계약유형 한글} [SEP] {조 제목} [SEP] {비식별 조항 원문}"`. 512토큰 초과분은 자른다 |
| 추론 | **CPU fp32**, 6스레드, 배치 16, 동적 패딩. 조항 100개 × 모델 2개 ≈ 2~4초(추정) |
| 결정성 | `torch.use_deterministic_algorithms(True)`, 점수 반올림. CPU에서 추론하므로 같은 입력에 같은 점수가 나온다(UC8 평가 재현성) |
| 체크포인트 | `{MODEL_ROOT}/m1-evasion-klue-roberta/` + `model_card.json` |
| 버전 문자열 | `loophole-klue-roberta-base@{학습 완료일}` |
| 호출 경로 | `/v1/jobs`(문서 단위, M2와 병렬), `/v1/detect/loophole`(조항 1건 재분석) |

### 5.2 M2 — 위법 탐지

| 항목 | 값 |
|---|---|
| 역할 | 범위 안 5개 법률(약관법·전자상거래법·소비자기본법·할부거래법·방문판매법) 위반 소지 **위법 조항** 점수화와 관련 법령 후보 |
| 베이스·학습·추론·결정성 | M1과 같다(별도 파인튜닝 체크포인트, 같은 게이트웨이 프로세스) |
| 출력 헤드 | 공유 인코더 + 헤드 2개: ① 이진(위법 소지 여부), ② 다중 레이블 5개(법률별) |
| 계약 응답 사상 | `score` = P(위법 소지), `related_laws` = 법률별 확률 0.5 이상(최대 3개), `type` = 최상위 법률. `related_laws`는 백엔드 근거 검색 가중치로 쓰인다(research R-09) |
| 체크포인트 | `{MODEL_ROOT}/m2-illegal-klue-roberta/` + `model_card.json` |
| 버전 문자열 | `illegal-klue-roberta-base@{학습 완료일}` |
| 호출 경로 | `/v1/jobs`, `/v1/detect/illegal` |

### 5.3 M3 — 최종판정

| 항목 | 값 |
|---|---|
| 역할 | 위험 후보 조항 + M1·M2 점수 + 백엔드가 검색한 근거 + 관점 + 지식 기준일 → 4범주·위험 유형·위험도·신뢰도·쉬운 설명(주장별 근거 ID) (3.5, 4.5, 4.8 재생성, 7.5 평가) |
| 배포본 | **`Qwen/Qwen3-4B-Instruct-2507`** 공식 원본(safetensors, Apache-2.0). `revision`에 커밋 SHA를 고정한다 |
| 구조 | 약 40억 파라미터, 36층, 어텐션 헤드 32 / KV 헤드 8, head_dim 128. 비사고 전용 모델이라 `enable_thinking` 설정이 필요 없다 |
| 정밀도 | **bf16** (양자화 없음). 가중치 약 8.1GB |
| 실행 | 서비스 Ollama(Metal), 모델명 `crd-m3` |
| 컨텍스트·동시 처리 | `num_ctx 8192`, 동시 4슬롯. 요청 규모: 지시문 약 400 + 조항 약 300 + 근거 5~10개 약 1,500 + 출력 상한 700 ≈ 3,000토큰 |
| 생성 설정 | `temperature 0`, `top_k 1`, `seed 0`, `num_predict 700` |
| 구조화 출력 | Ollama `/api/chat`의 `format`에 JSON 스키마를 넣는다(계약 `/v1/judge` 응답 형태). 설명 주장은 `maxItems 3`, `evidence_ids`는 요청 근거 ID의 `enum`으로 제한해 근거 없는 주장을 원천 차단한다(BR-EXP-04) |
| 후처리 | 게이트웨이 `postfilter.py`의 단정 표현 필터(BR-MDL-08). 백엔드 T062와 같은 사전을 쓴다 |
| 결정성 주의 | 동시 슬롯 배치 구성에 따라 부동소수 결과가 드물게 달라질 수 있다. 같은 조건의 재현은 백엔드 판정 캐시(`judgment` 5필드)가 보장한다(SC-008) |
| 버전 문자열 | `qwen3-4b-instruct-2507-bf16@{HF revision 앞 12자}` → 판정 캐시 키 `m3_model_version`. Ollama 모델 digest는 `model_card.json`에 함께 기록한다 |

### 5.4 M4 — 요약

| 항목 | 값 |
|---|---|
| 역할 | 비식별 조항 목록 → 계약 요약(핵심 조건·당사자 의무·해지/환불 조건) + 계약 유형 후보 (2.5). 실패해도 분석은 계속된다(UC1 E8) |
| 배포본 | **`Qwen/Qwen3-1.7B`** 공식 원본(Apache-2.0). `revision` 고정 |
| 구조 | 약 17억 파라미터, 28층, KV 헤드 8, head_dim 128. 사고/비사고 겸용 모델이다 |
| 정밀도 | **bf16**. 가중치 약 3.4GB |
| 실행 | 서비스 Ollama(Metal), 모델명 `crd-m4` |
| 사고 모드 | 요청마다 `think: false`(= `enable_thinking=False`, UC_00 §1.1 결정성 조건) |
| 컨텍스트 | `num_ctx 32768`. 30쪽 문서(약 2만 토큰)를 **자르지 않고** 요약한다 |
| 입력 절단 규칙 | 한도(컨텍스트 − 출력 − 지시문)를 넘는 긴 문서(예: 300쪽)는 **① 모든 조의 제목 목록 + ② 앞쪽 조항 본문 + ③ 해지·환불·위약금·변경 키워드를 포함한 조항 본문** 순으로 채운다 |
| 생성 설정 | `temperature 0`, `top_k 1`, `seed 0`, `num_predict 600`, JSON 스키마(`summary`, `contract_type_candidates[{label, score}]` — 라벨은 `contract_type_code` 6종 `enum`) |
| 버전 문자열 | `qwen3-1.7b-bf16@{revision 앞 12자}` |

> **주석 — 동시 슬롯**: `OLLAMA_NUM_PARALLEL`은 인스턴스 전체 설정이다. 그래서 M4도 4슬롯 분량의 KV 캐시(약 14.7GB)를 잡는다. 메모리가 넉넉해 그대로 둔다. 줄여야 하면 M4만 별도 인스턴스(`:11436`, `NUM_PARALLEL=1`)로 떼어 낸다.

### 5.5 게이트웨이 설정

```yaml
# model-server/config.yaml
server: { host: 127.0.0.1, port: 8000, workers: 1 }
model_root: /opt/crd/models
classifiers:
  device: cpu
  torch_threads: 6
  batch_size: 16
  max_length: 512
  score_decimals: 4
  m1: { path: m1-evasion-klue-roberta }
  m2: { path: m2-illegal-klue-roberta }
llm:
  base_url: http://127.0.0.1:11435
  m3: { model: crd-m3, timeout_sec: 60, concurrency: 4, json_schema: schemas/judge.json }
  m4: { model: crd-m4, timeout_sec: 90, think: false, json_schema: schemas/summarize.json }
limits: { max_clauses_per_job: 2000 }
logging: { body: false }        # 요청·응답 본문 기록 금지 — 요청 ID·엔드포인트·지연·상태만
```

`/health` 사상: 모델별 상태는 M1·M2 프로세스 내 적재 여부와 Ollama `/api/ps` 결과(`ready`/`loading`)로 정한다. `gpu.used_mb/total_mb`에는 `/api/ps`의 `size_vram` 합과 통합 메모리 총량을 보고한다.

### 5.6 `model_card.json` (모델 폴더마다)

```json
{
  "id": "M3",
  "name": "final-judge",
  "source": "Qwen/Qwen3-4B-Instruct-2507",
  "revision": "<commit sha>",
  "license": "Apache-2.0",
  "precision": "bf16",
  "model_version": "qwen3-4b-instruct-2507-bf16@<sha12>",
  "ollama_digest": "<crd-m3 digest>",
  "trained_data_date": null,
  "serving": { "runtime": "ollama", "device": "metal", "num_ctx": 8192, "parallel": 4 },
  "generation": { "temperature": 0, "top_k": 1, "seed": 0, "num_predict": 700, "structured_output": "json_schema" }
}
```

M1·M2의 `trained_data_date`에는 학습 데이터 기준일을 넣는다. `serving`은 `{ "runtime": "pytorch", "device": "cpu" }`로 적는다.

---

## 6. 이 서비스에 들어가는 모델 전체 목록

| # | 모델 | 실행 위치 | 용도 | 받는 곳 |
|:--:|---|---|---|---|
| 1 | M1 편법 탐지 | 게이트웨이, CPU | 편법 점수·유형 | 팀 파인튜닝 체크포인트 |
| 2 | M2 위법 탐지 | 게이트웨이, CPU | 위법 점수·관련 법령 | 팀 파인튜닝 체크포인트 |
| 3 | M3 최종판정 | 서비스 Ollama, Metal | 최종 분류·쉬운 설명 | `Qwen/Qwen3-4B-Instruct-2507` (bf16) |
| 4 | M4 요약 | 서비스 Ollama, Metal | 계약 요약·유형 후보 | `Qwen/Qwen3-1.7B` (bf16) |
| 5 | `klue/roberta-base` 원본 | 학습 시에만 (MPS) | M1·M2 파인튜닝 출발점 | `klue/roberta-base` |
| 6 | Tesseract 한국어 데이터 `kor.traineddata` | Node 백엔드, CPU | 스캔 PDF 문자 인식(FR-003) | tesseract.js 번들 — 비식별화 전 원문을 다루므로 백엔드 밖으로 보내지 않는다 |
| 7 | (모델 아님) 비식별화 | Node 백엔드 | 8종 가림(FR-006) | 규칙 기반 — research R-07 |
| 8 | (모델 아님) 근거 검색 | Node 백엔드 | BM25 + 명시 참조 | research R-09 |
| 9 | 모델 API 스텁 | `tools/model-api-stub` | 개발·CI | 모델 아님(결정적 가짜 응답) |

---

## 7. 운영

| 항목 | 할 일 |
|---|---|
| 상주 실행 | launchd: `kr.crd.ollama`(서비스 Ollama), `kr.crd.model-server`(게이트웨이). Node는 PM2 startup, Nginx는 `brew services`. 로그인 없이 뜨게 하려면 LaunchDaemon + 전용 사용자를 쓴다 |
| 기동 순서 | 서비스 Ollama → 게이트웨이(`/health`가 M3·M4 적재를 기다림) → Node |
| 전원·재시동 | 잠자기 방지와 정전 후 자동 재시동은 이미 켜져 있다. macOS **자동 업데이트 재시동을 끄고** 점검 시간에 수동 적용한다 |
| 외부 접속 | 공유기 포트포워딩(443만), DDNS, TLS 인증서(Let's Encrypt `certbot`), macOS 방화벽으로 443 외 차단 |
| GPU 경합 | 운영 시간에는 개인용 Ollama의 큰 모델 사용을 자제한다. 개인 인스턴스는 `OLLAMA_MAX_LOADED_MODELS=1`, `OLLAMA_KEEP_ALIVE=5m`으로 메모리를 빨리 돌려주게 한다 |
| 감시 | 게이트웨이 `/health` 1분 주기 확인, `ops:raw-retention`(원본 24시간 삭제 0건) cron, 실패 시 알림(메일·메신저 웹훅) |
| 백업 | 서비스 상태는 원격 MariaDB에 있다. 로컬에서는 모델 원본·GGUF·`model_card.json`, `.env`, Nginx·launchd 설정만 백업한다. 원본 계약서 파일은 24시간 삭제 대상이라 백업하지 않는다 |
| 모델 교체 | 새 `revision` 받기 → 변환 → `ollama create` → `model_card.json` 갱신 → 게이트웨이 재시작. 버전 문자열이 바뀌므로 판정 캐시가 자동으로 분리되고, 모델 교체 감지(9.6)가 탐지품질평가(UC8)를 권한다 |

---

## 8. 성능 추정과 착수 전 측정

### 8.1 추정 (30쪽 문서, 조항 100개, M3 호출 30회)

llama.cpp의 M1 Ultra 공개 측정치(7B 기준)를 모델 크기로 환산한 값이다. 측정치 자체도 기억에 의존한 값이라 [확인 필요]다.

| 단계 | 시간 |
|---|---|
| M1·M2 (CPU) | 2~4초 |
| M4 요약 (입력 2만 토큰, 출력 400토큰) | 8~15초 |
| M3 1건 (입력 2,000 + 출력 300토큰) | 약 5~7초 |
| M3 30건 (동시 4) | **약 60~85초** |
| 백엔드 처리 (추출·비식별·분할·검색·DB) | 약 10초 |
| **문서 1건** | **약 1분 30초~2분** |
| 분석 2건 동시 | 건당 **2분 30초~3분 30초** ⚠️ |
| 시간당 처리량 | 약 30~40건 |

- 한 건씩은 SC-009(3분) 안에 들어온다. **2건이 겹치면 3분을 넘길 수 있다.** 백엔드는 동시 분석 2건을 유지하되, M3 호출은 먼저 들어온 문서에 우선 배정한다(선입 우선).
- 맞는 용도: 시연, 내부 시범 운영, 동시 사용자 수 명 수준.

### 8.2 착수 전 측정

| # | 측정 | 합격 기준 |
|:--:|---|---|
| 1 | 공식 원본 `revision` 고정·다운로드. bf16 GGUF 변환본과 원본(transformers)의 출력 비교(temperature 0, 20건) | 분류·위험도 100% 일치 |
| 2 | M3 처리량: 판정 프롬프트 50건, 동시 1·2·4·6 | 30건 합계 ≤ 85초 |
| 3 | M4: 30쪽 표본 5건 전체 입력 | ≤ 15초 |
| 4 | 구조화 출력: Ollama `format` 스키마 준수율(판정 200건) | 스키마 위반 0건 |
| 5 | 전 흐름 SC-009 (tasks의 성능 측정 작업) — 단독, 2건 동시, 개인 모델 사용 중 | 95백분위 ≤ 3분 |
| 6 | 24시간 연속 부하 | 메모리 누수·스왑 없음, 재시작 없음 |

**2·5번이 불합격이면** 먼저 M3 슬롯을 6으로 늘려 다시 잰다. 그래도 부족하면 정밀도 변경(양자화)이나 장비 추가를 **팀 결정**으로 올린다. 어느 경우에도 백엔드와 모델 API 계약은 바뀌지 않는다.

### 8.3 측정 결과 — 공유 Ollama §0 구성 (2026-09-29 원래 표본, `model-server/scripts/bench.py`)

게이트웨이 `127.0.0.1:9542`, M3·M4 = 공용 `qwen3:4b-instruct-2507-q4_K_M`(Ollama 0.34.0, 동시 1건), M1·M2 = 키워드 휴리스틱(파인튜닝 체크포인트 전).
원자료는 `model-server/bench-results/*-20260929-*.json`(2026-09-28 축소 표본 결과도 같은 폴더에 남겨 둔다). 측정은 한 번에 하나씩 순차로 돌렸다(공유 Ollama 에 병렬 부하 금지).

| # | 측정 | 실행 | 결과 | 판정 |
|:--:|---|---|---|---|
| 1 | bf16 변환 일치 | **해당 없음** — §0 구성은 변환본을 쓰지 않는다(공용 q4_K_M). bf16 커스텀을 관리자와 협의해 쓰게 되면 그때 잰다 | — | 해당 없음 |
| 2 | M3 처리량 (판정 50건 × 클라이언트 동시 1·2·4·6, 예열 1건 제외) | 게이트웨이가 1건씩 직렬화 | 1건 중앙값 **2.74초**. 30건 환산 동시 1 **82.0** · 2 **83.9** · 4 **86.3** · 6 **80.8초**(대기 포함 중앙값 5.4·11.4·16.0초) | **경계** — 4조건 중 3개 합격, 동시 4 가 기준(≤ 85초)을 1.3초 초과 |
| 3 | M4 30쪽(조항 100개, 절단 규칙 적용) 5건 | 합성 문서 5건, **문서마다 본문이 달라** 프롬프트 캐시 미적중, 예열 1건 제외 | **8.31 · 8.60 · 8.44 · 8.57 · 8.68초** | 합격(≤ 15초) |
| 4 | 판정 스키마 준수율 | 200건(소비자·사업자 번갈아) | 위반 0건, HTTP 오류 0건 | 합격 |
| 5 | 전 흐름 SC-009 | `backend/tests/perf/sc009.test.ts`(T144) | 아래 8.4 | — |
| 6 | 24시간 연속 부하 | **미실행** — 공유 서버에 하루 동안 부하를 주므로 관리자와 시간대를 정한 뒤 `bench.py soak` | — | 보류(T150) |

- 2번: 게이트웨이가 M3 를 1건씩 직렬화하므로 네 조건은 같은 처리량을 네 번 잰 셈이다(80.8~86.3초, 편차 ±3%). 동시 4 의 초과는
  표본 간 변동 범위 안이다 — 실질적으로 **기준선 위에 걸쳐 있다**고 본다. 여유가 없으므로 문서 1건의 M3 호출 수가 30건을 넘으면 85초를 넘는다.
  M3 동시 수를 늘리는 것은 공유 Ollama 규칙(동시 1건)상 불가하므로, 더 줄여야 하면 M3 호출 대상 축소(M1·M2 임계값)나 판정 캐시 적중을 먼저 본다.
  SC-009 는 전 흐름 기준이라 8.4 결과로 판단한다.
- 2026-09-28 축소 표본(12건)의 77~78초보다 약 5% 느리다 — 표본 수·공유 서버 상태 차이로 본다.
- 적재 시간: 게이트웨이 기동 시 예열 1.1초(다른 사용자가 이미 올려 둔 상태). 완전히 내려간 뒤 첫 적재는 가이드 실측 10~30초 — 화면은 `warmup_estimate_sec`(크기 기반 추정과 관측값 중 큰 값)로 안내한다(§0.1).

### 8.4 SC-009 전 흐름 측정 — T144 (2026-09-29 원래 표본 20건)

`PERF_REAL_MODEL=1 PERF_SAMPLES=20 TEST_DB_NAME=crd_test_perf npx vitest run tests/perf/sc009.test.ts`(backend, 조건은 `PERF_CONDITIONS=solo|pair`).
30쪽 합성 문서(표본 약관 100조 → 조항 109개, 표본마다 문장을 바꿔 판정 캐시 미적중), 텍스트 입력, 요청 → 실행 완료까지(계약 유형은 즉시 확정).
게이트웨이 = §8.3 과 같은 구성(:9542). 원자료 `backend/tests/perf/results/sc009-2026-09-29T01-11-29-645Z.json`(2건 동시)·`…T01-27-22-487Z.json`(단독).

| 조건 | 표본 | 건별(초) | 95백분위 | SC-009(≤ 180초) |
|---|:--:|---|:--:|:--:|
| 단독 | 20 | 최소 40.8 · 중앙 43.9 · 최대 48.0 | **45.3초** | 합격 |
| 2건 동시 | 20(10쌍) | 먼저 끝나는 쪽 49.4~51.8 · 나중 쪽 80.0~81.7 | **81.6초** | 합격 |
| 다른 사용자 모델 사용 중 | — | 미측정 — 공유 서버 부하를 일부러 만들지 않았다. 운영 시간대 실측으로 대신한다 | — | 보류(T151) |

- 40건 모두 "분석 불가" 조항 0건, 조항 수 109개로 같다.
- 2건 동시는 두 갈래로 나뉜다(약 50초 / 약 81초). 공유 Ollama 가 M3 를 1건씩 처리하므로 뒤 문서가 앞 문서의 M3 호출을 기다린다(선입 우선, §8.1).
  2건이 겹쳐도 기준의 45% 수준이라 여유가 크다.
- 2026-09-28 축소 표본(단독 42.1초, 2건 동시 92.9초)과 같은 범위다.
- M1·M2 는 아직 휴리스틱이라 M3 호출 대상 수가 파인튜닝 모델과 다를 수 있다. 체크포인트가 나오면 같은 명령으로 다시 재고 이 표를 고친다(T152).
- 모델이 내려가 있던 첫 분석은 적재 시간(10~30초)이 더해진다. 그래도 단독 기준 3분 안이다.
- 측정 중 1회, 테스트 서버의 첫 요청이 다른 로컬 프로세스로 새어 404(빈 본문)가 났다. `tests/integration/setup.ts` `newAgent` 의
  `listen(0)`(전체 주소) ↔ supertest 의 `127.0.0.1` 접속 경합으로, 측정값과는 무관하다. 단독 조건만 다시 돌렸다.
