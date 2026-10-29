"""3회차 집계 — 미세조정·임베딩·고전 방법 결과를 모아 앙상블(가중치 VAL 선택)·최종 선택·구간별 TEST·보고서 표를 만든다.

    var/venv-r3/bin/python training/r3_report.py <run_dir(model-server/var/models/model3/m3_round3_v1)> <report_md>

선택 규칙: 데이터셋·방법 조합마다 VAL AUC 최고(동률 VAL F1). TEST 는 보고만 한다(선택에 쓰지 않음).
앙상블: 가장 좋은 미세조정 + 가장 좋은 임베딩·고전 방법의 점수를 VAL 평균·표준편차로 표준화해 가중 평균(w ∈ 0~1, VAL AUC 로 고름).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
from sklearn.metrics import roc_auc_score

sys.path.insert(0, str(Path(__file__).resolve().parent))
from r3_classical import best_th, load, mets  # noqa: E402

FT = {"legal_full": ["legal_full", "legal_full_cw"], "legal_strict": ["legal_strict", "legal_strict_cw"],
      "legal_concat": ["legal_concat", "legal_concat_cw"], "evasion": ["evasion", "evasion_cw"]}
EMB_ROWS = {"legal_full": "legal_full", "legal_strict": "legal_full", "legal_concat": "legal_full", "evasion": "evasion"}


def boot_ci(s: np.ndarray, y: np.ndarray, th: float, n: int = 2000) -> dict:
    rnd = np.random.default_rng(0)
    f1s, aucs = [], []
    for _ in range(n):
        i = rnd.integers(0, len(y), len(y))
        if y[i].min() == y[i].max():
            continue
        m = mets(s[i], y[i], th); f1s.append(m["f1"]); aucs.append(m["auc"])
    q = lambda v: [round(float(np.quantile(v, 0.025)), 3), round(float(np.quantile(v, 0.975)), 3)]
    return {"f1_ci95": q(f1s), "auc_ci95": q(aucs)}


def strat_auc(s: np.ndarray, y: np.ndarray, ln: np.ndarray, bins: int = 5) -> float | None:
    """길이 통제 AUC — 길이 5분위 구간 안에서만 양성·음성 쌍을 비교(형식 단서인 길이 차이를 뺀 판별력)."""
    edges = np.quantile(ln, np.linspace(0, 1, bins + 1)[1:-1])
    b = np.searchsorted(edges, ln, side="right")
    win = tot = 0.0
    for k in np.unique(b):
        m = b == k
        pos, neg = s[m & (y == 1)], s[m & (y == 0)]
        if len(pos) and len(neg):
            d = pos[:, None] - neg[None, :]
            win += (d > 0).sum() + 0.5 * (d == 0).sum(); tot += d.size
    return round(float(win / tot), 4) if tot else None


def main() -> None:
    run, md = Path(sys.argv[1]), Path(sys.argv[2])
    cl_dir = run / "_classical"
    cres = json.loads((cl_dir / "classical_result.json").read_text())
    rows = {k: {s: load(run / "_embed" / f"rows_{k}_{s}.jsonl") for s in ("validation", "test")} for k in ("legal_full", "evasion")}
    table, detail = [], {}
    for ds, fts in FT.items():
        er = rows[EMB_ROWS[ds]]
        yv = np.array([r["label"] for r in er["validation"]]); yt = np.array([r["label"] for r in er["test"]])
        lt = np.array([r["raw_len"] for r in er["test"]])
        cands: dict[str, dict] = {}
        for v in fts:
            p = run / v / "result.json"
            if not p.exists():
                continue
            res = json.loads(p.read_text())
            pv = {r["id"]: r["score"] for r in load(run / v / "preds_val.jsonl")}
            pt = {r["id"]: r["score"] for r in load(run / v / "preds_test.jsonl")}
            sv = np.array([pv[r["id"]] for r in er["validation"]]); st = np.array([pt[r["id"]] for r in er["test"]])
            tr = res["curve"][res["chosen_epoch"] - 1]["train_probe"]
            cands[f"finetune{'_cw' if v.endswith('_cw') else ''}"] = {"sv": sv, "st": st, "train_auc": tr["auc"], "params": {"epoch": res["chosen_epoch"]}}
        for m, info in cres[ds]["methods"].items():
            cands[m] = {"sv": np.load(cl_dir / f"{ds}__{m}__val.npy"), "st": np.load(cl_dir / f"{ds}__{m}__test.npy"),
                        "train_auc": info["train_auc"], "params": info["params"]}
        ft_best = max((k for k in cands if k.startswith("finetune")), key=lambda k: roc_auc_score(yv, cands[k]["sv"]), default=None)
        cl_best = max((k for k in cands if not k.startswith("finetune") and k != "fmt_only"), key=lambda k: roc_auc_score(yv, cands[k]["sv"]))
        if ft_best:
            z = lambda k, s: (s - cands[k]["sv"].mean()) / (cands[k]["sv"].std() + 1e-9)
            best_w = max(np.linspace(0, 1, 11), key=lambda w: roc_auc_score(yv, w * z(ft_best, cands[ft_best]["sv"]) + (1 - w) * z(cl_best, cands[cl_best]["sv"])))
            cands["ensemble"] = {"sv": best_w * z(ft_best, cands[ft_best]["sv"]) + (1 - best_w) * z(cl_best, cands[cl_best]["sv"]),
                                 "st": best_w * z(ft_best, cands[ft_best]["st"]) + (1 - best_w) * z(cl_best, cands[cl_best]["st"]),
                                 "train_auc": None, "params": {"finetune": ft_best, "other": cl_best, "w_finetune": round(float(best_w), 2)}}
        for k, c in cands.items():
            th = best_th(c["sv"], yv)
            mv, mt = mets(c["sv"], yv, th), mets(c["st"], yt, th)
            c.update(th=th, mv=mv, mt=mt)
            table.append({"dataset": ds, "method": k, "params": c["params"], "train_auc": c["train_auc"],
                          "val_auc": mv["auc"], "val_f1": mv["f1"], "test_auc": mt["auc"], "test_f1": mt["f1"],
                          "test_p": mt["precision"], "test_r": mt["recall"], "test_fpr": mt["fpr"], "test_auc_len": strat_auc(c["st"], yt, lt)})
        sel = max((k for k in cands if k != "fmt_only"), key=lambda k: (cands[k]["mv"]["auc"], cands[k]["mv"]["f1"]))
        c = cands[sel]
        te = er["test"]
        slices = {}
        for nm, f in {"len<100": lambda r: r["raw_len"] < 100, "len100-250": lambda r: 100 <= r["raw_len"] < 250, "len>=250": lambda r: r["raw_len"] >= 250,
                      "title있음": lambda r: r["has_title"], "title없음": lambda r: not r["has_title"]}.items():
            ix = np.array([f(r) for r in te])
            if ix.sum() and 0 < yt[ix].sum() < ix.sum():
                slices[nm] = {"n": int(ix.sum()), "pos": int(yt[ix].sum()), **{k: v for k, v in mets(c["st"][ix], yt[ix], c["th"]).items() if k in ("auc", "f1", "recall", "fpr")}}
            elif ix.sum():
                p = (c["st"][ix] >= c["th"]).astype(int)
                slices[nm] = {"n": int(ix.sum()), "pos": int(yt[ix].sum()), "acc": round(float((p == yt[ix]).mean()), 3)}
        levels = sorted({r.get("label_level") for r in te})
        for lv in levels:
            ix = np.array([r.get("label_level") == lv for r in te])
            p = (c["st"][ix] >= c["th"]).astype(int)
            slices[f"level:{lv}"] = {"n": int(ix.sum()), "pos": int(yt[ix].sum()), "pred_pos_rate": round(float(p.mean()), 3),
                                     "acc": round(float((p == yt[ix]).mean()), 3)}
        detail[ds] = {"selected": sel, "params": c["params"], "threshold": round(float(c["th"]), 5), "val": c["mv"], "test": c["mt"],
                      "test_ci": boot_ci(c["st"], yt, c["th"]), "val_ci": boot_ci(c["sv"], yv, c["th"]), "test_slices": slices,
                      "diag": cres[ds]["diag"]}
    (run / "r3_summary.json").write_text(json.dumps({"table": table, "detail": detail}, ensure_ascii=False, indent=1, default=float), encoding="utf-8")
    lines = ["| 데이터 | 방법 | 설정 | TRAIN AUC | VAL AUC | VAL F1 | TEST AUC | TEST F1 | TEST 정밀 | TEST 재현 | TEST 오탐률 | TEST 길이통제 AUC |", "|---|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|"]
    for t in table:
        lines.append(f"| {t['dataset']} | {t['method']} | {json.dumps(t['params'], ensure_ascii=False)} | {t['train_auc'] if t['train_auc'] is not None else '-'} | "
                     f"{t['val_auc']} | {t['val_f1']} | {t['test_auc']} | {t['test_f1']} | {t['test_p']} | {t['test_r']} | {t['test_fpr']} | {t['test_auc_len']} |")
    md.parent.mkdir(parents=True, exist_ok=True)
    md.write_text("\n".join(lines) + "\n\n```json\n" + json.dumps(detail, ensure_ascii=False, indent=1, default=float) + "\n```\n", encoding="utf-8")
    print("\n".join(lines))
    for ds, d in detail.items():
        print(ds, d["selected"], d["params"], "VAL", d["val"]["auc"], d["val"]["f1"], "TEST", d["test"], d["test_ci"])


if __name__ == "__main__":
    main()
