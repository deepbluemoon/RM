"""3회차(Model 3) 이진 분류 미세조정 — TRAIN 만으로 학습, 에폭·임계값은 held-out VALIDATION 으로만 고른다.

    .venv/bin/python training/train_r3_finetune.py <data_dir> <out_dir> --model m1|m2 [--extra-train <train.jsonl>] [--class-weight]

- 규칙(data_source/model_3/README §5, runs/README): VALIDATION 은 최종 학습에 합치지 않는다. TEST 는 마지막에 1회만 추론하고 선택에 쓰지 않는다
- 전처리는 2회차와 같다(train_binary_cv.prep — 계약유형 서빙 코드 매핑·text_clean_v1·PII 표기). 계약유형 null 은 general_consumer 로 가서 형식 단서가 되지 않는다
- --extra-train: 두 번째 TRAIN 파일을 이어 붙인다(위법 FULL+STRICT CONCAT — STRICT 는 FULL 의 부분집합이라 STRICT 행이 2배 가중된다)
- --class-weight: 교차 엔트로피 클래스 가중(TRAIN 빈도 역수). TRAIN P:N 과 평가 P:N 이 다를 때(위법 3.4~4.8:1 vs 평가 ~1:1)
- 에폭 선택: 에폭마다 VAL AUC(동률이면 VAL F1@0.5) 최고 에폭의 가중치를 메모리에 보관 → 그 에폭으로 확정
- 임계값: VAL F1 최대 임계값(0.05~0.95, 0.01 간격). TEST 는 0.5 와 VAL 임계값 두 가지로 보고
- 과적합 점검: 에폭마다 TRAIN 표본(최대 400) AUC·F1 과 VAL AUC·F1 의 차이
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import random
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import torch
from torch import nn
from torch.utils.data import DataLoader
from transformers import AutoModelForSequenceClassification, AutoTokenizer, get_linear_schedule_with_warmup

BASE = Path(__file__).resolve().parents[1]
ROOT = BASE.parent
sys.path.insert(0, str(BASE))
from training.train_binary_cv import bootstrap_f1, build_names, collate, load, metrics, prep, scores  # noqa: E402


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def best_threshold(s: list[float], y: list[int]) -> float:
    best = (0.0, 0.5)
    for i in range(5, 96):
        t = i / 100
        f = metrics(s, y, t)["f1"]
        if f > best[0] + 1e-9:
            best = (f, t)
    return best[1]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("data_dir")
    ap.add_argument("out_dir")
    ap.add_argument("--model", choices=["m1", "m2"], required=True)
    ap.add_argument("--extra-train", default=None)
    ap.add_argument("--class-weight", action="store_true")
    ap.add_argument("--base", default=str(BASE / "var/hf/klue-roberta-base"))
    ap.add_argument("--max-epochs", type=int, default=5)
    ap.add_argument("--lr", type=float, default=2e-5)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--max-len", type=int, default=512)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--run-id", required=True)
    ap.add_argument("--variant", required=True)
    ap.add_argument("--extra-eval", action="append", default=[], help="name=path.jsonl — 확정 후 점수만 저장(평범한 조항 오탐 확인용)")
    a = ap.parse_args()
    pos_name = "evasion" if a.model == "m1" else "illegal"
    dev = "mps" if torch.backends.mps.is_available() else "cpu"
    out = Path(a.out_dir).resolve(); out.mkdir(parents=True, exist_ok=True)
    logf = (out / "train.log").open("w", encoding="utf-8")

    def log(msg: str) -> None:
        print(msg, flush=True); logf.write(msg + "\n"); logf.flush()

    names = build_names()
    dd = Path(a.data_dir).resolve()
    files = {s: dd / f"{s}.jsonl" for s in ("train", "validation", "test")}
    raw_train = load(files["train"]) + (load(Path(a.extra_train)) if a.extra_train else [])
    train, val, test = prep(raw_train, names), prep(load(files["validation"]), names), prep(load(files["test"]), names)
    origin = {r["데이터ID"]: r.get("origin") for r in raw_train}
    y_val, y_test = [r["label"] for r in val], [r["label"] for r in test]
    npos = sum(r["label"] for r in train)
    log(f"[{a.variant}] train {len(train)} (pos {npos}) val {len(val)} (pos {sum(y_val)}) test {len(test)} device {dev}")

    random.seed(a.seed); torch.manual_seed(a.seed)
    tok = AutoTokenizer.from_pretrained(a.base)
    model = AutoModelForSequenceClassification.from_pretrained(
        a.base, num_labels=2, id2label={0: "none", 1: pos_name}, label2id={"none": 0, pos_name: 1}).to(dev)
    tl = DataLoader(train, batch_size=a.batch, shuffle=True, collate_fn=collate(tok, a.max_len),
                    generator=torch.Generator().manual_seed(a.seed))
    weight = None
    if a.class_weight:
        n = len(train)
        weight = torch.tensor([n / (2 * (n - npos)), n / (2 * npos)], dtype=torch.float32, device=dev)
    lossf = nn.CrossEntropyLoss(weight=weight)
    opt = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=0.01)
    steps = len(tl) * a.max_epochs
    sch = get_linear_schedule_with_warmup(opt, int(0.06 * steps), steps)
    probe = random.Random(a.seed).sample(train, min(400, len(train)))
    curve, best, best_state = [], None, None
    t0 = time.monotonic()
    for ep in range(a.max_epochs):
        model.train()
        tot = 0.0
        for b in tl:
            b = {k: v.to(dev) for k, v in b.items()}
            labels = b.pop("labels")
            loss = lossf(model(**b).logits.float(), labels)
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step(); sch.step(); opt.zero_grad()
            tot += loss.item()
        s_val = scores(model, val, tok, a.max_len, dev)
        s_pr = scores(model, probe, tok, a.max_len, dev)
        rec = {"epoch": ep + 1, "train_loss": round(tot / len(tl), 4), "val": metrics(s_val, y_val),
               "train_probe": metrics(s_pr, [r["label"] for r in probe])}
        curve.append(rec)
        key = (rec["val"]["auc"] or 0, rec["val"]["f1"])
        if best is None or key > best[0]:
            best = (key, ep + 1, s_val)
            best_state = {k: v.detach().to("cpu").clone() for k, v in model.state_dict().items()}
        log(f"[{a.variant}] ep{ep + 1} loss {rec['train_loss']} VAL AUC {rec['val']['auc']} F1 {rec['val']['f1']} | "
            f"TRAIN AUC {rec['train_probe']['auc']} F1 {rec['train_probe']['f1']} ({time.monotonic() - t0:.0f}s)")
    model.load_state_dict(best_state)
    chosen, s_val = best[1], best[2]
    th = best_threshold(s_val, y_val)
    # TEST: 확정 후 1회 추론
    s_test = scores(model, test, tok, a.max_len, dev)
    s_train = scores(model, train, tok, a.max_len, dev)
    res = {"chosen_epoch": chosen, "threshold": th,
           "val@0.5": metrics(s_val, y_val), "val@th": metrics(s_val, y_val, th),
           "test@0.5": metrics(s_test, y_test), "test@th": metrics(s_test, y_test, th),
           "test_f1_ci95@th": bootstrap_f1([float(s >= th) * 0.5 + 0.25 for s in s_test], y_test),
           "train@0.5": metrics(s_train, [r["label"] for r in train])}
    ck = out / "checkpoint"
    model.to("cpu").save_pretrained(ck); tok.save_pretrained(ck)

    def dump(name: str, rows: list[dict], s: list[float]) -> None:
        with (out / f"preds_{name}.jsonl").open("w", encoding="utf-8") as fh:
            for r, v in zip(rows, s):
                fh.write(json.dumps({"id": r["id"], "label": r["label"], "label_level": r["label_level"], "score": round(v, 5),
                                     "raw_len": r["raw_len"], "origin": origin.get(r["id"])}, ensure_ascii=False) + "\n")
    dump("val", val, s_val); dump("test", test, s_test); dump("train", train, s_train)
    if a.extra_eval:
        model.to(dev)  # 저장하면서 CPU 로 옮겼다
    for spec in a.extra_eval:
        nm, path = spec.split("=", 1)
        rows_x = prep(load(Path(path)), names)
        dump(nm, rows_x, scores(model, rows_x, tok, a.max_len, dev))
    (out / "result.json").write_text(json.dumps({"variant": a.variant, "curve": curve, **res}, ensure_ascii=False, indent=1), encoding="utf-8")
    real = sum(origin.get(r["id"]) == "real" for r in train)
    manifest = {
        "model_generation": "Model 3", "run_id": a.run_id, "variant": a.variant,
        "model": "m1 evasion_detector" if a.model == "m1" else "m2 direct_legal_detector",
        "dataset_version": "model3_dataset_v2",
        "splits": {"TRAIN": {"version": "model3_dataset_v2", "path": str(files["train"].relative_to(ROOT)), "sha256": sha(files["train"]),
                             "extra_path": str(Path(a.extra_train).resolve().relative_to(ROOT)) if a.extra_train else None,
                             "extra_sha256": sha(Path(a.extra_train)) if a.extra_train else None,
                             "rows": len(train), "real_rows": real, "synthetic_rows": len(train) - real},
                   "VALIDATION": {"version": "model3_eval_gen2", "path": str(files["validation"].relative_to(ROOT)), "sha256": sha(files["validation"]), "rows": len(val)},
                   "TEST": {"version": "model3_eval_gen2", "path": str(files["test"].relative_to(ROOT)), "sha256": sha(files["test"]), "rows": len(test)}},
        "evaluation_generation": "Model 3 evaluation generation 2 (model3_eval_gen2)",
        "augmentation": {"version": "model3_dataset_v2", "workstream": "direct_legal / evasion", "lineage": "data_source/model_3/datasets/model3_dataset_v2/train_row_sources.jsonl"},
        "base_model": "klue/roberta-base", "seed": a.seed, "epochs": chosen, "max_epochs": a.max_epochs, "lr": a.lr, "batch": a.batch,
        "class_weight": a.class_weight,
        "epoch_selection": "held-out VALIDATION AUC(동률 F1@0.5), 에폭마다 평가 후 최고 에폭 가중치로 확정",
        "threshold": th, "threshold_selection": "VALIDATION F1 최대(0.05~0.95). TEST 사용 안 함",
        "validation_in_final_training": False, "test_inference_count": 1,
        "training_script": {"path": str(Path(__file__).relative_to(ROOT)), "sha256": sha(Path(__file__))},
        "checkpoint_path": str(ck.relative_to(ROOT)),
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    (out / "RUN_MANIFEST.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    log(f"[{a.variant}] DONE epoch {chosen} th {th} VAL {res['val@th']} TEST@th {res['test@th']}")


if __name__ == "__main__":
    main()
