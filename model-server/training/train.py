"""M1·M2 파인튜닝 (PyTorch MPS) — klue/roberta-base 출발.

    uv run python training/train.py m1 data/split var/models/loophole-klue-roberta-base --trained-data-date 2026-09-20
    uv run python training/train.py m2 data/split var/models/illegal-klue-roberta-base  --trained-data-date 2026-09-20

M1: 8클래스(none + 위험 유형 7). M2: 이진(위법 소지) + 법률 5개 다중 레이블(app/m2_model.IllegalModel).
에폭마다 dev 로 평가해 가장 좋은 가중치를 저장하고, 끝에 eval(검수된 실제 조항)로 최종 지표를 model_card.json 에 남긴다.
"""
from __future__ import annotations

import argparse
import json
import random
import sys
import time
from pathlib import Path

import torch
from torch import nn
from torch.utils.data import DataLoader
from transformers import AutoModelForSequenceClassification, AutoTokenizer, get_linear_schedule_with_warmup

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE))
from app.classifiers import LAWS, M1_LABELS, format_input  # noqa: E402
from app.m2_model import IllegalModel  # noqa: E402

from training.model_card import write_card  # noqa: E402


def load(p: Path) -> list[dict]:
    return [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l.strip()] if p.is_file() else []


def m1_target(r: dict) -> int:
    return 0 if r["category"] == "normal" else M1_LABELS.index(r.get("risk_type") or "other")


def m2_target(r: dict) -> tuple[float, list[float]]:
    return float(r["category"] == "illegal"), [float(l in (r.get("laws") or [])) for l in LAWS]


def collate(tok, max_len: int, kind: str):
    def fn(rows):
        enc = tok([format_input(r["contract_type"], r.get("title"), r["text"]) for r in rows],
                  padding=True, truncation=True, max_length=max_len, return_tensors="pt")
        if kind == "m1":
            enc["labels"] = torch.tensor([m1_target(r) for r in rows])
        else:
            t = [m2_target(r) for r in rows]
            enc["y_bin"] = torch.tensor([[a] for a, _ in t])
            enc["y_law"] = torch.tensor([b for _, b in t])
        return enc
    return fn


@torch.no_grad()
def evaluate(model, loader, kind: str, dev: str) -> dict:
    model.eval()
    correct = n = 0
    tp = fp = fn_ = 0
    for b in loader:
        b = {k: v.to(dev) for k, v in b.items()}
        if kind == "m1":
            pred = model(input_ids=b["input_ids"], attention_mask=b["attention_mask"]).logits.argmax(-1)
            correct += int((pred == b["labels"]).sum())
            n += len(pred)
            pos_p, pos_t = pred != 0, b["labels"] != 0
        else:
            lb, _ = model(input_ids=b["input_ids"], attention_mask=b["attention_mask"])
            pred = (torch.sigmoid(lb) >= 0.5).squeeze(-1)
            tgt = b["y_bin"].squeeze(-1) >= 0.5
            correct += int((pred == tgt).sum())
            n += len(pred)
            pos_p, pos_t = pred, tgt
        tp += int((pos_p & pos_t).sum())
        fp += int((pos_p & ~pos_t).sum())
        fn_ += int((~pos_p & pos_t).sum())
    prec = tp / (tp + fp) if tp + fp else 0.0
    rec = tp / (tp + fn_) if tp + fn_ else 0.0
    return {"n": n, "accuracy": round(correct / n, 4) if n else None, "precision": round(prec, 4),
            "recall": round(rec, 4), "f1": round(2 * prec * rec / (prec + rec), 4) if prec + rec else 0.0}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("kind", choices=["m1", "m2"])
    ap.add_argument("split_dir")
    ap.add_argument("out_dir")
    ap.add_argument("--base", default=str(BASE / "var/hf/klue-roberta-base"))
    ap.add_argument("--trained-data-date", required=True)
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--lr", type=float, default=2e-5)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--max-len", type=int, default=512)
    ap.add_argument("--seed", type=int, default=42)
    a = ap.parse_args()

    random.seed(a.seed)
    torch.manual_seed(a.seed)
    dev = "mps" if torch.backends.mps.is_available() else "cpu"
    sd = Path(a.split_dir)
    train, dev_rows, eval_rows = load(sd / "train.jsonl"), load(sd / "dev.jsonl"), load(sd / "eval.jsonl")
    tok = AutoTokenizer.from_pretrained(a.base)
    col = collate(tok, a.max_len, a.kind)
    tl = DataLoader(train, batch_size=a.batch, shuffle=True, collate_fn=col,
                    generator=torch.Generator().manual_seed(a.seed))
    dl = DataLoader(dev_rows, batch_size=64, collate_fn=col)
    el = DataLoader(eval_rows, batch_size=64, collate_fn=col)

    if a.kind == "m1":
        model = AutoModelForSequenceClassification.from_pretrained(
            a.base, num_labels=len(M1_LABELS), id2label=dict(enumerate(M1_LABELS)),
            label2id={l: i for i, l in enumerate(M1_LABELS)})
    else:
        model = IllegalModel.from_base(a.base)
    model.to(dev)
    opt = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=0.01)
    steps = len(tl) * a.epochs
    sch = get_linear_schedule_with_warmup(opt, int(0.06 * steps), steps)
    bce = nn.BCEWithLogitsLoss()
    out = Path(a.out_dir)
    best, t0 = -1.0, time.monotonic()
    for ep in range(a.epochs):
        model.train()
        for i, b in enumerate(tl):
            b = {k: v.to(dev) for k, v in b.items()}
            if a.kind == "m1":
                loss = model(**b).loss
            else:
                lb, ll = model(input_ids=b["input_ids"], attention_mask=b["attention_mask"])
                loss = bce(lb, b["y_bin"]) + bce(ll, b["y_law"])
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step(); sch.step(); opt.zero_grad()
            if i % 50 == 0:
                print(f"ep{ep} step{i}/{len(tl)} loss {loss.item():.4f} ({time.monotonic() - t0:.0f}s)", flush=True)
        m = evaluate(model, dl, a.kind, dev) if dev_rows else {"f1": 0.0}
        print(f"ep{ep} dev {m}")
        if m["f1"] >= best:
            best = m["f1"]
            model.to("cpu")
            (model.save_pretrained(out) if a.kind == "m1" else model.save(out))
            tok.save_pretrained(out)
            model.to(dev)

    # 최종 평가는 저장된 최선 가중치로
    final = (AutoModelForSequenceClassification.from_pretrained(out) if a.kind == "m1" else IllegalModel.load(out)).to(dev)
    metrics = {"dev_best_f1": best, "eval": evaluate(final, el, a.kind, dev) if eval_rows else None}
    name = out.name
    write_card(out, mid="M1" if a.kind == "m1" else "M2", name=name, base=a.base,
               trained_data_date=a.trained_data_date, metrics=metrics,
               data_counts={"train": len(train), "dev": len(dev_rows), "eval": len(eval_rows)})
    print(f"완료 → {out} ({time.monotonic() - t0:.0f}s) {metrics}")


if __name__ == "__main__":
    main()
