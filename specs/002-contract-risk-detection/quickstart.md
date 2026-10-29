# Quickstart — 계약위험탐지서비스 (Docker 없이)

**Feature**: `002-contract-risk-detection` · **Plan**: [plan.md](./plan.md)

이 문서는 구현이 끝난 뒤 **개발 PC 에서 전 흐름을 띄우고 MVP(US1·US2)를 검증**하는 절차다. 컨테이너를 쓰지 않는다(Intent-Plan).

---

## 1. 준비물

| 항목 | 버전 | 설치(macOS 예) |
|---|---|---|
| Node.js | 20 LTS | `nvm install 20 && nvm use 20` (저장소 `.nvmrc` = `20`) |
| MariaDB 로컬 서버(개발·테스트용) | 12.0.x | `brew install mariadb` 후 `npm run devdb:start --prefix backend` — 저장소 전용 인스턴스(127.0.0.1:23610, 데이터 `backend/var/devdb`, git 제외) |
| Nginx(배포 검증 시) | 1.24+ | `brew install nginx` |
| PM2(배포 검증 시) | 5.x | `npm i -g pm2` |
| Python(실모델 시) | 3.11 | `brew install uv && uv python install 3.11` |
| Ollama(실모델 시) | 0.34+ | 이 서버의 **공유 서버** `127.0.0.1:11434`를 쓴다. 계정에서 `ollama serve`를 띄우지 않는다(model-serving §0) |

개발은 실모델 없이 저장소의 스텁으로 돈다(§4). **포트 주의**: 이 서버의 8000번은 다른 계정이 쓰고 있어 스텁·모델 서버 게이트웨이는 **9542**을 쓴다(`MODEL_API_BASE_URL`). 실모델(로컬 모델 서버)로 돌리는 방법은 §4-1, 모델 구성은 [model-serving.md](./model-serving.md).

## 2. 환경 변수

```bash
cp backend/.env.example backend/.env      # git 에 올리지 않는다
```

```dotenv
# backend/.env.example 요지 — 값은 자리표시자, 전체 키는 파일 참고
NODE_ENV=development
PORT=9522
DB_HOST=__TEAM_DB_HOST__            # 팀 DB — 실제 값은 Intent-Plan.md [데이터베이스 설정]. 로컬 개발은 devdb(127.0.0.1:23610)
DB_PASSWORD=__FILL_ME__
TEST_DB_PORT=23610                  # 로컬 devdb 의 crd_test
SESSION_SECRET=__random_64_chars__
KAKAO_CLIENT_ID=__kakao_rest_api_key__      # 소셜 로그인(FR-043) — 카카오·네이버만
KAKAO_CLIENT_SECRET=__kakao_client_secret__
NAVER_CLIENT_ID=__naver_client_id__
NAVER_CLIENT_SECRET=__naver_client_secret__
OAUTH_REDIRECT_BASE=http://127.0.0.1:9502   # 콜백 = {base}/api/auth/{provider}/callback (화이트리스트)
AUTH_DEV_PROVIDER=false             # 개발용 로그인 — true 여도 production 에서는 꺼진다
RAW_STORAGE_DIR=./var/raw
RAW_FILE_KEY=__64_hex_chars_32_bytes__      # AES-256-GCM
MODEL_API_BASE_URL=http://127.0.0.1:9542   # 스텁 또는 model-server 게이트웨이
MODEL_API_KEY=__model_api_key__     # 화면·로그에 출력 금지 (BR-API-02)
MODEL_LLM_TIMEOUT_SEC=300           # M3·M4 — 공유 Ollama 대기열·모델 적재 포함
DETECT_THRESHOLD_M1=0.5             # policy_constant 가 unknown 일 때만 (research R-15)
DETECT_THRESHOLD_M2=0.5
ANON_SESSION_TTL_HOURS=24           # migration 003 이 policy_constant 를 24(confirmed)로 바꾼다
ANALYSIS_CONCURRENCY=2
JUDGE_CONCURRENCY=1                 # 공유 Ollama 는 동시 1건
```

## 3. 설치·DB 마이그레이션

```bash
npm ci --prefix backend
npm ci --prefix frontend
npm ci --prefix tools/model-api-stub

# 스키마 적용 (001 = design/crd_ddl.sql 사본, 002 = 소셜 로그인·세션, 003 = 정책·취소 차감, 004 = 삭제 시 피드백 익명화 규칙) — 멱등
npm run devdb:start --prefix backend        # 로컬 개발 DB (팀 DB 를 쓰면 생략)
npm run db:migrate --prefix backend

# 로컬 테스트 DB 준비 + 설계 DDL 규칙 회귀 테스트(design/crd_ddl_test.sql)
npm run db:test:reset --prefix backend
npm run db:ddl-tests --prefix backend        # @setup/@accept/@reject/@expect 85건 전건 통과해야 한다
npm run db:check-ddl-copy --prefix backend   # 001 이 design/crd_ddl.sql 과 바이트 단위로 같은지

# 운영자·개발자·법률 전문가 역할 (자가 가입은 user 만 — G14). 대상 계정이 먼저 한 번 소셜 로그인해야 한다
npm run admin:grant-role --prefix backend -- --provider kakao --subject <카카오 회원번호> --role operator
# 개발 환경(AUTH_DEV_PROVIDER=true): 로그인 화면의 "개발 모드 로그인" → /api/auth/dev/start?devSubject=op1
npm run admin:grant-role --prefix backend -- --provider dev --subject op1 --role operator

# 최초 지식 기준일 적재 (P0 없이 시작할 수 없다 — UC1 사전조건 2)
npm run seed:knowledge --prefix backend -- --fixture tests/fixtures/knowledge/initial.json
```

