"""모델 서버 게이트웨이 — contracts/model-api.openapi.yaml 구현.

실행: uv run uvicorn app.main:app --host 127.0.0.1 --port 9542 --workers 1 --no-access-log
로그에는 요청 ID·엔드포인트·지연·상태만 남긴다(본문 기록 금지 — BR-MDL-01).
"""
from __future__ import annotations

import asyncio
import datetime as dt
import logging
import math
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Literal

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .auth import require_bearer
from .classifiers import CONTRACT_TYPE_KO, Classifier, ClauseText, load_classifiers
from .config import Settings, load_settings
from .health import build_health, build_models
from .jobs import JobRunner
from .llm import LlmService
from .ollama_client import Inventory, OllamaClient, OllamaError
from .postfilter import AssertionFilter

log = logging.getLogger("crd.access")
if not logging.getLogger().handlers:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)  # httpx 요청 로그 억제


# ------------------------------------------------------------------ 요청 스키마
# 모든 요청 모델은 선언한 필드만 받는다(extra=forbid, API 점검 B3). 조항 글자 수 상한은 설정(limits.max_clause_chars)이라
# 핸들러의 check_clauses 가 추론 전에 본다(B6·B8).
ContractType = Literal["ecommerce", "subscription", "installment", "door_to_door", "general_consumer", "out_of_scope"]
assert set(ContractType.__args__) == set(CONTRACT_TYPE_KO)  # 분류기 입력 사상과 같은 6종(B5)


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


def _not_blank(v: str) -> str:  # 「공백만」은 min_length 로 못 막는다(B7)
    if not v.strip():
        raise ValueError("빈 텍스트는 보낼 수 없습니다")
    return v


class ClauseIn(Strict):
    clause_id: str
    text: str = Field(min_length=1)
    article_no: str | None = None
    title: str | None = None

    _text_not_blank = field_validator("text")(_not_blank)


class SummarizeReq(Strict):
    clauses: list[ClauseIn] = Field(min_length=1)


class DetectReq(Strict):
    clauses: list[ClauseIn] = Field(min_length=1)
    contract_type: ContractType


class Scores(Strict):
    loophole: float | None = Field(default=None, ge=0, le=1)
    illegal: float | None = Field(default=None, ge=0, le=1)


class Evidence(Strict):
    id: str
    source_type: Literal["law_article", "ftc_case", "std_terms"]
    title: str
    text: str


class EmbedReq(Strict):
    """근거·조항 임베딩(하이브리드 RAG). 조항은 비식별 텍스트만(BR-MDL-01). 개수·길이 상한은 설정(llm.embed)으로 확인한다."""
    texts: list[str] = Field(min_length=1)


class JudgeReq(Strict):
    clause: str = Field(min_length=1)
    contract_type: ContractType
    perspective: Literal["consumer", "business"]
    knowledge_date: dt.date
    scores: Scores
    evidence: list[Evidence] = Field(max_length=10)

    _clause_not_blank = field_validator("clause")(_not_blank)


# ------------------------------------------------------------------ 상태
@dataclass
class AppState:
    settings: Settings
    client: OllamaClient
    inventory: Inventory
    llm: LlmService
    jobs: JobRunner
    classifiers: tuple[Classifier, Classifier] | None = None
    classifier_error: str | None = None


def _keep_alive_sec(ka: str) -> float:
    """'5m' → 300. 모델 응답 후 이 시간 동안 상주로 본다(config.validate 가 형식을 이미 확인)."""
    return float(ka[:-1]) * (60 if ka.endswith("m") else 1)


def _clause_texts(clauses: list[ClauseIn]) -> list[ClauseText]:
    return [ClauseText(c.clause_id, c.text, c.title) for c in clauses]


