# Docker Compose 실행 안내

컨테이너 4개(프런트·백엔드·모델 서버·MariaDB)를 `compose.yaml`로 함께 띄우는 방법이다. 이미지 규칙은 [Docker 이미지 규약](docker-image-policy.md), LLM 설정은 [Gemini·Vertex 가이드](gemini-vertex-setup.md)를 따른다. Windows·Mac 모두 같은 파일로 실행한다.

## 1. 구성

| 서비스 | 컨테이너 | 내용 | 외부 공개 |
|---|---|---|---|
| `frontend` | `rm-frontend-1` | 화면, `/api`를 백엔드로 전달 | `127.0.0.1:8080` |
| `backend` | `rm-backend-1` | Express 웹 서버 | 없음 |
| `model-server` | `rm-model-server-1` | M1·M2 분류, M3·M4(Vertex) | 없음 |
| `mariadb` | `rm-mariadb-1` | DB (공식 `mariadb:12.0`) | 없음 |
| `backend-init` | `rm-backend-init-1` | 1회 초기화: 마이그레이션 → 최초 지식 적재. 끝나면 종료(0) | 없음 |

| 파일 | 용도 |
|---|---|
| `compose.yaml` | 기본. Docker Hub 이미지를 받아 실행 |
| `compose.dev.yaml` | 개발. 기본 위에 겹쳐 직접 빌드·개발 모드 로그인·디버깅 포트 |
| `.env.example` | 환경 변수 예시. 복사해 `.env`로 쓴다(`.env`는 git 제외) |

운영용 `compose.prod.yaml`은 배포 환경이 정해지면 추가한다.

## 2. 준비

1. Docker Desktop(Windows는 WSL2)
2. `.env` 만들기

   ```bash
   cp .env.example .env
   ```

   | 꼭 채울 값 | 내용 |
   |---|---|
   | `DB_PASSWORD`, `DB_ROOT_PASSWORD` | DB 비밀번호 |
   | `SESSION_SECRET`, `RAW_FILE_KEY` | 각각 64자리 hex (`openssl rand -hex 32`) |
   | `MODEL_API_KEY` | 임의 값(백엔드·모델 서버 공용) |
   | `VERTEX_PROJECT` | GCP 프로젝트 ID |
   | `GCP_CREDENTIALS_FILE` | Vertex 인증 파일 경로(아래 3절) |

   값이 빠지면 `docker compose`가 어떤 값이 필요한지 알려 주고 멈춘다.

## 3. Vertex 인증 연결

모델 서버는 Vertex(Google Cloud)로 M3·M4를 호출한다. 컨테이너는 이 PC의 gcloud 인증을 볼 수 없으므로, 인증 파일을 **읽기 전용으로 연결**한다(compose의 `secrets`, 컨테이너 안 `/run/secrets/gcp-credentials`).

- 개인 ADC: `gcloud auth application-default login` 후 생성된 파일
  - Windows: `C:/Users/<계정>/AppData/Roaming/gcloud/application_default_credentials.json`
  - Mac·Linux: `/Users/<계정>/.config/gcloud/application_default_credentials.json` (`~` 대신 절대 경로)
- 또는 관리자가 준 서비스 계정 키 파일

`.env`의 `GCP_CREDENTIALS_FILE`에 그 경로를 적는다. 인증 파일은 이미지·저장소·이슈에 올리지 않는다. 권한 설정은 [Gemini·Vertex 가이드 §4](gemini-vertex-setup.md)를 따른다.

## 4. 실행

### 받아서 실행 (기본)

```bash
docker compose pull
docker compose up -d
docker compose ps        # backend·model-server·mariadb 가 healthy, backend-init 가 Exited (0)
```

브라우저에서 `http://localhost:8080` (포트는 `.env`의 `FRONTEND_PORT`).

### 직접 빌드해서 실행 (개발)

```bash
docker compose -f compose.yaml -f compose.dev.yaml up -d --build
```

- 이미지를 소스로 빌드한다(로컬 태그 `tamji-local/*`). Docker Hub에 이미지가 없어도 된다.
- 로그인 화면의 "개발 모드 로그인"이 켜진다.
- 디버깅 포트: 백엔드 `127.0.0.1:19522`, DB `127.0.0.1:13306`

### 계정 만들기

```bash
docker compose exec -e CRD_NEW_PASSWORD='<비밀번호>' backend \
  node scripts/admin-create-account.js --login-id <아이디> --name "<이름>" --role operator
```

### 끄기

```bash
docker compose down        # 컨테이너만 지운다. DB·업로드 데이터(볼륨)는 남는다
docker compose down -v     # 주의: 볼륨까지 지워 DB 데이터가 사라진다
```

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

## 7. 알아둘 점

- **근거 검색은 BM25만 쓴다.** 임베딩(bge-m3)은 Ollama를 썼는데 컨테이너 구성에는 Ollama가 없다. 대체 방식은 별도 작업에서 정한다(`RAG_HYBRID=off`).
- **HTTP 구성이다.** 백엔드는 `COOKIE_SECURE=off`, `TRUST_PROXY=loopback, uniquelocal`로 실행된다(#66). HTTPS 앞단을 둘 때는 `COOKIE_SECURE=auto`로 바꾼다.
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
