# 모델 API 서비스 운영 가이드라인 (crd-model-server :9542)

- 작성·검증일: 2026-09-29
- 대상: 이 서버(Mac Studio M1 Ultra, 계정 `pioneer2`)에서 모델 API 를 띄우고 관리하는 사람
- 최근 전수 점검: **2026-09-29 16:30~16:38** — `service_test.py` 19/19, 단위 테스트 54/54, curl 직접 호출 38건 모두 기대 코드, `launchctl kickstart -k` 후 3.7초 만에 복구. 로그 = [SERVICE_TEST_2026-09-29.md](SERVICE_TEST_2026-09-29.md)
- API 호출 방법은 [USER_MANUAL.md](USER_MANUAL.md), 모델 성능은 [../reports/baseline_v0/MODEL_TEST_REPORT.md](../reports/baseline_v0/MODEL_TEST_REPORT.md)

## 0. 웹에서 보기 (https://p2.sumzip.com)

| 화면 | 주소 | 내용 |
|---|---|---|
| API 활용 안내 | https://p2.sumzip.com/admin/model-api | 엔드포인트·가이드라인·매뉴얼·서버 상태·**문서·점검 결과**(이 문서, 점검 결과표, 모델 테스트 보고서) |
| **Swagger (/docs)** | **https://p2.sumzip.com/docs** | 모델 서버(FastAPI)의 Swagger 그대로. **Try it out** 으로 직접 호출 — 오른쪽 **Authorize** 에 `MODEL_API_KEY` 를 넣어야 호출됨(저장하지 않음, 없으면 401) |
| OpenAPI 명세 | https://p2.sumzip.com/openapi.json | `/docs` 가 읽는 명세(서버 주소 = 웹 프록시, Bearer Authorize 포함) |
| OpenAPI 원본 | https://p2.sumzip.com/api/admin/model-api/openapi | 모델 서버 `/openapi.json` 그대로 |

- 연결 방식: 공용 Nginx 가 p2.sumzip.com 전체를 프론트(Vite :9502)로 넘기고, Vite 프록시(`frontend/vite.config.ts`)가 `/docs` → 모델 서버 :9542, `/openapi.json` → 백엔드 `/api/admin/model-api/openapi?view=docs` 로 보냅니다(Nginx 설정 변경 없음). Vite 를 멈추면 `/docs` 도 멈춥니다.
- Swagger 의 호출은 `https://p2.sumzip.com/api/admin/model-api/try/<경로>` → 백엔드(:9522) → 모델 서버(:9542)로 전달됩니다. 백엔드는 **키를 대신 넣지 않고** 받은 `Authorization` 헤더만 넘깁니다. 키 없이 누르면 401 입니다.
- 프록시는 모델 API 계약의 경로(`/health`, `/v1/models`, `/v1/detect/*`, `/v1/jobs`, `/v1/jobs/{id}`, `/v1/judge`, `/v1/summarize`)만 허용하고, 그 밖은 404 입니다. 웹 경유 본문 한도는 3MB(백엔드 설정)입니다.
- **로그인·RBAC 복원(2026-09-29) 이후**: `/docs` 페이지 자체(HTML)는 열리지만, 명세(`/openapi.json`)와 호출 프록시(`/api/admin/model-api/*`)는 백엔드 세션(`crd.sid`)과 `modelApi.view` 권한(역할 `operator`·`developer`)이 있어야 합니다. 로그인 없이 열면 명세 로드가 `401 G8`(로그인 필요), 권한 없는 계정은 `403 G14` 로 실패합니다. 먼저 https://p2.sumzip.com 에서 로그인한 같은 브라우저로 `/docs` 를 여세요. 역할 부여는 `npm run admin:grant-role --prefix backend`.
- 공개 사이트이므로 Swagger 로 보내는 조항도 **비식별화된 텍스트만** 씁니다.

## 1. 구성