def create_app(
    settings: Settings | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
    sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep,
    classifier_loader: Callable[[Settings], tuple[Classifier, Classifier]] | None = None,
) -> FastAPI:
    s = settings or load_settings()

    def default_loader(st: Settings) -> tuple[Classifier, Classifier]:
        return load_classifiers(st.model_root, st.m1_path, st.m2_path, st.torch_threads, st.batch_size,
                                st.max_length, st.score_decimals)

    loader = classifier_loader or default_loader

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        client = OllamaClient(s.ollama_url, s.timeout_sec, s.max_attempts, s.backoff_sec, s.concurrency,
                              transport=transport, sleep=sleep)
        inv = Inventory(client, ttl_sec=s.status_cache_sec, resident_sec=_keep_alive_sec(s.keep_alive))
        llm = LlmService(s, client, inv, AssertionFilter(s.assertion_terms_path))
        st = AppState(s, client, inv, llm, JobRunner(lambda: st.classifiers, s.batch_size,
                                                     s.job_batch_timeout_sec, s.job_ttl_sec))
        app.state.crd = st
        if not s.api_key:
            logging.getLogger("crd").warning("MODEL_API_KEY 가 설정되지 않아 모든 요청을 401 로 거부한다")

        async def init_classifiers() -> None:  # 적재 중에는 /health status=loading
            try:
                st.classifiers = await asyncio.to_thread(loader, s)
                loop = asyncio.get_running_loop()

                def embed_sync(texts: list[str]) -> list[list[float]]:  # 분류 스레드 → 공유 Ollama 임베딩(동시 1건 규칙 그대로)
                    fut = asyncio.run_coroutine_threadsafe(llm.embed([t[: s.embed_max_chars] for t in texts]), loop)
                    return fut.result(timeout=s.job_batch_timeout_sec)["embeddings"]

                for c in st.classifiers:
                    if hasattr(c, "bind_embed"):
                        c.bind_embed(embed_sync)
            except Exception as e:
                st.classifier_error = type(e).__name__
                logging.getLogger("crd").error("M1·M2 적재 실패: %s", st.classifier_error)

        init = asyncio.create_task(init_classifiers())
        st.jobs.start()
        if s.warmup_on_start:  # 미리 올리기는 기동 시 1회만(가이드 1.6, 1.7-10)
            llm.start_warmup()
        try:
            yield
        finally:
            init.cancel()
            await st.jobs.stop()
            await llm.aclose()
            await client.aclose()

    app = FastAPI(title="crd model-server", version=s.bundle_version, lifespan=lifespan)

    # -------------------------------------------------------------- 미들웨어·오류 사상
    @app.middleware("http")
    async def access_log(request: Request, call_next):
        rid = request.headers.get("x-request-id") or uuid.uuid4().hex[:12]
        t0 = time.perf_counter()
        cl = request.headers.get("content-length")
        if cl and cl.isdigit() and int(cl) > s.max_body_bytes:
            resp = JSONResponse({"detail": "요청 본문이 너무 큽니다"}, status_code=413)
        else:
            try:
                resp = await call_next(request)
            except Exception as e:  # 처리 못 한 오류 = 고장(500). 503 은 «준비 안 됨»(적재 중·Ollama)만 — 본문 없이 종류만 남긴다
                logging.getLogger("crd").error("rid=%s 처리 오류 %s", rid, type(e).__name__)
                resp = JSONResponse({"detail": "내부 오류"}, status_code=500)
        resp.headers["x-request-id"] = rid
        log.info("rid=%s %s %s status=%d latency_ms=%d", rid, request.method, request.url.path,
                 resp.status_code, (time.perf_counter() - t0) * 1000)
        return resp

    @app.exception_handler(RequestValidationError)
    async def on_validation(_: Request, exc: RequestValidationError):
        # 입력값(exc.errors()[i]['input'])은 되돌리지 않는다 — 위치와 사유만
        parts = [f"{'.'.join(str(x) for x in e.get('loc', ()))}: {e.get('msg', '')}" for e in exc.errors()[:5]]
        return JSONResponse({"detail": "입력 오류 — " + "; ".join(parts)}, status_code=400)

    @app.exception_handler(OllamaError)
    async def on_ollama(_: Request, exc: OllamaError):
        return JSONResponse({"detail": exc.detail}, status_code=exc.status)

    def state(request: Request) -> AppState:
        return request.app.state.crd

    def ready_classifiers(st: AppState) -> tuple[Classifier, Classifier]:
        if st.classifiers is None:
            raise HTTPException(503, "M1·M2 적재 중" if not st.classifier_error else "M1·M2 적재 실패")
        return st.classifiers

    def check_size(n: int) -> None:
        if n > s.max_clauses_per_job:
            raise HTTPException(413, f"조항 수가 한도({s.max_clauses_per_job})를 넘습니다")

    def check_text(text: str) -> None:  # 자르지 않고 거절 — 추론 전에(B6·B8)
        if len(text) > s.max_clause_chars:
            raise HTTPException(400, f"입력 오류 — 조항은 {s.max_clause_chars}자까지입니다")

    def check_clauses(clauses: list[ClauseIn]) -> None:
        check_size(len(clauses))
        for c in clauses:
            check_text(c.text)

    auth = [Depends(require_bearer)]

    # -------------------------------------------------------------- 엔드포인트
    @app.get("/health", dependencies=auth)
    async def health(request: Request):
        code, body = await build_health(state(request))
        return JSONResponse(body, status_code=code)

    @app.get("/v1/models", dependencies=auth)
    async def models(request: Request):
        return await build_models(state(request))

    @app.post("/v1/summarize", dependencies=auth)
    async def summarize(req: SummarizeReq, request: Request):
        st = state(request)
        check_clauses(req.clauses)
        return await st.llm.summarize([c.model_dump() for c in req.clauses])

    async def _detect(st: AppState, req: DetectReq, idx: int) -> dict:
        check_clauses(req.clauses)
        model = ready_classifiers(st)[idx]
        timeout = s.job_batch_timeout_sec * math.ceil(len(req.clauses) / s.batch_size)
        try:
            results = await asyncio.wait_for(
                asyncio.to_thread(model.predict, req.contract_type, _clause_texts(req.clauses)), timeout)
        except asyncio.TimeoutError:
            raise HTTPException(504, f"{model.id} 시간 초과") from None
        return {"results": results, "model_version": model.model_version, "knowledge_date": None}

    @app.post("/v1/detect/loophole", dependencies=auth)
    async def detect_loophole(req: DetectReq, request: Request):
        return await _detect(state(request), req, 0)

    @app.post("/v1/detect/illegal", dependencies=auth)
    async def detect_illegal(req: DetectReq, request: Request):
        return await _detect(state(request), req, 1)

    @app.post("/v1/jobs", dependencies=auth, status_code=202)
    async def create_job(req: DetectReq, request: Request):
        st = state(request)
        check_clauses(req.clauses)
        ready_classifiers(st)
        job_id = st.jobs.submit(req.contract_type, _clause_texts(req.clauses))
        return {"job_id": job_id}

    @app.get("/v1/jobs/{job_id}", dependencies=auth)
    async def get_job(job_id: str, request: Request):
        job = state(request).jobs.get(job_id)
        if job is None:
            raise HTTPException(404, "작업이 없습니다")
        return job.view()

    @app.post("/v1/embed", dependencies=auth)
    async def embed(req: EmbedReq, request: Request):
        if len(req.texts) > s.embed_max_batch:
            raise HTTPException(413, f"한 번에 {s.embed_max_batch}개까지 보낼 수 있습니다(가이드 1.7-7)")
        if any(not t.strip() for t in req.texts):
            raise HTTPException(400, "입력 오류 — 빈 텍스트가 있습니다")
        if any(len(t) > s.embed_max_chars for t in req.texts):
            raise HTTPException(400, f"입력 오류 — 텍스트는 {s.embed_max_chars}자까지입니다")
        return await state(request).llm.embed(req.texts)

    @app.post("/v1/judge", dependencies=auth)
    async def judge(req: JudgeReq, request: Request):
        check_text(req.clause)
        body = req.model_dump(mode="json")
        return await state(request).llm.judge(body)

    return app


app = create_app()
