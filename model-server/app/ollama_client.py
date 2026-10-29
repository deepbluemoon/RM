"""공유 Ollama 클라이언트 (참조 §7·§8).

- 런타임에서 부르는 경로는 /api/version, /api/tags, /api/ps, /api/chat, /api/generate(예열), /api/embed(근거 임베딩) 뿐이다.
  pull·create·delete·copy·push·stop·serve 는 이 모듈에 없다(ALLOWED_PATHS 로 강제).
- 추론 호출(/api/chat, /api/generate, /api/embed)은 게이트웨이 전체 세마포어 1개를 거친다(동시 1건, 가이드 1.7-5).
- 타임아웃 300초. 연결 오류·시간 초과·5xx 만 3초·6초 간격 최대 3회(가이드 2.3). 4xx 는 재시도하지 않는다.
- 호출이 취소되면(백엔드 연결 끊김) 진행 중인 httpx 요청도 닫혀 서버 생성이 멈춘다(가이드 1.7-9).
- 요청·응답 본문은 로그에 남기지 않는다(BR-MDL-01).
"""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

import httpx

log = logging.getLogger("crd.ollama")

ALLOWED_PATHS = frozenset({"/api/version", "/api/tags", "/api/ps", "/api/chat", "/api/generate", "/api/embed"})
GATED_PATHS = frozenset({"/api/chat", "/api/generate", "/api/embed"})


class OllamaError(Exception):
    """호출자에게 돌려줄 HTTP 상태(503·504)와 짧은 사유. 요청 본문은 담지 않는다."""

    def __init__(self, status: int, detail: str, upstream_status: int | None = None):
        super().__init__(detail)
        self.status = status
        self.detail = detail
        self.upstream_status = upstream_status


def norm_name(name: str) -> str:
    """Ollama 이름 정규화 — 태그가 없으면 ':latest'."""
    return name if ":" in name.split("/")[-1] else f"{name}:latest"


class OllamaClient:
    def __init__(
        self,
        base_url: str,
        timeout_sec: float = 300,
        max_attempts: int = 3,
        backoff_sec: tuple[float, ...] = (3, 6),
        concurrency: int = 1,
        transport: httpx.AsyncBaseTransport | None = None,
        sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep,
    ):
        self._http = httpx.AsyncClient(base_url=base_url, timeout=timeout_sec, transport=transport)
        self._sem = asyncio.Semaphore(concurrency)
        self._waiting = 0
        self._inflight = 0
        self.max_attempts = max_attempts
        self.backoff_sec = backoff_sec
        self._sleep = sleep

    @property
    def queue_depth(self) -> int:
        """세마포어를 기다리는 요청 수."""
        return self._waiting

    @property
    def inflight(self) -> int:
        return self._inflight

    async def aclose(self) -> None:
        await self._http.aclose()

    async def _once(self, method: str, path: str, body: dict | None, timeout: float | None) -> dict:
        kw = {"timeout": timeout} if timeout else {}
        resp = await self._http.request(method, path, json=body, **kw)
        if resp.status_code >= 400:
            try:
                msg = str(resp.json().get("error", ""))[:200]
            except Exception:
                msg = ""
            raise httpx.HTTPStatusError(msg or f"HTTP {resp.status_code}", request=resp.request, response=resp)
        return resp.json()

    async def _call(self, method: str, path: str, body: dict | None = None,
                    attempts: int | None = None, timeout: float | None = None) -> dict:
        if path not in ALLOWED_PATHS:
            raise ValueError(f"허용되지 않은 Ollama 경로: {path}")
        attempts = attempts or self.max_attempts
        last: Exception | None = None
        for attempt in range(attempts):
            try:
                return await self._once(method, path, body, timeout)
            except httpx.HTTPStatusError as e:
                code = e.response.status_code
                if code < 500:  # 4xx(404 모델 없음 포함) — 재시도해도 같은 결과
                    raise OllamaError(503, f"Ollama {code}: {e}", code) from None
                last = e
            except httpx.TimeoutException as e:
                last = e
            except httpx.TransportError as e:  # 연결 거부 등
                last = e
            if attempt < attempts - 1:
                delay = self.backoff_sec[min(attempt, len(self.backoff_sec) - 1)]
                log.warning("ollama %s 재시도 %d/%d (%s)", path, attempt + 1, attempts - 1, type(last).__name__)
                await self._sleep(delay)
        if isinstance(last, httpx.TimeoutException):
            raise OllamaError(504, f"Ollama {path} 시간 초과")
        if isinstance(last, httpx.HTTPStatusError):
            raise OllamaError(503, f"Ollama {last.response.status_code}: {last}", last.response.status_code)
        raise OllamaError(503, f"Ollama 연결 실패({type(last).__name__}) — 관리자 확인 필요")

    async def _gated(self, path: str, body: dict) -> dict:
        self._waiting += 1
        try:
            await self._sem.acquire()
        finally:
            self._waiting -= 1
        self._inflight += 1
        try:
            return await self._call("POST", path, body)
        finally:
            self._inflight -= 1
            self._sem.release()

    # --- 추론(세마포어) ---
    async def chat(self, body: dict) -> dict:
        return await self._gated("/api/chat", body)

    async def warmup(self, model: str, keep_alive: str, num_ctx: int) -> dict:
        """미리 올리기 — 프롬프트 없는 /api/generate(가이드 1.6). num_ctx 는 채팅과 같은 8192."""
        body = {"model": model, "keep_alive": keep_alive, "stream": False, "options": {"num_ctx": num_ctx}}
        return await self._gated("/api/generate", body)

    async def embed(self, model: str, texts: list[str], keep_alive: str) -> dict:
        """임베딩 — /api/embed(가이드 1.2 bge-m3). 묶음 크기·묶음 사이 휴식은 호출자(백엔드 적재 작업)가 지킨다(가이드 1.7-7)."""
        return await self._gated("/api/embed", {"model": model, "input": texts, "keep_alive": keep_alive, "truncate": True})

    # --- 상태 조회(읽기 전용, 세마포어 밖, 재시도 없이 5초). Inventory 캐시(≥60초)를 거쳐서만 부른다 ---
    async def version(self) -> dict:
        return await self._call("GET", "/api/version", attempts=1, timeout=5)

    async def tags(self) -> dict:
        return await self._call("GET", "/api/tags", attempts=1, timeout=5)

    async def ps(self) -> dict:
        return await self._call("GET", "/api/ps", attempts=1, timeout=5)


