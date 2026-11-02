# RM 운영 모니터링 대시보드

기존 RM 사용자 화면과 분리된 독립 운영 페이지다. Docker Engine을 감시 대상으로 삼지만 대시보드 자체는 기본적으로 호스트 Node 프로세스로 실행할 수 있으며, 필요할 때만 제공된 Dockerfile/Compose로 컨테이너화한다.

## 제공 범위

- 모든 컨테이너(실행 중·중지됨)를 한 화면에서 확인한다.
- 실행 중 컨테이너의 CPU·메모리 사용률을 5초마다 읽고, 개별 자원이 80% 이상이면 지속 시간을 포함한 경고를 표시한다.
- 컨테이너를 선택하면 Docker 로그를 타임스탬프와 함께 실시간 스트림으로 표시한다.
- 오류코드에 대응하는 운영 스크립트 버튼은 평상시 비활성화하고, 해당 오류코드가 활성화된 경우에만 활성화한다.
- 자원 경고 대응은 대상 Compose 서비스의 인스턴스를 늘리는 방식이며, 운영 환경 설정이 없으면 실행되지 않는다.
- MariaDB 컨테이너도 전체 대상에 포함되지만 무상태 서비스와 달리 자동 수평 확장하지 않는다. DB는 복제·클러스터 정책을 확정한 후 별도 대응 스크립트를 추가한다.
- 실행 중 컨테이너의 Docker access log에서 HTTP 상태코드 전체를 비식별 파싱하고 `HTTP-200`, `HTTP-404`, `HTTP-5XX-RATE-001` 같은 태그·경고로 집계한다.

## 호스트에서 실행

Docker CLI와 Docker Engine에 접근할 수 있는 계정에서 실행한다.

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
| `OPS_DASHBOARD_POLL_MS` | `5000` | Docker 자원 조회 주기(ms) |
| `OPS_RESOURCE_THRESHOLD` | `80` | 자원 경고 임계치(%) |
| `OPS_CONTAINER_SCOPE` | `all` | `all`, `image`, `name`, `image-or-name` 중 선택 |
| `OPS_IMAGE_PREFIXES` | 없음 | `image` 계열 범위에서 사용할 쉼표 구분 이미지 접두사 |
| `OPS_NAME_PREFIXES` | 없음 | `name` 계열 범위에서 사용할 쉼표 구분 컨테이너 이름 접두사 |
| `OPS_COMPOSE_FILE` | 없음 | `scale-service.sh`가 사용할 Compose 파일 |
| `OPS_SCALE_SERVICE` | 없음 | 늘릴 Compose 서비스 이름 |
| `OPS_SCALE_TARGET` | `2` | 경고 대응 후 목표 인스턴스 수 |
| `OPS_SCALE_MAX` | `5` | 사전점검에서 허용하는 최대 인스턴스 수 |
| `OPS_SCALE_ALLOWED_SERVICES` | `backend,frontend,model-server` | 자동 확장이 허용된 무상태 Compose 서비스 목록 |
| `OPS_HTTP_STATUS_LOG_TAIL` | `200` | 상태코드 파싱에 사용할 컨테이너별 최근 로그 줄 수 |
| `OPS_HTTP_STATUS_ALERT_DURATION_MS` | `30000` | HTTP 상태코드 경고가 활성화되기까지의 지속 시간(ms) |

현재 프로젝트의 컨테이너만 감시하려면 예를 들어 다음처럼 설정한다. MariaDB가 공식 `mariadb` 이미지라면 앱 이미지와 함께 접두사를 넣는다. 이 설정으로 다른 프로젝트의 컨테이너는 대시보드에서 제외된다. 저장소의 `compose.yaml`은 프로젝트 이름이 `rm`이라 컨테이너가 `rm-<서비스>-1`(`rm-frontend-1`·`rm-backend-1`·`rm-model-server-1`·`rm-mariadb-1`, 1회 초기화 `rm-backend-init-1`)로 뜬다.

```dotenv
OPS_CONTAINER_SCOPE=image-or-name
OPS_IMAGE_PREFIXES=moonsangjin/tamji,mariadb
OPS_NAME_PREFIXES=rm-backend,rm-frontend,rm-model-server,rm-mariadb
OPS_COMPOSE_FILE=/srv/tamji/compose.yml
OPS_SCALE_SERVICE=backend
OPS_SCALE_TARGET=2
OPS_SCALE_MAX=5
OPS_SCALE_ALLOWED_SERVICES=backend,frontend,model-server
```

`tamji` Docker Hub 이미지의 정확한 태그는 Compose 파일에서 관리하고, 대시보드는 접두사로 현재 프로젝트 범위를 잡는다. 저장소에는 비공개 태그나 비밀 환경변수를 기록하지 않는다.

`scale-service.sh`는 변경 전에 `preflight-ops.sh`를 실행한다. Docker Engine·Compose 파일·서비스 목록·허용 목록·replica 상한을 모두 통과해야 하며, 기본 허용 목록에 없는 서비스와 MariaDB/MySQL 계열 서비스는 자동 확장하지 않는다. 사전점검만 수행하려면 다음처럼 실행한다.

```bash
OPS_COMPOSE_FILE=/srv/tamji/compose.yml \
OPS_SCALE_SERVICE=backend OPS_SCALE_TARGET=2 OPS_SCALE_MAX=5 \
  bash ops-dashboard/scripts/preflight-ops.sh
```

## 대시보드만 컨테이너로 실행

대상 서비스가 실행 중인 호스트의 Docker 소켓과 Compose 파일을 읽을 수 있어야 한다. Docker 소켓은 강한 권한이므로 운영 서버에서 접근 계정·파일 권한을 별도로 검토한다.

```bash
cd ops-dashboard
OPS_PROJECT_DIR=/srv/rm OPS_COMPOSE_FILE=/workspace/compose.yml \
  OPS_SCALE_SERVICE=backend OPS_SCALE_TARGET=2 \
  docker compose up -d --build
```

## API

- `GET /api/overview`: 컨테이너·자원·활성 경고
- `GET /api/logs/stream?containerId=<id>`: 컨테이너 로그 SSE
- `GET /api/error-codes`: 오류코드와 액션 정의
- `GET /api/status-codes`: 표준 HTTP 상태코드 전체와 운영 경고 규칙
- `POST /api/actions/run`: 활성 오류코드에 허용된 대응 스크립트 실행
- `GET /api/health`: 프로세스 상태

HTTP 상태코드 수집·운영 기준과 주의사항은 [docs/http-status-codes.md](docs/http-status-codes.md)에 기록한다. 인증·TLS·감사 로그·다중 Docker 호스트·메트릭 영속화는 현재 단계가 아니다. 운영 공개 전에는 기존 인증 체계 또는 별도 운영망/리버스 프록시를 붙이는 후속 이슈가 필요하다.
