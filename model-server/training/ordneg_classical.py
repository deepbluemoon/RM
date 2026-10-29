"""ordneg v1 — 평범한 조항 음성을 넣은/뺀 SVM(편법)·TF-IDF(위법)를 같은 기준으로 비교한다.

    var/venv-r3/bin/python training/ordneg_classical.py

선택 기준(VAL 만, M3 앞 선별기이므로 놓치지 않는 쪽): 선택용 평범한 조항(ordVAL) 오탐률 ≤ 5% 를 지키는 임계값 중 공식 VAL 재현율 최대(동률 F1). 없으면 ordVAL 오탐률 최소.
TEST·ordTEST 는 확정 후 보고만. 점수는 앙상블용으로 저장.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.svm import SVC

sys.path.insert(0, str(Path(__file__).resolve().parent))
from r3_classical import load, mets  # noqa: E402

E = Path("var/models/model3/m3_round3_v1/_embed")
OUT = Path("var/models/model3/m3_ordneg_v1/_classical"); OUT.mkdir(parents=True, exist_ok=True)
CAP = 0.05


def pick(sv, yv, so):
    best = None
    for t in np.unique(np.quantile(np.concatenate([sv, so]), np.linspace(0.01, 0.99, 197))):
        flag = float((so >= t).mean()); m = mets(sv, yv, t)
        # 선별기 기준: 오탐 상한 안에서 재현율 최대(동률이면 F1)
        key = (flag <= CAP, (m["recall"], m["f1"]) if flag <= CAP else (-flag, 0))
        if best is None or key > best[0]:
            best = (key, float(t))
    return best[1]


def main():
    Kx = json.loads((E / "emb_keys.json").read_text()); EM = np.load(E / "emb.npy")
    R = lambda n: load(E / f"rows_{n}.jsonl")
    ordn = {k: R(f"ordinary_{k}") for k in ("train", "val", "test")}
    tasks = {
        "evasion_svm": dict(train=R("evasion_train"), val=R("evasion_validation"), test=R("evasion_test"), kind="svm"),
        "legal_tfidf": dict(train=R("legal_full_train") + R("legal_strict_train"), val=R("legal_full_validation"), test=R("legal_full_test"), kind="tfidf"),
    }
    report = {}
    for name, t in tasks.items():
        for with_ord in (False, True):
            tr = t["train"] + (ordn["train"] if with_ord else [])
            y = np.array([r["label"] for r in tr]); yv = np.array([r["label"] for r in t["val"]]); yt = np.array([r["label"] for r in t["test"]])
            sets = {"val": t["val"], "test": t["test"], "ordval": ordn["val"], "ordtest": ordn["test"]}
            if t["kind"] == "svm":
                X = lambda rows: EM[[Kx[r["key"]] for r in rows]]
                grid = [(C, cw) for C in (0.3, 1, 3, 10) for cw in (None, "balanced")]
                fit = lambda C, cw: SVC(C=C, class_weight=cw, kernel="rbf", gamma="scale").fit(X(tr), y)
                sc = lambda m, rows: m.decision_function(X(rows))
            else:
                vec = TfidfVectorizer(analyzer="char_wb", ngram_range=(2, 4), min_df=2, sublinear_tf=True, max_features=200000).fit([r["text"] for r in tr])
                grid = [(C, cw) for C in (1, 3, 10) for cw in (None, "balanced")]
                fit = lambda C, cw: LogisticRegression(C=C, class_weight=cw, max_iter=4000).fit(vec.transform([r["text"] for r in tr]), y)
                sc = lambda m, rows: m.predict_proba(vec.transform([r["text"] for r in rows]))[:, 1]
            best = None
            for C, cw in grid:
                m = fit(C, cw); s = {k: sc(m, v) for k, v in sets.items()}
                th = pick(s["val"], yv, s["ordval"]); flag = float((s["ordval"] >= th).mean()); mv = mets(s["val"], yv, th)
                key = (flag <= CAP, mv["recall"], mv["f1"], mv["auc"])
                if best is None or key > best[0]:
                    best = (key, (C, cw), th, s)
            _, prm, th, s = best
            tag = f"{name}{'_ord' if with_ord else ''}"
            report[tag] = {"params": prm, "threshold": th, "val": mets(s["val"], yv, th), "test": mets(s["test"], yt, th),
                           "ordval_flag": round(float((s["ordval"] >= th).mean()), 3), "ordtest_flag": round(float((s["ordtest"] >= th).mean()), 3)}
            for k, v in s.items():
                np.save(OUT / f"{tag}__{k}.npy", v)
            r = report[tag]
            print(f"{tag:18s} {prm} VAL AUC {r['val']['auc']} F1 {r['val']['f1']} | TEST AUC {r['test']['auc']} F1 {r['test']['f1']} 재현 {r['test']['recall']} | 평범 오탐 VAL {r['ordval_flag']} TEST {r['ordtest_flag']}", flush=True)
    (OUT / "result.json").write_text(json.dumps(report, ensure_ascii=False, indent=1, default=str), encoding="utf-8")


if __name__ == "__main__":
    main()
