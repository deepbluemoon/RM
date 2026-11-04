# 운영 오류코드 카탈로그

운영 화면의 오류코드는 임의 문자열 대신 `OPS-영역-조건-일련번호` 형식을 사용한다. 코드는 화면·로그·스크립트 실행 이력에서 같은 의미로 사용해야 하며, 새 코드를 추가하면 `src/errors.mjs`와 이 문서를 함께 갱신한다.

| 코드 | 조건 | 화면 메시지 의미 | 대응 스크립트 |
|---|---|---|---|
| `OPS-PREFLIGHT-001` | 사람이 선택한 변경 작업 실행 전 Docker·Compose·서비스·replica 설정 사전점검 실패 | 변경 없이 실행을 차단하고 실패 원인을 표시 | `preflight-ops.sh` |
| `OPS-CPU-80-001` | 개별 컨테이너 CPU 사용률이 기본 80% 이상으로 15초 연속 유지 | 경고를 활성화하고 지속 시간을 표시한다. 75% 미만이 30초 연속 유지되면 해제한다. | `collect-container-incident.sh`; 별도 확인 후 `scale-service.sh` |
| `OPS-MEM-80-001` | 개별 컨테이너 메모리 사용률이 기본 80% 이상으로 15초 연속 유지 | 경고를 활성화하고 지속 시간을 표시한다. 75% 미만이 30초 연속 유지되면 해제한다. | `collect-container-incident.sh`; 별도 확인 후 `scale-service.sh` |
| `OPS-DOCKER-001` | Docker CLI가 엔진에 연결되지 않음 | 자원·로그 수집을 일시 중지하고 연결 오류 표시 | `check-docker-access.sh` |
| `HTTP-404-RATE-001` | 최근 access log에서 HTTP 404 비율이 20% 이상이고 10건 이상·30초 이상 지속 | 라우팅·배포 누락 확인이 필요한 상태 | 자동 스크립트 없음 |
| `HTTP-429-RATE-001` | 최근 access log에서 HTTP 429 비율이 10% 이상이고 10건 이상·30초 이상 지속 | rate limit·호출자 폭주 확인이 필요한 상태 | 자동 스크립트 없음 |
| `HTTP-5XX-RATE-001` | 최근 access log에서 HTTP 5xx 비율이 5% 이상이고 10건 이상·30초 이상 지속 | 서버·게이트웨이 오류가 지속되는 상태 | `collect-container-incident.sh` |

## 스크립트 실행 안전 조건

- 자원 경고가 발생해도 스크립트를 자동 실행하지 않는다. 운영자가 대상을 확인하고 실행을 선택해야 한다.
- 자원 경고는 기본 5초 조회 주기에서 80% 이상이 15초 연속 유지될 때 활성화한다. 활성 경고는 75% 이상으로 잠깐 반등해도 유지하며, 75% 미만이 30초 연속 유지될 때 해제한다. 임계치와 지속시간은 `OPS_RESOURCE_THRESHOLD`, `OPS_RESOURCE_CLEAR_THRESHOLD`, `OPS_RESOURCE_ALERT_FOR_MS`, `OPS_RESOURCE_RECOVERY_FOR_MS`로 조정한다.
- 확장은 `OPS_COMPOSE_FILE`, `OPS_SCALE_SERVICE`, `OPS_SCALE_TARGET`, `OPS_SCALE_ALLOWED_SERVICES`를 설정하고 현재 replica보다 큰 목표를 지정한 경우에만 가능하다. 기본 허용 목록은 비어 있다.
- `collect-container-incident.sh`는 컨테이너 상태·종료 정보와 선택적으로 최근 로그 100줄(최대 256 KiB)을 로컬 보고서로 저장한다. 로그 마스킹은 알려진 패턴에 대한 최선형 처리이므로 공유 전 사람이 내용을 확인해야 한다.
- `check-docker-access.sh`는 Docker CLI/context와 Engine 연결 가능 여부를 출력하며, Engine 연결이 불가능해도 점검 결과를 반환한다.
- `scale-service.sh`는 상태 변경 작업이며 실제 변경 전에 `preflight-ops.sh`를 실행한다. Docker Engine 연결, Compose 파일 읽기, Compose 서비스 존재, 명시적 허용 목록, 현재 replica 수, 목표 상한을 확인한다. 실패 시 `OPS-PREFLIGHT-001`을 출력하고 변경하지 않는다.
- `OPS_SCALE_BLOCKED_SERVICES`는 기본적으로 backend·frontend·model-server·MariaDB/MySQL·초기화 서비스를 차단한다. backend 작업 큐, model-server 요청 큐, frontend 고정 포트가 현재 배포에서 수평 확장에 안전하지 않기 때문이다. 해당 서비스는 공유 상태·라우팅·포트 정책을 별도로 개선하기 전까지 허용하지 않는다.
- `preflight-ops.sh`는 현재 실행 replica 수와 목표를 비교한다. 축소는 거부하고 같은 수면 변경 없이 종료한다. `OPS_SCALE_TARGET`는 `OPS_SCALE_MAX`를 넘을 수 없다.
- 실행 이력은 `.ops-data/action-audit.jsonl`에 제한된 항목만 저장한다. 보고서 내용, 원시 로그, 스크립트의 전체 출력은 감사 파일에 넣지 않는다.
- 운영 스크립트는 컨테이너 ID나 사용자 입력을 셸 문자열로 조합하지 않고, 서버에서 허용된 오류코드·액션 조합만 전달받는다.
- HTTP 상태코드 태그(`HTTP-404`)와 운영 이벤트 코드(`OPS-*`, `HTTP-5XX-RATE-001`)는 다른 용도로 유지한다. 단일 4xx 응답만으로 스크립트를 실행하지 않는다.
