"""베이스라인(v0) M1·M2 상세 평가 — 파인튜닝 체크포인트 vs 현재 휴리스틱, 같은 eval 세트.

    model-server/.venv/bin/python tools/dataset_build/baseline_v0/eval_v0.py [--split eval] [--data DIR --models DIR --report DIR]

train.py 의 요약 지표(이진 P/R/F1)에 더해 출처별 오탐, 위험 유형 macro-F1, 법률 멀티레이블, 임계값별 지표를 낸다.
산출: dataset_work/reports/baseline_v0/eval_{split}.json
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
MS = ROOT / "model-server"
sys.path.insert(0, str(MS))
from app.classifiers import (LAWS, M1_LABELS, RISK_TYPES, ClauseText, HeuristicIllegal,  # noqa: E402
                             HeuristicLoophole, TorchIllegal, TorchLoophole)

DATA = ROOT / "dataset_work/master/baseline_v0/split"
MODELS = MS / "var/models/baseline_v0"
REPORT = ROOT / "dataset_work/reports/baseline_v0"


def prf(tp: int, fp: int, fn: int) -> dict:
    p = tp / (tp + fp) if tp + fp else 0.0
    r = tp / (tp + fn) if tp + fn else 0.0
    return {"precision": round(p, 4), "recall": round(r, 4), "f1": round(2 * p * r / (p + r), 4) if p + r else 0.0,
            "tp": tp, "fp": fp, "fn": fn}


def binary(scores: list[float], gold: list[bool], th: float) -> dict:
    tp = sum(s >= th and g for s, g in zip(scores, gold))
    fp = sum(s >= th and not g for s, g in zip(scores, gold))
    fn = sum(s < th and g for s, g in zip(scores, gold))
    return prf(tp, fp, fn)


def auc(scores: list[float], gold: list[bool]) -> float | None:
    pos = [s for s, g in zip(scores, gold) if g]
    neg = [s for s, g in zip(scores, gold) if not g]
    if not pos or not neg:
        return None
    wins = sum((p > n) + 0.5 * (p == n) for p in pos for n in neg)
    return round(wins / (len(pos) * len(neg)), 4)


def predict(clf, rows: list[dict]) -> list[dict]:
    out: list[dict] = []
    by_ct = defaultdict(list)
    for i, r in enumerate(rows):
        by_ct[r["contract_type"]].append(i)
    res: dict[int, dict] = {}
    for ct, idx in by_ct.items():
        preds = clf.predict(ct, [ClauseText(rows[i]["id"], rows[i]["text"], rows[i].get("title")) for i in idx])
        for i, p in zip(idx, preds):
            res[i] = p
    out = [res[i] for i in range(len(rows))]
    return out


def eval_m1(rows, preds, th=0.5) -> dict:
    gold = [r["category"] != "normal" for r in rows]
    scores = [p["score"] for p in preds]
    # 유형: 양성으로 맞힌 것 중 유형 일치(macro-F1, 7종)
    per = {}
    for t in RISK_TYPES:
        tp = sum(g and s >= th and p.get("type") == t and r["risk_type"] == t for r, p, s, g in zip(rows, preds, scores, gold))
        fp = sum(s >= th and p.get("type") == t and r["risk_type"] != t for r, p, s in zip(rows, preds, scores))
        fn = sum(r["risk_type"] == t and not (s >= th and p.get("type") == t) for r, p, s in zip(rows, preds, scores))
        per[t] = prf(tp, fp, fn)
    present = [t for t in RISK_TYPES if any(r["risk_type"] == t for r in rows)]
    return {
        "binary@0.5": binary(scores, gold, th), "auc": auc(scores, gold),
        "thresholds": {str(t): binary(scores, gold, t) for t in (0.3, 0.5, 0.7, 0.9)},
        "type_macro_f1": round(sum(per[t]["f1"] for t in present) / len(present), 4) if present else None,
        "type_per_class": {t: per[t] for t in present},
    }


def eval_m2(rows, preds, th=0.5) -> dict:
    gold = [r["category"] == "illegal" for r in rows]
    scores = [p["score"] for p in preds]
    law = {}
    for l in LAWS:
        g = [l in r["laws"] for r in rows]
        pr = [l in (p.get("related_laws") or []) for p in preds]
        law[l] = prf(sum(a and b for a, b in zip(pr, g)), sum(a and not b for a, b in zip(pr, g)),
                     sum(b and not a for a, b in zip(pr, g)))
    # 참고: 위험 전체(비정상) 대비 M2 점수가 얼마나 갈리는지
    any_risk = [r["category"] != "normal" for r in rows]
    return {"binary@0.5(illegal)": binary(scores, gold, th), "auc(illegal)": auc(scores, gold),
            "auc(any_risk)": auc(scores, any_risk),
            "thresholds": {str(t): binary(scores, gold, t) for t in (0.3, 0.5, 0.7, 0.9)},
            "laws": {k: v for k, v in law.items() if v["tp"] + v["fn"] + v["fp"]}}


def by_source(rows, preds, positive_fn, th=0.5) -> dict:
    out = {}
    for src in sorted({f"{r['source']}/{r['category']}" for r in rows}):
        idx = [i for i, r in enumerate(rows) if f"{r['source']}/{r['category']}" == src]
        flagged = sum(preds[i]["score"] >= th for i in idx)
        out[src] = {"n": len(idx), "flagged": flagged, "flag_rate": round(flagged / len(idx), 4),
                    "gold_positive": positive_fn(rows[idx[0]])}
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--split", default="eval")
    ap.add_argument("--data", default=str(DATA), help="split 디렉터리(회차별)")
    ap.add_argument("--models", default=str(MODELS), help="체크포인트 상위 디렉터리(회차별)")
    ap.add_argument("--report", default=str(REPORT), help="결과 디렉터리(회차별)")
    a = ap.parse_args()
    data_dir, models_dir, report_dir = Path(a.data), Path(a.models), Path(a.report)
    rows = [json.loads(l) for l in (data_dir / f"{a.split}.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
    kw = dict(threads=6, batch=16, max_len=512, nd=4)
    models = {
        "M1": {"heuristic": HeuristicLoophole(), "finetuned_v0": TorchLoophole(models_dir / "loophole-klue-roberta-base", **kw)},
        "M2": {"heuristic": HeuristicIllegal(), "finetuned_v0": TorchIllegal(models_dir / "illegal-klue-roberta-base", **kw)},
    }
    report = {"split": a.split, "n": len(rows),
              "gold": dict(Counter(f"{r['source']}/{r['category']}" for r in rows)), "results": {}}
    errors = {}
    per_row = [{"id": r["id"], "source": r["source"], "category": r["category"], "risk_type": r.get("risk_type"),
                "laws": r.get("laws"), "len": len(r["text"])} for r in rows]
    for mid, clfs in models.items():
        for name, clf in clfs.items():
            preds = predict(clf, rows)
            for pr, p in zip(per_row, preds):
                pr[f"{mid}/{name}"] = {k: p.get(k) for k in ("score", "type", "related_laws") if k in p}
            if mid == "M1":
                res = eval_m1(rows, preds)
                res["by_source"] = by_source(rows, preds, lambda r: r["category"] != "normal")
            else:
                res = eval_m2(rows, preds)
                res["by_source"] = by_source(rows, preds, lambda r: r["category"] == "illegal")
            report["results"][f"{mid}/{name}"] = res
            if name == "finetuned_v0":
                pos = (lambda r: r["category"] != "normal") if mid == "M1" else (lambda r: r["category"] == "illegal")
                errs = [{"id": r["id"], "source": r["source"], "category": r["category"], "score": p["score"],
                         "type": p.get("type"), "text": r["text"][:160]}
                        for r, p in zip(rows, preds) if (p["score"] >= 0.5) != pos(r)]
                errors[mid] = sorted(errs, key=lambda e: -abs(e["score"] - 0.5))
    report_dir.mkdir(parents=True, exist_ok=True)
    (report_dir / f"eval_{a.split}.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    with (report_dir / f"preds_{a.split}.jsonl").open("w", encoding="utf-8") as f:
        for pr in per_row:
            f.write(json.dumps(pr, ensure_ascii=False) + "\n")
    (report_dir / f"errors_{a.split}.json").write_text(json.dumps(errors, ensure_ascii=False, indent=2), encoding="utf-8")
    for k, v in report["results"].items():
        head = v.get("binary@0.5") or v.get("binary@0.5(illegal)")
        print(k, head, "auc", v.get("auc") or v.get("auc(illegal)"), "type_macro_f1", v.get("type_macro_f1"))


if __name__ == "__main__":
    main()
