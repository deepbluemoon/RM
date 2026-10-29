# 모델 API 사용자 매뉴얼 (crd-model-server)

계약 조항을 보내면 편법(M1)·위법(M2) 점수, 최종 판정(M3), 계약 요약(M4)을 돌려주는 내부 API 입니다.
FastAPI + uvicorn 으로 동작하며 이 서버 안(`127.0.0.1`)에서만 접속할 수 있습니다.

> **점검 상태 (2026-09-29 16:30~16:38)** — launchd `user/504/kr.crd.model-server` 가 `model-server/.venv/bin/uvicorn app.main:app` 을 127.0.0.1:9542 에서 상주 실행 중. 종합 점검 19/19, 단위 테스트 54/54, curl 직접 호출 38건 모두 기대 코드, `kickstart -k` 재기동 후 3.7초 만에 복구. 상세 = [SERVICE_TEST_2026-09-29.md](SERVICE_TEST_2026-09-29.md), 운영 = [GUIDELINE.md](GUIDELINE.md)

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
- **로그인이 필요합니다(2026-09-29 RBAC 복원).** `/docs` 페이지는 열리지만 명세·호출은 백엔드 세션과 `modelApi.view` 권한(운영자·개발자 역할)이 있어야 합니다. 로그인 없이 열면 "Failed to load API definition"(백엔드 `401 G8`), 권한이 없으면 `403 G14`. https://p2.sumzip.com 에서 먼저 로그인한 뒤 같은 브라우저로 `/docs` 를 엽니다.
- 공개 사이트이므로 Swagger 로 보내는 조항도 **비식별화된 텍스트만** 씁니다.

## 1. 엔드포인트

**기본 주소: `http://127.0.0.1:9542`** (서버 밖에서는 접속 불가 — 백엔드 :9522 가 대신 호출)

| 메서드 | 경로 | 모델 | 기능 | 입력 | 응답(정상) | 평균 지연(2026-09-29 실측) |
|---|---|---|---|---|---|---|
| GET | `/health` | — | 서버·모델 상태, 대기 수, 적재 예상 시간 | 없음 | 200 `{status, models[], gpu, warmup_estimate_sec, queue_depth, …}` (적재 중·저하 시 503) | 8ms (10회) |
| GET | `/v1/models` | — | 모델 이름·버전·학습 기준일 | 없음 | 200 `{models[], model_version}` | 4ms |
| POST | `/v1/detect/loophole` | M1 | 편법 탐지(동기) | `{contract_type, clauses[{clause_id, text, title?, article_no?}]}` | 200 `{results[{clause_id,label,type,score}], model_version}` | 45ms (2조항) |
| POST | `/v1/detect/illegal` | M2 | 위법 탐지 + 관련 법률 후보(동기) | 위와 같음 | 200 `{results[{…, related_laws}], model_version}` | 47ms (2조항) |
| POST | `/v1/jobs` | M1 ∥ M2 | 문서 단위 비동기 탐지 작업 생성 | 위와 같음 | 202 `{job_id}` | 3ms (생성), 완료까지 2조항 0.65초·100조항 1.3초 |
| GET | `/v1/jobs/{job_id}` | — | 작업 진행·결과 조회 | 경로의 `job_id` | 200 `{status, total, done, results[], model_versions}` | 3~4ms |
| POST | `/v1/judge` | M3 | 조항 1건 최종 판정(근거 인용) | `{clause, contract_type, perspective, knowledge_date, scores, evidence[≤10]}` | 200 `{risk_class, risk_type, risk_level, confidence, explanation[], model_version}` | 2.1초 (상주, 3회) ~ 4.8초, cold +10~30초 |
| POST | `/v1/summarize` | M4 | 계약 요약 + 계약 유형 후보 | `{clauses[]}` | 200 `{summary, contract_type_candidates[≤3], model_version}` | 2.0초 (상주, 2조항 3회) |
| GET | `/docs` | — | Swagger UI (인증 없음) | 없음 | 200 HTML | 2ms |
| GET | `/openapi.json` | — | 기계용 명세 (인증 없음) | 없음 | 200 JSON (OpenAPI 3.1) | 1ms |