@dataclass
class Snapshot:
    ok: bool
    installed: dict[str, dict] = field(default_factory=dict)       # 이름 → {size, digest}
    ps_resident_until: dict[str, float] = field(default_factory=dict)  # 이름 → 만료(단조 시계)
    vram_used: int = 0
    error: str | None = None
    at: float = 0.0


def _expires_in(expires_at: str | None, default: float) -> float:
    """/api/ps 의 expires_at(ISO) → 지금부터 남은 초. 읽을 수 없으면 default."""
    if not expires_at:
        return default
    try:
        exp = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
        return max(0.0, (exp - datetime.now(timezone.utc)).total_seconds())
    except ValueError:
        return default


class Inventory:
    """Ollama 상태 — 폴링 금지(가이드 1.7-6)를 지키는 캐시.

    - /api/version·/api/tags·/api/ps 는 캐시가 비었거나 ttl(≥60초)이 지났을 때만, 각각 1회 읽는다.
      /health 를 아무리 자주 불러도 upstream 호출은 ttl 당 최대 1회씩이다.
    - 상주 여부는 로컬로도 추론한다: 모델 응답을 받으면 keep_alive(5분) 동안 상주로 본다.
    - 호출 결과로 상태를 고친다(추가 조회 없음): 연결 실패 → ok=False, 404 → 해당 모델 미설치.
    """

    def __init__(self, client: OllamaClient, ttl_sec: float = 60.0, resident_sec: float = 300.0,
                 clock: Callable[[], float] = time.monotonic):
        self.client = client
        self.ttl = ttl_sec
        self.resident_sec = resident_sec
        self.clock = clock
        self._snap: Snapshot | None = None
        self._local_until: dict[str, float] = {}
        self._lock = asyncio.Lock()

    async def snapshot(self) -> Snapshot:
        async with self._lock:
            now = self.clock()
            if self._snap and now - self._snap.at < self.ttl:
                return self._snap
            try:
                await self.client.version()
                tags, ps = await self.client.tags(), await self.client.ps()
                snap = Snapshot(
                    ok=True,
                    installed={norm_name(m["name"]): {"size": m.get("size"), "digest": m.get("digest")}
                               for m in tags.get("models", [])},
                    ps_resident_until={norm_name(m.get("name") or m["model"]):
                                       now + _expires_in(m.get("expires_at"), self.resident_sec)
                                       for m in ps.get("models", [])},
                    vram_used=sum(int(m.get("size_vram") or 0) for m in ps.get("models", [])),
                    at=now,
                )
            except OllamaError as e:
                snap = Snapshot(ok=False, error=e.detail, at=now)
            self._snap = snap
            return snap

    def is_resident(self, name: str) -> bool:
        n, now = norm_name(name), self.clock()
        if self._local_until.get(n, 0) > now:
            return True
        return bool(self._snap and self._snap.ps_resident_until.get(n, 0) > now)

    # --- 호출 결과로 추론(추가 조회 없음) ---
    def note_success(self, name: str) -> None:
        n = norm_name(name)
        self._local_until[n] = self.clock() + self.resident_sec
        if self._snap:
            self._snap.ok = True
            self._snap.error = None
            self._snap.installed.setdefault(n, {"size": None, "digest": None})

    def note_down(self, detail: str) -> None:
        if self._snap:
            self._snap.ok = False
            self._snap.error = detail

    def note_missing(self, name: str) -> None:
        n = norm_name(name)
        self._local_until.pop(n, None)
        if self._snap:
            self._snap.installed.pop(n, None)
