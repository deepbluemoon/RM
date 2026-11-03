# Docker Compose 실행 안내

컨테이너(프런트·백엔드·모델 서버·임베딩 Ollama·MariaDB)를 `compose.yaml`로 함께 띄우는 방법이다. 이미지 규칙은 [Docker 이미지 규약](docker-image-policy.md), LLM 설정은 [Gemini·Vertex 가이드](gemini-vertex-setup.md)를 따른다. Windows·Mac 모두 같은 파일로 실행한다.

## 1. 구성

| 서비스 | 컨테이너 | 내용 | 외부 공개 |
|---|---|---|---|
| `frontend` | `rm-contract-risk-frontend-1` | 화면, `/api`를 백엔드로 전달 | `127.0.0.1:8080` |
| `backend` | `rm-contract-risk-backend-1` | Express 웹 서버 | 없음 |
| `model-server` | `rm-contract-risk-model-server-1` | M1·M2 분류, M3·M4(Vertex), 임베딩 중계 | 없음 |
| `ollama` | `rm-contract-risk-ollama-1` | 임베딩 전용 Ollama(bge-m3 baked) — 하이브리드 RAG 벡터 | 없음 |
| `mariadb` | `rm-contract-risk-mariadb-1` | DB (공식 `mariadb:12.0`) | 없음 |
| `backend-init` | `rm-contract-risk-backend-init-1` | 1회 초기화: 마이그레이션 → 최초 지식 적재. 끝나면 종료(0) | 없음 |
| `backend-embed` | `rm-contract-risk-backend-embed-1` | 1회성: 초기 근거 벡터 적재(ollama·model-server 준비 후). 끝나면 종료(0) | 없음 |

| 파일 | 용도 |
|---|---|
| `compose.yaml` | 범용. 팀원 PC와 운영 서버 공통. Docker Hub 이미지를 받아 실행(로그·자원 제한, 개발 로그인 끔). 서버마다 다른 값은 `.env`로 |
| `compose.dev.yaml` | 개발. 범용 위에 겹쳐 직접 빌드·개발용 로그인·디버깅 포트. **운영 서버에서는 쓰지 않는다** |
| `compose.local.yaml` | 로컬 빌드. Docker Hub 백엔드 이미지가 소스보다 오래됐을 때 이 PC에서 빌드한 백엔드·프런트 이미지로 바꿔 띄운다(개발용 로그인은 켜지 않음, 4절) |
| `.env.example` | 환경 변수 예시. 복사해 `.env`로 쓴다(`.env`는 git 제외) |

## 2. 준비

1. Docker Desktop(Windows는 WSL2)
2. `.env` 만들기

   ```bash
   cp .env.example .env
   ```

   | 꼭 채울 값 | 내용 |
   |---|---|
   | `DB_PASSWORD`, `DB_ROOT_PASSWORD` | 사용자가 생성해 `.env`에 넣는 DB 비밀번호. MariaDB가 자동으로 알려주는 값이 아니다. |
   | `SESSION_SECRET`, `RAW_FILE_KEY` | 각각 64자리 hex (`openssl rand -hex 32`) |
   | `MODEL_API_KEY` | 임의 값(백엔드·모델 서버 공용) |
   | `VERTEX_PROJECT` | GCP 프로젝트 ID |
   | `GCP_CREDENTIALS_FILE` | Vertex 인증 파일 경로(아래 3절) |

   값이 빠지면 `docker compose`가 어떤 값이 필요한지 알려 주고 멈춘다.

   비밀번호는 터미널에서 생성해 `.env`에 직접 입력한다. 예를 들어 Mac의 zsh에서 각각 실행한다.

   ```bash
   openssl rand -hex 32
   openssl rand -hex 32
   ```

   첫 번째 값을 `.env`의 `DB_PASSWORD`, 두 번째 값을 `DB_ROOT_PASSWORD`에 붙여 넣고 저장한다. 기존 `.env`가 있으면 덮어쓰지 말고 필요한 항목만 수정한다.

   `SESSION_SECRET`, `RAW_FILE_KEY`, `MODEL_API_KEY`도 같은 방식으로 생성한다. `.env`에는 실서비스 비밀값을 넣고 GitHub·채팅·이슈에는 올리지 않는다.

## 3. Vertex 인증 연결

모델 서버는 Vertex(Google Cloud)로 M3·M4를 호출한다. 컨테이너는 이 PC의 gcloud 인증을 볼 수 없으므로, 인증 파일을 **읽기 전용으로 연결**한다(compose의 `secrets`, 컨테이너 안 `/run/secrets/gcp-credentials`).

- 개인 ADC: `gcloud auth application-default login` 후 생성된 파일
  - Windows: `C:/Users/<계정>/AppData/Roaming/gcloud/application_default_credentials.json`
  - Mac·Linux: `/Users/<계정>/.config/gcloud/application_default_credentials.json` (`~` 대신 절대 경로)
