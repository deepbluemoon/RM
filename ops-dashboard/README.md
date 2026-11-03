# RM 운영 모니터링 대시보드

기존 RM 사용자 화면과 분리된 독립 운영 페이지다. Docker Engine을 감시 대상으로 삼지만 대시보드 자체는 기본적으로 호스트 Node 프로세스로 실행할 수 있으며, 필요할 때만 제공된 Dockerfile/Compose로 컨테이너화한다.

## 제공 범위

- 모든 컨테이너(실행 중·중지됨)를 한 화면에서 확인한다.
- 실행 중 컨테이너의 CPU·메모리 사용률을 5초마다 읽고, 개별 자원이 80% 이상이면 지속 시간을 포함한 경고를 표시한다.
- 컨테이너를 선택하면 Docker 로그를 타임스탬프와 함께 실시간 스트림으로 표시한다.
- 오류코드에 대응하는 운영 스크립트 옵션은 평상시 비활성화하고, 해당 오류코드가 활성화된 경우에만 선택할 수 있다. 경고는 스크립트를 자동 실행하지 않는다.
- 실행 전 대상·내용을 대화상자에서 확인하며, 읽기 전용 진단 결과는 대응 패널에 남긴다. 스크립트별 용도와 주의사항은 [운영 대응 스크립트 매뉴얼](docs/response-scripts.md)을 따른다.
- 자원 경고는 진단 옵션을 활성화한다. 확장은 운영자가 명시적으로 허용한 서비스에 한해 현재보다 큰 목표 replica 수로 실행할 수 있다.
- 현재 RM의 backend·frontend·model-server·DB·초기화 작업은 메모리 상태, 작업 큐, 고정 포트 또는 데이터 일관성 문제로 기본 차단한다.
- 스크립트 실행 이력은 로컬 JSONL로 보관하며, 진단 보고서 다운로드·개별 삭제·30일 초과분 정리를 제공한다.
- 실행 중 컨테이너의 Docker access log에서 HTTP 상태코드 전체를 비식별 파싱하고 `HTTP-200`, `HTTP-404`, `HTTP-5XX-RATE-001` 같은 태그·경고로 집계한다.

## 호스트에서 실행

Docker CLI와 Docker Engine에 접근할 수 있는 계정에서 실행한다. 대시보드는 다중 사용자 인증이 없는 단일 운영자용 도구다. 호스트 실행은 `127.0.0.1`에만 바인딩하고, Compose 실행 시에도 호스트 포트를 loopback에만 공개한다.

```bash
npm run check --prefix ops-dashboard
npm test --prefix ops-dashboard
npm run test:coverage --prefix ops-dashboard
npm run dev --prefix ops-dashboard
open http://127.0.0.1:9760
```

단위 테스트 커버리지는 `test:coverage` 명령으로 확인하며 line·branch·function 각각 80% 미만이면 실패한다. 현재 검증은 실제 Docker Engine 없이 가짜 Docker CLI와 모듈 경계 테스트로 수행한다. Dockerfile·Compose·tamji 이미지가 준비되면 실제 컨테이너 통합 테스트를 별도 단계로 추가한다.

환경 변수:

| 키 | 기본값 | 설명 |
|---|---:|---|
| `OPS_DASHBOARD_PORT` | `9760` | 대시보드 HTTP 포트 |
| `OPS_DASHBOARD_HOST` | `127.0.0.1` | 수신 주소. 호스트 실행에서는 loopback 유지 |
| `OPS_DASHBOARD_POLL_MS` | `5000` | Docker 자원 조회 주기(ms) |
| `OPS_RESOURCE_THRESHOLD` | `80` | 자원 경고 임계치(%) |
| `OPS_CONTAINER_SCOPE` | `all` | `all`, `image`, `name`, `image-or-name` 중 선택 |
| `OPS_IMAGE_PREFIXES` | 없음 | `image` 계열 범위에서 사용할 쉼표 구분 이미지 접두사 |
| `OPS_NAME_PREFIXES` | 없음 | `name` 계열 범위에서 사용할 쉼표 구분 컨테이너 이름 접두사 |
| `OPS_COMPOSE_FILE` | 없음 | `scale-service.sh`가 사용할 Compose 파일 |
| `OPS_SCALE_SERVICE` | 없음 | 늘릴 Compose 서비스 이름 |
| `OPS_SCALE_TARGET` | `2` | 목표 replica 수. 현재 실행 수보다 작은 값은 차단 |
| `OPS_SCALE_MAX` | `5` | 사전점검 최대 replica 수(절대 상한 20) |
| `OPS_SCALE_WAIT_SECONDS` | `30` | 변경 후 replica 수·헬스 확인 대기 상한(초) |
| `OPS_SCALE_ALLOWED_SERVICES` | 비어 있음 | 안전성 검토 후 확장을 허용할 서비스를 명시하는 목록 |
| `OPS_SCALE_BLOCKED_SERVICES` | 현재 RM의 backend·frontend·model-server·DB·초기화 서비스 | 기본 차단 목록 |
| `OPS_DIAGNOSTICS_DIR` | `${TMPDIR:-/tmp}/rm-ops-diagnostics` | 장애 보고서 저장 디렉터리 |
| `OPS_ACTION_AUDIT_FILE` | `ops-dashboard/.ops-data/action-audit.jsonl` | 최근 스크립트 실행 이력 파일 |
| `OPS_HTTP_STATUS_LOG_TAIL` | `200` | 상태코드 파싱에 사용할 컨테이너별 최근 로그 줄 수 |
| `OPS_HTTP_STATUS_ALERT_DURATION_MS` | `30000` | HTTP 상태코드 경고가 활성화되기까지의 지속 시간(ms) |

