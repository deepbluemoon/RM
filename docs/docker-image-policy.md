# Docker 이미지·Docker Hub 규약

계약위험탐지 서비스(tamji)를 컨테이너로 빌드해 Docker Hub에 올리고 `compose.yaml`로 실행할 때의 기준이다. millia9님의 모델 게이트웨이 이미지 규약 초안(#17, PR #19)을 바탕으로, 공유 Ollama 전제를 걷어 내고 서비스 전체로 범위를 넓혔다. Dockerfile·compose 구현은 별도 이슈에서 이 기준을 따른다.

## 1. 구성

| 서비스 (compose) | 컨테이너 이름 | 이미지 | 내용 |
|---|---|---|---|
| `frontend` | `rm-frontend` | 직접 빌드 | 화면(정적 파일)과 `/api` 프록시 |
| `backend` | `rm-backend` | 직접 빌드 | Express 웹 서버: 로그인, 업로드, 문서 추출, 개인정보 가리기, 청크(조항 분할), RAG(근거 검색), 분석 흐름 |
| `model-server` | `rm-model-server` | 직접 빌드 | FastAPI 모델 게이트웨이: M1·M2 분류, LLM 외부 API 호출 |
| `mariadb` | `rm-mariadb` | 공식 `mariadb:12.0` | 데이터 저장. 직접 빌드하지 않는다 |

- 실행 정의는 저장소 루트의 `compose.yaml` 하나로 둔다.
- 컨테이너 이름은 운영 대시보드(`ops-dashboard/README.md`의 `OPS_NAME_PREFIXES`)와 맞춘다. 이름을 바꾸면 대시보드 설정도 함께 바꾼다.
- LLM(M3 판정·M4 요약)은 외부 API를 쓴다. 컨테이너에서 Ollama를 띄우거나 공유 Ollama에 접속하지 않는다.

## 2. Docker Hub 저장소와 태그

- 저장소는 팀 저장소 `moonsangjin/tamji` 하나를 쓰고, **태그 앞의 서비스 약어**로 이미지를 구분한다.

| 서비스 | 약어 | 예 |
|---|---|---|
| frontend | `fe` | `moonsangjin/tamji:fe-0.1.0` |
| backend | `be` | `moonsangjin/tamji:be-0.1.0` |
| model-server | `ms` | `moonsangjin/tamji:ms-0.1.0` |

- 태그 종류

| 태그 | 형식 | 용도 | 덮어쓰기 |
|---|---|---|---|
| 릴리스 | `<약어>-<버전>` (예: `be-0.1.0`) | 배포·compose에서 사용 | **금지** |
| 개발 빌드 | `<약어>-sha-<커밋 앞 12자리>` | 검증·추적 | 금지 |
| 최신 | `<약어>-latest` | `main` 기준 최신 릴리스를 가리킴 | 릴리스 때만 이동 |

- 버전은 `0.1.0`처럼 쓰고, 세 서비스가 같은 릴리스로 함께 검증됐을 때 같은 버전 번호를 붙인다.
- `compose.yaml`은 `latest`가 아니라 릴리스 태그를 가리킨다.
- push한 뒤에는 태그와 함께 **이미지 digest와 소스 커밋**을 PR이나 릴리스 기록에 남긴다. 롤백은 검증했던 digest로 한다.

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

- **첫 릴리스는 담당자가 직접 push한다.** `docker buildx build --platform linux/amd64,linux/arm64 --push`로 두 플랫폼을 한 번에 올린다. push 권한은 `moonsangjin` 계정 소유자가 부여한다.
- push 결과(태그, digest, 소스 커밋, 확인한 플랫폼)는 해당 PR에 남긴다.
- 안정되면 GitHub Actions 자동 빌드·push로 옮긴다(별도 `ci` 이슈). 이때 Docker Hub 접근 토큰은 GitHub Secrets에 두고, 새 이미지가 올라오면 팀 채널로 알림을 보낸다.

## 8. 검증

구현 PR에서 아래를 실행하고 결과를 통과 / 실패 / 미실행 / 차단 / 해당 없음으로 남긴다([작업 안내](01-issue-template/GUIDE.md)).

1. 두 플랫폼으로 빌드되고, digest를 기록했다.
2. Mac(arm64)과 Windows(amd64)에서 `docker compose up`으로 네 컨테이너가 모두 뜬다.
3. 모델 서버 `/health`에서 M1·M2가 heuristic이 아닌 실모델로 `ready`이고, 가상 조항으로 실제 추론을 확인했다.
4. LLM 외부 API 호출(M3·M4)을 확인했다. 확인하지 못했으면 스텁 결과와 구분해 적는다.
5. 화면에서 로그인 → 업로드 → 분석 → 결과까지 확인했다.
6. 이미지에 비밀값, 계약서 원문, 불필요한 데이터가 없다.

## 9. 아직 정하지 않은 것

- LLM 제공자(Gemini 등)와 호출 방식. 제공자를 설정만으로 바꿀 수 있도록 OpenAI 호환 방식을 검토한다.
- 임베딩(bge-m3) 대체. Ollama를 쓰지 않으면 RAG가 BM25만으로 동작하므로, 모델 서버에서 직접 실행할지 외부 API로 바꿀지 정한다.
- CI 자동화 시점, `sha` 태그 보존·삭제 기간, 베이스 이미지 갱신 주기와 취약점 점검 담당.

참고: [Docker 빌드 모범 사례](https://docs.docker.com/build/building/best-practices/), [멀티 플랫폼 빌드](https://docs.docker.com/build/building/multi-platform/), [uv의 Docker 사용 안내](https://docs.astral.sh/uv/guides/integration/docker/).
