# 공유 Ollama 서버 사용 가이드 (사용자·에이전트용)

> 최종 갱신: 2026-09-28 (설치 모델 공용화, `num_ctx` 8192 고정, 1.7절 성능 주의사항) | 위치: `/Users/Shared/ollama/ollama-user-guide.md` | 이 서버의 모든 사용자 계정이 읽을 수 있다
>
> 에이전트에게는 "`/Users/Shared/ollama/ollama-user-guide.md`를 읽고 그 규칙대로 구현하라"고 지시하면 된다.

## 목차
- [1. 사용자 가이드라인](#1-사용자-가이드라인)
  - [1.1 접속 정보](#11-접속-정보)
  - [1.2 사용 가능 모델](#12-사용-가능-모델)
  - [1.3 사용 규칙](#13-사용-규칙)
  - [1.4 알려진 함정](#14-알려진-함정)
  - [1.5 새 모델 추가하기](#15-새-모델-추가하기)
  - [1.6 모델 로드·상주·언로드](#16-모델-로드상주언로드)
  - [1.7 서버 성능 주의사항](#17-서버-성능-주의사항)
- [2. 에이전트 구현 매뉴얼](#2-에이전트-구현-매뉴얼)
  - [2.1 구현 절차](#21-구현-절차)
  - [2.2 코드 템플릿](#22-코드-템플릿)
  - [2.3 오류 대응](#23-오류-대응)
  - [2.4 완료 체크리스트](#24-완료-체크리스트)

---

## 1. 사용자 가이드라인

> 대상: 이 서버의 개별 사용자 계정과, 그 계정에서 서비스를 구현하는 AI 에이전트
> 검증일: 2026-09-28 (아래 호출 예시와 코드는 모두 실제로 실행해 확인했다)

이 서버에는 **모든 사용자가 함께 쓰는 공유 Ollama 서버**가 하나 떠 있다. 각 계정에서 Ollama를 설치하거나, 서버를 띄우거나, 모델을 내려받을 필요가 없다. 로컬 주소로 API를 호출하기만 하면 된다.

### 1.1 접속 정보

| 항목 | 값 |
|------|----|
| API 주소 | `http://127.0.0.1:11434` (이 서버 안에서만) |
| 인증 | 없음 |
| 네이티브 API | `/api/chat`, `/api/generate`, `/api/embed` |
| OpenAI 호환 API | `/v1/chat/completions`, `/v1/embeddings`, `/v1/models` |
| CLI | `ollama list`, `ollama run <모델>` (추가 설정 없이 동작) |

설정값은 코드에 직접 쓰지 말고 환경변수로 받는다:
```bash
export OLLAMA_URL=http://127.0.0.1:11434
export OLLAMA_CHAT_MODEL=gemma3:4b
export OLLAMA_EMBED_MODEL=bge-m3
```

접속 확인:
```bash
curl -s http://127.0.0.1:11434/api/version     # {"version":"..."}
```

### 1.2 사용 가능 모델

**서버에 이미 설치된 모델은 모든 사용자가 공용으로 쓸 수 있다.** 누가 받았든, 누가 올려 두었든 똑같이 호출하면 된다. 이미 메모리에 올라가 있는 모델을 **같은 `num_ctx`(8192)로** 부르면 로딩 없이 바로 응답한다. 현재 목록은 `ollama list`(설치), `ollama ps`(메모리 상주)로 확인한다. 모델은 크기에 따라 세 등급으로 나눈다.

#### A등급: 자유 사용 (10GB 이하)

| 용도 | 모델 | 특징 |
|------|------|------|
| **채팅 기본** | `gemma3:4b` | 빠름 (약 4초), 한국어 가능, JSON 모드 정상 (실측) |
| 채팅 고품질 | `qwen3:8b` | `"think": false` 필수 (1.4) (실측) |
| 채팅 경량 | `qwen3:4b-instruct-2507-q4_K_M` | 사고 모드가 없는 instruct 판. 짧고 깨끗한 답 (실측) |
| 채팅 초경량 | `llama3.2:1b`, `gemma:2b` | 간단한 분류·요약용 |
| 12B 채팅·추출 | `gemma4:12b-optimized` | 12B 추출 튜닝 모델 (gemma3 12B 기반, temperature 0으로 결정적 출력). 8.5GiB, 약 7초 (실측) |
| 12B 채팅·추출 | `gemma3:12b-optimized` | 위와 같은 계열의 추출 튜닝 모델 |
| 12B 도구 호출 | `PetrosStav/gemma3-tools:12b` | function calling 지원 |
| 이미지 이해 | `qwen3-vl:latest`, `gemma4:e4b` | 비전 모델. `gemma4:e4b`는 오디오·도구·사고 모드도 지원 |
| 임베딩 (다국어·한국어) | `bge-m3` | 1024차원 (실측) |
| 임베딩 (영어·경량) | `nomic-embed-text` (768차원), `mxbai-embed-large` (1024차원) | |

#### B등급: 조건부 사용 (10~20GB)

`phi4-reasoning:14b`, `gpt-oss:20b`, `gemma3:27b`, `gemma4:26b`, `qwen3:30b`, `qwen3-coder:30b`

- 품질이 꼭 필요한 **짧은 작업이나 시험용**으로만 쓴다. 상시 서비스의 기본 모델로 쓰지 않는다.
- `keep_alive`는 `"2m"` 이하로 하고, 대량 작업(배치)에는 쓰지 않는다.
- 한 사용자가 B등급 모델을 동시에 두 개 이상 올리지 않는다.

#### C등급: 관리자 승인 필요

`gpt-oss:120b` (65GB). 올리기만 해도 서버 메모리의 절반을 차지한다.

#### 사용하지 않는 모델

| 모델 | 이유 | 대신 쓸 모델 |
|------|------|------|
| `gemma3:12b` | 운영 서비스가 상주시켜 쓰는 예약 모델이다. 다른 `num_ctx`로 부르면 모델이 다시 로딩되어 운영 서비스가 느려진다 | `gemma3:12b-optimized` 또는 `gemma4:12b-optimized` |
| 이름이 `:cloud`로 끝나는 모델 | 외부 과금 계정을 소모한다 | A등급 모델 |
| `qwen3:4b` | 사고 모드가 꺼지지 않는다. 사고 과정만으로 출력 한도를 다 써서 답을 얻지 못하는 경우가 있다 (1.4, 실측) | `qwen3:4b-instruct-2507-q4_K_M` |
| `-64k`, `-128k` 변형 | 내장 컨텍스트가 커서 `/v1` 경로로 부르면 메모리를 크게 쓴다 | 기본 이름 + `num_ctx: 8192` |

`-4k`, `-8k`, `-16k`, `-32k`, `-optimized` 같은 변형은 같은 가중치에 설정만 다른 모델이다. 이름이 다르면 메모리에 따로 올라가므로, 가능하면 **기본 이름을 쓰고 `num_ctx: 8192`를 넘긴다.** 그래야 다른 사용자와 같은 인스턴스를 공유할 수 있다.

한 서비스 안에서는 임베딩 모델을 바꾸지 않는다. 차원이 다르면 이미 저장한 벡터와 섞어 쓸 수 없다.

### 1.3 사용 규칙

공유 서버라서 한 사람의 행동이 모든 사용자에게 영향을 준다.

| 구분 | 규칙 |
|------|------|
| ✅ 허용 | 새 모델 `ollama pull` (크기 10GB 이하, 1.5 절차) |
| ✅ 허용 | `ollama create` / `ollama cp`. 단, 이름은 반드시 **`<계정명>-`으로 시작** (예: `pioneer7-faqbot:v1`) |
| ✅ 허용 | **자기 계정명으로 시작하는 모델만** `ollama rm` |
| 🚫 금지 | 그 밖의 모델을 `ollama rm` (`/api/delete`). **모든 사용자에게서 그 모델이 사라진다** |
| 🚫 금지 | 접두사 없는 이름이나 기존 모델 이름으로 `create` / `cp`. 다른 사람이 쓰는 모델을 덮어쓴다 |
| 🚫 금지 | `ollama stop`, `ollama push` (`/api/push`). 다른 사람이 쓰는 모델이 내려가거나 외부로 올라간다 |
| 🚫 금지 | 자기 계정에서 `ollama serve` 실행, 또는 11434 포트 점유 |
| 🚫 금지 | 이름에 `:cloud`가 붙은 모델 사용 (외부 과금 계정을 소모함) |
| 🚫 금지 | `keep_alive`를 `-1`(영구 상주)로 지정 |
| ✅ 필수 | `keep_alive`는 `"5m"` 이하 |
| ✅ 필수 | **모든 요청에 `"options":{"num_ctx":8192}`를 넣는다. 8192가 고정값이며 더 큰 값은 쓰지 않는다** (모두가 같은 값을 써야 로드된 모델을 공유할 수 있다). 생략하면 모델의 최대값(131072)으로 올라간다. 그러면 4B 모델이 24GiB를 차지하고 **다른 사용자의 모델이 밀려난다** (실측) |
| ✅ 필수 | 서비스 하나가 동시에 보내는 요청은 **1건**. 병렬로 보내면 결국 줄만 길어진다 |
| ✅ 필수 | 요청 타임아웃은 300초 이상. 앞 사람 요청이 끝날 때까지 기다리는 시간이 포함된다 |
| ✅ 권장 | 배치 작업(대량 임베딩 등)은 한 번에 16~64개씩 묶어 보내고, 사용자가 적은 시간대에 돌린다 |

### 1.4 알려진 함정

| 증상 | 원인 | 해결 |
|------|------|------|
| `qwen3:*` 응답에 긴 사고 과정과 `</think>`가 섞여 나옴 | qwen3는 사고 모드가 기본값이다 | `qwen3:8b`는 요청에 `"think": false`를 넣으면 꺼진다. **`qwen3:4b`는 `think:false`와 `/no_think` 어느 방법으로도 안정적으로 꺼지지 않는다** (실측). `qwen3:4b-instruct-2507-q4_K_M`을 쓴다. 2.2 템플릿은 `</think>` 앞부분을 잘라내는 안전장치를 갖고 있다 |
| 첫 요청만 10~30초 걸림 | 모델을 메모리에 올리는 중이다 | 정상이다. 타임아웃을 넉넉히 잡는다 |
| 평소보다 응답이 느리거나 타임아웃이 남 | 다른 사용자의 요청이 앞에 줄 서 있다 | 재시도한다 (2.2 템플릿에 포함). 동시 요청을 늘리지 않는다 |
| 내 모델을 올리자 다른 모델이 목록(`/api/ps`)에서 사라짐 | 서버 메모리가 모자라 서버가 오래된 모델부터 내렸다 | `num_ctx`를 지정해 내 모델 크기를 줄인다. 필요 이상으로 상주시키지 않는다 (1.6) |
| JSON이 깨져서 옴 | 자유 형식으로 생성했다 | `"format": "json"`을 지정하고, 프롬프트에 원하는 키를 명시한다 |
| `model '...' not found` (404) | 서버에 없는 모델 이름이거나 오타가 있다 | `ollama list`로 이름을 확인한다. 없는 모델이면 1.5 절차로 추가한다. 같은 요청을 재시도하지 않는다 |
| `ollama show --modelfile`에 낯선 서버 경로가 보임 | 서버 저장소 경로가 표시되는 것이다 | 정상이다. 그 경로에 직접 접근하거나 코드에 쓰지 않는다 |

### 1.5 새 모델 추가하기

모델을 추가하면 **서버 전체에 추가된다.** 다른 사용자도 그 모델을 볼 수 있고 쓸 수 있다. 저장 공간과 메모리를 모두가 함께 쓰므로 아래 한도를 지킨다.

| 항목 | 한도 |
|------|------|
| 모델 크기 | **10GB 이하** (대략 14B 이하, Q4 양자화 기준). 넘으면 관리자와 협의한다 |
| 1인당 추가 개수 | 새로 받는 기본 모델은 3개 이하. 쓰지 않게 된 모델은 관리자에게 정리를 요청한다 |
| 이름 | 직접 만드는 모델(`create`/`cp`)은 `<계정명>-<서비스>:<버전>` |

#### ① 공개 모델 내려받기 (`pull`)

```bash
# 1) 이미 서버에 있는지 먼저 확인한다 (있으면 받지 않고 그대로 쓴다)
ollama list | grep -i llama3.2

# 2) 크기를 확인한다: https://ollama.com/library/<모델> 페이지의 태그별 크기 참고
# 3) 태그를 명시해서 받는다 (:latest 생략 금지 — 어떤 크기가 받아질지 모른다)
ollama pull llama3.2:3b

# Hugging Face의 GGUF 모델도 받을 수 있다 (양자화 태그 명시)
ollama pull hf.co/<사용자>/<저장소>-GGUF:Q4_K_M
```

API로 받을 때는 `POST /api/pull`에 `{"model":"llama3.2:3b","stream":false}`를 보낸다. 몇 분 이상 걸릴 수 있으므로 타임아웃을 길게 잡는다.

#### ② 내 서비스용 모델 만들기 (`create`)

시스템 프롬프트와 파라미터를 모델에 고정하려면 Modelfile로 **내 이름이 붙은 새 모델**을 만든다. 원본 모델은 바뀌지 않는다.

```bash
ME=$(whoami)
cat > Modelfile <<'EOF'
FROM gemma3:4b
SYSTEM "당신은 도서관 FAQ 안내원입니다. 두 문장 이내로 답합니다."
PARAMETER temperature 0.3
PARAMETER num_ctx 8192
EOF
ollama create "$ME-faqbot:v1" -f Modelfile
ollama show "$ME-faqbot:v1"                       # 파라미터 확인
ollama run  "$ME-faqbot:v1" "대출 기간은?"          # 동작 확인
```

- `FROM`에는 서버에 있는 모델 이름을 쓴다. 자기 계정에 있는 GGUF 파일(`FROM ./my-model.gguf`)도 쓸 수 있다. 이 경우 파일이 서버로 업로드되므로 크기 한도가 똑같이 적용된다 (Ollama 공식 기능이며, 이 서버에서 GGUF 경로는 아직 검증하지 않았다).
- 새 버전을 만들 때는 `:v2`처럼 태그를 올린다. 서비스 설정의 모델 이름만 바꾸면 롤백도 쉽다.
- 코드에서는 `OLLAMA_CHAT_MODEL=pioneer7-faqbot:v1`처럼 환경변수로 지정한다.

#### ③ 정리

```bash
ollama rm "$(whoami)-faqbot:v1"     # 내 접두사 모델만 삭제 가능
```

내 모델을 삭제해도 `FROM`으로 쓴 원본 모델은 남는다 (실측 확인). `pull`로 받은 공개 모델은 다른 사람이 쓰고 있을 수 있으므로 직접 지우지 않고, 관리자에게 정리를 요청한다.

### 1.6 모델 로드·상주·언로드

**모델 상태는 모두가 공유한다.** 내가 올린 모델은 다른 사람도 그대로 쓰고, 내가 내리면 다른 사람에게서도 내려간다. 서버 메모리가 넉넉하지 않아서, 새 모델을 올리면 서버가 다른 모델을 자동으로 내릴 수 있다.

| 목적 | 방법 | 응답 |
|------|------|------|
| 현재 올라간 모델 보기 | `GET /api/ps` 또는 `ollama ps` | 모델명, 만료 시각(`expires_at`), 메모리, 컨텍스트 |
| 설치된 모델 목록 | `GET /api/tags` 또는 `ollama list` | 모델명, 크기 |
| 미리 올리기 (첫 응답 지연 제거) | `POST /api/generate` 본문 `{"model":"gemma3:4b","keep_alive":"5m","options":{"num_ctx":8192}}` (프롬프트 없이) | `"done_reason":"load"` |
| 상주 시간 연장 | 요청마다 `keep_alive`를 보낸다. 마지막 요청 시점부터 다시 계산된다 | — |
| 내리기 | `POST /api/generate` 본문 `{"model":"<계정명>-faqbot:v1","keep_alive":0}` | `"done_reason":"unload"` |

```bash
# 미리 올리고 → 확인하고 → 내리기
curl -s http://127.0.0.1:11434/api/generate -d '{"model":"gemma3:4b","keep_alive":"5m","options":{"num_ctx":8192}}'
curl -s http://127.0.0.1:11434/api/ps
curl -s http://127.0.0.1:11434/api/generate -d '{"model":"'"$(whoami)"'-faqbot:v1","keep_alive":0}'
```

규칙:
- **상주 시간은 최대 5분이다.** 서비스가 요청할 때마다 `keep_alive:"5m"`을 보내면, 사용 중에는 계속 올라가 있다. 요청이 끊기면 5분 뒤 내려간다. 이것이 공유 서버에서의 "상주"다.
- `keep_alive:-1`(영구)이나 `"24h"`처럼 긴 상주는 **금지**한다. 꼭 필요하면 관리자와 협의한다.
- 미리 올릴 때도 `num_ctx`를 반드시 넣는다. 나중에 다른 `num_ctx`로 요청하면 모델이 다시 올라간다. 그러니 서비스 전체에서 같은 값을 쓴다.
- **내리기(`keep_alive:0`)는 내 접두사 모델에만** 쓴다. 공용 모델을 내리면 그 모델을 쓰던 다른 사용자의 응답이 멈추고 다시 로딩을 기다리게 된다.
- `ollama stop`은 `keep_alive:0`과 같은 동작이다. 같은 규칙을 적용한다.

### 1.7 서버 성능 주의사항

서버의 메모리와 처리 능력은 모든 사용자가 나눠 쓴다. 한 서비스가 과하게 쓰면 **다른 사용자의 모델이 밀려나고, 요청이 줄 서며, 서버 전체가 느려진다.**

| # | 주의사항 | 이유 |
|---|---------|------|
| 1 | **`num_ctx`는 8192로 고정**한다. `/v1` 경로는 `num_ctx 8192`를 박은 내 모델로만 호출한다 | 생략하면 최대 131072로 올라가 수십 GB를 쓴다. 다른 값으로 부르면 이미 올라간 공용 모델이 **다시 로딩**된다 |
| 2 | **출력 길이를 제한**한다: `"num_predict": 1024` (템플릿 기본값). 긴 글이 필요할 때만 늘린다 | 끝없이 생성하는 요청 하나가 뒤의 모든 요청을 기다리게 한다 |
| 3 | **이미 올라간 모델을 우선 쓴다.** `ollama ps`에 있는 A등급 모델로 요구를 채울 수 있으면 새 모델을 올리지 않는다 | 새로 올릴 때마다 메모리를 더 쓰고, 다른 모델을 밀어낼 수 있다 |
| 4 | 한 서비스에서 모델은 **채팅 1개 + 임베딩 1개**까지 쓴다 | 모델마다 메모리를 따로 차지한다 |
| 5 | **동시 요청 1건**. 병렬 스레드나 비동기로 여러 건을 한꺼번에 보내지 않는다 | 서버는 요청을 차례로 처리한다. 병렬로 보내면 다른 사용자의 대기만 길어진다 |
| 6 | `/api/ps`·`/api/tags`를 **반복해서 조회(폴링)하지 않는다**. 헬스체크는 `/api/version`을 1분에 1회 이하로 호출한다 | 불필요한 부하를 만든다 |
| 7 | **대량 작업**(수천 건 임베딩, 일괄 생성)은 16~64개씩 나누고, 묶음 사이에 1~2초 쉰다. 사용자가 적은 시간대에 돌린다 | 한 사람이 서버를 몇 분씩 독점하지 않게 한다 |
| 8 | **결과를 캐시**한다. 같은 입력을 다시 임베딩하거나 다시 생성하지 않는다 | 가장 쉬운 부하 절감법이다 |
| 9 | 긴 응답은 **스트리밍(`"stream": true`)**으로 받고, 사용자가 취소하면 연결을 끊는다 | 연결을 끊으면 서버도 생성을 멈춘다 |
| 10 | `keep_alive`는 A등급 5분, B등급 2분 이하. 미리 올리기는 서비스 시작 시 1회만 한다 | 오래 상주하면 다른 사용자가 쓸 메모리가 줄어든다 |
| 11 | 서비스를 그만 쓰면 **내 접두사 모델을 `keep_alive:0`으로 내린다** | 메모리를 바로 돌려준다 |
| 12 | 응답이 계속 느리면 **요청을 늘리지 말고** 관리자에게 알린다 | 재시도가 몰리면 혼잡이 더 커진다 |

## 2. 에이전트 구현 매뉴얼

> AI 에이전트가 사용자 계정에서 Ollama를 쓰는 서비스를 구현할 때 따르는 절차다. 1장 규칙이 이 매뉴얼보다 우선한다.

### 2.1 구현 절차

1. **연결 확인**: `curl -s http://127.0.0.1:11434/api/version`가 버전을 돌려주는지 본다. 실패하면 구현하지 말고 사용자에게 보고한다 (2.3).
2. **모델 선택**: 1.2의 A등급 공용 모델을 먼저 검토한다. B등급은 조건을 지키고, C등급과 사용 금지 모델은 쓰지 않는다. 맞는 모델이 없을 때만 1.5 절차를 따른다. 먼저 `ollama list`로 이미 있는지 보고, 10GB 이하인지 확인한 뒤, 태그를 명시해서 `pull`한다. 시스템 프롬프트를 고정해야 하면 `<계정명>-<서비스>:v1`로 `create`한다. 10GB를 넘는 모델은 받지 말고 사용자에게 보고한다.
3. **설정 외부화**: `OLLAMA_URL`, `OLLAMA_CHAT_MODEL`, `OLLAMA_EMBED_MODEL`을 환경변수나 `.env`로 받는다. 기본값은 1.1의 값을 쓴다.
4. **클라이언트 작성**: 2.2 템플릿에서 시작한다. 템플릿에 이미 들어 있는 다섯 가지(타임아웃 300초, 재시도, `keep_alive: 5m`, `num_ctx: 8192`, `num_predict: 1024`)는 빼지 않는다. 1.7 주의사항을 설계에 반영한다.
5. **동시성 제한**: 웹 서비스라면 Ollama 호출 앞에 동시 1건 제한(세마포어, 큐)을 둔다.
6. **검증**: 실제 호출 1회로 응답 형식을 확인한다. qwen3를 쓴다면 응답에 `<think>`가 없는지도 본다.
7. **정리**: 테스트용으로 띄운 프로세스는 종료한다. 공용 모델은 내리지 않는다. `keep_alive`가 지나면 서버가 알아서 내린다. 내 접두사 모델은 `keep_alive:0`으로 내려도 된다 (1.6).

### 2.2 코드 템플릿

**Python (표준 라이브러리만 사용, 추가 설치 불필요, Python 3.9+)** — `ollama_client.py`

가이드의 규칙(1.3·1.4·1.6·1.7)을 코드로 강제하는 완성판 클라이언트다. 아래 블록을 `ollama_client.py`로 저장해서 쓴다. 같은 파일이 공유 폴더에도 있다: `cp /Users/Shared/ollama/ollama_client.py .`

| 함수 | 용도 | 가이드 |
|------|------|------|
| `chat(messages, model, json_mode)` | 응답 전체를 한 번에 받기 | 1.3 |
| `chat_stream(messages, model)` | 조각 단위로 받기. 중간에 멈추면 서버 생성도 멈춘다 | 1.7-9 |
| `embed(texts, model)` | 임베딩. 32개씩 나눠 보내고 묶음 사이에 1초 쉰다 | 1.7-7 |
| `preload(model)` | 서비스 시작 시 1회 미리 올리기 | 1.6 |
| `unload(model)` | 내 접두사(`<계정명>-`) 모델만 내리기. 공용 모델이면 `PermissionError` | 1.6 |
| `installed_models()` / `loaded_models()` / `health()` | 설치 목록, 상주 목록, 서버 버전 (폴링 금지) | 1.6, 1.7-6 |

고정 동작: `num_ctx` 8192, `num_predict` 1024, `keep_alive` 5분, 프로세스당 동시 요청 1건, 연결 오류·시간 초과만 재시도(3초·6초), `think:false`와 `</think>` 제거.

```python
"""공유 Ollama 서버 클라이언트 (표준 라이브러리만 사용, Python 3.9+)

가이드: /Users/Shared/ollama/ollama-user-guide.md
가이드 규칙을 코드로 강제한다:
  - num_ctx 8192 고정, num_predict 1024 기본          (1.3, 1.7-1·2)
  - 서버 호출은 프로세스당 동시 1건                    (1.7-5)
  - 연결 오류·시간 초과만 재시도, 4xx/5xx는 즉시 실패   (2.3)
  - keep_alive 5분 이하, 내리기는 내 접두사 모델만      (1.6)
  - 임베딩은 묶음 단위로 나눠 보내고 사이에 쉰다        (1.7-7)
  - qwen3 사고 모드 끄기, 새어 나온 사고 과정 제거       (1.4)

사용 예:
    from ollama_client import chat, chat_stream, embed
    print(chat([{"role": "user", "content": "안녕"}]))
"""
import getpass
import json
import os
import threading
import time
import urllib.error
import urllib.request

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
CHAT_MODEL = os.environ.get("OLLAMA_CHAT_MODEL", "gemma3:4b")
EMBED_MODEL = os.environ.get("OLLAMA_EMBED_MODEL", "bge-m3")

NUM_CTX = 8192          # 고정값. 모두가 같은 값을 써야 로드된 모델을 공유한다
NUM_PREDICT = 1024      # 출력 길이 기본 상한
KEEP_ALIVE = "5m"       # A등급 상한 (B등급 모델은 "2m"을 넘긴다)
TIMEOUT = 300           # 앞 사람 요청을 기다리는 시간 포함
EMBED_BATCH = 32        # 임베딩 묶음 크기 (16~64)
EMBED_PAUSE = 1.0       # 묶음 사이 휴식(초)

_lock = threading.Semaphore(1)  # 동시 요청 1건


def _request(path, payload=None, stream=False, retries=3):
    """서버 호출. 스트리밍이면 열린 응답 객체를, 아니면 JSON을 돌려준다."""
    data = json.dumps(payload).encode() if payload is not None else None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(
                OLLAMA_URL + path, data=data,
                headers={"Content-Type": "application/json"})
            resp = urllib.request.urlopen(req, timeout=TIMEOUT)
            if stream:
                return resp
            with resp:
                return json.load(resp)
        except urllib.error.HTTPError as e:  # 4xx/5xx: 재시도해도 같은 결과
            raise RuntimeError(f"Ollama {e.code}: {e.read().decode()}") from e
        except (urllib.error.URLError, TimeoutError) as e:  # 연결 실패·시간 초과만 재시도
            if attempt == retries - 1:
                raise RuntimeError(f"Ollama 요청 실패: {e}") from e
            time.sleep(2 ** attempt * 3)  # 3s, 6s


def _strip_think(text):
    """think:false여도 사고 과정이 본문에 섞이는 모델(qwen3:4b)용 안전장치 (가이드 1.4)."""
    return text.split("</think>", 1)[1].lstrip() if "</think>" in text else text


def _chat_body(messages, model, json_mode, num_predict, keep_alive, stream):
    body = {"model": model, "messages": messages, "stream": stream,
            "think": False, "keep_alive": keep_alive,
            "options": {"num_ctx": NUM_CTX, "num_predict": num_predict}}
    if json_mode:
        body["format"] = "json"
    return body


def chat(messages, model=CHAT_MODEL, json_mode=False,
         num_predict=NUM_PREDICT, keep_alive=KEEP_ALIVE):
    """응답 전체를 한 번에 받는다."""
    body = _chat_body(messages, model, json_mode, num_predict, keep_alive, False)
    with _lock:
        return _strip_think(_request("/api/chat", body)["message"]["content"])


def chat_stream(messages, model=CHAT_MODEL,
                num_predict=NUM_PREDICT, keep_alive=KEEP_ALIVE):
    """응답을 조각 단위로 내준다. 중간에 멈추면 연결을 닫아 서버 생성도 멈춘다."""
    body = _chat_body(messages, model, False, num_predict, keep_alive, True)
    with _lock:
        resp = _request("/api/chat", body, stream=True)
        try:
            for line in resp:
                if not line.strip():
                    continue
                part = json.loads(line)
                if "error" in part:
                    raise RuntimeError(f"Ollama: {part['error']}")
                yield part.get("message", {}).get("content", "")
                if part.get("done"):
                    break
        finally:
            resp.close()


def embed(texts, model=EMBED_MODEL, keep_alive=KEEP_ALIVE):
    """임베딩 목록을 돌려준다. 입력이 많으면 묶음으로 나눠 보낸다."""
    if isinstance(texts, str):
        texts = [texts]
    vectors = []
    for i in range(0, len(texts), EMBED_BATCH):
        if i:
            time.sleep(EMBED_PAUSE)
        with _lock:
            vectors += _request("/api/embed", {
                "model": model, "input": texts[i:i + EMBED_BATCH],
                "keep_alive": keep_alive})["embeddings"]
    return vectors


def preload(model=CHAT_MODEL, keep_alive=KEEP_ALIVE):
    """서비스 시작 시 1회 미리 올린다 (첫 응답 지연 제거)."""
    with _lock:
        return _request("/api/generate", {
            "model": model, "keep_alive": keep_alive,
            "options": {"num_ctx": NUM_CTX}}).get("done_reason")  # "load"


def unload(model):
    """내 접두사(<계정명>-) 모델만 내린다. 공용 모델은 내리지 않는다."""
    prefix = getpass.getuser() + "-"
    if not model.startswith(prefix):
        raise PermissionError(f"공용 모델은 내리지 않는다: {model} (허용: {prefix}*)")
    with _lock:
        return _request("/api/generate", {
            "model": model, "keep_alive": 0}).get("done_reason")  # "unload"


def installed_models():
    """설치된 모델 이름 목록 (:cloud 제외). 폴링하지 말고 필요할 때만 호출한다."""
    return [m["name"] for m in _request("/api/tags")["models"]
            if not m["name"].endswith("cloud")]


def loaded_models():
    """메모리에 올라간 모델: [(이름, 컨텍스트, 만료 시각)]."""
    return [(m["name"], m.get("context_length"), m.get("expires_at"))
            for m in _request("/api/ps")["models"]]


def health():
    """서버 버전. 헬스체크는 1분에 1회 이하로 호출한다."""
    return _request("/api/version")["version"]


if __name__ == "__main__":
    print("version :", health())
    print("chat    :", chat([{"role": "user", "content": "한 문장으로 자기소개"}]))
    print("stream  :", "".join(chat_stream([{"role": "user", "content": "say OK"}])))
    print("embed   :", len(embed(["안녕하세요"])[0]), "차원")
    print("loaded  :", loaded_models())
```

실행 검증 (2026-09-28): 자체 테스트(`python3 ollama_client.py`), JSON 모드, 스트리밍 중간 중단, 70건 배치 임베딩(3묶음, 3.2초), 공용 모델 `unload` 차단, 404 즉시 실패, `qwen3:8b`·`qwen3:4b-instruct-2507` 사고 과정 없음을 모두 확인했다.

**Node.js 18+ (내장 `fetch`)**
```javascript
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";

async function chat(messages, model = "gemma3:4b") {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, stream: false, think: false,
                           keep_alive: "5m", options: { num_ctx: 8192, num_predict: 1024 } }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  return (await res.json()).message.content;
}

console.log(await chat([{ role: "user", content: "say OK" }]));
```

**OpenAI SDK를 쓰는 기존 코드에 연결할 때** (`pip install openai`가 필요하며, 계정별로 설치한다)
```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:11434/v1", api_key="ollama")  # 키 값은 아무 문자열
r = client.chat.completions.create(
    model="gemma3:4b", timeout=300,
    messages=[{"role": "user", "content": "안녕"}],
)
print(r.choices[0].message.content)
```
⚠️ **OpenAI 호환 경로(`/v1`)로는 `num_ctx`를 넘길 수 없다.** 기본 모델 이름을 그대로 쓰면 최대 컨텍스트로 올라간다 (실측: 1B 모델이 1.4GiB가 아니라 6.0GiB). 그래서 `/v1`을 쓸 때는 **1.5절 ② 방식으로 `PARAMETER num_ctx 8192`를 넣은 내 모델**(예: `pioneer7-chat:v1`)을 만들어 그 이름으로 호출한다. Modelfile의 `num_ctx`는 `/v1`로 호출해도 적용된다 (실측 확인). `keep_alive`와 `think`도 넘기기 어렵다. qwen3를 쓰거나 세밀하게 제어해야 하면 네이티브 `/api/chat`을 쓴다.

**curl (빠른 확인용)**
```bash
curl -s http://127.0.0.1:11434/api/chat -d '{
  "model":"gemma3:4b","stream":false,"keep_alive":"5m",
  "options":{"num_ctx":8192},
  "messages":[{"role":"user","content":"say OK"}]}'
```

### 2.3 오류 대응

| 상황 | 판정 | 에이전트 행동 |
|------|------|------|
| 연결 거부, `/api/version` 무응답 | 공유 서버 장애 | **직접 복구하지 않는다** (`ollama serve` 실행 금지). 사용자에게 "관리자 확인 필요"라고 보고한다 |
| HTTP 404 `model not found` | 모델 이름 오류 또는 미설치 | 이름을 `ollama list`와 대조한다. 미설치라면 1.5 절차(크기 확인 후 `pull`)를 따른다 |
| `pull` 실패 (디스크 부족 등) | 서버 자원 문제 | 재시도하거나 다른 모델을 받지 않는다. 사용자에게 보고한다 |
| HTTP 400 | 요청 형식 오류 | 요청 본문을 고친다. 재시도하지 않는다 |
| HTTP 5xx, 시간 초과 | 서버 혼잡 또는 일시 오류 | 3초, 6초 간격으로 최대 3회 재시도한다. 그래도 실패하면 보고한다 |
| 메모리 부족 오류 | `num_ctx`가 8192를 넘었거나 모델이 크다 | `num_ctx`를 8192로 맞추고, A등급 모델을 쓴다 |

### 2.4 완료 체크리스트

- [ ] 1.2 A등급 공용 모델을 먼저 검토했고 (B등급은 조건 준수, C등급·사용 금지 모델은 미사용), 새 모델은 1.5 한도(10GB 이하, 태그 명시)를 지켜 추가했다
- [ ] 직접 만든 모델 이름이 `<계정명>-`으로 시작한다
- [ ] URL과 모델 이름을 환경변수로 받는다
- [ ] 타임아웃 300초 이상, 연결 오류·시간 초과에만 재시도한다
- [ ] 모든 호출(미리 올리기 포함)에 `num_ctx: 8192`를 넣었다. `/v1` 경로라면 `num_ctx`를 박은 내 모델을 쓴다
- [ ] `keep_alive` 5m 이하. `-1`이나 긴 상주는 쓰지 않는다
- [ ] `/api/ps`에서 내 모델의 `context_length`가 의도한 값인지 확인했다
- [ ] Ollama 동시 호출 1건으로 제한한다
- [ ] qwen3를 쓴다면 사고 모드를 껐고, 응답에 `<think>`가 없는 것을 확인했다
- [ ] 서비스 **런타임 코드**에는 `pull`, `create`, `rm`, `stop`, `serve` 호출이 없다 (모델 준비는 배포 전 1회, 수동으로 한다)
- [ ] `rm`은 내 접두사 모델에만 썼다
- [ ] 1.7 성능 주의사항(출력 길이 제한, 폴링 금지, 대량 작업 분할)을 지켰다
- [ ] 실제 호출 1회로 동작을 확인했다
