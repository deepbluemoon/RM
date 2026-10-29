# 배포 — macOS 서버 1대 (Docker 미사용)

계약위험탐지서비스를 운영 서버(Mac Studio M1 Ultra, 128GB) 한 대에 올리는 절차다. 구성 근거는
`specs/002-contract-risk-detection/quickstart.md` §7, `model-serving.md` §0·§7이다.

```text
인터넷 ──443──▶ Nginx (brew services) ──/api──▶ Node 백엔드 :9522 (PM2, 인스턴스 1)
                 └─ 정적 파일 frontend/dist                      │
                                                                 ├─▶ MariaDB (팀 서버, 원격)
                                                                 └─▶ 모델 서버 게이트웨이 :9542 (launchd LaunchAgent, .venv + uvicorn)
                                                                        ├─ M1·M2: 게이트웨이 프로세스 안(CPU)
                                                                        └─ M3·M4: 공유 Ollama :11434 (이 계정이 띄우지 않는다)
```

## 1. 사전 조건

| 항목 | 확인 |
|---|---|
| Node 20 LTS, Nginx, uv | `brew install node@20 nginx uv` |
| 공유 Ollama | `curl -s http://127.0.0.1:11434/api/version` 가 버전을 돌려준다. 실패하면 관리자에게 알린다(`ollama serve` 를 직접 띄우지 않는다) |
| 채팅 모델 | `ollama list` 에 `qwen3:4b-instruct-2507-q4_K_M` 이 있다(공용 A등급 — 받거나 만들 필요 없음) |
| 비밀값 | `backend/.env`, `model-server/.env` 는 **서버에만** 둔다(저장소·CI 변수에 넣지 않는다). 두 파일의 `MODEL_API_KEY` 는 같은 값 |
| 포트 | 9522(백엔드), 9542(게이트웨이)은 127.0.0.1 에만 묶는다. 8000 은 이 서버의 다른 계정이 쓴다 |

## 2. 설치·갱신

```bash
# 1) 빌드 (CI deploy 단계가 같은 일을 한다 — .gitlab-ci.yml)
npm ci --prefix backend && npm run build --prefix backend
npm ci --prefix frontend && npm run build --prefix frontend
rsync -a --delete backend/dist/ /srv/crd/backend/dist/
rsync -a --delete frontend/dist/ /srv/crd/frontend/dist/
rsync -a --delete backend/db/ /srv/crd/backend/db/ && rsync -a --delete shared/ /srv/crd/shared/
rsync -a backend/package.json backend/package-lock.json backend/ecosystem.config.cjs /srv/crd/backend/

# 2) DB 마이그레이션(001 DDL 사본 → 002 소셜 인증 → 003 정책) — 멱등
cd /srv/crd/backend && npm ci && npm run db:migrate

# 3) 모델 서버 게이트웨이 (기동 시 공용 모델을 1회 미리 올린다 — 약 1~30초)
cd model-server && ./scripts/install_launchd.sh install      # 기본 포트 9542
curl -s -H "Authorization: Bearer $MODEL_API_KEY" http://127.0.0.1:9542/health   # M1~M4 ready 또는 M3·M4 cold

# 4) 백엔드
pm2 start /srv/crd/backend/ecosystem.config.cjs --env production
pm2 save && pm2 startup          # 출력된 sudo 명령을 한 번 실행하면 재부팅 뒤 자동 기동

# 5) Nginx
cp deploy/nginx/crd.conf /opt/homebrew/etc/nginx/servers/crd.conf
nginx -t && brew services restart nginx
```

갱신은 1)·2)·`pm2 reload crd-backend` 만 하면 된다. 게이트웨이는 `model-server/` 코드가 바뀐 경우에만
`./scripts/install_launchd.sh install` 로 다시 등록한다.

기동 순서: 공유 Ollama(이미 떠 있음) → 게이트웨이 → 백엔드. 백엔드는 게이트웨이가 늦게 떠도 기동하며,
그동안 분석 시작은 G5("모델 서버 준비 중")로 막히고 C11 이 상태를 보여 준다.

## 3. 모델 적재 시간과 화면 안내

공유 Ollama 는 5분 동안 쓰지 않은 모델을 내린다. 그 뒤 첫 분석에는 적재 시간(보통 10~30초)이 더해진다.

- 게이트웨이 `/health` 가 M3·M4 를 `cold` 로 보고하고 `warmup_estimate_sec`(크기 기반 추정과 관측값 중 큰 값)를 준다. `cold` 는 G5 가 아니다.
- 화면: S1 C11 "모델 대기 중 — 첫 분석은 준비 시간 약 N초 추가", S2·S3 진행 줄에 경과 시간과 적재·대기 안내,
  S9(운영자) 모델별 설치·상주 상태·크기·예상 적재 시간.
- 게이트웨이는 Ollama 를 동시에 1건만 부른다. 대기 건수(`queue_depth`)가 있으면 S3 에 "앞 요청 처리 중"을 보여 준다.
- 모델을 **추가**하는 일(관리자 협의 후 bf16 커스텀 등록)은 런타임이 하지 않는다. `model-server/README.md`
  "모델 준비" 절차(다운로드 수 분~수십 분, 변환 수 분, 등록 1~3분, 첫 적재 20~40초)를 점검 시간에 수동으로 한다.

## 4. 운영 규칙

| 항목 | 규칙 |
|---|---|
| 공유 Ollama | `docs/ollama-guide.md` 를 따른다: `num_ctx 8192`, `keep_alive 5m`, 동시 1건, 상태 조회 60초 캐시, `pull`·`create`·`rm`·`stop`·`serve` 는 서비스가 부르지 않는다 |
| 외부 접속 | 공유기 포트포워딩은 443(과 인증서 갱신용 80)만. macOS 방화벽으로 그 밖을 막는다. TLS 는 certbot |
| 전원·재시동 | 잠자기 방지·정전 후 자동 재시동은 켜 둔다. macOS 자동 업데이트 재시동은 끄고 점검 시간에 수동 적용한다 |
| 자원 경합 | 운영 시간에는 같은 서버에서 큰 모델(B·C등급)을 올리지 않는다. 느려지면 요청을 늘리지 말고 관리자에게 알린다 |
| 감시 | `npm run ops:gates`(미해제 게이트), `npm run ops:raw-retention`(원본 24시간 삭제 확인), 게이트웨이 `/health` 는 1분에 1회 이하 |
| 로그 | 백엔드 `backend/var/log/*.log`(PM2), 게이트웨이 `~/Library/Logs/crd-model-server.log`. 요청·응답 본문은 어디에도 남기지 않는다 |
| 백업 | 서비스 데이터는 원격 MariaDB 에 있다. 로컬에서는 `.env` 두 개, Nginx·launchd 설정만 백업한다. 원본 계약서는 24시간 삭제 대상이라 백업하지 않는다 |
| 롤백 | 이전 `dist` 를 rsync 로 되돌리고 `pm2 reload crd-backend`. 마이그레이션은 추가만 하므로 되돌리지 않는다 |
