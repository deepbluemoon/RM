"""회차 공통 데이터 누수 점검 — 학습 전에 split 디렉터리(train/dev/eval.jsonl)만 보고 판단한다.

    python3 tools/dataset_build/checks/leakage_check.py <split_dir> [--out report.json]

점검 항목
1. 그룹 겹침: group(없으면 doc_id)이 두 분할 이상에 나오는가
2. 문장 완전 중복: 공백 제거 텍스트가 분할 사이에 겹치는가(라벨 충돌 포함)
3. 근사 중복: 4-gram 포함률 ≥ 0.8 인 쌍이 train↔(dev|eval) 사이에 있는가
4. 지름길(shortcut) 위험: 출처(source)만으로 라벨이 결정되는 비율, 라벨별 길이·기호 분포 차이
데이터를 고치지 않는다(보고만).
"""
from __future__ import annotations

import argparse
import json
import re
import statistics
from collections import Counter, defaultdict
from pathlib import Path

SPLITS = ("train", "dev", "eval")


def load(p: Path) -> list[dict]:
    return [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l.strip()] if p.is_file() else []


def key(t: str) -> str:
    return re.sub(r"\s+", "", t)


def grams(t: str, n: int = 4) -> set[str]:
    t = key(t)
    return {t[i:i + n] for i in range(max(0, len(t) - n + 1))}


def label(r: dict) -> str:
    return r.get("category", "?")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("split_dir")
    ap.add_argument("--out")
    ap.add_argument("--near", type=float, default=0.8)
    a = ap.parse_args()
    sd = Path(a.split_dir)
    data = {s: load(sd / f"{s}.jsonl") for s in SPLITS}
    rep: dict = {"split_dir": str(sd), "sizes": {s: len(v) for s, v in data.items()}}

    # 1 그룹 겹침
    where = defaultdict(set)
    for s, rows in data.items():
        for r in rows:
            where[r.get("group") or r.get("doc_id")].add(s)
    overlap = {g: sorted(v) for g, v in where.items() if len(v) > 1}
    rep["group_overlap"] = {"n_groups": len(where), "n_overlapping": len(overlap), "examples": dict(list(overlap.items())[:10])}

    # 2 완전 중복
    tex = defaultdict(list)
    for s, rows in data.items():
        for r in rows:
            tex[key(r["text"])].append((s, label(r), r["id"]))
    cross = [v for v in tex.values() if len({s for s, _, _ in v}) > 1]
    within_conflict = [v for v in tex.values() if len({l for _, l, _ in v}) > 1]
    rep["exact_duplicate"] = {"cross_split_texts": len(cross), "label_conflict_texts": len(within_conflict),
                              "examples": [v[:3] for v in cross[:5]]}

    # 3 근사 중복 (train ↔ dev/eval)
    tg = [(r["id"], label(r), grams(r["text"])) for r in data["train"]]
    inv = defaultdict(set)
    for i, (_, _, g) in enumerate(tg):
        for x in g:
            inv[x].add(i)
    near = []
    for s in ("dev", "eval"):
        for r in data[s]:
            g = grams(r["text"])
            if not g:
                continue
            cnt = Counter()
            for x in g:
                for i in inv.get(x, ()):
                    cnt[i] += 1
            for i, c in cnt.most_common(3):
                cont = c / min(len(g), len(tg[i][2]) or 1)
                if cont >= a.near:
                    near.append({"split": s, "id": r["id"], "label": label(r), "train_id": tg[i][0],
                                 "train_label": tg[i][1], "containment": round(cont, 3)})
                    break
    rep["near_duplicate_train_vs_heldout"] = {
        "threshold": a.near, "n": len(near), "label_mismatch": sum(n["label"] != n["train_label"] for n in near),
        "by_split": dict(Counter(n["split"] for n in near)), "examples": near[:10]}

    # 4 지름길 위험
    allr = [r for rows in data.values() for r in rows]
    by_src = defaultdict(Counter)
    for r in allr:
        by_src[r.get("source", "?")][label(r)] += 1
    purity = {s: round(max(c.values()) / sum(c.values()), 3) for s, c in by_src.items()}
    pos = [r for r in allr if label(r) != "normal"]
    neg = [r for r in allr if label(r) == "normal"]

    def feat(rows):
        L = [len(r["text"]) for r in rows]
        return {"n": len(rows), "len_median": statistics.median(L) if L else None,
                "has_[회사]": round(sum("[회사]" in r["text"] for r in rows) / max(1, len(rows)), 3),
                "has_quote": round(sum('"' in r["text"] or "'" in r["text"] for r in rows) / max(1, len(rows)), 3),
                "has_title": round(sum(bool(r.get("title")) for r in rows) / max(1, len(rows)), 3)}
    rep["shortcut_risk"] = {"label_by_source": {s: dict(c) for s, c in by_src.items()}, "source_purity": purity,
                            "positive_features": feat(pos), "negative_features": feat(neg)}

    # 판정
    issues = []
    if overlap:
        issues.append(f"그룹 겹침 {len(overlap)}개")
    if cross:
        issues.append(f"분할 사이 완전 중복 문장 {len(cross)}개")
    if near:
        issues.append(f"train↔검증·평가 근사 중복 {len(near)}건(≥{a.near})")
    if purity and min(purity.values()) >= 0.95 and len(by_src) > 1:
        issues.append("모든 출처가 라벨 하나로 거의 결정됨 → 출처 지름길 위험")
    rep["verdict"] = {"leakage": bool(overlap or cross or near), "issues": issues}
    s = json.dumps(rep, ensure_ascii=False, indent=2)
    if a.out:
        Path(a.out).write_text(s, encoding="utf-8")
    print(s)


if __name__ == "__main__":
    main()
