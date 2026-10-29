"""3회차 비교 실험 — 임베딩·고전 방법 전체와 누수·과적합 진단. 선택은 VALIDATION 으로만, TEST 는 방법마다 확정 후 1회.

    var/venv-r3/bin/python training/r3_classical.py <embed_dir> <out_dir>

데이터셋: legal_full · legal_strict · legal_concat(FULL+STRICT 이어 붙임) · evasion
방법(하이퍼파라미터는 VAL AUC 로 고름, 임계값은 VAL F1 최대)
- fmt_only   : 형식 단서만(길이·제목 유무·계약유형) — 후보 아님, 형식 단서 점검용
- tfidf_lr   : 글자 2~4-gram TF-IDF + 로지스틱 회귀
- emb_lr     : bge-m3 임베딩 + 로지스틱 회귀
- pca_lr     : 임베딩 → PCA(k) → 로지스틱 회귀
- kmeans_lr  : 임베딩 → KMeans(k, TRAIN 으로만 적합) 중심 거리 특징 → 로지스틱 회귀
- knn        : 임베딩 코사인 kNN(거리 가중)
- svm_rbf    : 임베딩 RBF SVM
진단: TRAIN↔평가 근접 중복(코사인), 합성↔실제 문체 분리도(TRAIN 내부 5겹 AUC), 군집별 라벨·합성 비율, PCA 설명 분산
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np
from sklearn.cluster import KMeans
from sklearn.decomposition import PCA
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import f1_score, roc_auc_score
from sklearn.model_selection import StratifiedKFold, cross_val_predict
from sklearn.neighbors import KNeighborsClassifier
from sklearn.svm import SVC

CT = ["subscription", "ecommerce", "general_consumer"]


def load(p: Path) -> list[dict]:
    return [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l.strip()]


def mets(s: np.ndarray, y: np.ndarray, th: float) -> dict:
    p = (s >= th).astype(int)
    tp = int(((p == 1) & (y == 1)).sum()); fp = int(((p == 1) & (y == 0)).sum())
    fn = int(((p == 0) & (y == 1)).sum()); tn = int(((p == 0) & (y == 0)).sum())
    pr = tp / (tp + fp) if tp + fp else 0.0; rc = tp / (tp + fn) if tp + fn else 0.0
    return {"auc": round(float(roc_auc_score(y, s)), 4), "f1": round(2 * pr * rc / (pr + rc), 4) if pr + rc else 0.0,
            "precision": round(pr, 4), "recall": round(rc, 4), "fpr": round(fp / (fp + tn), 4) if fp + tn else None,
            "tp": tp, "fp": fp, "fn": fn, "tn": tn}


def best_th(s: np.ndarray, y: np.ndarray) -> float:
    cands = np.unique(np.quantile(s, np.linspace(0.02, 0.98, 97)))
    return float(max(cands, key=lambda t: (f1_score(y, (s >= t).astype(int), zero_division=0), -abs(t - np.median(s)))))


def fmt_feats(rows: list[dict]) -> np.ndarray:
    return np.array([[math.log1p(r["raw_len"]), float(r["has_title"]), float(r["ct_null"])] + [float(r["ct"] == c) for c in CT] for r in rows])


def main() -> None:
    ed, out = Path(sys.argv[1]), Path(sys.argv[2]); out.mkdir(parents=True, exist_ok=True)
    E = np.load(ed / "emb.npy"); K = json.loads((ed / "emb_keys.json").read_text())
    R = {f"{t}_{s}": load(ed / f"rows_{t}_{s}.jsonl") for t in ("legal_full", "legal_strict", "evasion") for s in ("train", "validation", "test")}
    sets = {
        "legal_full": (R["legal_full_train"], R["legal_full_validation"], R["legal_full_test"]),
        "legal_strict": (R["legal_strict_train"], R["legal_strict_validation"], R["legal_strict_test"]),
        "legal_concat": (R["legal_full_train"] + R["legal_strict_train"], R["legal_full_validation"], R["legal_full_test"]),
        "evasion": (R["evasion_train"], R["evasion_validation"], R["evasion_test"]),
    }
    report: dict = {}
    for name, (tr, va, te) in sets.items():
        print(f"== {name} train {len(tr)} val {len(va)} test {len(te)}", flush=True)
        X = {k: E[[K[r["key"]] for r in rows]] for k, rows in (("tr", tr), ("va", va), ("te", te))}
        Y = {k: np.array([r["label"] for r in rows]) for k, rows in (("tr", tr), ("va", va), ("te", te))}
        T = {k: [r["text"] for r in rows] for k, rows in (("tr", tr), ("va", va), ("te", te))}
        rep: dict = {"n": {k: int(len(v)) for k, v in Y.items()}, "pos": {k: int(v.sum()) for k, v in Y.items()}, "methods": {}, "diag": {}}

        # ---- 진단 ----
        for ev in ("va", "te"):
            sim = X[ev] @ X["tr"].T
            mx = sim.max(1)
            same = [int(Y["tr"][j] == Y[ev][i]) for i, j in enumerate(sim.argmax(1))]
            rep["diag"][f"neardup_{ev}"] = {"exact_key": int(len({r['key'] for r in (va if ev == 'va' else te)} & {r['key'] for r in tr})),
                                            ">=0.98": int((mx >= 0.98).sum()), ">=0.95": int((mx >= 0.95).sum()), ">=0.90": int((mx >= 0.90).sum()),
                                            "max_cos_median": round(float(np.median(mx)), 4),
                                            "nn_label_agree_>=0.95": round(float(np.mean([s for s, m in zip(same, mx) if m >= 0.95])), 3) if (mx >= 0.95).any() else None}
        orig = np.array([r["origin"] == "synthetic" for r in tr]).astype(int)
        if 0 < orig.sum() < len(orig):
            pr = cross_val_predict(LogisticRegression(C=1.0, max_iter=2000), X["tr"], orig, cv=StratifiedKFold(5, shuffle=True, random_state=0), method="predict_proba")[:, 1]
            pos_mask = Y["tr"] == 1
            rep["diag"]["synthetic_vs_real_auc_all"] = round(float(roc_auc_score(orig, pr)), 4)
            if 0 < orig[pos_mask].sum() < pos_mask.sum():
                rep["diag"]["synthetic_vs_real_auc_within_pos"] = round(float(roc_auc_score(orig[pos_mask], pr[pos_mask])), 4)
        km = KMeans(16, n_init=4, random_state=0).fit(X["tr"])
        cl = []
        for c in range(16):
            m = km.labels_ == c
            cl.append({"c": c, "n": int(m.sum()), "pos_rate": round(float(Y["tr"][m].mean()), 3), "synthetic_rate": round(float(orig[m].mean()), 3)})
        rep["diag"]["kmeans16_train"] = sorted(cl, key=lambda x: -x["n"])
        rep["diag"]["kmeans16_pure_clusters(pos_rate<=0.05 or >=0.95)"] = sum(1 for x in cl if x["pos_rate"] <= 0.05 or x["pos_rate"] >= 0.95)
        pca_full = PCA(256, random_state=0).fit(X["tr"])
        cum = np.cumsum(pca_full.explained_variance_ratio_)
        rep["diag"]["pca_components_for_var"] = {v: int(np.searchsorted(cum, v) + 1) for v in (0.5, 0.8, 0.9)}

        # ---- 방법 ----
        def fit_eval(mname: str, grid: list[dict], make, feats) -> None:
            best = None
            for g in grid:
                clf, f = make(g), feats(g)
                clf.fit(f["tr"], Y["tr"])
                sv = score(clf, f["va"])
                auc = roc_auc_score(Y["va"], sv)
                if best is None or auc > best[0]:
                    best = (auc, g, clf, f)
            _, g, clf, f = best
            sv, st, s_tr = score(clf, f["va"]), score(clf, f["te"]), score(clf, f["tr"])
            th = best_th(sv, Y["va"])
            rep["methods"][mname] = {"params": g, "threshold": round(th, 5), "train_auc": round(float(roc_auc_score(Y["tr"], s_tr)), 4),
                                     "val@th": mets(sv, Y["va"], th), "test@th": mets(st, Y["te"], th)}
            np.save(out / f"{name}__{mname}__val.npy", sv); np.save(out / f"{name}__{mname}__test.npy", st)
            m = rep["methods"][mname]
            print(f"  {mname:10s} {g} TRAIN AUC {m['train_auc']} VAL AUC {m['val@th']['auc']} F1 {m['val@th']['f1']} | TEST AUC {m['test@th']['auc']} F1 {m['test@th']['f1']}", flush=True)

        def score(clf, f):
            return clf.predict_proba(f)[:, 1] if hasattr(clf, "predict_proba") and not isinstance(clf, SVC) else clf.decision_function(f)

        Cs = [0.1, 0.3, 1, 3, 10]
        cws = [None, "balanced"]
        lr = lambda g: LogisticRegression(C=g["C"], class_weight=g["cw"], max_iter=4000)
        F_fmt = {k: fmt_feats(rows) for k, rows in (("tr", tr), ("va", va), ("te", te))}
        fit_eval("fmt_only", [{"C": c, "cw": w} for c in (0.1, 1, 10) for w in cws], lr, lambda g: F_fmt)
        tf = TfidfVectorizer(analyzer="char_wb", ngram_range=(2, 4), min_df=2, sublinear_tf=True, max_features=200000).fit(T["tr"])
        F_tf = {k: tf.transform(v) for k, v in T.items()}
        fit_eval("tfidf_lr", [{"C": c, "cw": w} for c in (1, 3, 10, 30) for w in cws], lr, lambda g: F_tf)
        fit_eval("emb_lr", [{"C": c, "cw": w} for c in Cs for w in cws], lr, lambda g: X)
        pcas = {k: PCA(k, random_state=0).fit(X["tr"]) for k in (16, 32, 64, 128, 256)}
        F_p = {k: {s: p.transform(X[s]) for s in X} for k, p in pcas.items()}
        fit_eval("pca_lr", [{"k": k, "C": c, "cw": w} for k in pcas for c in Cs for w in cws], lr, lambda g: F_p[g["k"]])
        kms = {k: KMeans(k, n_init=4, random_state=0).fit(X["tr"]) for k in (8, 16, 32, 64)}
        F_k = {k: {s: -m.transform(X[s]) for s in X} for k, m in kms.items()}
        fit_eval("kmeans_lr", [{"k": k, "C": c, "cw": w} for k in kms for c in Cs for w in cws], lr, lambda g: F_k[g["k"]])
        fit_eval("knn", [{"k": k} for k in (5, 15, 31, 61)], lambda g: KNeighborsClassifier(g["k"], weights="distance", metric="cosine"), lambda g: X)
        fit_eval("svm_rbf", [{"C": c, "cw": w} for c in (0.3, 1, 3, 10) for w in cws], lambda g: SVC(C=g["C"], class_weight=g["cw"], kernel="rbf", gamma="scale"), lambda g: X)
        report[name] = rep
        (out / "classical_result.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print("DONE")


if __name__ == "__main__":
    main()
