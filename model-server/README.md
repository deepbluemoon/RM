# model-server — 로컬 모델 게이트웨이

`specs/002-contract-risk-detection/contracts/model-api.openapi.yaml` 계약을 구현하는 FastAPI 게이트웨이다.
M1(편법)·M2(위법)는 프로세스 안에서 CPU 로, M3(최종판정)·M4(요약)는 서버의 **공유 Ollama** 로 실행한다.
구성 근거: `specs/002-contract-risk-detection/model-serving.md` §0 (공유 Ollama 적용 구성).

## Git LFS 모델 준비

M1·M2 가중치(`model.safetensors`)는 Git LFS로 관리한다. Git LFS를 설치한 후 저장소 루트에서 `git lfs install`과 `git lfs pull`을 실행한다. 가중치가 LFS 포인터 텍스트로 남아 있으면 실모델을 사용할 수 없다. 각 모델 카드·토크나이저·설정은 가중치와 함께 유지한다.

기본 `MODEL_ROOT`는 `model-server/var/models/model3/serving_ordneg`이다. 환경변수 `MODEL_ROOT`가 설정되어 있으면 기본값보다 우선하므로 각 모델 디렉터리가 직접 들어 있는 경로로 지정한다. 별도의 심볼릭 링크는 필요하지 않다.

실모델에는 `uv sync --frozen --extra classifiers`가 필요하다. `/v1/models`에서 M1·M2 이름·버전을 확인하고 실제 추론을 수행한다. 모델 파일이 있거나 `/health`가 ready인 것만으로 실모델 추론 성공을 뜻하지 않는다. M3·M4, Ollama, DB 및 지식 스냅숏 준비는 별도다.

## 실행

```bash
cd model-server
cp .env.example .env            # MODEL_API_KEY 를 채운다(백엔드 MODEL_API_KEY 와 같은 값). .env 는 git 에 올리지 않는다
uv sync --frozen --extra classifiers  # 실모델 M1·M2 의존성 포함
uv run uvicorn app.main:app --host 127.0.0.1 --port 9542 --workers 1 --no-access-log
uv run pytest                   # Ollama 는 목 — 실제 서버를 부르지 않는다
```

`uv sync` 가 만든 `.venv` 가 이 서비스의 가상환경이다(uvicorn 포함). 모델은 가상환경 안(M1·M2, CPU)과 공유 Ollama(M3·M4)
두 곳에서만 불러온다.

백엔드는 `backend/.env` 에 `MODEL_API_BASE_URL=http://127.0.0.1:9542`, `MODEL_API_KEY=<같은 값>`,
`MODEL_LLM_TIMEOUT_SEC=300`, `JUDGE_CONCURRENCY=1` 을 둔다. 개발·CI 는 `tools/model-api-stub` 를 같은 주소로 쓸 수 있다.

> **포트 (2026-09-28 확인)**: 이 공유 서버에서는 `127.0.0.1:8000` 을 다른 계정 프로세스가 쓴다. 게이트웨이 기본 포트는
> `9542` 이다(`config.yaml`, `install_launchd.sh`). 개발용 스텁(`tools/model-api-stub`)도 기본 9542 이다 — 스텁과 게이트웨이 중 하나만 띄운다.

상주 실행(로그인 세션): `./scripts/install_launchd.sh install` → `~/Library/LaunchAgents/kr.crd.model-server.plist`.
운영 가이드라인·사용자 매뉴얼·서비스 점검: `docs/GUIDELINE.md`, `docs/USER_MANUAL.md`, `scripts/service_test.py`.
가상환경을 다시 맞출 때는 `uv sync --frozen --extra classifiers` (extra 없이 돌리면 torch 가 지워져 M1·M2 가 휴리스틱으로 바뀐다).
**Ollama 용 plist 는 없다.** 공유 서버(`127.0.0.1:11434`)를 쓰며 이 계정에서 `ollama serve` 를 띄우지 않는다.