```
백엔드 :9522 ──Bearer──▶ crd-model-server  127.0.0.1:9542   (FastAPI · uvicorn 1 worker · launchd 상주)
                          ├─ M1 편법  loophole-klue-roberta-base  ┐ 프로세스 안 CPU fp32, 6스레드, 배치 16
                          ├─ M2 위법  illegal-klue-roberta-base   ┘ var/models/baseline_v0/
                          └─ M3 판정·M4 요약 ──▶ 공유 Ollama 127.0.0.1:11434  qwen3:4b-instruct-2507-q4_K_M (동시 1건)
```

| 항목 | 값 |
|---|---|
| 서비스 이름 | launchd `kr.crd.model-server` (도메인 `user/504` — 이 계정은 GUI 세션이 없어 `gui/` 대신 `user/`) |
| 실행 명령 | `model-server/.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 9542 --workers 1 --no-access-log` |
| 가상환경 | `model-server/.venv` (Python 3.11, fastapi·uvicorn·httpx·torch 2.14·transformers 5.17) |
| 설정 | `config.yaml`(기본값) + `.env`(비밀값·덮어쓰기: `MODEL_API_KEY`, `OLLAMA_URL`, `OLLAMA_M3_MODEL`, `OLLAMA_M4_MODEL`, `MODEL_ROOT`) |
| 모델 위치 | `.env` 의 `MODEL_ROOT=…/model-server/var/models/baseline_v0` |
| 로그 | `~/Library/Logs/crd-model-server.log` (요청 ID·경로·상태·지연만, 본문 없음) |
| 등록 파일 | 원본 `launchd/kr.crd.model-server.plist` → 설치본 `~/Library/LaunchAgents/kr.crd.model-server.plist` |
| 자동 재시작 | 비정상 종료 시(`KeepAlive.SuccessfulExit=false`) 10초 간격. 정상 종료(exit 0)는 재시작하지 않음 |

## 2. 기동·중지·재기동

모두 `model-server` 폴더에서 실행합니다.

| 할 일 | 명령 |
|---|---|
| 등록 + 기동(처음 또는 plist 변경 후) | `./scripts/install_launchd.sh install` |
| 재기동(`.env`·모델·코드 변경 후) | `./scripts/install_launchd.sh restart` |
| 상태 | `./scripts/install_launchd.sh status` → `state = running`, `pid = …` |
| 중지 + 해제 | `./scripts/install_launchd.sh uninstall` |
| 포트 사용 확인 | `lsof -iTCP:9542 -sTCP:LISTEN` |
| 로그 보기 | `tail -f ~/Library/Logs/crd-model-server.log` |
| 종합 점검 | `.venv/bin/python scripts/service_test.py --out docs/service-test-result.json` (19항목, 약 10초) |
| 단위 테스트 | `.venv/bin/python -m pytest -q tests` (54개, 약 10초, 서비스와 무관하게 실행) |

- 기동 후 **M1·M2 적재 약 5초**, 그동안 `/health` 는 `503 loading`. 기동 때 M3·M4 모델을 한 번 미리 올립니다(2~3초).
- **`uvicorn` 을 손으로 따로 띄우지 마세요.** launchd 인스턴스와 포트가 부딪혀 launchd 쪽이 10초마다 재시작을 반복합니다. 이미 떠 있는 수동 프로세스가 있으면 먼저 끄고(`kill <pid>`) `install` 합니다.
- 등록 스크립트는 SSH 전용 계정이면 설치본 plist 에 `LimitLoadToSessionType=Background` 를 넣어 `user/<uid>` 에 올립니다. 이게 없으면 `Bootstrap failed: 5: Input/output error` 가 납니다.

## 3. 반드시 지킬 규칙