- 공식 계약서: `specs/002-contract-risk-detection/contracts/model-api.openapi.yaml`
- 현재 모델: M1 `loophole-klue-roberta-base@2026-09-29`, M2 `illegal-klue-roberta-base@2026-09-29`(baseline_v0), M3·M4 공유 Ollama `qwen3:4b-instruct-2507-q4_K_M`

## 2. 인증

`/docs`·`/openapi.json` 을 뺀 모든 경로는 Bearer 키가 필요합니다.

```
Authorization: Bearer <MODEL_API_KEY>
```

- 키는 `model-server/.env` 의 `MODEL_API_KEY` 와 `backend/.env` 의 `MODEL_API_KEY` 에 같은 값으로 있습니다. 문서·채팅·코드에 옮겨 적지 않습니다.
- 키가 없거나 틀리면 `401 {"detail":"인증 실패"}`.
- Swagger UI(`/docs`)에서 호출할 때는 각 요청의 헤더에 위 값을 직접 넣습니다.

셸에서 쓸 때(키를 화면에 출력하지 않는 방법):

```bash
cd ~/project2610/model-server
set -a; source .env; set +a          # MODEL_API_KEY 를 셸 변수로만 읽음(echo 금지)
K=$MODEL_API_KEY
B=http://127.0.0.1:9542
```

### 2.1 첫 요청 예시 (키 자리 = `<MODEL_API_KEY>`, 실제 값은 `.env` 에서 읽기)

curl:

```bash
curl -s -H "Authorization: Bearer <MODEL_API_KEY>" -H 'content-type: application/json' \
  http://127.0.0.1:9542/v1/detect/loophole \
  -d '{"contract_type":"ecommerce","clauses":[{"clause_id":"c1","text":"회사는 어떠한 손해에 대하여도 책임을 지지 않습니다."}]}'
```

Python (httpx — `model-server/.venv` 에 있음):

```python
import os, httpx

key = os.environ["MODEL_API_KEY"]            # 코드에 <MODEL_API_KEY> 값을 적지 않는다
with httpx.Client(base_url="http://127.0.0.1:9542",
                  headers={"Authorization": f"Bearer {key}"}, timeout=60) as c:
    r = c.post("/v1/detect/loophole", json={
        "contract_type": "ecommerce",
        "clauses": [{"clause_id": "c1", "text": "회사는 어떠한 손해에 대하여도 책임을 지지 않습니다."}],
    })
    r.raise_for_status()
    print(r.json()["results"][0])            # {'clause_id': 'c1', 'label': 'loophole', 'type': ..., 'score': ...}
```

JavaScript (Node 20 내장 fetch — 백엔드와 같은 방식):

```javascript
const key = process.env.MODEL_API_KEY; // <MODEL_API_KEY>
const res = await fetch('http://127.0.0.1:9542/v1/detect/loophole', {
  method: 'POST',
  headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    contract_type: 'ecommerce',
    clauses: [{ clause_id: 'c1', text: '회사는 어떠한 손해에 대하여도 책임을 지지 않습니다.' }],
  }),
});
if (!res.ok) throw new Error(`${res.status} ${(await res.json()).detail}`);
console.log((await res.json()).results);
```

브라우저에서 직접 부르지 않습니다(127.0.0.1 전용·키 노출). 웹 화면은 백엔드(:9522)를 거칩니다.

## 3. 공통 규칙

| 항목 | 내용 |
|---|---|
| 본문 형식 | `Content-Type: application/json`, UTF-8 |
| 조항 텍스트 | **비식별화가 끝난 텍스트만** 보냅니다(CLAUDE.md 규칙). 서버는 본문을 로그에 남기지 않습니다 |
| 조항 수 한도 | 요청당 2,000개. 넘으면 413 |
| 본문 크기 한도 | 20MB. 넘으면 413 |
| 조항 길이 | 512토큰(약 700~900자)까지 봅니다. 뒷부분은 잘립니다 |
| 요청 ID | `x-request-id` 헤더를 보내면 응답에 그대로, 안 보내면 새로 만들어 돌려줍니다. 문의할 때 이 값을 알려 주세요 |
| 결정성 | 같은 입력이면 항상 같은 점수(배치 크기와도 무관) — 결과 캐시에 써도 됩니다 |