## 4. 실행 (터미널 3개)

```bash
# 1) 모델 API 스텁 — 7개 엔드포인트, 결정적 응답
npm run dev --prefix tools/model-api-stub          # http://127.0.0.1:9542 (/health, /v1/*) — STUB_COLD=true 로 콜드 스타트 안내 확인

# 2) 백엔드
cd backend && npm run dev                           # http://127.0.0.1:9522/api

# 3) 프론트엔드 (Vite 가 /api 를 9522 로 프록시)
cd frontend && npm run dev                          # http://127.0.0.1:9502
```

### 4-1. 실모델(로컬 모델 서버)로 실행

스텁 대신 `model-server/` 게이트웨이를 같은 포트(9542)에 띄운다. 게이트웨이는 uv 가상환경(`.venv`)의 uvicorn 으로 돌고, M3(판정)·M4(요약)는 **공유 Ollama**(`127.0.0.1:11434`)의 공용 모델 `qwen3:4b-instruct-2507-q4_K_M` **하나**를 쓴다(`docs/ollama-guide.md` — 채팅 모델 1개, `num_ctx` 8192 고정). 모델 추가 작업은 없다. 규칙은 [model-serving.md](./model-serving.md) §0.

```bash
cd model-server && uv sync
# MODEL_API_KEY 는 backend/.env 와 같은 값 — model-server/.env 에만
uv run uvicorn app.main:app --host 127.0.0.1 --port 9542 --workers 1
curl -s -H "Authorization: Bearer $MODEL_API_KEY" http://127.0.0.1:9542/health
```

- 게이트웨이는 기동 시 1회만 모델을 미리 올린다. 5분 넘게 쓰지 않으면 공유 서버가 모델을 내려 `/health` 에 `cold` 로 보이고, 첫 호출에 적재 시간(10~30초)이 더 든다. 화면 C11·진행 레일에 예상 시간이 표시된다(G5 아님).
- 게이트웨이는 Ollama 상태를 1분에 1번 넘게 조회하지 않는다(폴링 금지). 연결 확인은 운영자 계정으로 `API 활용 > 서버 상태`(S9).

## 5. MVP 검증 시나리오 (US1·US2)

| # | 조작 | 기대 결과 | 근거 |
|:--:|---|---|---|
| 1 | 비로그인으로 `/analyze`(S1) 진입 | 개인정보 처리 고지, "이번 달 남은 무료 분석 3 / 3건", 관점 선택(소비자 기본) | FR-010, C10, 1.1 |
| 2 | `tests/fixtures/contracts/subscription-sample.pdf` 업로드 | 사전 검사 5항목 통과 표시, "분석 시작" 활성 | 1.3, U2 |
| 3 | 분석 시작 | S2 로 이동, 레일 세부 줄 수신 → 비식별화 → 구조화 진행 | FR-024 |
| 4 | S2 에서 계약 유형 후보 "구독" 확인·확정 | S3 로 이동, "조항 N개 중 M개 점수 수신" 진행 | 2.6, 3.2 |
| 5 | 완료 알림 → "결과 보기" | S4-C: 고지 띠 + 지식 기준일, 위험도별 개수, 원문 하이라이트(글자+모양), 위험도순 목록. 남은 한도 2 / 3 | US1-AS2·4·5, 3.9 |
| 6 | 하이라이트 조항 선택 | 판정 배지(분류·유형·위험도·신뢰도) + 근거 칩 1개 이상 → 드로어에 6항목 | US1-AS3, SC-003 |
| 7 | "쉬운 설명" 탭 | 주장마다 연결 근거 강조, 단정 표현 없음 | US2-AS1·5 |
| 8 | "비교 보기" | 원문 ↔ 법령 조문, 원문 ↔ 표준약관 좌우 표시 | US2-AS2·3 |
| 9 | 개인정보 표본(`tests/fixtures/pii/contract-with-pii.docx`) 분석 | 화면·DB(`clause.deid_text`)·로그 어디에도 원문 개인정보 없음, `〔전화번호〕` 등 표기 | US4-AS1, SC-013 |

게이트 확인(스텁 제어 헤더/환경변수로 재현):

