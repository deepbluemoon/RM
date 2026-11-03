# Docker 이미지·Docker Hub 규약

계약위험탐지 서비스(tamji)를 컨테이너로 빌드해 Docker Hub에 올리고 `compose.yaml`로 실행할 때의 기준이다. millia9님의 모델 게이트웨이 이미지 규약 초안(#17, PR #19)을 바탕으로, 공유 Ollama 전제를 걷어 내고 서비스 전체로 범위를 넓혔다. Dockerfile·compose 구현은 별도 이슈에서 이 기준을 따른다.

## 1. 구성

| 서비스 (compose) | 컨테이너 이름 | 이미지 | 내용 |
|---|---|---|---|
| `frontend` | `rm-frontend` | 직접 빌드 | 화면(정적 파일)과 `/api` 프록시 |
| `backend` | `rm-backend` | 직접 빌드 | Express 웹 서버: 로그인, 업로드, 문서 추출, 개인정보 가리기, 청크(조항 분할), RAG(근거 검색), 분석 흐름 |
| `model-server` | `rm-model-server` | 직접 빌드 | FastAPI 모델 게이트웨이: M1·M2 분류, M3·M4 LLM 외부 API 호출, 임베딩 호출 중계 |
| `ollama` | `rm-ollama` | 직접 빌드 | 임베딩 전용 Ollama: bge-m3 를 구워 넣어 하이브리드 RAG 의 벡터를 만든다 |
| `mariadb` | `rm-mariadb` | 공식 `mariadb:12.0` | 데이터 저장. 직접 빌드하지 않는다 |

- 실행 정의는 저장소 루트의 `compose.yaml` 하나로 둔다.
- 컨테이너 이름은 운영 대시보드(`ops-dashboard/README.md`의 `OPS_NAME_PREFIXES`)와 맞춘다. 이름을 바꾸면 대시보드 설정도 함께 바꾼다.
- **LLM(M3 판정·M4 요약)은 외부 API(Vertex 등)를 쓴다.** 컨테이너에서 채팅 LLM 을 Ollama 로 띄우거나 공유 Ollama 에 접속하지 않는다.
- **임베딩(bge-m3)은 임베딩 전용 Ollama 컨테이너(`ollama`)로 띄운다.** bge-m3 를 이미지에 구워 넣어 런타임 다운로드 없이 동작한다. 이 서비스가 없거나 죽어도 근거 검색은 BM25 로 폴백한다. 공유 Ollama 에는 접속하지 않는다.

## 2. Docker Hub 저장소와 태그

### 버전 올리는 기준 — 유의적 버전(SemVer) `주.부.수` (#121)

| 올릴 버전 | 언제 | 우리 서비스에서의 예 | 예 |
|---|---|---|---|
| **주** (Major) | 받는 쪽이 손대야 하는 호환 깨짐 | `.env` 변수 이름 변경·삭제·필수 추가, compose 서비스 구성 변경, 되돌릴 수 없는 DB 마이그레이션, 모델 API 계약 변경 | `1.4.2` → `2.0.0` (부·수 0으로) |
| **부** (Minor) | 호환되는 기능 추가 | 새 화면·기능, 선택 변수 추가, 기존 데이터와 호환되는 DB 마이그레이션 | `1.4.2` → `1.5.0` (수 0으로) |
| **수** (Patch) | 호환되는 버그 수정 | 버그·문구 수정, 의존성 패치 | `1.4.2` → `1.4.3` |

- 운영 전에는 `0.y.z`(초기 개발 단계)로 `0.1.0`부터 시작하고, 실제 운영을 시작할 때 `1.0.0`을 붙인다.
- 네 이미지는 항상 **같은 버전으로 함께** 발행한다. 하나만 바뀌어도 함께 올린다. `.env`의 `TAMJI_VERSION` 하나가 함께 검증된 한 세트를 가리킨다.

### 저장소와 태그 이름

- 저장소는 팀 저장소 `moonsangjin/tamji` 하나를 쓰고, **태그 앞의 서비스 이름**으로 이미지를 구분한다. 태그는 `<서비스>-<주.부.수>` 하나뿐이다.

| 서비스 | 예 |
|---|---|
| frontend | `moonsangjin/tamji:frontend-0.1.0` |
| backend | `moonsangjin/tamji:backend-0.1.0` |
| model-server | `moonsangjin/tamji:model-server-0.1.0` |
| ollama | `moonsangjin/tamji:ollama-0.1.0` |

- **버전 태그는 덮어쓰지 않는다.** 이미 있으면 발행을 중단한다. 같은 날 다시 낼 때도 수 버전을 올린다.
- **이동 태그는 만들지 않는다.** `backend-0.1` 같은 부분 버전 태그와 `backend-latest`가 없다. 최신 버전은 `.env.example`의 `TAMJI_VERSION`과 GitHub Release로 확인한다.
- 개발 빌드는 Docker Hub에 올리지 않는다(CI 검증용 로컬 이미지, 개발용은 `compose.dev.yaml`로 각자 빌드).
- **커밋 추적**: 이미지에 OCI 라벨(`org.opencontainers.image.revision`·`version`·`created`·`source`)을 넣는다. `docker buildx imagetools inspect <이미지> --format '{{json .Image}}'`로 확인한다.
- **릴리스 기록**: 발행하면 git 태그 `v<주.부.수>`와 GitHub Release를 만든다. 본문에 소스 커밋, 이미지 digest, 마지막 DB 마이그레이션, 포함 PR을 남긴다. 롤백은 이전 버전으로 `TAMJI_VERSION`을 바꿔서 하되, 그 사이 DB 마이그레이션이 있으면 호환을 먼저 확인한다(마이그레이션은 앞으로만 적용된다).

## 3. 플랫폼

- 모든 직접 빌드 이미지는 **`linux/amd64`와 `linux/arm64`** 두 플랫폼으로 빌드해 한 태그(멀티 아키텍처)로 올린다. Windows·인텔 Mac·대부분의 서버는 amd64, Apple Silicon Mac은 arm64다. 받는 쪽은 자기 CPU에 맞는 이미지를 자동으로 받는다.
- 두 플랫폼 모두에서 실행을 확인한다. 확인하지 않은 플랫폼은 지원한다고 적지 않는다.
- 공식 `mariadb:12.0`은 두 플랫폼을 이미 제공한다.

## 4. 빌드 규칙

### 공통

- **멀티스테이지**로 빌드 도구와 실행 파일을 나누고, 실행 단계에는 실행에 필요한 파일만 명시적으로 복사한다.
- 베이스 이미지는 버전을 고정하고(가능하면 digest까지), 갱신할 때는 다시 검증한다. slim 계열을 우선하고, alpine은 네이티브 의존성을 확인한 뒤에만 쓴다.
- 빌드 컨텍스트는 저장소 루트로 한다(`model-server/config.yaml`이 `../shared/assertion-terms.json`을 참조하는 등 폴더 간 참조가 있다).
- `.dockerignore`로 `.git`, `node_modules`, `.venv`, 캐시, 로그, `.env`와 비밀 파일, `backend/var/`, 학습 데이터를 제외한다. `.dockerignore`만 믿지 않고 복사 대상을 명시한다.
- **이미지 레이어와 빌드 인자에 비밀값·계약서 원문·개인정보를 넣지 않는다.**
- 컨테이너는 고정 UID/GID의 일반 사용자로 실행한다.

### frontend

- 빌드 단계: Node 20에서 `npm ci` → `vite build`
- 실행 단계: nginx에 빌드 결과만 복사하고, `/api` 요청을 `backend`로 넘긴다.

### backend

- 빌드 단계: Node 20에서 `npm ci` → TypeScript 빌드
- 실행 단계: Node 20 slim에 운영 의존성과 빌드 결과만 둔다. 실행 중 읽는 저장소 파일(`shared/assertion-terms.json`, `specs/002-contract-risk-detection/contracts/model-api.openapi.yaml`, `backend/db/migrations/` 등)을 확인해 함께 복사한다.

### model-server

- Python 3.11 slim, `uv sync --frozen --no-dev --extra classifiers`.
- **torch는 CPU 전용 빌드를 쓴다.** Linux amd64에서 기본 torch는 GPU(CUDA) 라이브러리까지 받아 이미지가 수 GB 커진다. 지금도 CPU로 추론하므로 동작에 영향이 없다.
- 학습·평가 코드(`training/`, `reports/`, `scripts/`, `tests/`)는 넣지 않는다.

### ollama (임베딩 전용)

- `FROM ollama/ollama:<태그>` — 베이스 태그를 digest까지 고정한다(멀티아치 amd64+arm64 매니페스트).
- **빌드 단계에서 `ollama serve`를 백그라운드로 띄워 `ollama pull bge-m3`로 모델을 받아 이미지에 구워 넣는다(baked).** 런타임에 모델을 받지 않으므로 네트워크 없이 바로 동작한다.
- 모델은 `/root/.ollama`가 아니라 `OLLAMA_MODELS=/models`에 두고 고정 UID/GID(10001)의 비루트로 실행한다. **런타임에 볼륨으로 `/models`를 덮으면 구운 모델이 가려지므로 덮지 않는다.**
- 교차아치(arm64) 빌드는 빌드 단계에서 `ollama`를 QEMU로 실행하므로 느리다. 확인하지 않은 플랫폼은 지원한다고 적지 않는다(§3).
- 공개 모델만 담으므로 비밀값이 없다. 포트(11434)는 compose 내부 네트워크로만 연다.

## 5. 모델 가중치 (model-server 이미지에 포함)

- M1·M2 가중치는 **모델 서버 이미지에 포함**한다. `docker compose pull`만으로 실모델이 동작하게 하기 위해서다.
- **구동에 필요한 파일만** 넣는다. 모델마다 아래 5개이고, 합계는 약 886MB다(대부분 `model.safetensors`).

| 파일 | 쓰는 곳 |
|---|---|
| `config.json` | `AutoModelForSequenceClassification.from_pretrained` |
| `model.safetensors` | 위와 같음 (가중치) |
| `tokenizer.json`, `tokenizer_config.json` | `AutoTokenizer.from_pretrained` |
| `model_card.json` | 분류기 종류(`serving.kind`)·임계값 판정 |

- 경로: `model-server/var/models/model3/serving_ordneg/m1-evasion-klue-roberta/`, `m2-illegal-klue-roberta/`
- 빌드 전에 `git lfs pull`로 실제 파일을 받는다. **LFS 포인터만 있는 상태로 빌드하면 모델 서버가 heuristic으로 조용히 동작**하므로, 빌드 단계에서 `model.safetensors` 크기를 확인해 실패시킨다.
- 가중치를 fp16 등으로 줄이는 것은 이 규약에서 하지 않는다. 판정 임계값이 fp32 기준으로 맞춰져 있어 결과가 달라질 수 있으므로, 평가 사례와 비교 기준을 정한 별도 작업으로 다룬다(AGENTS.md).

## 6. 실행 규칙 (compose.yaml)

- 비밀값(DB 비밀번호, 세션 키, 원본 파일 암호화 키, 모델 API 키, LLM API 키)은 **실행 시 `.env`로 주입**한다. 저장소에는 `.env.example`만 둔다.
- 호스트에 공개하는 포트는 `frontend`만 둔다. `backend`·`model-server`·`mariadb`는 compose 내부 네트워크로만 통신한다.
- MariaDB 데이터는 이름 있는 볼륨에 둔다. 볼륨을 지우면 데이터가 사라지므로 백업 방법을 실행 문서에 적는다.
- DB 스키마는 백엔드의 마이그레이션(`backend/db/migrations/`)으로 만든다. 적용 시점(백엔드 기동 시 또는 별도 1회 실행)은 구현 이슈에서 정한다.
- `model-server`는 인스턴스 1개로 시작한다(메모리·외부 API 호출 제한). `mariadb`는 자동 확장하지 않는다(운영 대시보드 정책과 같음).
- 로그는 표준 출력으로 내보내고, 요청·응답 본문, 계약서 원문, 인증 정보는 기록하지 않는다.

## 7. push 절차

- **이미지 릴리스는 담당자가 직접 push할 수 있다.** `docker buildx build --platform linux/amd64,linux/arm64 --push`로 두 플랫폼을 한 번에 올린다. push 권한은 `moonsangjin` 계정 소유자가 부여한다.
- push 결과(태그, digest, 소스 커밋, 확인한 플랫폼)는 해당 PR에 남긴다.
- GitHub Actions(`.github/workflows/images.yml`, #84)가 네 이미지를 amd64·arm64 네이티브 러너에서 빌드하고 `compose.yaml`로 네 컨테이너를 띄워 확인한다.
  - PR·`main`: 빌드·확인만 하고 push하지 않는다.
- push: Actions 화면에서 수동 실행(Run workflow)하고 `push`를 켠 뒤, `release`에 버전(예: `0.1.0`)을 입력한다. `main`에서만 `<서비스>-<주.부.수>`를 발행한다. git 태그 `v<버전>`이나 버전 태그가 하나라도 이미 있으면 릴리스를 중단한다.
  - 발행이 끝나면 git 태그 `v<버전>`과 GitHub Release(소스 커밋·digest·마지막 DB 마이그레이션·포함 PR)를 자동으로 만든다. 실행 요약(Summary)에도 같은 표가 남는다.
  - 발행 뒤 `.env.example`의 `TAMJI_VERSION`을 새 버전으로 올리는 PR을 낸다.
- 관리자 작업: 저장소 Settings → Secrets and variables → Actions에 `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`(`moonsangjin/tamji` 쓰기 권한 접근 토큰)을 등록한다. 없으면 push 실행이 처음에 멈춘다.
- 모델 가중치(LFS)는 Actions 캐시에 두어 실행마다 LFS 대역폭을 쓰지 않게 한다. 새 이미지 알림 채널은 정해지면 워크플로의 "알림" 단계에 연결한다.

## 8. 검증

구현 PR에서 아래를 실행하고 결과를 통과 / 실패 / 미실행 / 차단 / 해당 없음으로 남긴다([작업 안내](01-issue-template/GUIDE.md)).

1. 두 플랫폼으로 빌드되고, digest를 기록했다.
2. Mac(arm64)과 Windows(amd64)에서 `docker compose up`으로 네 컨테이너가 모두 뜬다.
3. 모델 서버 `/health`에서 M1·M2가 heuristic이 아닌 실모델로 `ready`이고, 가상 조항으로 실제 추론을 확인했다.
4. LLM 외부 API 호출(M3·M4)을 확인했다. 확인하지 못했으면 스텁 결과와 구분해 적는다.
5. 화면에서 로그인 → 업로드 → 분석 → 결과까지 확인했다.
6. 이미지에 비밀값, 계약서 원문, 불필요한 데이터가 없다.

## 9. 릴리스 준비 체크

- [ ] 이전 릴리스 이후 변경을 보고 §2 기준표로 올릴 버전(주·부·수)을 정한다.
- [ ] 로컬 `.env`에 DB·세션·모델 API 비밀값을 설정하고, Vertex 인증 파일을 준비한다.
- [ ] `main` 커밋 SHA를 기록하고 Git LFS 가중치를 받은 뒤 네 이미지 모두 같은 소스 커밋으로 빌드한다.
- [ ] 네 이미지 각각 `linux/amd64`와 `linux/arm64` manifest를 확인한다.
- [ ] GitHub Release에 이미지별 태그(`frontend-<버전>`, `backend-<버전>`, `model-server-<버전>`, `ollama-<버전>`)와 digest가 기록됐는지 확인한다.
- [ ] `.env`의 `TAMJI_VERSION=<버전>`을 설정하고 `docker compose pull`이 네 이미지를 모두 받는지 확인한다.
- [ ] MariaDB·모델 서버·Ollama·백엔드·프런트엔드 healthcheck와 초기화 작업의 종료 코드를 확인한다.

## 10. 아직 정하지 않은 것

- LLM 제공자(Gemini 등)와 호출 방식. 제공자를 설정만으로 바꿀 수 있도록 OpenAI 호환 방식을 검토한다.
- 베이스 이미지 갱신 주기와 취약점 점검 담당.

> 임베딩(bge-m3)은 **임베딩 전용 Ollama 컨테이너(B안)**로 정했다(2026-11-03). 대안이던 모델서버 직접 실행(A)·외부 API(C) 대신, bge-m3 모델과 검색 코드를 그대로 두고 실행 위치만 컨테이너로 옮겨 코드 변경을 최소화한다. 구성은 §1·§4(ollama)를 따른다.

참고: [Docker 빌드 모범 사례](https://docs.docker.com/build/building/best-practices/), [멀티 플랫폼 빌드](https://docs.docker.com/build/building/multi-platform/), [uv의 Docker 사용 안내](https://docs.astral.sh/uv/guides/integration/docker/).
