"""Gemini 채팅 클라이언트 — LLM_PROVIDER 가 gemini(AI Studio) 또는 vertex(Google Cloud)일 때
M3(판정)·M4(요약)를 공유 Ollama 대신 Gemini generateContent 로 돌린다.

두 모드는 엔드포인트와 인증만 다르고 요청·응답 형식(generateContent)은 같다:
  - gemini : https://generativelanguage.googleapis.com, 인증 = API 키(x-goog-api-key). 무료 티어/선불 크레딧.
  - vertex : https://{location}-aiplatform.googleapis.com, 인증 = ADC Bearer 토큰(google-auth).
            GCP 결제계정의 크레딧에서 차감돼 무료 티어 한도(분당 15·일 1,500)에 안 막힌다 — 호출이 많은 팀용.

- Ollama 의 think:false 에 대응해 thinkingConfig.thinkingLevel="low" 로 사고를 줄인다(지연 완화).
  주의: Gemini 3.x 는 thinkingBudget 이 아니라 thinkingLevel 을 쓴다(budget 은 무시돼 기본 사고 → 느려짐).
- 구조화 출력은 responseMimeType=application/json 으로 받는다. responseJsonSchema(스키마 강제)는 쓰지 않는다 —
  실측상 스키마 강제가 지연을 크게 키운다(judge 5s→60s+). 대신 필드명 차이(claim vs sentence/text)는
  게이트웨이(llm.py normalize_claims)가 흡수하고, 값 검증·보정은 judge/summarize 가 지금처럼 그대로 한다.
- 오류는 OllamaClient 와 같은 OllamaError(모델 상류 오류)로 돌려 main.py 의 예외 사상을 함께 쓴다.
- 요청·응답 본문은 로그에 남기지 않는다(BR-MDL-01).
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Awaitable, Callable

import httpx

from .ollama_client import OllamaError

log = logging.getLogger("crd.gemini")

# 사고를 끈 flash 모델의 JSON 한 건은 길지 않다(판정 1문장·요약 5~8문장). 넉넉하게 잡아 잘림을 막는다.
MAX_OUTPUT_TOKENS = 2048
CLOUD_SCOPE = "https://www.googleapis.com/auth/cloud-platform"

TokenProvider = Callable[[], str]


def default_adc_token_provider() -> TokenProvider:
    """Application Default Credentials(gcloud auth application-default login 또는 서비스계정)로
    cloud-platform 토큰을 주는 provider. google-auth 가 있어야 한다(uv sync --extra vertex).
    자격증명은 한 번 로드하고, 만료되면 refresh 한다."""
    try:
        import google.auth
        import google.auth.transport.requests as gatr
    except ImportError as e:
        raise OllamaError(503, "vertex 모드엔 google-auth 가 필요합니다 — uv sync --extra vertex") from e
    creds, _ = google.auth.default(scopes=[CLOUD_SCOPE])
    request = gatr.Request()

    def get() -> str:
        if not creds.valid:
            creds.refresh(request)
        return creds.token

    return get


class GeminiClient:
    def __init__(
        self,
        model: str,
        *,
        mode: str = "gemini",
        api_key: str | None = None,
        base_url: str = "https://generativelanguage.googleapis.com",
        project: str | None = None,
        location: str = "us-central1",
        token_provider: TokenProvider | None = None,
        timeout_sec: float = 60,
        max_attempts: int = 3,
        backoff_sec: tuple[float, ...] = (3, 6),
        transport: httpx.AsyncBaseTransport | None = None,
        sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep,
    ):
        self._model = model
        self._mode = mode
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._project = project
        self._location = location
        self._token_provider = token_provider  # vertex 전용. None 이면 첫 호출 때 ADC 로 만든다.
        self._http = httpx.AsyncClient(timeout=timeout_sec, transport=transport)
        self.max_attempts = max_attempts
        self.backoff_sec = backoff_sec
        self._sleep = sleep

    async def aclose(self) -> None:
        await self._http.aclose()

    def _vertex_host(self) -> str:
        return "aiplatform.googleapis.com" if self._location == "global" else f"{self._location}-aiplatform.googleapis.com"

    def _endpoint(self) -> tuple[str, dict[str, str]]:
        """모드별 (URL, 헤더). 인증 실패/미설정은 OllamaError(503) 으로 올린다."""
        if self._mode == "vertex":
            if not self._project:
                raise OllamaError(503, "VERTEX_PROJECT 가 설정되지 않았습니다 — model-server/.env 에 넣어 주세요")
            if self._token_provider is None:
                self._token_provider = default_adc_token_provider()
            try:
                token = self._token_provider()
            except OllamaError:
                raise
            except Exception as e:  # 토큰 발급·refresh 실패 — ADC 미설정 등
                raise OllamaError(503, f"Vertex 인증 실패({type(e).__name__}) — gcloud auth application-default login 확인") from e
            url = (f"https://{self._vertex_host()}/v1/projects/{self._project}"
                   f"/locations/{self._location}/publishers/google/models/{self._model}:generateContent")
            return url, {"Authorization": f"Bearer {token}", "content-type": "application/json"}
        # gemini(AI Studio)
        if not self._api_key:
            raise OllamaError(503, "GEMINI_API_KEY 가 설정되지 않았습니다 — model-server/.env 에 넣어 주세요")
        url = f"{self._base_url}/v1beta/models/{self._model}:generateContent"
        return url, {"x-goog-api-key": self._api_key, "content-type": "application/json"}

    def _body(self, system: str, user: str, schema: dict | None = None) -> dict:
        gen: dict = {
            "temperature": 0,
            "responseMimeType": "application/json",
            "maxOutputTokens": MAX_OUTPUT_TOKENS,
            "thinkingConfig": {"thinkingLevel": "low"},  # Gemini 3.x 사고 억제 — 2.5 의 thinkingBudget 은 안 먹힘
        }
        # 스키마 강제는 vertex 에서만 — 실측상 vertex 는 빠르면서(lite ≈1s) 필드 구조를 보장하지만,
        # AI Studio 는 스키마 강제 시 지연이 크게 늘어(judge 5s→60s+) 쓰지 않는다(필드명은 normalize_claims 가 흡수).
        if schema is not None and self._mode == "vertex":
            gen["responseJsonSchema"] = schema
        return {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": user}]}],
            "generationConfig": gen,
        }

    @staticmethod
    def _extract_text(data: dict) -> str:
        """generateContent 응답에서 첫 후보의 텍스트를 꺼낸다. 차단·빈 응답은 503 으로 올린다."""
        candidates = data.get("candidates") or []
        if not candidates:
            reason = (data.get("promptFeedback") or {}).get("blockReason")
            raise OllamaError(503, f"Gemini 응답 없음{f'(차단: {reason})' if reason else ''}")
        parts = ((candidates[0].get("content") or {}).get("parts")) or []
        text = "".join(p.get("text", "") for p in parts)
        if not text.strip():
            fr = candidates[0].get("finishReason")
            raise OllamaError(503, f"Gemini 빈 응답{f'(finishReason={fr})' if fr else ''}")
        return text

    async def chat(self, system: str, user: str, schema: dict | None = None) -> str:
        """M3·M4 공통 — 시스템·사용자 프롬프트로 JSON 텍스트를 받는다(파싱은 호출자).
        schema 는 vertex 모드에서만 responseJsonSchema 로 쓰여 출력 구조를 강제한다."""
        url, headers = self._endpoint()
        body = self._body(system, user, schema)
        last: Exception | None = None
        for attempt in range(self.max_attempts):
            try:
                resp = await self._http.post(url, json=body, headers=headers)
                if resp.status_code >= 400:
                    code = resp.status_code
                    if code < 500:  # 4xx(인증·요청 오류) — 재시도해도 같다
                        detail = ("Gemini 인증 실패 — 키/자격증명을 확인하세요" if code in (401, 403)
                                  else f"Gemini 요청 오류 {code}")
                        raise OllamaError(503, detail, code)
                    last = httpx.HTTPStatusError(f"HTTP {code}", request=resp.request, response=resp)
                else:
                    return self._extract_text(resp.json())
            except httpx.TimeoutException as e:
                last = e
            except httpx.TransportError as e:  # 연결 거부·DNS 등
                last = e
            if attempt < self.max_attempts - 1:
                delay = self.backoff_sec[min(attempt, len(self.backoff_sec) - 1)]
                log.warning("gemini(%s) 재시도 %d/%d (%s)", self._mode, attempt + 1, self.max_attempts - 1, type(last).__name__)
                await self._sleep(delay)
        if isinstance(last, httpx.TimeoutException):
            raise OllamaError(504, "Gemini 시간 초과")
        raise OllamaError(503, f"Gemini 연결 실패({type(last).__name__}) — 네트워크·자격증명을 확인하세요")