## 공유 Ollama 규칙 (`docs/ollama-guide.md` — 코드에 반영됨)

| 규칙 | 구현 위치 |
|---|---|
| 주소·모델 이름은 env (`OLLAMA_URL`, `OLLAMA_M3_MODEL`=`OLLAMA_M4_MODEL`=`qwen3:4b-instruct-2507-q4_K_M` — 채팅 모델 1개, 공용 A등급) | `app/config.py` |
| 런타임은 `/api/version`·`/api/tags`·`/api/ps`·`/api/chat`·`/api/generate`(예열)만 호출. pull·create·delete·copy·push·stop·serve 없음 | `app/ollama_client.py` `ALLOWED_PATHS` |
| 요청마다 `keep_alive "5m"`, `think false`, `stream false`, `num_ctx 8192`(고정), temperature 0·top_k 1·seed 0, `format`=JSON 스키마 | `app/llm.py` `_body` |
| 게이트웨이 전체 동시 1건(예열 포함) — 대기 수는 `/health.queue_depth` | `OllamaClient` 세마포어 |
| 타임아웃 300초. 연결 오류·시간 초과·5xx 만 3초·6초 간격 최대 3회. 4xx(404 포함)는 재시도 없이 503 | `OllamaClient._call` |
| 출력에 `</think>` 가 있으면 그 앞부분 제거(가이드 2.2 `_strip_think`) | `app/llm.py` `strip_think` |
| 상태 조회(`/api/version`·`/api/tags`·`/api/ps`)는 60초 캐시 — `/health` 를 자주 불러도 upstream 조회는 늘지 않는다 | `Inventory` |
| 미리 올리기는 기동 시 1회만(`OLLAMA_WARMUP_ON_START`) | `LlmService.start_warmup` |
| 설정 검증: num_ctx ≠ 8192, num_predict > 1024, keep_alive > 5m 또는 -1, concurrency ≠ 1, timeout < 300, 상태 캐시 < 60초, M3·M4 모델이 다름, 사용 금지 모델(`qwen3:4b`·`gemma3:12b`·`:cloud`·`-64k`·`-128k`) → 시작 거부 | `config.validate` |

`OLLAMA_M3_FALLBACK`·`OLLAMA_M4_FALLBACK`(예: `gemma3:4b`)는 **주 모델이 설치되지 않았을 때만** 쓴다.
이때 `model_version` 은 `ollama:<이름>` 이 되어 백엔드 판정 캐시가 주 모델 결과와 섞이지 않는다.

## 적재(콜드 스타트) 처리

공유 서버는 5분간 쓰지 않은 모델을 내린다. 첫 호출에는 적재 시간(가이드 1.4 실측 10~30초)이 더해진다.
`/health` 는 60초 캐시한 `/api/tags`(설치)·`/api/ps`(상주)와 **자기 호출 기록**(마지막 성공 + keep_alive 5분)으로
모델별 상태를 보고한다.

| state | 뜻 | 전체 status |
|---|---|---|
| `ready` | 상주 중(최근 5분 안에 응답했거나 `/api/ps` 에 있음) | ready |
| `cold` | 설치됐지만 내려가 있음 — 호출 가능, 첫 호출에 적재 시간 추가(G5 아님) | ready |
| `loading` | 예열 중이거나 cold 모델을 부르는 중(M3·M4) / 적재 중(M1·M2) | M1·M2 적재 중이면 loading |
| `missing` | 주 모델·대체 모델 모두 미설치(호출이 404 를 받으면 즉시 반영) | degraded (→ 백엔드 G5) |
| `error` | Ollama 연결 불가(호출이 연결 오류를 받으면 즉시 반영) | degraded |

- `warmup_estimate_sec` = cold/loading 모델(서로 다른 이름 — M3·M4 가 같으면 한 번)마다 `max(10, ceil(크기GB × 3))`.
  이보다 긴 `load_duration` 을 관측하면 그 값을 쓴다(짧은 관측으로 줄이지 않는다). cold 모델이 없으면 `null`.
