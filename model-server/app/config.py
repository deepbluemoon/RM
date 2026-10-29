"""게이트웨이 설정 — config.yaml 을 읽고 환경변수로 덮어쓴다.

비밀값(MODEL_API_KEY)은 환경변수(또는 gitignore 된 .env)에서만 읽는다.
공유 Ollama 규칙(참조 §7.3)을 어기는 값은 시작 시 거부한다.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

BASE_DIR = Path(__file__).resolve().parent.parent  # model-server/
MAX_NUM_CTX = 8192
MAX_NUM_PREDICT = 1024
MIN_STATUS_CACHE_SEC = 60.0
_KEEP_ALIVE_RE = re.compile(r"^(\d+)(s|m)$")
# 가이드 1.2 "사용하지 않는 모델" — 사고 모드가 꺼지지 않음·운영 예약·외부 과금·과대 컨텍스트 변형
FORBIDDEN_MODELS = frozenset({"qwen3:4b", "qwen3:4b:latest", "qwen3:latest", "gemma3:12b"})
_FORBIDDEN_SUFFIX_RE = re.compile(r"(:cloud|-cloud|-64k|-128k)$")


def load_dotenv(path: Path) -> None:
    """KEY=VALUE 형식의 .env 를 읽어 아직 없는 환경변수만 채운다(launchd 에서 비밀값을 plist 에 쓰지 않기 위함)."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key.strip(), value)


@dataclass(frozen=True)
class LlmModelCfg:
    id: str               # M3 | M4
    model: str            # 주 모델(Ollama 이름)
    fallback: str | None  # 주 모델 미설치 시에만 사용
    num_ctx: int
    num_predict: int
    json_schema: Path
    explain_max_items: int | None = None  # M3 설명 문장 수 상한(스키마 maxItems). None = 스키마 파일 값
    explain_max_chars: int | None = None  # M3 설명 문장 길이 상한(claim maxLength)


@dataclass(frozen=True)
class Settings:
    host: str
    port: int
    model_root: Path
    bundle_version: str
    torch_threads: int
    batch_size: int
    max_length: int
    score_decimals: int
    m1_path: str
    m2_path: str
    ollama_url: str
    keep_alive: str
    concurrency: int
    timeout_sec: float
    max_attempts: int
    backoff_sec: tuple[float, ...]
    status_cache_sec: float
    warmup_on_start: bool
    m3: LlmModelCfg
    m4: LlmModelCfg
    embed_model: str
    embed_dim: int
    embed_max_batch: int
    embed_max_chars: int
    max_clauses_per_job: int
    max_clause_chars: int
    max_body_bytes: int
    job_batch_timeout_sec: float
    job_ttl_sec: float
    assertion_terms_path: Path
    models_lock_path: Path
    api_key: str | None = field(default=None, repr=False)  # repr 에 노출하지 않는다


def _resolve(p: str | os.PathLike[str]) -> Path:
    path = Path(p).expanduser()
    return path if path.is_absolute() else (BASE_DIR / path).resolve()


def _llm(cfg: dict[str, Any], mid: str) -> LlmModelCfg:
    env_model = os.environ.get(f"OLLAMA_{mid}_MODEL")
    env_fb = os.environ.get(f"OLLAMA_{mid}_FALLBACK")
    return LlmModelCfg(
        id=mid,
        model=env_model or cfg["model"],
        fallback=(env_fb or cfg.get("fallback")) or None,
        num_ctx=int(cfg.get("num_ctx", MAX_NUM_CTX)),
        num_predict=int(cfg["num_predict"]),
        json_schema=_resolve(cfg["json_schema"]),
        explain_max_items=int(cfg["explain_max_items"]) if cfg.get("explain_max_items") is not None else None,
        explain_max_chars=int(cfg["explain_max_chars"]) if cfg.get("explain_max_chars") is not None else None,
    )


def forbidden_reason(name: str) -> str | None:
    """가이드 1.2 에서 쓰지 않기로 한 모델이면 사유를 돌려준다."""
    n = name.strip()
    if n in FORBIDDEN_MODELS:
        return "사용하지 않는 모델(가이드 1.2)"
    if _FORBIDDEN_SUFFIX_RE.search(n):
        return "':cloud'·'-64k'·'-128k' 변형 사용 금지(가이드 1.2)"
    return None


