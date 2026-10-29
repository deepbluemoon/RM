"""3회차 위법 모델(CONCAT 미세조정 + TF-IDF 로지스틱 회귀 앙상블) 서빙 파일 만들기.

    var/venv-r3/bin/python training/r3_export_legal.py <run_dir> <variant(예: legal_concat_s43)> <out_dir>

- 미세조정 체크포인트는 그대로 복사(<out_dir>/encoder/). TF-IDF 는 어휘·idf·계수를 tfidf.npz·tfidf_vocab.json 으로 내보내
  서빙이 sklearn 없이 계산한다(app/classifiers.py char_wb_ngrams — sklearn TfidfVectorizer(char_wb, 2~4) 와 같은 규칙)
- 앙상블: z(미세조정) · z(TF-IDF) 를 VAL 평균·표준편차로 표준화, 가중치 w 와 임계값은 VAL 로만 고른다
- 점수: sigmoid((결합 − 임계값) / VAL 결합 표준편차) → 임계값이 0.5
- 검증: 순수 파이썬 TF-IDF 확률 == sklearn predict_proba (VAL·TEST), 앙상블 VAL/TEST 지표 출력
"""
from __future__ import annotations

import json
import shutil
import sys
from datetime import date
from pathlib import Path

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from r3_classical import best_th, load, mets  # noqa: E402
from app.classifiers import tfidf_proba  # noqa: E402


def main() -> None:
    run, variant, out = Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3])
    out.mkdir(parents=True, exist_ok=True)
    ed = run / "_embed"
    rows = {s: load(ed / f"rows_legal_full_{s}.jsonl") for s in ("train", "validation", "test")}
    strict = load(ed / "rows_legal_strict_train.jsonl")
    tr = rows["train"] + strict                           # CONCAT
    params = json.loads((run / "_classical/classical_result.json").read_text())["legal_concat"]["methods"]["tfidf_lr"]["params"]
    T = {"train": [r["text"] for r in tr], "validation": [r["text"] for r in rows["validation"]], "test": [r["text"] for r in rows["test"]]}
    Y = {"train": np.array([r["label"] for r in tr]), "validation": np.array([r["label"] for r in rows["validation"]]),
         "test": np.array([r["label"] for r in rows["test"]])}
    vec = TfidfVectorizer(analyzer="char_wb", ngram_range=(2, 4), min_df=2, sublinear_tf=True, max_features=200000).fit(T["train"])
    lr = LogisticRegression(C=params["C"], class_weight=params["cw"], max_iter=4000).fit(vec.transform(T["train"]), Y["train"])
    sk = {s: lr.predict_proba(vec.transform(T[s]))[:, 1] for s in ("validation", "test")}
    saved = np.load(run / "_classical/legal_concat__tfidf_lr__val.npy")
    assert np.allclose(saved, sk["validation"], atol=1e-6), "r3_classical 결과와 다름"
    vocab = {k: int(v) for k, v in vec.vocabulary_.items()}
    np.savez(out / "tfidf.npz", idf=vec.idf_.astype(np.float64), coef=lr.coef_.ravel().astype(np.float64), intercept=float(lr.intercept_[0]))
    (out / "tfidf_vocab.json").write_text(json.dumps(vocab, ensure_ascii=False), encoding="utf-8")
    z = np.load(out / "tfidf.npz")
    for s in ("validation", "test"):
        mine = np.array(tfidf_proba(T[s], vocab, z["idf"], z["coef"], float(z["intercept"])))
        diff = float(np.abs(mine - sk[s]).max())
        assert diff < 1e-6, (s, diff)
        print(f"TF-IDF 재구현 일치 {s}: 최대 오차 {diff:.2e}")
    # 미세조정 점수
    get = lambda f: {x["id"]: x["score"] for x in load(run / variant / f)}
    pv, pt = get("preds_val.jsonl"), get("preds_test.jsonl")
    ft = {"validation": np.array([pv[r["id"]] for r in rows["validation"]]), "test": np.array([pt[r["id"]] for r in rows["test"]])}
    mf, sf = float(ft["validation"].mean()), float(ft["validation"].std())
    mt, st = float(sk["validation"].mean()), float(sk["validation"].std())
    comb = lambda w, s: w * (ft[s] - mf) / sf + (1 - w) * (sk[s] - mt) / st
    w = float(max(np.linspace(0, 1, 11), key=lambda w: roc_auc_score(Y["validation"], comb(w, "validation"))))
    cv = comb(w, "validation"); th = float(best_th(cv, Y["validation"])); scale = float(cv.std())
    score = lambda s: 1 / (1 + np.exp(-(comb(w, s) - th) / scale))
    res = {"variant": variant, "w_finetune": round(w, 2), "threshold_comb": th, "scale": scale,
           "val": mets(score("validation"), Y["validation"], 0.5), "test": mets(score("test"), Y["test"], 0.5)}
    enc = out / "encoder"
    if enc.exists():
        shutil.rmtree(enc)
    shutil.copytree(run / variant / "checkpoint", enc)
    card = {"id": "M2", "name": "illegal-concat-ensemble", "source": "klue/roberta-base 미세조정 + 글자 2~4gram TF-IDF 로지스틱 회귀",
            "model_version": f"illegal-concat-ensemble@m3_round3_v1-{variant}-{date.today().isoformat()}", "trained_data_date": date.today().isoformat(),
            "serving": {"kind": "ensemble_binary", "runtime": "pytorch+numpy", "device": "cpu", "max_length": 512,
                        "w_finetune": w, "ft_mean": mf, "ft_std": sf, "tfidf_mean": mt, "tfidf_std": st,
                        "threshold_comb": th, "scale": scale, "threshold": 0.5},
            "input_format": "미세조정 = {계약유형 한글} [SEP] {조 제목} [SEP] {조항}, TF-IDF = 조항 본문", "labels": "binary {none, illegal}",
            "run": "data_source/model_3/runs/m3_round3_v1", "metrics": res}
    (out / "model_card.json").write_text(json.dumps(card, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(res, ensure_ascii=False))


if __name__ == "__main__":
    main()