`contract_type` 값(M1·M2 입력 앞에 한글로 붙음):

| 값 | 뜻 |
|---|---|
| `ecommerce` | 전자상거래 |
| `subscription` | 구독 |
| `installment` | 할부 |
| `door_to_door` | 방문판매 |
| `general_consumer` | 일반 소비자 거래 |
| `out_of_scope` | 범위 밖 |

목록에 없는 값도 400 없이 처리되지만 학습에 없던 입력이라 권하지 않습니다.

## 4. 엔드포인트별 사용법

### 4.1 상태 확인 — `GET /health`

```bash
curl -s -H "Authorization: Bearer $K" $B/health
```

```json
{
  "status": "ready",
  "models": [
    {"id": "M1", "state": "ready", "model": "loophole-klue-roberta-base", "size_mb": 422},
    {"id": "M2", "state": "ready", "model": "illegal-klue-roberta-base", "size_mb": 422},
    {"id": "M3", "state": "ready", "model": "qwen3:4b-instruct-2507-q4_K_M", "size_mb": 2381},
    {"id": "M4", "state": "ready", "model": "qwen3:4b-instruct-2507-q4_K_M", "size_mb": 2381}
  ],
  "gpu": {"used_mb": 3677, "total_mb": 131072},
  "model_version": "crd-model-server@0.1.0",
  "knowledge_date": null,
  "warmup_estimate_sec": null,
  "queue_depth": 0
}
```

| 필드 | 읽는 법 |
|---|---|
| `status` | `ready`(200) 사용 가능 / `loading`(503) M1·M2 적재 중(기동 직후 약 5초) / `degraded`(503) M3·M4 모델 없음·Ollama 연결 불가 |
| `models[].state` | `ready` 상주 / `cold` 설치됐지만 내려가 있음(첫 호출에 10~30초 추가, 오류 아님) / `loading` / `missing` / `error` |
| `warmup_estimate_sec` | cold 모델을 올리는 데 걸릴 예상 초. 없으면 `null` — 화면 안내("준비 중 약 N초")에 씁니다 |
| `queue_depth` | M3·M4 호출 대기 수(동시 1건만 처리). 1 이상이면 "앞 요청 처리 중" 안내 |

**`models[].model` 이 `loophole-heuristic`·`illegal-heuristic` 이면 파인튜닝 모델이 아니라 키워드 규칙으로 동작 중입니다** → 운영 가이드라인 §6 참고.

### 4.2 모델 버전 — `GET /v1/models`

결과를 저장할 때 `model_version` 을 함께 저장합니다. 모델이 바뀌면 버전 문자열이 달라져 캐시·평가가 섞이지 않습니다.

### 4.3 편법 탐지 — `POST /v1/detect/loophole` (M1)

```bash
curl -s -H "Authorization: Bearer $K" -H 'content-type: application/json' $B/v1/detect/loophole -d '{
  "contract_type": "ecommerce",
  "clauses": [
    {"clause_id": "c1", "title": "면책", "text": "회사는 서비스 이용과 관련하여 회원에게 발생한 어떠한 손해에 대하여도 책임을 지지 않습니다."},
    {"clause_id": "c2", "text": "회원은 아이디와 비밀번호를 제3자에게 이용하게 하여서는 안 됩니다."}
  ]}'
```

```json
{"results": [
   {"clause_id": "c1", "label": "loophole", "type": "liability_avoid", "score": 0.9131},
   {"clause_id": "c2", "label": "none", "type": "rights_limit", "score": 0.1454}],
 "model_version": "loophole-klue-roberta-base@2026-09-29", "knowledge_date": null}
```

