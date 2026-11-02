"""Gemini(Google AI Studio) 채팅 클라이언트 — LLM_PROVIDER=gemini 일 때 M3(판정)·M4(요약)를
공유 Ollama 대신 Google AI Studio 의 generateContent 로 돌린다(로컬에 qwen3:4b 를 못 띄우는 PC 용).

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


class GeminiClient:
    def __init__(
        self,
        api_key: str | None,
        model: str,
        base_url: str = "https://generativelanguage.googleapis.com",
        timeout_sec: float = 60,
        max_attempts: int = 3,
        backoff_sec: tuple[float, ...] = (3, 6),
        transport: httpx.AsyncBaseTransport | None = None,
        sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep,
    ):
        self._api_key = api_key
        self._model = model
        self._http = httpx.AsyncClient(base_url=base_url.rstrip("/"), timeout=timeout_sec, transport=transport)
        self.max_attempts = max_attempts
        self.backoff_sec = backoff_sec
        self._sleep = sleep

    async def aclose(self) -> None:
        await self._http.aclose()

    def _body(self, system: str, user: str) -> dict:
        return {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": user}]}],
            "generationConfig": {
                "temperature": 0,
                "responseMimeType": "application/json",
                "maxOutputTokens": MAX_OUTPUT_TOKENS,
                "thinkingConfig": {"thinkingLevel": "low"},  # Gemini 3.x 사고 억제 — 2.5 의 thinkingBudget 은 안 먹힘
            },
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

    async def chat(self, system: str, user: str) -> str:
        """M3·M4 공통 — 시스템·사용자 프롬프트로 JSON 텍스트를 받는다(파싱은 호출자)."""
        if not self._api_key:
            raise OllamaError(503, "GEMINI_API_KEY 가 설정되지 않았습니다 — model-server/.env 에 넣어 주세요")
        path = f"/v1beta/models/{self._model}:generateContent"
        headers = {"x-goog-api-key": self._api_key, "content-type": "application/json"}
        body = self._body(system, user)
        last: Exception | None = None
        for attempt in range(self.max_attempts):
            try:
                resp = await self._http.post(path, json=body, headers=headers)
                if resp.status_code >= 400:
                    code = resp.status_code
                    if code < 500:  # 4xx(키 오류·요청 오류) — 재시도해도 같다
                        detail = "Gemini 인증 실패 — API 키를 확인하세요" if code in (401, 403) else f"Gemini 요청 오류 {code}"
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
                log.warning("gemini 재시도 %d/%d (%s)", attempt + 1, self.max_attempts - 1, type(last).__name__)
                await self._sleep(delay)
        if isinstance(last, httpx.TimeoutException):
            raise OllamaError(504, "Gemini 시간 초과")
        raise OllamaError(503, f"Gemini 연결 실패({type(last).__name__}) — 네트워크·키를 확인하세요")