- 또는 관리자가 준 서비스 계정 키 파일

`.env`의 `GCP_CREDENTIALS_FILE`에 그 경로를 적는다. 인증 파일은 이미지·저장소·이슈에 올리지 않는다. 권한 설정은 [Gemini·Vertex 가이드 §4](gemini-vertex-setup.md)를 따른다.

## 4. 실행

### 받아서 실행 (기본)

`.env.example`의 `TAMJI_VERSION`은 현재 최신 릴리스 버전(`0.1.0`, 주.부.수)이다. Docker Hub에는 `frontend-<버전>`, `backend-<버전>`, `model-server-<버전>`, `ollama-<버전>`이 같은 버전으로 발행된다. 새 버전이 발행되면(GitHub Release) `.env`의 `TAMJI_VERSION`만 바꾼다. 주 버전이 올랐으면 Release 본문에서 바꿀 설정을 먼저 확인한다.

```bash
docker compose pull
docker compose up -d
docker compose ps        # backend·model-server·ollama·mariadb 가 healthy, backend-init·backend-embed 가 Exited (0)
```

`backend-init`, `backend-embed`는 초기화가 끝나면 `Exited (0)`인 일회성 작업 컨테이너다. 종료 코드와 필요한 로그를 확인한 뒤 목록을 정리하려면 다음을 실행한다. 컨테이너만 제거하며 DB·업로드 볼륨은 유지된다. 실패했거나 원인을 더 조사할 때는 로그 확인 전까지 남겨 둔다.

```bash
docker compose rm -f backend-init backend-embed
```

브라우저에서 `http://localhost:8080` (포트는 `.env`의 `FRONTEND_PORT`).

벡터는 MariaDB의 `evidence_embedding` 테이블에 저장된다. 기본 `db-data` named volume(또는 `.env`의 `DB_DATA`)에 함께 영속화되므로, 별도의 벡터 파일 볼륨은 필요하지 않다. 초기 적재는 `backend-embed`가 수행한다.

### 직접 빌드해서 실행 (개발)

```bash
docker compose -f compose.yaml -f compose.dev.yaml up -d --build
```

- 이미지를 소스로 빌드한다(로컬 태그 `tamji-local/*`). Docker Hub에 이미지가 없어도 된다.
- 개발용 로그인이 켜진다. **로그인 화면에는 버튼이 없으므로** 주소로 들어간다: `http://localhost:8080/api/auth/dev/start?devSubject=<아무 이름>` → 사용자 권한으로 로그인된다.
- 디버깅 포트: 백엔드 `127.0.0.1:19522`, DB `127.0.0.1:13306`

### backend 이미지에 초기 임베딩 스크립트가 없을 때

`backend-embed` 로그에 `Cannot find module '/app/backend/scripts/embed-evidence.js'`가 나오면 Docker Hub backend 이미지가 현재 Dockerfile보다 오래된 것이다. 현재 소스로 backend 이미지를 한 번 빌드한 뒤 로컬 오버레이를 적용한다. 이 방법은 개발용 로그인 설정을 켜지 않는다.

```bash
docker build -f backend/Dockerfile -t tamji-local/backend:local .
docker build -f frontend/Dockerfile -t tamji-local/frontend:local .
docker compose -f compose.yaml -f compose.local.yaml up -d
docker compose ps --all
```