- `queue_depth` = 게이트웨이 안에서 Ollama 호출(동시 1건)을 기다리는 요청 수. 백엔드가 "앞 요청 처리 중" 안내에 쓴다.
- 예열: 게이트웨이 **기동 시 1회만** 빈 프롬프트 `/api/generate`(`keep_alive 5m`, `num_ctx 8192`)로 올린다.
  이미 상주 중이면 건너뛴다. 요청마다 예열하지 않는다 — 요청 자체가 `keep_alive` 를 연장한다.
- 백엔드는 이 값으로 `GET /api/analyses/{id}` 의 `modelNotice`(`cold_start`·`loading`·`queue`)를 만들고, 화면(S1 C11, S2·S3
  진행 줄, S9 서버 상태)에 준비 시간을 안내한다.
- HTTP: `/health` 는 status=ready 일 때 200, loading·degraded 일 때 503(계약).

## 모델 준비 — 기본 구성은 없음 (bf16 커스텀은 관리자 협의 시 수동 1회)

기본 구성은 서버에 이미 설치된 공용 `qwen3:4b-instruct-2507-q4_K_M` 을 쓰므로 받거나 만들 모델이 없다.
관리자와 협의해 bf16 커스텀을 쓰기로 한 경우에만 아래를 배포 전 한 번 실행한다(예상 소요는 M1 Ultra 기준 추정).
런타임 코드는 모델을 만들지 않는다. 등록 후 `OLLAMA_M3_MODEL`·`OLLAMA_M4_MODEL` 을 **같은 이름 하나**로 둔다.

| 단계 | 명령 | 예상 소요 |
|---|---|---|
| 0 | `models.lock.yaml` 의 `<commit-sha>` 를 HF 커밋 SHA 로 고정 | — |
| 1 원본 받기 | `uv sync --extra tools && uv run python scripts/fetch_models.py` | M3 8.1GB·M4 3.4GB — 회선에 따라 수 분~수십 분 |
| 2 bf16 변환 | `LLAMA_CPP=~/src/llama.cpp uv run python scripts/convert_bf16.py` | M3 3~5분, M4 1~2분 (+ SHA-256) |
| 3 등록 | `./scripts/provision_models.sh` (`DRY_RUN=1` 로 점검만 가능) | M3 1~3분, M4 30초~1분 |
| 4 검증 | 스크립트가 1회 호출 — 첫 적재 포함 | M3 20~40초, M4 10~20초 |

`provision_models.sh` 는 `ollama list` 로 같은 이름을 확인하고(있으면 건너뜀), GGUF 가 10GB 이하인지, 이름이
`$(whoami)-` 로 시작하는지 확인한 뒤 `ollama create` 를 부르고 단계별 소요 시간을 출력한다. 새 버전은 `:v2` 로 만들고
env 의 모델 이름만 바꾼다(`model_version` 이 바뀌어 판정 캐시가 분리된다).

## M1·M2

`{MODEL_ROOT}/loophole-klue-roberta-base/`·`illegal-klue-roberta-base/`(+ `model_card.json`)와 `uv sync --extra classifiers`
가 있으면 PyTorch CPU fp32(6스레드, 배치 16, 512토큰, 결정적)로 추론한다. 없으면 키워드 휴리스틱
(`loophole-heuristic@2026-09-28`, `illegal-heuristic@2026-09-28`)으로 파이프라인을 끝까지 돌릴 수 있다.
파인튜닝은 `training/README.md`.

## 로그

요청 ID·메서드·경로·상태·지연만 남긴다(BR-MDL-01). 요청·응답 본문, 검증 오류의 입력값, Ollama 요청 본문은 남기지 않는다.
응답 헤더 `x-request-id` 로 백엔드 로그와 맞춘다.

## 측정

`scripts/bench.py` — model-serving §8.2 의 1~4·6번(동시 1건 구성). 공유 서버라 사용자가 적은 시간대에 돌린다.
