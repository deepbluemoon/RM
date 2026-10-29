"""3회차 편법 모델(bge-m3 임베딩 + RBF SVM) 서빙 파일 만들기 — numpy 만으로 추론할 수 있게 서포트 벡터를 내보낸다.

    var/venv-r3/bin/python training/r3_export_svm.py <run_dir> <out_dir>

- 학습: evasion TRAIN 임베딩, 설정 = r3_classical 이 VAL 로 고른 값(classical_result.json)
- 점수: Platt(로지스틱) 보정을 VALIDATION 결정값으로 적합 → 임계값 = VAL F1 최대(확률 공간). TEST 는 확인용 1회
- 검증: numpy 재계산 결정값 == sklearn decision_function, VAL/TEST AUC 가 r3_classical 결과와 같음
"""
from __future__ import annotations

import json
import sys
from datetime import date
from pathlib import Path

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.svm import SVC

sys.path.insert(0, str(Path(__file__).resolve().parent))
from r3_classical import best_th, load, mets  # noqa: E402


def main() -> None:
    run, out = Path(sys.argv[1]), Path(sys.argv[2]); out.mkdir(parents=True, exist_ok=True)
    ed = run / "_embed"
    E = np.load(ed / "emb.npy"); K = json.loads((ed / "emb_keys.json").read_text())
    params = json.loads((run / "_classical/classical_result.json").read_text())["evasion"]["methods"]["svm_rbf"]["params"]
    R = {s: load(ed / f"rows_evasion_{s}.jsonl") for s in ("train", "validation", "test")}
    X = {s: E[[K[r["key"]] for r in rows]] for s, rows in R.items()}
    Y = {s: np.array([r["label"] for r in rows]) for s, rows in R.items()}
    clf = SVC(C=params["C"], class_weight=params["cw"], kernel="rbf", gamma="scale").fit(X["train"], Y["train"])
    gamma = float(clf._gamma)
    sv, coef, b = clf.support_vectors_.astype(np.float32), clf.dual_coef_.ravel().astype(np.float32), float(clf.intercept_[0])

    def dec_np(A):
        d2 = (sv * sv).sum(1)[None, :] + (A * A).sum(1)[:, None] - 2 * A @ sv.T
        return np.exp(-gamma * np.maximum(d2, 0)) @ coef + b
    for s in ("validation", "test"):
        diff = float(np.abs(dec_np(X[s].astype(np.float32)) - clf.decision_function(X[s])).max())
        assert diff < 1e-3, (s, diff)
    dv = clf.decision_function(X["validation"])
    platt = LogisticRegression(C=1e6, max_iter=5000).fit(dv[:, None], Y["validation"])
    # 서빙 식: p = 1 / (1 + exp(A·d + B))
    A, B = -float(platt.coef_[0][0]), -float(platt.intercept_[0])
    prob = lambda d: 1 / (1 + np.exp(A * d + B))
    pv, pt = prob(dv), prob(clf.decision_function(X["test"]))
    th = best_th(pv, Y["validation"])
    res = {"params": params, "gamma": gamma, "n_support": int(len(sv)), "platt": [A, B], "threshold": th,
           "val": mets(pv, Y["validation"], th), "test": mets(pt, Y["test"], th),
           "train_auc": round(float(roc_auc_score(Y["train"], clf.decision_function(X["train"]))), 4)}
    np.savez(out / "svm.npz", support_vectors=sv, dual_coef=coef, intercept=b, gamma=gamma, platt_a=A, platt_b=B)
    card = {"id": "M1", "name": "evasion-bge-m3-svm", "source": "bge-m3 (공유 Ollama) + RBF SVM",
            "model_version": f"evasion-bge-m3-svm@m3_round3_v1-{date.today().isoformat()}", "trained_data_date": date.today().isoformat(),
            "serving": {"kind": "embed_svm", "runtime": "numpy", "embed_model": "bge-m3", "embed_batch": 32, "threshold": th},
            "input_format": "조항 본문만 임베딩(계약유형·제목 미사용)", "labels": "binary {none, evasion}",
            "run": "data_source/model_3/runs/m3_round3_v1", "metrics": res}
    (out / "model_card.json").write_text(json.dumps(card, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(res, ensure_ascii=False))


if __name__ == "__main__":
    main()