| # | 규칙 | 이유 |
|---|---|---|
| 1 | **가상환경을 `uv sync` 로 다시 맞출 때는 반드시 `uv sync --frozen --extra classifiers`** | `--extra classifiers` 없이 돌리면 torch·transformers 가 지워져 M1·M2 가 키워드 휴리스틱으로 조용히 바뀝니다. 등록 스크립트는 그래서 sync 를 하지 않습니다 |
| 2 | 바인딩은 `127.0.0.1` 만. 외부 공개가 필요하면 Nginx 뒤에 두고 따로 협의 | 키 하나로 모든 모델을 부를 수 있음 |
| 3 | `MODEL_API_KEY` 는 `model-server/.env`·`backend/.env` 에만. 문서·로그·채팅·plist 에 쓰지 않음 | CLAUDE.md 규칙 |
| 4 | 비식별화 전 텍스트를 보내지 않음 | 서버는 본문을 기록하지 않지만 Ollama 로 넘어감 |
| 5 | 공유 Ollama 에 `pull`·`create`·`rm`·`stop`·`serve` 를 부르지 않음. 상태 조회는 60초 캐시 | `docs/ollama-guide.md`. 코드가 `ALLOWED_PATHS` 로 막고, 설정 위반이면 기동을 거부합니다 |
| 6 | `/health` 를 짧은 주기로 폴링하지 않음(백엔드는 10초 캐시) | 공유 서버 부하 |
| 7 | 포트 9542 만 사용. 9521·9523·9524 는 다른 팀원 백엔드 | 로컬 모드 합의 |
| 8 | `tools/model-api-stub` 과 이 게이트웨이는 같은 9542 — **둘 중 하나만** 띄움 | 포트 충돌 |

## 4. 모니터링

| 확인 | 정상 | 조치 기준 |
|---|---|---|
| `/health.status` | `ready` | `loading` 이 30초 넘게 지속, `degraded` |
| `/health.models[M1/M2].model` | `*-klue-roberta-base` | `*-heuristic` 이면 §6-1 |
| `/health.models[M3/M4].state` | `ready` 또는 `cold` | `missing`·`error` |
| `/health.queue_depth` | 0~1 | 계속 3 이상이면 M3 호출이 밀림 — 백엔드 `JUDGE_CONCURRENCY=1` 확인 |
| 백엔드 시각 | `curl -s 127.0.0.1:9522/api/model-server/status` → `state: ready` | |
| 로그 | `status=200` 위주 | `status=503`·`처리 오류` 반복 |

## 5. 성능 기준 (2026-09-29 실측)

| 항목 | 값 |
|---|---|
| 동기 탐지 | 2조항 요청 평균 45~47ms(10회), 3조항 51~62ms. 조항당 약 20~60ms(길이에 따라) |
| 상태·목록 | `/health` 평균 8ms, `/v1/models` 4ms, `/docs`·`/openapi.json` 1~2ms, `POST /v1/jobs` 생성 3ms |
| 문서 작업 `/v1/jobs` | 100조항 1.3초(16:30 점검) ~ 4.1초 ~ 11.4초(동시 요청이 겹칠 때), 2조항 0.65초 |
| 처리량 | 모델당 약 18 조항/초 |
| M3 판정 | 2.1~2.3초(상주 시, 설명 짧을 때) ~ 4.8초(설명 3개), cold 이면 +10~30초 |
| M4 요약 | 2.0~2.4초(상주 시, 2조항) |
| 메모리 | 게이트웨이 RSS 약 0.4~2GB, Ollama 모델 약 2.4GB(통합 메모리) |
| 장애 복구 | `kill -9` 뒤 13초, `restart` 뒤 10초, `launchctl kickstart -k` 뒤 3.7초(16:37) 만에 `/health` 200 |

## 6. 장애 대응

| 증상 | 원인 | 조치 |
|---|---|---|
| 1. `/health` 에 `loophole-heuristic` | `.env` 의 `MODEL_ROOT` 가 없거나 틀림 / 가상환경에 torch 없음 | `grep MODEL_ROOT .env`, `ls $MODEL_ROOT/*/model_card.json`, `.venv/bin/python -c "import torch, transformers"` → 고친 뒤 `restart`. 로그에 "torch 가 없어 휴리스틱을 쓴다"가 있으면 규칙 1 |
| 2. 포트에 응답 없음 | 프로세스 없음 / 기동 실패 반복 | `status`, 로그 끝부분 확인. `last exit code = 3` 은 보통 포트 충돌 → `lsof -iTCP:9542` 로 다른 프로세스 확인 |
| 3. 모든 요청 401 | `.env` 에 `MODEL_API_KEY` 없음 / 백엔드와 값이 다름 | 두 `.env` 비교(값을 출력하지 말고 `diff <(grep ^MODEL_API_KEY= backend/.env) <(grep ^MODEL_API_KEY= model-server/.env)`) |
| 4. `/v1/judge`·`/v1/summarize` 503 | Ollama 연결 불가·모델 없음 | `curl -s 127.0.0.1:11434/api/version`. 공유 서버 문제면 관리자에게 알림(직접 재기동하지 않음) |
| 5. `/v1/judge` 가 수십 초 | cold 적재 또는 대기열 | `/health` 의 `warmup_estimate_sec`·`queue_depth` 확인. 정상 동작 |
| 6. 기동 시 설정 오류로 종료 | `num_ctx ≠ 8192`, 금지 모델명 등 `config.validate` 위반 | 로그의 사유대로 `config.yaml`·`.env` 수정 |
| 7. `Bootstrap failed: 5` | SSH 세션에서 세션 유형 없음 | `./scripts/install_launchd.sh install`(스크립트가 처리) 로 다시 등록 |