| 게이트 | 재현 | 기대 |
|:--:|---|---|
| G2 | 60MB 파일 또는 암호 PDF 업로드 | 사전 검사 실패 항목 + C2 블록, "분석 시작" 비활성(사유 붙음) |
| G4 | 같은 기기로 4번째 분석 | "이번 달 무료 분석을 모두 사용했습니다", 초기화 일자 |
| G4(취소 차감) | 분석 2건 저장 뒤 3번째 분석을 S2·S3 에서 "분석 취소" → 확인 대화상자 "취소하면 이번 달 무료 분석 1건이 차감됩니다" → 4번째 분석 시작 | 취소 후 남은 한도 0 / 3, 4번째에서 G4. 재분석(S6)은 한도 0이어도 가능 |
| G5 | 스텁 `STUB_HEALTH=loading` 으로 재기동 | "분석 일시 불가", 한도 미차감 |
| (안내) 콜드 스타트 | 스텁 `STUB_COLD=true` 로 재기동 | C11 "모델 대기 중 — 첫 분석은 준비 시간이 약 10초 더 걸릴 수 있습니다"(스텁 값. 실모델은 크기 기반 추정과 관측값 중 큰 값), S2·S3 세부 줄에 경과 시간과 적재 안내. G5 아님 |
| G6 | `tests/fixtures/non-contract/receipt.pdf` | S2 중단 "계약서·약관으로 인식되지 않았습니다" |
| G8 | 다른 브라우저에서 결과 URL 직접 열기 | 화면 전체 대체 C2 |

## 6. 테스트

```bash
npm test --prefix backend                 # 단위 + 통합(로컬 crd_test + 스텁) + 계약(contracts/*.yaml 검증)
npm test --prefix frontend                # 컴포넌트(C1~C11 상태별)
npx --prefix frontend playwright install chromium   # 최초 1회·Playwright 갱신 뒤 — 브라우저 버전이 맞지 않으면 모든 e2e 가 실패한다
npm run e2e --prefix frontend             # Playwright — §5 시나리오 자동화(vite :9502 를 스스로 띄운다, 백엔드 :9522 는 미리 실행)
```

### 6-1. 검증 기록 (T149, 2026-09-28)

§3~§6 을 이 서버에서 실제로 실행했다(`npm ci` 는 설치된 의존성을 그대로 써서 생략).

| 절 | 결과 |
|---|---|
| §3 | `db:migrate`(001~004), `db:test:reset`, `db:ddl-tests` 85/85 통과, `db:check-ddl-copy` 일치, `seed:knowledge` 멱등(이미 있으면 변경 없음), `admin:grant-role` 은 로그인 전이면 "먼저 한 번 로그인하세요" → 로그인 후 부여 |
| §4-1 | 게이트웨이 :9542(공용 `qwen3:4b-instruct-2507-q4_K_M`, 기동 예열 1~2초) + 백엔드 :9522 + 프런트 :9502. 텍스트 약관(43조) 분석 → 저장까지 약 18초, 진행 중 `modelNotice`(queue) 표시, 한도 3→2 |
| §5 | Playwright 12건 통과(2건은 선택 실행 — `E2E_REAL_G4`, 취소 가능 단계가 짧아 건너뜀). 실모델에서만 드러난 S2 계약 유형 후보 미선택 버그를 고쳤다(요약이 문서 표시보다 늦게 옴) |
| §6 | 백엔드 360건 통과(성능 측정 2건은 `PERF_REAL_MODEL=1` 일 때만), 프런트 단위 55건, 모델 서버 pytest 54건 |

## 7. 배포 (Docker 없이 — Nginx + PM2)

```bash
# 빌드
npm run build --prefix backend            # backend/dist
npm run build --prefix frontend           # frontend/dist

# 백엔드 프로세스 (인스턴스 1개 — 프로세스 내 작업 큐, research R-06)
pm2 start backend/ecosystem.config.cjs --env production
pm2 save && pm2 startup                  # 재부팅 후 자동 기동

# 모델 서버 게이트웨이 상주 (launchd LaunchAgent — Ollama 는 공유 서버라 따로 띄우지 않는다, model-serving §0)
MODEL_SERVER_PORT=9542 ./model-server/scripts/install_launchd.sh install
brew services start nginx
```

```nginx
# /opt/homebrew/etc/nginx/servers/crd.conf (요지 — macOS Homebrew Nginx)
server {
  listen 443 ssl http2;
  server_name crd.example.kr;
  client_max_body_size 55m;               # 50MB 한도(FR-002) + 여유 — 초과는 413 → 앱이 G2 로 안내
  root /srv/crd/frontend/dist;
  location / { try_files $uri /index.html; }
  location /api/ {
    proxy_pass http://127.0.0.1:9522;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 120s;
  }
}
```

GitLab CI(이 서버에 등록한 shell runner): `lint → test(backend, frontend, ddl-tests — 모델은 스텁) → build → deploy(rsync dist + pm2 reload, main 브랜치만)`. 모델 교체는 CI 가 아니라 model-serving §7 절차로 한다. `.env` 는 서버에만 둔다.

## 8. 운영 점검 명령

```bash
npm run ops:raw-retention --prefix backend   # v_raw_retention_overdue — 0건이어야 한다 (SC-014)
npm run ops:gates --prefix backend           # v_gate_open — 미해제 게이트
```