현재 프로젝트의 컨테이너만 감시하려면 예를 들어 다음처럼 설정한다. MariaDB가 공식 `mariadb` 이미지라면 앱 이미지와 함께 접두사를 넣는다. 이 설정으로 다른 프로젝트의 컨테이너는 대시보드에서 제외된다. 저장소의 `compose.yaml`은 프로젝트 이름이 `rm-contract-risk`라 컨테이너가 `rm-contract-risk-<서비스>-1`(`rm-contract-risk-frontend-1`·`rm-contract-risk-backend-1`·`rm-contract-risk-model-server-1`·`rm-contract-risk-ollama-1`·`rm-contract-risk-mariadb-1`, 1회 초기화 `rm-contract-risk-backend-init-1`·`rm-contract-risk-backend-embed-1`)로 뜬다.

```dotenv
OPS_CONTAINER_SCOPE=image-or-name
OPS_IMAGE_PREFIXES=moonsangjin/tamji,mariadb
OPS_NAME_PREFIXES=rm-contract-risk-backend,rm-contract-risk-frontend,rm-contract-risk-model-server,rm-contract-risk-ollama,rm-contract-risk-mariadb
OPS_COMPOSE_FILE=/srv/tamji/compose.yml
OPS_SCALE_SERVICE=
OPS_SCALE_TARGET=2
OPS_SCALE_MAX=5
OPS_SCALE_ALLOWED_SERVICES=
OPS_SCALE_BLOCKED_SERVICES=backend,frontend,model-server,mariadb,mysql,database,db,backend-init,backend-embed
```

`tamji` Docker Hub 이미지의 정확한 태그는 Compose 파일에서 관리하고, 대시보드는 접두사로 현재 프로젝트 범위를 잡는다. 저장소에는 비공개 태그나 비밀 환경변수를 기록하지 않는다.

`scale-service.sh`는 사람이 대시보드에서 명시적으로 실행한 경우에만 변경하며, 변경 전에 `preflight-ops.sh`를 실행한다. 현재 실행 수와 목표 수를 비교하고 축소 요청은 차단한다. 허용 목록은 기본적으로 비어 있으며, 현재 RM의 backend·frontend·model-server·DB·초기화 작업은 기본 차단한다. 확장 가능성이 검증된 서비스에 한해 허용 목록에 명시한다. 사전점검만 수행하려면 다음처럼 실행한다.

```bash
OPS_COMPOSE_FILE=/srv/tamji/compose.yml \
OPS_SCALE_SERVICE=<검증된 서비스> OPS_SCALE_TARGET=2 OPS_SCALE_MAX=5 \
OPS_SCALE_ALLOWED_SERVICES=<검증된 서비스> \
  bash ops-dashboard/scripts/preflight-ops.sh
```

## 대시보드만 컨테이너로 실행

대상 서비스가 실행 중인 호스트의 Docker 소켓과 Compose 파일을 읽을 수 있어야 한다. Docker 소켓은 강한 권한이므로 운영 서버에서 접근 계정·파일 권한을 별도로 검토한다.

```bash
cd ops-dashboard
OPS_PROJECT_DIR=/srv/rm OPS_COMPOSE_FILE=/workspace/compose.yml \
  OPS_SCALE_SERVICE= OPS_SCALE_ALLOWED_SERVICES= \
  docker compose up -d --build
```

## API

- `GET /api/overview`: 컨테이너·자원·활성 경고
- `GET /api/logs/stream?containerId=<id>`: 컨테이너 로그 SSE
- `GET /api/error-codes`: 오류코드와 액션 정의
- `GET /api/status-codes`: 표준 HTTP 상태코드 전체와 운영 경고 규칙
- `POST /api/actions/run`: 활성 오류코드에 허용된 대응 스크립트 실행
- `GET /api/health`: 프로세스 상태
- `GET /api/actions/history`: 최근 운영자 실행 이력
- `GET /api/reports`: 진단 보고서 목록
- `GET|DELETE /api/reports/<report-id>`: 개별 보고서 다운로드·삭제

HTTP 상태코드 수집·운영 기준과 주의사항은 [docs/http-status-codes.md](docs/http-status-codes.md)에 기록한다. 실행 이력은 로컬 파일에 저장하지만 사용자 인증·TLS·다중 Docker 호스트·메트릭 영속화는 제공하지 않는다. 다른 사용자나 네트워크에 공개하기 전에는 별도 인증·감사 설계를 적용해야 한다.
