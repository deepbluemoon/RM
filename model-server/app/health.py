"""/health 와 /v1/models (model-serving §0.1, 계약 Health 스키마).

모델별 state:
  M1·M2 — 적재 중 loading, 적재 완료 ready, 적재 실패 error
  M3·M4 — /api/tags(설치)·/api/ps(상주) 로 판단. 상주 ready, 설치만 됨 cold(호출 가능 — G5 아님),
          예열 중 loading, 주 모델·대체 모델 모두 미설치 missing, Ollama 연결 불가 error
전체 status — M1·M2 적재 중이면 loading, missing·error 가 하나라도 있으면 degraded, 그 밖에는 ready.
warmup_estimate_sec — cold/loading 인 M3·M4 적재 예상 초의 합(서로 다른 모델만). 없으면 null.
"""
from __future__ import annotations

import json
import os
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .main import AppState


def total_memory_mb() -> int:
    try:
        return int(os.sysconf("SC_PHYS_PAGES") * os.sysconf("SC_PAGE_SIZE") / 2**20)
    except (ValueError, OSError, AttributeError):
        return 0


def _classifier_entry(st: "AppState", idx: int, mid: str) -> dict:
    if st.classifier_error:
        return {"id": mid, "state": "error", "model": None, "size_mb": None}
    if st.classifiers is None:
        return {"id": mid, "state": "loading", "model": None, "size_mb": None}
    c = st.classifiers[idx]
    size = None
    if c.kind == "pytorch":
        path = st.settings.model_root / (c.path or "")
        size = int(sum(f.stat().st_size for f in path.rglob("*") if f.is_file()) / 2**20) if path.is_dir() else None
    return {"id": mid, "state": "ready", "model": c.name, "size_mb": size}


async def build_health(st: "AppState") -> tuple[int, dict]:
    models = [_classifier_entry(st, 0, "M1"), _classifier_entry(st, 1, "M2")]
    snap = await st.inventory.snapshot()
    cold_names: dict[str, int] = {}
    for mid in ("M3", "M4"):
        r = await st.llm.resolve(mid)
        models.append({"id": mid, "state": r.state, "model": r.name,
                       "size_mb": int(r.size / 2**20) if r.size else None})
        if r.state in ("cold", "loading"):
            cold_names[r.name] = st.llm.load_estimate(r)
    states = {m["state"] for m in models}
    if st.classifiers is None and not st.classifier_error:
        status = "loading"
    elif states & {"missing", "error"}:
        status = "degraded"
    else:
        status = "ready"
    body = {
        "status": status,
        "models": models,
        "gpu": {"used_mb": int(snap.vram_used / 2**20), "total_mb": total_memory_mb()},
        "model_version": st.settings.bundle_version,
        "knowledge_date": None,
        "warmup_estimate_sec": sum(cold_names.values()) if cold_names else None,
        "queue_depth": st.client.queue_depth,
    }
    return (200 if status == "ready" else 503), body


def _card(path) -> dict:
    f = path / "model_card.json"
    return json.loads(f.read_text(encoding="utf-8")) if f.is_file() else {}


async def build_models(st: "AppState") -> dict:
    out: list[dict] = []
    if st.classifiers:
        out += [c.info() for c in st.classifiers]
    snap = await st.inventory.snapshot()
    for mid in ("M3", "M4"):
        r = await st.llm.resolve(mid)
        lk = st.llm.lock.get(mid, {})
        card = _card(st.settings.model_root / mid)
        out.append({
            "id": mid,
            "name": r.name,
            "base": card.get("source") or (r.name if r.is_fallback else lk.get("repo")),
            "path": None if r.is_fallback else lk.get("gguf"),
            "model_version": st.llm.model_version(r),
            "trained_data_date": None,
            "ollama_digest": r.digest or card.get("ollama_digest"),
            "state": r.state if snap.ok else "error",
        })
    # 계약에서 path·base·ollama_digest 는 nullable 이 아니다 — 값이 없으면 키를 뺀다
    out = [{k: v for k, v in m.items() if v is not None or k == "trained_data_date"} for m in out]
    return {"models": out, "model_version": st.settings.bundle_version, "knowledge_date": None}
