"""ordneg v1 평범한 조항을 전처리(train_binary_cv.prep)하고 bge-m3 임베딩 캐시(m3_round3_v1/_embed)에 더한다. 1회만 실행.

    .venv/bin/python training/ordneg_embed.py
"""
from __future__ import annotations

import hashlib
import json
import sys
import time
import urllib.request
from pathlib import Path

import numpy as np

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE))
from training.train_binary_cv import build_names, load, prep  # noqa: E402

SRC = BASE.parent / "dataset_work/model3_ordneg_v1"
E = BASE / "var/models/model3/m3_round3_v1/_embed"


def main() -> None:
    names = build_names()
    keys = json.loads((E / "emb_keys.json").read_text()); vecs = list(np.load(E / "emb.npy"))
    todo = {}
    for k in ("train", "val", "test"):
        raw = load(SRC / f"ordinary_{k}.jsonl"); rows = prep(raw, names)
        with (E / f"rows_ordinary_{k}.jsonl").open("w", encoding="utf-8") as fh:
            for r, x in zip(rows, raw):
                key = hashlib.sha1(r["text"].encode()).hexdigest()
                if key not in keys:
                    todo[key] = r["text"]
                fh.write(json.dumps({**r, "origin": "real", "has_title": bool(x.get("title")), "ct_null": False, "key": key}, ensure_ascii=False) + "\n")
    items = list(todo.items()); print("new", len(items), flush=True)
    for i in range(0, len(items), 32):
        chunk = items[i:i + 32]
        req = urllib.request.Request("http://127.0.0.1:11434/api/embed", data=json.dumps({"model": "bge-m3", "input": [t[:8000] for _, t in chunk]}).encode(),
                                     headers={"Content-Type": "application/json"})
        for (k, _), v in zip(chunk, json.loads(urllib.request.urlopen(req, timeout=300).read())["embeddings"]):
            a = np.asarray(v, dtype=np.float32); keys[k] = len(vecs); vecs.append(a / (np.linalg.norm(a) + 1e-12))
        time.sleep(1.0)
    np.save(E / "emb.npy", np.stack(vecs)); (E / "emb_keys.json").write_text(json.dumps(keys)); print("done", len(keys))


if __name__ == "__main__":
    main()
