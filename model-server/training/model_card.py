"""model_card.json 생성 (model-serving §5.6). 서빙(app/classifiers.py)은 name·model_version·trained_data_date·source 를 읽는다."""
from __future__ import annotations

import json
from pathlib import Path

import yaml

BASE = Path(__file__).resolve().parents[1]


def write_card(out: Path, *, mid: str, name: str, base: str, trained_data_date: str,
               metrics: dict | None = None, data_counts: dict | None = None) -> Path:
    lock = yaml.safe_load((BASE / "models.lock.yaml").read_text(encoding="utf-8"))["models"].get("BASE", {})
    card = {
        "id": mid,
        "name": name,
        "source": lock.get("repo", "klue/roberta-base"),
        "revision": lock.get("revision"),
        "base_local": str(base),
        "license": lock.get("license"),
        "precision": "fp32",
        "model_version": f"{name}@{trained_data_date}",
        "trained_data_date": trained_data_date,
        "serving": {"runtime": "pytorch", "device": "cpu", "threads": 6, "batch": 16, "max_length": 512},
        "input_format": "{계약유형 한글} [SEP] {조 제목} [SEP] {조항}",
        "labels": "none + 7 risk types" if mid == "M1" else "binary illegal + 5 laws multi-label",
        "metrics": metrics,
        "data_counts": data_counts,
    }
    p = Path(out) / "model_card.json"
    p.write_text(json.dumps(card, ensure_ascii=False, indent=2), encoding="utf-8")
    return p
