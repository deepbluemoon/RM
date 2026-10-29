"""ordneg v1 최종 비교 — 미세조정·SVM/TF-IDF·앙상블(평범한 조항 추가) vs 현재 서빙, 같은 선택 기준.

    var/venv-r3/bin/python training/ordneg_compare.py
선택(VAL 만): ordVAL 평범한 조항 오탐 ≤ 5% 안에서 공식 VAL 재현율 최대. TEST·ordTEST 는 보고만.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from sklearn.metrics import roc_auc_score

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ordneg_classical import CAP, pick  # noqa: E402
from r3_classical import load, mets  # noqa: E402

R = Path("var/models/model3/m3_ordneg_v1"); C = R / "_classical"; E = Path("var/models/model3/m3_round3_v1/_embed")
SV = json.loads((R / "serving_scores.json").read_text())
ORD = {k: load(E / f"rows_ordinary_{k}.jsonl") for k in ("val", "test")}


def ft(variant, rows_val, rows_test):
    g = lambda f: {x["id"]: x["score"] for x in load(R / variant / f)}
    pv, pt, po, pq = g("preds_val.jsonl"), g("preds_test.jsonl"), g("preds_ordval.jsonl"), g("preds_ordtest.jsonl")
    return {"val": np.array([pv[r["id"]] for r in rows_val]), "test": np.array([pt[r["id"]] for r in rows_test]),
            "ordval": np.array([po[r["id"]] for r in ORD["val"]]), "ordtest": np.array([pq[r["id"]] for r in ORD["test"]])}


def evaluate(name, s, yv, yt, th=None):
    th = pick(s["val"], yv, s["ordval"]) if th is None else th
    mv, mt = mets(s["val"], yv, th), mets(s["test"], yt, th)
    return {"name": name, "th": th, "val_auc": mv["auc"], "val_recall": mv["recall"], "test_auc": mt["auc"], "test_f1": mt["f1"],
            "test_recall": mt["recall"], "test_precision": mt["precision"], "ordval_flag": round(float((s["ordval"] >= th).mean()), 3),
            "ordtest_flag": round(float((s["ordtest"] >= th).mean()), 3), "flags_test": (s["test"] >= th), "flags_ordtest": (s["ordtest"] >= th)}


def main():
    out = {}
    for task, emb_rows, ftvars, clname, svkey in (
        ("evasion", "evasion", ["evasion", "evasion_cw"], "evasion_svm_ord", "M1"),
        ("legal", "legal_full", ["legal_concat"], "legal_tfidf_ord", "M2")):
        rv, rt = load(E / f"rows_{emb_rows}_validation.jsonl"), load(E / f"rows_{emb_rows}_test.jsonl")
        yv, yt = np.array([r["label"] for r in rv]), np.array([r["label"] for r in rt])
        cands = {f"미세조정({v})": ft(v, rv, rt) for v in ftvars}
        cands[clname] = {k: np.load(C / f"{clname}__{k}.npy") for k in ("val", "test", "ordval", "ordtest")}
        best_ft = max((k for k in cands if k.startswith("미세조정")), key=lambda k: roc_auc_score(yv, cands[k]["val"]))
        z = lambda a, ref: (a - ref.mean()) / (ref.std() + 1e-9)
        a, b = cands[best_ft], cands[clname]
        w = float(max(np.linspace(0, 1, 11), key=lambda w: roc_auc_score(yv, w * z(a["val"], a["val"]) + (1 - w) * z(b["val"], b["val"]))))
        cands[f"앙상블(w={w:.1f})"] = {k: w * z(a[k], a["val"]) + (1 - w) * z(b[k], b["val"]) for k in a}
        res = [evaluate(k, v, yv, yt) for k, v in cands.items()]
        cur = {"val": np.array(SV[f"{svkey}_{'eva' if task == 'evasion' else 'leg'}_val"]), "test": np.array(SV[f"{svkey}_{'eva' if task == 'evasion' else 'leg'}_test"]),
               "ordval": np.array(SV[f"{svkey}_ordval"]), "ordtest": np.array(SV[f"{svkey}_ordtest"])}
        res.append(evaluate(f"현재 서빙({svkey}, 기준 0.5)", cur, yv, yt, th=0.5))
        ok = [r for r in res if not r["name"].startswith("현재") and r["ordval_flag"] <= CAP]
        sel = max(ok or res[:-1], key=lambda r: (r["val_recall"], r["val_auc"]))
        out[task] = {"results": res, "selected": sel["name"]}
        print(f"== {task} (선택: {sel['name']})")
        for r in res:
            print(f"  {r['name']:26s} VAL AUC {r['val_auc']} 재현 {r['val_recall']} | TEST AUC {r['test_auc']} F1 {r['test_f1']} 재현 {r['test_recall']} 정밀 {r['test_precision']} | 평범 오탐 VAL {r['ordval_flag']} TEST {r['ordtest_flag']}")
    # 선별 합산(둘 중 하나라도 위험 → M3): 평범한 조항 최종 확인용에서 M3 호출 비율
    e, l = out["evasion"], out["legal"]
    se = next(r for r in e["results"] if r["name"] == e["selected"]); sl = next(r for r in l["results"] if r["name"] == l["selected"])
    ce = e["results"][-1]; cl = l["results"][-1]
    print("M3 호출 비율(평범한 조항 ordTEST): 새 조합", round(float((se["flags_ordtest"] | sl["flags_ordtest"]).mean()), 3),
          "| 현재 서빙", round(float((ce["flags_ordtest"] | cl["flags_ordtest"]).mean()), 3))
    for t in out.values():
        for r in t["results"]:
            r.pop("flags_test"); r.pop("flags_ordtest")
    (R / "compare.json").write_text(json.dumps(out, ensure_ascii=False, indent=1, default=float), encoding="utf-8")


if __name__ == "__main__":
    main()