`compose.local.yaml`은 `backend`, `backend-init`, `backend-embed`, `frontend`를 로컬 이미지로 바꾼다. DB 볼륨은 유지되며, 임베딩 작업은 빠진 벡터만 채운다. 이 문제를 고친 이미지(`0.1.1` 이상, #125)가 Docker Hub에 올라오면 `.env`의 `TAMJI_VERSION`을 그 버전으로 바꾸고 기본 `docker compose up -d`로 돌아간다.

### DB 비밀번호와 계정 만들기

MariaDB 계정 비밀번호는 `.env`의 `DB_PASSWORD`이며, root 비밀번호는 `DB_ROOT_PASSWORD`다. 컨테이너 안에서 새 비밀번호를 조회하는 구조가 아니므로, 기동 전에 직접 생성해 `.env`에 보관한다. 컨테이너를 처음 만든 뒤 값을 바꾸면 이미 초기화된 DB 볼륨의 비밀번호는 자동 변경되지 않는다. 기존 볼륨의 비밀번호 변경은 MariaDB 내부에서 별도로 수행해야 한다.

새로 띄운 DB에는 애플리케이션 계정이 없다. 로그인 화면의 아이디·비밀번호로 들어가려면 아래처럼 운영자 계정을 만들거나, 화면의 **회원가입**으로 사용자 계정을 만든다.

```bash
docker compose exec -e CRD_NEW_PASSWORD='<비밀번호>' backend \
  node scripts/admin-create-account.js --login-id <아이디> --name "<이름>" --role operator
```

### 끄기

```bash
docker compose down        # 컨테이너만 지운다. DB·업로드 데이터(볼륨)는 남는다
docker compose down -v     # 주의: 볼륨까지 지워 DB 데이터가 사라진다
```

### 운영 서버에서 실행

운영 서버도 PC와 같은 `compose.yaml`로 띄운다(#118). 서버에서 이미지를 빌드하지 않고 Docker Hub 이미지를 받는다.

```bash
docker compose pull
docker compose up -d
```

`compose.yaml`에 이미 들어 있는 것(모든 환경 공통):

| 항목 | 기본값 |
|---|---|
| 로그 | 컨테이너마다 10MB × 5개까지 |
| 개발 로그인 | 끔(`NODE_ENV=production`, `AUTH_DEV_PROVIDER=false`). 코드에서도 production이면 켜지지 않는다 |
| 자원 제한 | mariadb 1GB·1CPU, model-server 2GB·2CPU, ollama 2GB·1CPU, backend 1GB·1CPU, frontend 256MB·0.5CPU (임시값, 최대 사용량 상한) |
| 로그 수준 | `info` |
| PC에 여는 포트 | 프런트뿐 |

**운영 서버 체크리스트** — 서버의 `.env`에 맞춘다.

| 항목 | 설정 |
|---|---|
| 쿠키 | **`COOKIE_SECURE=auto`** — HTTPS 앞단(리버스 프록시·로드밸런서)이 있을 때. 기본(`off`)은 PC용 HTTP 설정이다 |
| 공개 범위 | `FRONTEND_BIND`·`FRONTEND_PORT`(프록시가 같은 서버면 `127.0.0.1` 유지) |
| 주소 | `APP_BASE_URL`(서비스 도메인) |
| 이미지 버전 | `TAMJI_VERSION`(검증한 태그) |
| Vertex 인증 | 개인 ADC 대신 서비스 계정 키 파일을 `GCP_CREDENTIALS_FILE`로 |
| 자원 제한 | 서버 사양에 맞춰 `LIMIT_<서비스>_CPUS`·`LIMIT_<서비스>_MEMORY`(예: `LIMIT_MODEL_SERVER_MEMORY=4g`) |
| 근거 정기 수집 | 고정 공인 IP 서버에서 `KNOWLEDGE_CRON`·API 키 설정(6절) |

`compose.dev.yaml`은 운영 서버에서 쓰지 않는다(비밀번호 없는 개발용 로그인·DB 포트가 켜진다).

## 5. 데이터와 백업

- DB 데이터는 이름 있는 볼륨 `rm_db-data`, 업로드 원본 임시 보관·지식 스테이징은 `rm_backend-var`에 있다.
- DB를 폴더에 두려면 `.env`에 `DB_DATA=./data/mariadb` (Windows·Mac에서는 느릴 수 있다).
- 백업과 복원:

  ```bash
  docker compose exec mariadb sh -c 'mariadb-dump -uroot -p"$MARIADB_ROOT_PASSWORD" --single-transaction --routines --triggers crd' > backup.sql
  docker compose exec -T mariadb sh -c 'mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" crd' < backup.sql
  ```

  `backup.sql`은 저장소에 올리지 않는다.

## 6. 근거 정기 수집

외부 공공 API(법령·공정위·표준약관·소비자원)는 웹훅을 제공하지 않아 정기 수집(cron)으로 확인한다.

- `.env`에 `KNOWLEDGE_CRON=0 6 * * *`(매일 06:00, 한국 시간)과 API 키(`LAW_API_OC` 등)를 넣는다. 백엔드는 `TZ=Asia/Seoul`로 실행된다.
- 법령 API의 일자별 개정 이력은 전일 기준(D+1)으로 제공되므로 아침 수집이면 전날 변경까지 받는다. 공식 갱신 시각은 공개돼 있지 않다. 낮 동안 반영분까지 당일에 받으려면 `0 6,18 * * *`.
- 법제처 Open API는 신청 시 호출 서버의 공인 IP·도메인 등록이 필요할 수 있다. 정기 수집은 고정 공인 IP가 있는 서버에서 켜고, 그 전까지는 비워 두고 S0 수동 수집을 쓴다.
- 수집한 자료는 운영자가 S0 화면에서 승인해야 반영된다. 긴급한 경우 S0에서 바로 수동 수집한다.
- 비워 두면 정기 수집을 하지 않는다.
- 수집·반영 결과(수집 실패, 검토 대기, 변경 없음, 반영 완료)는 백엔드 로그에 `knowledge event`로 남는다(#99). 반영 완료 뒤에는 새 근거의 벡터를 자동으로 채운다(하이브리드 검색을 쓸 때, 실패해도 BM25로 검색). 팀 채널 알림 등 받는 곳은 `backend/src/modules/knowledge/subscribers.ts`에 구독자를 추가해 늘린다.

## 7. 알아둘 점

- **근거 검색은 BM25 + bge-m3 벡터 하이브리드다(#98).** 임베딩은 `ollama` 컨테이너가 계산하고, 처음 기동할 때 `backend-embed`가 근거 벡터를 채운다. 벡터가 없거나 Ollama를 쓸 수 없으면 자동으로 BM25만 쓰고 분석은 계속된다.
- **기본은 HTTP 구성이다.** 백엔드는 `COOKIE_SECURE=off`, `TRUST_PROXY=loopback, uniquelocal`로 실행된다(#66). HTTPS 앞단을 두는 운영 서버는 `.env`에 `COOKIE_SECURE=auto`를 넣는다(4절 "운영 서버 체크리스트").
- **arm64(Apple Silicon)** 이미지는 규칙상 함께 올린다. 이미지가 아직 amd64만 있으면 Mac에서는 에뮬레이션으로 느리게 동작할 수 있다.
- Vertex 인증 파일이 없거나 쓸 수 없으면 모델 서버 `/health`가 M3·M4를 `error`로 표시하고(1분마다 다시 확인), 이유는 모델 서버 로그에 남는다. 이때는 3절을 확인한다.

## 8. 자주 겪는 문제

| 증상 | 원인 | 해결 |
|---|---|---|
| `required variable … is missing a value` | `.env` 값 누락 | 메시지에 나온 값을 `.env`에 채운다 |
| `backend-init` 가 Exited (1) | DB 접속·마이그레이션 실패 | `docker compose logs backend-init` 확인 |
| 로그인 후 바로 로그아웃됨 | HTTPS 없이 `COOKIE_SECURE=on/auto` | HTTP 구성에서는 `COOKIE_SECURE=off` |
| 판정 단계에서 실패 | Vertex 인증 파일·권한 | 3절, [Gemini·Vertex 가이드 §7](gemini-vertex-setup.md) |
| 같은 네트워크의 다른 기기에서 접속 안 됨 | 기본은 이 PC 전용 | `.env`에 `FRONTEND_BIND=0.0.0.0` (노출 범위 주의) |
| 포트 충돌 | 8080·19522·13306 사용 중 | `.env`의 `FRONTEND_PORT`·`DEV_BACKEND_PORT`·`DEV_DB_PORT` 변경 |

## 9. 기동·종료 시간

`compose.yaml`의 기동 유예(`start_period`)와 종료 유예(`stop_grace_period`)는 아래 측정값을 근거로 정했다(#89). 서버 사양이 정해지면 다시 측정해 조정한다.

- 측정 환경: Windows 11, Docker Desktop(WSL2 메모리 3GB·CPU 4개), CPU·메모리 제한 없음(기본 compose), 실모델 M1·M2, Vertex. 2026-11-02
- 기동: 컨테이너 시작부터 준비(DB 접속 가능, M1·M2 적재 완료, `/api/session` 200, `/healthz` 200)까지. 첫 기동 1회 + 재기동 4회
- 종료: `docker stop` 후 종료까지. 종료 코드 0이면 정상 종료, 137이면 강제 종료

| 서비스 | 기동 실측 | 기동 유예 | 종료 실측 | 종료 유예 |
|---|---|---|---|---|
| mariadb | 첫 기동 약 13초(초기화), 재기동 약 5초 | 30초 | 0.7초 | 30초 |
| model-server | 11~13초(M1·M2 적재) | 60초 | 유휴 1.5초, 200조항 작업 중 5.4초 | 30초 |
| backend | 5~7초 | 30초 | 0.4~0.5초(분석 진행 중 포함) | 15초 |
| frontend | 5초 이내 | — | 0.6초 | 기본 10초 |
| 전체 | `docker compose up -d` 후 모두 준비까지 16~21초 | | 분석 중 `docker compose stop` 3.2초 | |

- 모든 종료가 코드 0(정상)이었다. 분석 중에 끈 뒤 다시 띄우면 그 분석은 "중단"으로 정리되고 한도는 차감되지 않는다(재기동 복구).
- 유예 시간은 측정값의 2~4배로 잡았다. 기동 유예 동안에는 healthcheck 실패를 세지 않는다. 종료 유예가 지나면 Docker가 강제 종료한다.
- 백엔드는 종료 신호를 받으면 늦어도 10초 뒤 스스로 끝나므로, 종료 유예를 그보다 긴 15초로 두었다(Docker 기본값 10초면 정리 중 강제 종료될 수 있다).