| 필드 | 뜻 |
|---|---|
| `clause_id` | 보낸 순서·ID 그대로 |
| `score` | 편법(위험) 확률 = 1 − P(정상). 0~1 |
| `label` | `score ≥ 0.5` 이면 `loophole`, 아니면 `none` |
| `type` | 가장 가능성 높은 위험 유형: `rights_limit`(권리 제한) · `liability_avoid`(책임 회피) · `refund_cancel_limit`(환불·해지 제한) · `unilateral_change`(일방 변경) · `excessive_penalty`(과도한 위약금) · `vague`(모호) · `other`. **`label` 이 `none` 이어도 채워지므로 `label` 을 먼저 봅니다** |

선택 필드 `title`(조 제목)·`article_no`(조 번호)는 있으면 보냅니다. 제목은 점수에 영향이 작습니다.

### 4.4 위법 탐지 — `POST /v1/detect/illegal` (M2)

요청 형식은 4.3 과 같습니다.

```json
{"results": [{"clause_id": "a1", "label": "illegal", "type": "약관의 규제에 관한 법률",
              "related_laws": ["약관의 규제에 관한 법률"], "score": 0.7201}],
 "model_version": "illegal-klue-roberta-base@2026-09-29", "knowledge_date": null}
```

| 필드 | 뜻 |
|---|---|
| `score`·`label` | 위법 소지 확률, `≥ 0.5` 이면 `illegal` |
| `type` | 관련 가능성이 가장 높은 법률 1개 |
| `related_laws` | 확률 0.5 이상 법률(최대 3개). 후보: 약관법·전자상거래법·소비자기본법·할부거래법·방문판매법 |

현재 모델(baseline_v0)은 **`related_laws` 에 약관법만** 내놓습니다. 근거 검색 가중치로만 쓰고 화면에 확정 법률처럼 보여 주지 않습니다.

### 4.5 문서 단위 비동기 탐지 — `POST /v1/jobs` → `GET /v1/jobs/{job_id}`

조항이 많을 때(수십~수천 개) 씁니다. M1·M2 를 함께 돌려 조항별 결과를 쌓습니다.

```bash
JOB=$(curl -s -H "Authorization: Bearer $K" -H 'content-type: application/json' $B/v1/jobs -d '{
  "contract_type": "subscription",
  "clauses": [{"clause_id": "c1", "text": "구매한 이용권은 어떠한 경우에도 환불되지 않습니다."},
              {"clause_id": "c2", "text": "회원은 회원정보가 변경된 경우 지체 없이 수정하여야 합니다."}]}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["job_id"])')
curl -s -H "Authorization: Bearer $K" $B/v1/jobs/$JOB
```

생성 응답은 `202 {"job_id": "..."}`. 조회 응답:

```json
{"job_id": "…", "status": "done", "total": 2, "done": 2,
 "results": [{"clause_id": "c1",
              "loophole": {"label": "loophole", "type": "refund_cancel_limit", "score": 0.9726},
              "illegal": {"label": "illegal", "type": "약관의 규제에 관한 법률", "related_laws": ["약관의 규제에 관한 법률"], "score": 0.7762},
              "error": null}, …],
 "model_versions": {"M1": "loophole-klue-roberta-base@2026-09-29", "M2": "illegal-klue-roberta-base@2026-09-29"},
 "knowledge_date": null}
```

- `status`: `queued` → `running` → `done` | `failed`. 작업은 들어온 순서대로 하나씩 처리합니다.
- `done`/`total` 로 진행률을 보여 줄 수 있습니다. 결과는 16조항 배치가 끝날 때마다 쌓입니다.
- 조회 간격은 0.5~1초면 충분합니다. 100조항이 약 1.3~11초(동시 부하에 따라), 2조항은 약 0.65초 걸립니다(2026-09-29 실측).
- 조항 결과가 `{"clause_id": …, "error": "timeout"}`(loophole·illegal 없음)이면 그 16조항 배치가 60초 안에 끝나지 않은 것입니다(분석 불가로 표시).
- 작업은 **1시간 뒤 지워지고**, 없는 ID 는 404 입니다. 서버를 재기동해도 사라집니다.

### 4.6 최종 판정 — `POST /v1/judge` (M3)

조항 1건과 M1·M2 점수, 백엔드가 찾은 근거(최대 10개)를 보내면 판정과 근거 인용 설명을 돌려줍니다.