def validate(s: Settings) -> None:
    """공유 Ollama 규칙 위반 설정을 막는다."""
    for m in (s.m3, s.m4):
        if m.num_ctx != MAX_NUM_CTX:
            raise ValueError(f"{m.id} num_ctx 는 {MAX_NUM_CTX} 고정이다(가이드 1.3) — 현재 {m.num_ctx}")
        if m.num_predict > MAX_NUM_PREDICT:
            raise ValueError(f"{m.id} num_predict {m.num_predict} > {MAX_NUM_PREDICT} (가이드 1.7-2)")
        for name in (m.model, m.fallback):
            if name and (why := forbidden_reason(name)):
                raise ValueError(f"{m.id}: {name} — {why}")
    # 임베딩: 묶음 16~64(가이드 1.7-7), 규칙 위반 모델명 금지
    if not 16 <= s.embed_max_batch <= 64:
        raise ValueError(f"embed max_batch {s.embed_max_batch} 는 16~64 여야 한다(가이드 1.7-7)")
    if why := forbidden_reason(s.embed_model):
        raise ValueError(f"embed: {s.embed_model} — {why}")
    # 채팅 모델은 서비스당 1개(가이드 1.7-4). 대체 모델도 M3·M4 가 같아야 한다
    if s.m3.model != s.m4.model or s.m3.fallback != s.m4.fallback:
        raise ValueError("M3·M4 는 같은 채팅 모델 하나를 써야 한다(가이드 1.7-4) — OLLAMA_M3_MODEL·OLLAMA_M4_MODEL 을 같게")
    if s.status_cache_sec < MIN_STATUS_CACHE_SEC:
        raise ValueError(f"상태 조회 캐시는 {MIN_STATUS_CACHE_SEC:.0f}초 이상이어야 한다(가이드 1.7-6 폴링 금지)")
    ka = _KEEP_ALIVE_RE.match(s.keep_alive)
    if not ka or (int(ka.group(1)) * (60 if ka.group(2) == "m" else 1)) > 300:
        raise ValueError("keep_alive 는 '5m' 이하여야 한다(-1 금지)")
    if s.concurrency != 1:
        raise ValueError("공유 Ollama 동시 호출은 1건이어야 한다")
    if s.timeout_sec < 300:
        raise ValueError("Ollama 요청 타임아웃은 300초 이상이어야 한다")


def _bool(env: str | None, default: Any) -> bool:
    if env is None or env == "":
        return bool(default)
    return env.strip().lower() in ("1", "true", "yes", "on")


def load_settings(config_path: str | os.PathLike[str] | None = None) -> Settings:
    load_dotenv(BASE_DIR / ".env")
    path = Path(config_path or os.environ.get("MODEL_SERVER_CONFIG") or BASE_DIR / "config.yaml")
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    cls, llm, lim = raw["classifiers"], raw["llm"], raw["limits"]
    retry = llm.get("retry", {})
    s = Settings(
        host=raw["server"]["host"],
        port=int(raw["server"]["port"]),
        model_root=_resolve(os.environ.get("MODEL_ROOT") or raw["model_root"]),
        bundle_version=raw.get("bundle_version", "crd-model-server"),
        torch_threads=int(cls["torch_threads"]),
        batch_size=int(cls["batch_size"]),
        max_length=int(cls["max_length"]),
        score_decimals=int(cls["score_decimals"]),
        m1_path=cls["m1"]["path"],
        m2_path=cls["m2"]["path"],
        ollama_url=(os.environ.get("OLLAMA_URL") or llm["base_url"]).rstrip("/"),
        keep_alive=str(llm.get("keep_alive", "5m")),
        concurrency=int(llm.get("concurrency", 1)),
        timeout_sec=float(llm.get("timeout_sec", 300)),
        max_attempts=int(retry.get("max_attempts", 3)),
        backoff_sec=tuple(float(x) for x in retry.get("backoff_sec", [3, 6])),
        status_cache_sec=float(llm.get("status_cache_sec", MIN_STATUS_CACHE_SEC)),
        warmup_on_start=_bool(os.environ.get("OLLAMA_WARMUP_ON_START"), llm.get("warmup_on_start", True)),
        m3=_llm(llm["m3"], "M3"),
        m4=_llm(llm["m4"], "M4"),
        embed_model=os.environ.get("OLLAMA_EMBED_MODEL") or (llm.get("embed") or {}).get("model", "bge-m3"),
        embed_dim=int((llm.get("embed") or {}).get("dim", 1024)),
        embed_max_batch=int((llm.get("embed") or {}).get("max_batch", 32)),
        embed_max_chars=int((llm.get("embed") or {}).get("max_chars", 8000)),
        max_clauses_per_job=int(lim["max_clauses_per_job"]),
        max_clause_chars=int(lim.get("max_clause_chars", 10_000)),
        max_body_bytes=int(lim.get("max_body_bytes", 20_000_000)),
        job_batch_timeout_sec=float(lim.get("job_batch_timeout_sec", 60)),
        job_ttl_sec=float(lim.get("job_ttl_sec", 3600)),
        assertion_terms_path=_resolve(os.environ.get("ASSERTION_TERMS_PATH") or raw["postfilter"]["assertion_terms"]),
        models_lock_path=BASE_DIR / "models.lock.yaml",
        api_key=os.environ.get("MODEL_API_KEY") or None,
    )
    validate(s)
    return s