## 7. 모델 교체 절차

1. 새 체크포인트를 `var/models/<버전>/{loophole,illegal}-klue-roberta-base/` 에 둡니다(`model_card.json` 필수, `model_version` 이 이전과 달라야 백엔드 판정 캐시가 섞이지 않음).
2. 오프라인 테스트: `reports/baseline_v0/run_model_test.py` 의 `MODEL_ROOT` 를 바꿔 실행 → 길이·시정 문구 탐침(§5.1·§5.2)을 반드시 확인.
3. `.env` 의 `MODEL_ROOT` 를 새 폴더로 → `./scripts/install_launchd.sh restart`.
4. `.venv/bin/python scripts/service_test.py` → 19/19 통과, T01 의 모델 이름 확인.
5. 되돌리기: `MODEL_ROOT` 를 이전 값으로 → `restart`. 휴리스틱으로 되돌리려면 `MODEL_ROOT` 줄을 지우고 `restart`.

## 8. 테스트 결과 (2026-09-29 재점검, `scripts/service_test.py`, 원자료 `service-test-result.json`, 상세 로그 [SERVICE_TEST_2026-09-29.md](SERVICE_TEST_2026-09-29.md))

요약: **19/19 통과(9.7초)**, 단위 테스트 **54/54**, curl 직접 호출 38건 기대 코드 일치, 재기동 복구 3.7초. 실패 없음.

| ID | 항목 | 결과 |
|---|---|---|
| T01 | `GET /health` 200·계약 스키마·M1·M2 실모델 | 통과 |
| T02 | `GET /v1/models` 버전 | 통과 |
| T03 | 8개 엔드포인트 × (키 없음·틀린 키·Basic) → 401 | 통과 |
| T04·T05 | `/v1/detect/loophole`·`/illegal` 계약 스키마·순서·예상 판정 | 통과 |
| T06 | M2 `type`·`related_laws` | 통과(약관법만) |
| T07 | 결정성(반복·단건/배치) | 통과 |
| T08 | 잘못된 입력 5종 → 400, 오류 응답에 원문 없음 | 통과 |
| T09 | 2,001조항·42MB 본문 → 413 | 통과 |
| T10 | `/v1/jobs` 100조항 완료·오류 0 | 통과(1.3초) |
| T11 | 없는 작업 → 404 | 통과 |
| T12 | 동시 8요청 | 통과 |
| T13 | `x-request-id` 되돌림·생성 | 통과 |
| T14 | 계약 유형 6종 + 미정의 값 | 통과(미정의 값도 200) |
| T15 | `/v1/judge` M3 계약 스키마·근거 ID 검증 | 통과(4.8초) |
| T16 | `/v1/judge` 잘못된 입력 5종 → 400 | 통과 |
| T17 | `/v1/summarize` M4 계약 스키마 | 통과(2.4초) |
| T18 | `/docs`·`/openapi.json` | 통과 |
| T19 | 로그에 조항 원문·키 없음 | 통과 |
| — | 단위 테스트 `pytest` | 54/54 통과 |
| — | curl 직접 호출(정상 10·jobs 흐름·401 7·400 6·404 2·405 1·413 4) | 모두 기대 코드 |
| — | 장애 복구(`kill -9`)·`restart`·`kickstart -k` | 13초·10초·3.7초 만에 복구, 재기동 전 작업 ID 는 404(메모리 보관) |
| — | 공개 경로 `https://p2.sumzip.com/docs` | 200(페이지). `/openapi.json`·`/api/admin/model-api/*` 는 비로그인 401 G8(§0, 의도된 동작) |
| — | 백엔드 `/api/model-server/status` | `ready` |