```bash
curl -s -H "Authorization: Bearer $K" -H 'content-type: application/json' $B/v1/judge -d '{
  "clause": "구매한 이용권은 어떠한 경우에도 환불되지 않습니다.",
  "contract_type": "subscription",
  "perspective": "business",
  "knowledge_date": "2026-09-29",
  "scores": {"loophole": 0.96, "illegal": 0.79},
  "evidence": [{"id": "ev-1", "source_type": "law_article",
                "title": "전자상거래 등에서의 소비자보호에 관한 법률 제17조",
                "text": "통신판매업자와 재화등의 구매에 관한 계약을 체결한 소비자는 7일 이내에 … 청약철회등을 할 수 있다."}]}'
```

```json
{"risk_class": "dispute", "risk_type": "refund_cancel_limit", "risk_level": "mid", "confidence": "medium",
 "explanation": [{"claim": "소비자는 구매 후 7일 이내에 청약철회를 할 수 있습니다. 이는 환불이 불가능하다는 조항과 충돌할 수 있습니다.",
                  "evidence_ids": ["ev-1"]}, …],
 "model_version": "ollama:qwen3:4b-instruct-2507-q4_K_M", "knowledge_date": "2026-09-29"}
```

| 요청 필드 | 필수 | 값 |
|---|---|---|
| `clause` | 예 | 비식별 조항(빈 문자열 불가) |
| `contract_type` | 예 | 3절 표 |
| `perspective` | 예 | `consumer` · `business` (현재 서비스는 `business` 고정) |
| `knowledge_date` | 예 | `YYYY-MM-DD` — 근거 자료 기준일 |
| `scores` | 예 | `{loophole, illegal}` 0~1 (M1·M2 점수, 빈 객체 가능) |
| `evidence` | 예 | 최대 10개. `source_type` = `law_article` · `ftc_case` · `std_terms`. 빈 배열 가능 |

| 응답 필드 | 값 |
|---|---|
| `risk_class` | `normal`(정상) · `dispute`(분쟁 가능) · `unfair`(불공정 가능) · `illegal`(위법 가능) |
| `risk_type` | M1 유형 7종 또는 `null` |
| `risk_level` / `confidence` | `high`·`mid`·`low` / `high`·`medium`·`low` |
| `explanation[]` | 주장 + 인용한 근거 ID. 보낸 근거에 없는 ID 는 나오지 않습니다 |

- 공유 Ollama 에서 **동시에 1건씩** 처리합니다. 여러 조항은 순서대로 보내고, 대기 중이면 `/health.queue_depth` 가 늘어납니다.
- 모델이 내려가 있으면(`cold`) 첫 호출이 10~30초 더 걸립니다. 요청 제한 시간은 300초입니다.
- 서버 후처리: 단정 표현(`shared/assertion-terms.json`)이 들어간 주장, 근거 ID 가 없거나 보낸 근거에 없는 ID 를 인용한 주장은 **뺍니다**. 모두 빠지면 `explanation` 이 빈 배열이 됩니다(백엔드가 G9 로 처리).

### 4.7 계약 요약 — `POST /v1/summarize` (M4)

```bash
curl -s -H "Authorization: Bearer $K" -H 'content-type: application/json' $B/v1/summarize -d '{
  "clauses": [{"clause_id": "s1", "title": "목적", "text": "이 약관은 회사가 제공하는 구독형 동영상 서비스의 이용 조건을 정합니다."},
              {"clause_id": "s2", "title": "요금", "text": "이용요금은 매월 결제일에 등록된 결제수단으로 자동 결제됩니다."}]}'
```

응답: `{"summary": "…", "contract_type_candidates": [{"label": "subscription", "score": …}, …], "model_version": "…", "knowledge_date": null}`

- 후보는 최대 3개, `label` 은 3절의 6종 중 하나입니다.
- 설계 결정(2026-09-29)으로 M4 역할이 "분석 후 탐지 결과 요약"으로 바뀔 예정입니다. 바뀌면 이 요청 형식도 달라집니다.

## 5. 오류 코드

