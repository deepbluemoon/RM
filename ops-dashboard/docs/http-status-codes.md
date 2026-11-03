# HTTP 상태코드 운영 카탈로그

이 문서는 `OPS-*` 운영 이벤트 코드와 분리된 HTTP 응답 상태코드 운영 기준이다. 대시보드는 실행 중인 프로젝트 컨테이너의 Docker access log tail을 읽고, 응답 상태코드만 비식별 파싱해 컨테이너별·전체별로 집계한다.

표준 코드명은 [IANA HTTP Status Code Registry](https://www.iana.org/assignments/http-status-codes)를 기준으로 관리한다. 등록되지 않은 숫자나 지원하지 않는 로그 포맷은 상태코드로 추정하지 않는다.

## 태그 규칙

```text
http.status=404
http.status_class=4xx
http.status_tag=HTTP-404
service=backend
container=rm-backend
environment=production
```

- `HTTP-200`처럼 모든 등록 상태코드는 고정 태그를 가진다.
- `1xx`, `2xx`, `3xx`, `4xx`, `5xx` 그룹도 함께 집계한다.
- 요청 경로, query string, Authorization, Cookie, 사용자 식별자는 저장하거나 화면에 표시하지 않는다.
- `OPS-CPU-80-001` 같은 운영 이벤트 코드와 `HTTP-404` 같은 응답 태그를 혼용하지 않는다.

## 등록 상태코드

| 그룹 | 태그 | 설명 |
|---|---|---|
| 1xx | `HTTP-100`, `HTTP-101`, `HTTP-102`, `HTTP-103`, `HTTP-104` | Continue, Switching Protocols, Processing, Early Hints, Upload Resumption Supported(임시) |
| 2xx | `HTTP-200`, `HTTP-201`, `HTTP-202`, `HTTP-203`, `HTTP-204`, `HTTP-205`, `HTTP-206`, `HTTP-207`, `HTTP-208`, `HTTP-226` | 성공·접수·부분 응답·WebDAV·IM Used |
| 3xx | `HTTP-300`, `HTTP-301`, `HTTP-302`, `HTTP-303`, `HTTP-304`, `HTTP-305`, `HTTP-306`, `HTTP-307`, `HTTP-308` | 선택·이동·캐시·리다이렉션. 306은 미사용 |
| 4xx | `HTTP-400`, `HTTP-401`, `HTTP-402`, `HTTP-403`, `HTTP-404`, `HTTP-405`, `HTTP-406`, `HTTP-407`, `HTTP-408`, `HTTP-409`, `HTTP-410`, `HTTP-411`, `HTTP-412`, `HTTP-413`, `HTTP-414`, `HTTP-415`, `HTTP-416`, `HTTP-417`, `HTTP-418`, `HTTP-421`, `HTTP-422`, `HTTP-423`, `HTTP-424`, `HTTP-425`, `HTTP-426`, `HTTP-428`, `HTTP-429`, `HTTP-431`, `HTTP-451` | 요청·권한·검증·제한 오류. 418은 미사용 |
| 5xx | `HTTP-500`, `HTTP-501`, `HTTP-502`, `HTTP-503`, `HTTP-504`, `HTTP-505`, `HTTP-506`, `HTTP-507`, `HTTP-508`, `HTTP-510`, `HTTP-511` | 서버·게이트웨이·저장공간·네트워크 인증 오류. 510은 폐기(obsoleted) |

## 수집 방식

현재 단계는 추가 DB 없이 Docker CLI로 최근 로그를 읽는다.

```text
docker logs --timestamps --tail ${OPS_HTTP_STATUS_LOG_TAIL} <container>
```

지원하는 최소 로그 형태:

```text
"GET /health HTTP/1.1" 200 41
{"status": 404, "message": "not found"}
responseStatus=503
HTTP/1.1 429
```

현재 파서는 `HTTP/x.y status`, `status/statusCode/responseStatus=...`, 일반적인 combined access log의 상태 위치를 인식한다. 애플리케이션별 사용자 정의 로그 포맷은 추후 파서 어댑터로 확장한다.

## 운영 경고 기준

단일 4xx는 정상적인 사용자 입력·권한 거부일 수 있으므로 자동 대응하지 않는다. 다음 조건을 모두 만족할 때만 상태코드 경고를 활성화한다.

| 이벤트 코드 | 기본 기준 | 대응 |
|---|---|---|
| `HTTP-404-RATE-001` | 최소 10건 중 404 비율 20% 이상이 30초 이상 지속 | 라우팅·프론트/백엔드 계약·배포 누락 확인 |
| `HTTP-429-RATE-001` | 최소 10건 중 429 비율 10% 이상이 30초 이상 지속 | rate limit, 호출자 폭주, 재시도 정책 확인 |
| `HTTP-5XX-RATE-001` | 최소 10건 중 5xx 비율 5% 이상이 30초 이상 지속 | 운영자가 선택하는 컨테이너 장애 정보 수집 옵션 활성화. 자동 롤백·자동 확장 금지 |

현재 단계에서 `HTTP-5XX-RATE-001`은 `collect-container-incident.sh` 옵션을 활성화한다. 오류코드는 옵션 노출에만 사용하며 스크립트를 자동 실행하지 않는다. 404·429에는 대응 스크립트를 연결하지 않는다.

## 주의사항

- Docker 로그 tail을 매 polling 주기마다 읽는 최소 구현이므로, 정확한 장기 비율·초당 요청률이 아니다. 정식 운영에서는 access log 수집기 또는 메트릭 저장소로 교체한다.
- 같은 로그가 tail에 반복 포함될 수 있으므로 대시보드의 집계는 “최근 tail 관측값”으로 해석해야 한다.
- 로그 포맷을 잘못 추정해 상태코드를 만들지 않도록 미지원 라인은 무시한다.
- HTTP 상태코드만으로 자동 스케일링하지 않는다. 특히 MariaDB/MySQL 컨테이너는 데이터 일관성 때문에 별도 복제 정책 없이는 확장하지 않는다.
- 화면에 표시되는 경고는 운영자가 확인해야 할 신호이며, 자동 복구 성공을 의미하지 않는다.
- 공개 운영 전에는 인증·TLS·감사 로그를 별도 단계로 추가해야 한다. 이 프로젝트 단계에서는 해당 기능을 구현하지 않는다.

## 후속 확장

1. 장기 메트릭 저장과 시간대별 rate 계산
2. 서비스·라우트별 상태코드 집계
3. 배포 버전·trace ID·request ID 상관관계
4. 포맷별 access log parser adapter
5. 관리자 인증/RBAC와 외부 알림
