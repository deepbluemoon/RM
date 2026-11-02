# Gemini·Vertex LLM 공급자 설정 가이드

M3(최종판정)·M4(요약)를 공유 Ollama(qwen3:4b) 대신 **Google Gemini**로 돌리기 위한 설정 안내다. 로컬에 Ollama 를 띄울 수 없는 PC나 호출량이 많은 팀 환경에서 쓴다. M1·M2(탐지 분류기)와 임베딩(bge-m3)은 공급자와 무관하게 그대로 Ollama 를 쓴다.

> 코드·기본값은 [model-server/.env.example](../model-server/.env.example)·[model-server/config.yaml](../model-server/config.yaml)이 기준이다. 이 문서와 값이 다르면 그 두 파일을 따른다.

## 1. 공급자 선택

`LLM_PROVIDER` 환경변수로 고른다.

| provider | 인증 | 비용·한도 | 용도 |
|---|---|---|---|
| `ollama`(기본) | 공유 Ollama | - | qwen3:4b 를 띄울 수 있는 환경 |
| `gemini` | AI Studio **API 키** | 무료 티어(분당 15·일 1,500) 또는 선불 크레딧 | 1인 개발·소량 |
| `vertex` | **ADC**(Google Cloud) | GCP 결제 크레딧에서 차감, 무료 티어 한도 없음 | **호출 많은 팀** |

## 2. 공통

- 설정은 **`model-server/.env`** 에 넣는다(없으면 새로 만든다). `.env` 는 git 에 올리지 않는다(`git check-ignore -v model-server/.env` 로 확인).
- `MODEL_API_KEY` 는 백엔드의 `MODEL_API_KEY` 와 **같은 값**이어야 백엔드가 모델 서버를 호출한다.

## 3. gemini (AI Studio, API 키)

1. [Google AI Studio](https://aistudio.google.com) 에서 API 키 발급.
2. `model-server/.env`:
   ```
   MODEL_API_KEY=<backend 와 동일>
   LLM_PROVIDER=gemini
   GEMINI_API_KEY=<AI Studio 키>
   GEMINI_MODEL=gemini-3.5-flash-lite
   ```
3. 구형 모델(예: `gemini-2.5-flash`)은 신규 키에 404 가 날 수 있다 — 현재 세대(3.x)를 쓴다.
4. 선불(Prepay) 결제가 걸린 키가 잔액 0 이면 **402**(선불 크레딧 소진)로 막힌다. 무료 티어 키를 쓰거나 vertex 로 전환한다.

## 4. vertex (Google Cloud, 팀용)

### 4.1 관리자(프로젝트 소유자)가 1회

1. 대상 프로젝트에 **Vertex AI API 사용 설정**(API 및 서비스 → 사용 설정). 콘솔에 따라 "Agent Platform API" 로 표기될 수 있다(동일 서비스 `aiplatform.googleapis.com`).
2. 프로젝트에 **결제계정 연결**(크레딧이 있는 계정).
3. 팀원에게 IAM 역할 **`Agent Platform 사용자`**(= Vertex AI User, `roles/aiplatform.user`) 부여:
   - 콘솔: IAM 및 관리자 → IAM → **액세스 권한 부여** → 주 구성원에 팀원 Google 계정, 역할 `Agent Platform 사용자` → 저장.
   - gcloud:
     ```bash
     gcloud projects add-iam-policy-binding <GCP 프로젝트 ID> \
       --member="user:<팀원 이메일>" --role="roles/aiplatform.user"
     ```
   - 팀원이 본인 ADC 사용 시 "requires a quota project" 403 이 나면 그 팀원에게만 `roles/serviceusage.serviceUsageConsumer` 를 추가한다.

### 4.2 팀원이 각자

1. 인증 — 둘 중 하나:
   - 개인 ADC: `gcloud auth application-default login`
   - 서비스계정 키(공유 시): 환경변수 `GOOGLE_APPLICATION_CREDENTIALS=<키 파일 경로>` (키 파일은 저장소에 넣지 않는다)
   - 코드는 `google.auth.default()` 라 둘 다 자동 인식한다.
2. 의존성: `cd model-server && uv sync --extra vertex` (google-auth·requests 설치).
3. `model-server/.env`:
   ```
   MODEL_API_KEY=<backend 와 동일>
   LLM_PROVIDER=vertex
   VERTEX_PROJECT=<GCP 프로젝트 ID>
   VERTEX_LOCATION=global
   GEMINI_MODEL=gemini-3.5-flash-lite
   ```
   vertex 모드는 `GEMINI_API_KEY` 가 필요 없다.

### 4.3 리전 주의 — `global`

현재 세대 Gemini 모델은 Vertex 의 **`global` 엔드포인트에만** 있다. `us-central1` 등 리전으로 호출하면 `publisher model ... not found`(**404**)가 난다. `VERTEX_LOCATION=global` 로 둔다.

## 5. 모델·성능 메모

- vertex 는 출력 구조를 `responseJsonSchema` 로 강제해도 빠르다 → **`gemini-3.5-flash-lite` 로 판정 ≈1초**, 설명 구조(claim/evidence_ids) 보장. (AI Studio 는 스키마 강제 시 지연이 커 쓰지 않으며, 필드명 차이는 게이트웨이가 흡수한다.)
- `gemini-3.8-flash` 는 설명 구조가 더 안정적이지만 약간 느리다. 모델은 `GEMINI_MODEL` 로 바꾼다.
- 판정 캐시 일관성을 위해 `-latest` 별칭보다 **버전 고정 모델**을 권장한다.

## 6. 실행·확인

```bash
cd model-server
uv run python -m uvicorn app.main:app --host 127.0.0.1 --port 9542 --workers 1
```

```bash
# M3·M4 가 gemini/vertex 로 ready 인지
curl -H "Authorization: Bearer <MODEL_API_KEY>" http://127.0.0.1:9542/health
```

`/health` 의 M3·M4 `state` 가 `ready`, `model` 이 설정한 Gemini 모델명이면 정상이다. `model_version` 은 `gemini:<모델>` 또는 `vertex:<모델>` 로 나온다. 키(gemini)나 인증 정보(vertex)가 준비되지 않았으면 M3·M4 가 `error` 로 나오고 모델 서버 로그에 이유가 남는다(1분마다 다시 확인).

## 7. 트러블슈팅

| 증상 | 원인 | 해결 |
|---|---|---|
| **402** prepayment credits depleted | gemini 키가 선불 결제이고 잔액 0 | 무료 티어 키 사용 또는 vertex 전환 |
| **404** publisher model not found | vertex 리전 오류(현재 세대는 global 만) 또는 모델명 | `VERTEX_LOCATION=global`, 현재 세대 모델명 사용 |
| **403** requires a quota project | ADC 쿼터 프로젝트/권한 | 팀원에게 `roles/serviceusage.serviceUsageConsumer` 추가 |
| 503 "google-auth 가 필요합니다" | vertex extra 미설치 | `uv sync --extra vertex` |
| 503 "Vertex 인증 실패" | ADC 미설정 | `gcloud auth application-default login` 또는 `GOOGLE_APPLICATION_CREDENTIALS` |
| 401 인증 실패 | `MODEL_API_KEY` 불일치 | backend 와 같은 값으로 맞춤 |
| /health 에서 M3·M4 error | (ollama 모드에서) Ollama 미연결 | gemini/vertex 로 전환하거나 Ollama 기동 |

> 크레딧은 프로젝트에 연결된 결제계정에서 공용으로 차감된다 — 팀원 전원이 같은 풀을 쓴다.