모든 오류 본문은 `{"detail": "<사유>"}` 입니다. 사유에 요청 원문은 들어가지 않습니다.

| 코드 | 뜻 | 언제(실측 `detail` 예) | 고치는 방법 |
|---|---|---|---|
| 400 | 입력 오류 | 깨진 JSON(`입력 오류 — body.12: JSON decode error`), 빈 `clauses`(`List should have at least 1 item`), 필드 누락(`body.clauses.0.text: Field required`), `perspective`(`Input should be 'consumer' or 'business'`)·날짜·점수 범위 오류, 근거 11개 이상. **FastAPI 기본 422 대신 400 으로 돌려줍니다** | `detail` 의 위치(`body.clauses.0.text` 등)를 보고 본문을 고침 |
| 401 | 인증 실패 | 키 없음·틀린 키·Basic 방식(`{"detail":"인증 실패"}`) — `/docs`·`/openapi.json` 외 전 경로 | `Authorization: Bearer <MODEL_API_KEY>` 확인, 두 `.env` 값 일치 확인(GUIDELINE §6-3) |
| 404 | 없음 | 없는·1시간 지난·재기동 전 `job_id`(`작업이 없습니다`), 없는 경로(`Not Found`) | 작업을 다시 생성, 경로 확인 |
| 405 | 메서드 불일치 | 예: `GET /v1/judge`(`Method Not Allowed`) | 1절 표의 메서드 사용 |
| 413 | 한도 초과 | 조항 2,001개 이상(`조항 수가 한도(2000)를 넘습니다`), 본문 20MB 초과(`요청 본문이 너무 큽니다`) | 나눠서 보냄. 문서 전체는 `/v1/jobs` |
| 503 | 사용 불가 | M1·M2 적재 중(기동 직후 약 4~5초), M3·M4 모델 없음·Ollama 연결 불가, 처리 중 예외 | 잠시 뒤 재시도, 계속되면 `/health` 확인 → GUIDELINE §6 |
| 504 | 시간 초과 | 동기 탐지·M3·M4 시간 초과(M3·M4 300초) | 조항 수를 줄이거나 `/v1/jobs` 사용, `/health` 의 `queue_depth` 확인 |

웹 프록시(`https://p2.sumzip.com/api/admin/model-api/*`)를 거치면 모델 서버 코드 앞에 백엔드 게이트가 먼저 옵니다: 비로그인 `401 G8`, 권한 없음 `403 G14`, 허용 목록 밖 경로 404, 본문 3MB 초과 413.

## 6. 결과를 해석할 때 주의 (현재 모델 baseline_v0 기준)

테스트 결과(`reports/baseline_v0/MODEL_TEST_REPORT.md`)에 따른 주의점입니다.

1. **짧은 문장에서만 잘 맞습니다.** 약 130자를 넘는 조항, 여러 항이 섞인 조항에서는 명백한 위험 문구도 낮은 점수를 받습니다. 긴 조항의 낮은 점수를 "안전"으로 단정하지 마세요.
2. **M1 은 주제에 반응합니다.** 책임·환불·위약금이 들어간 공정한 조항도 높은 점수를 받습니다. 높은 점수는 "검토 필요" 신호로 쓰고, 최종 판단은 M3 판정과 근거로 합니다.
3. M2 `related_laws` 는 약관법만 나옵니다(4.4).
4. 참고 성능(eval 363조항): M1 F1 0.77·AUC 0.94, M2 F1 0.67·AUC 0.95. 이 수치는 실제 계약서 성능보다 높게 나온 값입니다.

## 7. 빠른 점검

```bash
cd ~/project2610/model-server
.venv/bin/python scripts/service_test.py            # 19개 항목, 약 10~30초 (M3·M4 호출 2~3회 포함)
.venv/bin/python scripts/service_test.py --out docs/service-test-result.json   # 결과 저장
.venv/bin/python scripts/service_test.py --no-llm   # 공유 Ollama 호출 없이
```

마지막에 `19/19 통과` 가 나오면 정상입니다(2026-09-29 16:30 = 19/19, 9.7초).
