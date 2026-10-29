"""FR-042 분할 — 평가 데이터 분리(doc 단위), 평가는 검수된 실제 조항만, 인위 변형은 학습에만.

    uv run python training/split.py data/clauses.jsonl data/split [--eval-pct 15] [--dev-pct 10]
"""
from __future__ import annotations

import argparse
import hashlib
import json
from collections import Counter
from pathlib import Path


def bucket(doc_id: str, salt: str) -> int:
    return int(hashlib.sha256(f"{salt}:{doc_id}".encode()).hexdigest(), 16) % 100


def split(rows: list[dict], eval_pct: int, dev_pct: int) -> dict[str, list[dict]]:
    eval_docs = {r["doc_id"] for r in rows if r.get("origin") == "real" and bucket(r["doc_id"], "eval") < eval_pct}
    out: dict[str, list[dict]] = {"train": [], "dev": [], "eval": []}
    for r in rows:
        synthetic = r.get("origin") == "synthetic"
        if synthetic and (r["doc_id"] in eval_docs or r.get("derived_from_doc") in eval_docs):
            continue  # 평가 문서에서 파생된 변형은 누수 — 버린다
        if r["doc_id"] in eval_docs and not synthetic:
            if r.get("reviewed"):
                out["eval"].append(r)
            continue  # 검수 안 된 평가 문서 조항은 어느 쪽에도 넣지 않는다(문서 경계 유지)
        out["dev" if not synthetic and bucket(r["doc_id"], "dev") < dev_pct else "train"].append(r)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--eval-pct", type=int, default=15)
    ap.add_argument("--dev-pct", type=int, default=10)
    a = ap.parse_args()
    rows = [json.loads(l) for l in Path(a.src).read_text(encoding="utf-8").splitlines() if l.strip()]
    parts = split(rows, a.eval_pct, a.dev_pct)
    dst = Path(a.dst)
    dst.mkdir(parents=True, exist_ok=True)
    for name, rs in parts.items():
        (dst / f"{name}.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rs), encoding="utf-8")
        print(name, len(rs), dict(Counter(r["category"] for r in rs)))
    assert not any(r.get("origin") == "synthetic" for r in parts["eval"]), "평가에 인위 변형 조항이 섞였다"


if __name__ == "__main__":
    main()
