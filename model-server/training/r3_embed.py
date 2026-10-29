"""3회차 임베딩 계열 실험 입력 — 전처리한 조항(train_binary_cv.prep)을 bge-m3 로 임베딩해 저장한다.

    .venv/bin/python training/r3_embed.py <out_dir>

- 공유 Ollama 규칙("docs/ollama-guide.md"): /api/embed 만 부른다, 배치 32 + 1초 쉼, pull·create 금지
- 출력: <out_dir>/rows_<dataset>_<split>.jsonl(전처리 행 + 임베딩 행 번호), <out_dir>/emb.npy(float32, L2 정규화), emb_keys.json(본문 sha1 → 행 번호)
- 이미 임베딩한 본문은 다시 부르지 않는다(sha1 캐시)
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

import numpy as np

BASE = Path(__file__).resolve().parents[1]
ROOT = BASE.parent
sys.path.insert(0, str(BASE))
from training.train_binary_cv import build_names, load, prep  # noqa: E402

DS = ROOT / "data_source/model_3/datasets/model3_dataset_v2"
SETS = {"legal_full": "direct_legal_detector_full", "legal_strict": "direct_legal_detector_strict", "evasion": "evasion_detector"}
URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434") + "/api/embed"


def embed(texts: list[str]) -> list[list[float]]:
    req = urllib.request.Request(URL, data=json.dumps({"model": "bge-m3", "input": texts}).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read())["embeddings"]


def main() -> None:
    out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
    names = build_names()
    keys_p, emb_p = out / "emb_keys.json", out / "emb.npy"
    keys: dict[str, int] = json.loads(keys_p.read_text()) if keys_p.exists() else {}
    vecs = list(np.load(emb_p)) if emb_p.exists() else []
    todo: dict[str, str] = {}
    for tag, d in SETS.items():
        for sp in ("train", "validation", "test"):
            raw = load(DS / d / f"{sp}.jsonl")
            rows = prep(raw, names)
            with (out / f"rows_{tag}_{sp}.jsonl").open("w", encoding="utf-8") as fh:
                for r, x in zip(rows, raw):
                    k = hashlib.sha1(r["text"].encode()).hexdigest()
                    if k not in keys:
                        todo[k] = r["text"]
                    fh.write(json.dumps({**r, "origin": x.get("origin"), "has_title": bool(x.get("title")),
                                         "ct_null": x.get("contract_type") is None, "key": k}, ensure_ascii=False) + "\n")
    items = list(todo.items())
    print(f"new texts {len(items)} cached {len(keys)}", flush=True)
    for i in range(0, len(items), 32):
        chunk = items[i:i + 32]
        for (k, _), v in zip(chunk, embed([t[:8000] for _, t in chunk])):
            a = np.asarray(v, dtype=np.float32)
            keys[k] = len(vecs); vecs.append(a / (np.linalg.norm(a) + 1e-12))
        if (i // 32) % 20 == 0:
            print(f"  {min(i + 32, len(items))}/{len(items)}", flush=True)
            np.save(emb_p, np.stack(vecs)); keys_p.write_text(json.dumps(keys))
        time.sleep(1.0)
    np.save(emb_p, np.stack(vecs)); keys_p.write_text(json.dumps(keys))
    print("done", len(keys))


if __name__ == "__main__":
    main()