## 9. 알려진 한계와 할 일

| # | 내용 | 영향 |
|---|---|---|
| 1 | 현재 M1·M2(baseline_v0)는 긴 조항에서 위험 문구를 놓치고, M1 은 공정한 조항도 주제만으로 높게 봄 | 결과 해석 주의(USER_MANUAL §6). 2회차 모델로 교체 예정 |
| 2 | `/docs`·`/openapi.json` 은 인증 없이 열림 | 127.0.0.1 전용이라 허용. 외부 공개 시 끄기(`FastAPI(docs_url=None, openapi_url=None)`) |
| 3 | 작업(`/v1/jobs`)은 메모리에만 있어 재기동하면 사라짐 | 재기동은 분석이 없는 시간에 |
| 4 | 미정의 `contract_type` 도 200 으로 받음 | 백엔드가 6종만 보내야 함 |
| 5 | `/v1/models` 의 M4 `base`(Qwen3-1.7B)와 M3·M4 `path`(`var/gguf/m3·m4-bf16.gguf`)가 `models.lock.yaml` 옛 값으로 표시(16:30 재확인) | 표시만 틀림. 실제 호출 모델은 `name`·`model_version`·`ollama_digest` 로 확인 |
| 6 | 로그에 transformers `torch_dtype` 경고·진행 막대가 섞임 | 동작 영향 없음 |
| 7 | 실측 CPU 경합: `/v1/jobs` 가 M1·M2 를 각 6스레드로 동시에 돌려, 다른 요청과 겹치면 100조항 4초 → 11초 | 대량 분석이 겹칠 때 참고 |
| 8 | 스키마 검증 오류는 FastAPI 기본 422 가 아니라 **400** 으로 바꿔 돌려줌(`입력 오류 — <위치>: <사유>`) | 계약서대로. 클라이언트는 400 만 처리하면 됨 |
| 9 | 공개 `/docs` 는 로그인·`modelApi.view` 권한이 있어야 명세가 뜸(RBAC 복원) | §0 |

## 10. 2026-09-29 변경 기록

| 파일 | 변경 |
|---|---|
| `launchd/kr.crd.model-server.plist` | `uv run --no-sync uvicorn` → `.venv/bin/uvicorn` 직접 실행 |
| `scripts/install_launchd.sh` | `uv sync --frozen`(torch 삭제 위험) 제거 → 가상환경 점검으로 교체, SSH 세션용 `user/` 도메인·Background 세션 처리, `restart` 추가 |
| `.env` | `MODEL_ROOT=…/var/models/baseline_v0` 추가(휴리스틱 → 파인튜닝 모델) |
| `scripts/service_test.py` | 새로 추가 — 실행 중 서비스 종합 점검 19항목 |
| 운영 | 수동 실행 프로세스(휴리스틱) 종료 → launchd `user/504/kr.crd.model-server` 로 전환 |
| 웹 연결 | S9 화면(`/admin/model-api`)에 `/docs` 버튼·문서·점검 결과 탭 추가, `https://p2.sumzip.com/docs`(Vite 프록시 → 모델 서버 Swagger)·`/openapi.json`(→ 백엔드 `?view=docs`) 연결, 백엔드 `GET /api/admin/model-api/docs/{name}`·`GET·POST /api/admin/model-api/try/*`(키 비주입 프록시) 추가, web-api 계약·계약 테스트 반영, 백엔드 :9522 재기동 |
| `docs/GUIDELINE.md`·`docs/USER_MANUAL.md`·`docs/SERVICE_TEST_2026-09-29.md` | 16:30~16:38 전수 재점검 결과 반영(지연 실측, 오류 코드표, 첫 요청 예시, 공개 `/docs` 로그인 요건) |
