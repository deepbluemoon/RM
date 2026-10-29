"""2회차 이진 분류 학습(M1 편법 evasion_detector / M2 위법 direct_legal_detector) — 그룹 K-겹 교차검증으로 에폭을 정한다.

    .venv/bin/python training/train_binary_cv.py <data_dir> <out_dir> --model m1|m2 [--folds 5 --max-epochs 5]

- 입력: 06_model_dataset/<model>/{train,validation,test}.jsonl (label 0|1, 분할그룹ID)
- 전처리(학습 입력에서만, 원본 파일은 건드리지 않음)
  - 계약유형: 데이터 한글 6종 → 서빙 코드(추천안 B) → 서빙 한글(CONTRACT_TYPE_KO). 서빙과 같은 입력 문자열이 되게 한다
  - 텍스트 정리: tools/workspace/text_clean_v1(편집·발췌 표시 삭제, 회사·서비스명 → "회사") — 06 export 와 같은 규칙
  - PII: 전화·이메일 → 서빙 deid 와 같은 〔전화번호〕·〔이메일〕
- 절차
  1) TEST 는 고정(3회차까지). 손대지 않는다
  2) TRAIN+VALIDATION 을 분할그룹ID 단위로 K겹(양성 수 균형 탐욕 배정) → 에폭별 held-out F1·AUC, 학습 쪽 F1(과적합 판단)
  3) 평균 held-out F1 이 가장 높은 에폭 수로 TRAIN+VALIDATION 전체 재학습 → TEST 평가, model_card.json
- 출력 헤드 2클래스 {0: none, 1: evasion|illegal}. 서빙 점수 = 1 − P(none) = P(1)
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import random
import re
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

import torch
from torch import nn
from torch.utils.data import DataLoader
from transformers import AutoModelForSequenceClassification, AutoTokenizer, get_linear_schedule_with_warmup

BASE = Path(__file__).resolve().parents[1]
ROOT = BASE.parent
sys.path.insert(0, str(BASE))
from app.classifiers import format_input  # noqa: E402

from training.model_card import write_card  # noqa: E402

sys.path.insert(0, str(ROOT / "tools/workspace"))
from text_clean_v1 import clean as clean_text  # noqa: E402

# 추천안 B — 데이터 계약유형 → 서빙 코드
CONTRACT_MAP = {"구독": "subscription", "쇼핑": "ecommerce", "플랫폼": "ecommerce", "중개": "ecommerce",
                "금융": "general_consumer", "기타": "general_consumer"}

# 회사명: v1 공정위 사건 목록의 이름 조각 + 실제 약관 플랫폼·운영사 + 보충 목록. 일반어·부분일치 위험어는 뺀다
NAME_STOP = {"플랫폼", "임시조치", "금융위", "금소법", "발렛파킹", "패키지", "이벤트", "정기검침일", "체육시설법", "계정 소유자",
             "저축은행", "온투업자", "전문투자자", "휴양림", "시즌", "알리", "다방", "더공", "HUG", "IDC", "리셀", "스카이패스"}
NAME_EXTRA = {"Netflix", "넷플릭스", "CJ ENM", "씨제이이엔엠", "DIA TV", "YES24", "예스24", "리디북스", "교보문고", "교보e캐시",
              "톡소다", "쿠팡이츠", "배달의민족", "배달의 민족", "요기요", "와디즈", "인터파크", "11번가", "G마켓", "지마켓", "옥션",
              "위메프", "티몬", "네이버", "카카오", "쏘카", "그린카", "야놀자", "여기어때", "하나투어", "모두투어", "숨고", "크몽", "탈잉",
              "직방", "밀리의서재", "넥슨", "엔씨소프트", "넷마블", "구글", "유튜브", "페이스북", "트위치", "아프리카TV", "아프리카tv"}
NAME_OK_SHORT = {"쿠팡", "크몽", "숨고", "탈잉", "직방", "리디", "윌라", "왓챠", "티빙", "컬리", "테무", "캠핏", "웹젠", "펍지", "넥슨",
                 "쏘카", "야놀자", "네이버", "카카오", "구글"}
PII = [(re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+"), "〔이메일〕"),
       (re.compile(r"(?<![0-9])0\d{1,2}[-. ]?\d{3,4}[-. ]?\d{4}(?![0-9])|(?<![0-9])1[5689]\d{2}-\d{4}(?![0-9])"), "〔전화번호〕")]
CORP = re.compile(r"\(주\)\s*[\w가-힣]+|㈜\s*[\w가-힣]+|[\w가-힣]+\s*주식회사|주식회사\s*[\w가-힣]+")


def build_names() -> list[str]:
    names = set(NAME_EXTRA)
    with (ROOT / "data_source/v1/unfair_cases/source/cases.csv").open(encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            for part in re.split(r"[,·/\[\]()（）‘’'\"]|\s및\s|\s등\s", r["company_or_platform"]):
                p = re.sub(r"㈜|\(주\)|주식회사|\(유\)|\(학\)|\s+", " ", part).strip()
                if not p or len(p) > 15 or p in NAME_STOP or re.search(r"기준|대상|조사|사업자|약관|이하|순", p):
                    continue
                if len(p) >= 3 or p in NAME_OK_SHORT:
                    names.add(p)
    for l in (ROOT / "data_source/v1/actual_terms/structured/terms_clauses.jsonl").open(encoding="utf-8"):
        t = json.loads(l)
        for n in (t.get("platform"), t.get("operator")):
            if n and (len(n) >= 3 or n in NAME_OK_SHORT) and n not in NAME_STOP:
                names.add(n.strip())
    return sorted(names, key=len, reverse=True)


def deid(text: str, names=None) -> str:
    """06 export 와 같은 정리(text_clean_v1: 표시 삭제·회사명→"회사") + 서빙 deid 와 같은 PII 표기. 이미 정리된 텍스트엔 영향 없음."""
    text = clean_text(text)
    for pat, rep in PII:
        text = pat.sub(rep, text)
    return text


def prep(rows: list[dict], names: list[str]) -> list[dict]:
    out = []
    for r in rows:
        ct = CONTRACT_MAP.get(r.get("contract_type"), "general_consumer")
        out.append({"id": r["데이터ID"], "group": r["분할그룹ID"], "split": r["데이터분할"], "label": int(r["label"]),
                    "label_level": r.get("label_level"), "ct": ct, "ct_src": r.get("contract_type"),
                    "title": deid(r["title"], names) if r.get("title") else None, "text": deid(r["text"], names),
                    "raw_len": len(r["text"])})
    return out


def load(p: Path) -> list[dict]:
    return [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l.strip()]


def folds_by_group(rows: list[dict], k: int, seed: int) -> list[int]:
    """그룹 단위 K겹. 양성이 많은 그룹부터 양성 수가 가장 적은 겹에 배정(동률은 행 수, 해시 순)."""
    g = defaultdict(lambda: [0, 0])
    for r in rows:
        g[r["group"]][0] += r["label"]
        g[r["group"]][1] += 1
    order = sorted(g, key=lambda x: (-g[x][0], -g[x][1], hashlib.sha256(f"{seed}:{x}".encode()).hexdigest()))
    pos, cnt, assign = [0] * k, [0] * k, {}
    for x in order:
        f = min(range(k), key=lambda i: (pos[i], cnt[i]))
        assign[x] = f
        pos[f] += g[x][0]
        cnt[f] += g[x][1]
    return [assign[r["group"]] for r in rows]


def collate(tok, max_len):
    def fn(rows):
        enc = tok([format_input(r["ct"], r["title"], r["text"]) for r in rows], padding=True, truncation=True,
                  max_length=max_len, return_tensors="pt")
        enc["labels"] = torch.tensor([r["label"] for r in rows])
        return enc
    return fn


@torch.no_grad()
def scores(model, rows, tok, max_len, dev) -> list[float]:
    model.eval()
    out: list[float] = []
    for b in DataLoader(rows, batch_size=64, collate_fn=collate(tok, max_len)):
        b = {k: v.to(dev) for k, v in b.items() if k != "labels"}
        out += torch.softmax(model(**b).logits.float(), -1)[:, 1].cpu().tolist()
    return out


def metrics(s: list[float], y: list[int], th: float = 0.5) -> dict:
    tp = sum(a >= th and b for a, b in zip(s, y)); fp = sum(a >= th and not b for a, b in zip(s, y))
    fn = sum(a < th and b for a, b in zip(s, y)); tn = sum(a < th and not b for a, b in zip(s, y))
    p = tp / (tp + fp) if tp + fp else 0.0
    r = tp / (tp + fn) if tp + fn else 0.0
    pos = [a for a, b in zip(s, y) if b]; neg = [a for a, b in zip(s, y) if not b]
    auc = (sum((a > c) + 0.5 * (a == c) for a in pos for c in neg) / (len(pos) * len(neg))) if pos and neg else None
    return {"n": len(y), "pos": sum(y), "precision": round(p, 4), "recall": round(r, 4),
            "f1": round(2 * p * r / (p + r), 4) if p + r else 0.0, "auc": round(auc, 4) if auc is not None else None,
            "fpr": round(fp / (fp + tn), 4) if fp + tn else None, "tp": tp, "fp": fp, "fn": fn, "tn": tn}


def bootstrap_f1(s, y, n=2000, seed=0):
    rnd = random.Random(seed)
    idx = list(range(len(y)))
    vals = []
    for _ in range(n):
        b = [rnd.choice(idx) for _ in idx]
        vals.append(metrics([s[i] for i in b], [y[i] for i in b])["f1"])
    vals.sort()
    return [round(vals[int(0.025 * n)], 4), round(vals[int(0.975 * n) - 1], 4)]


def train_run(train_rows, eval_sets: dict, a, dev, log, tag) -> tuple:
    """train_rows 로 max_epochs 학습, 에폭마다 eval_sets 점수 기록. (model, tok, curve) 반환."""
    random.seed(a.seed); torch.manual_seed(a.seed)
    tok = AutoTokenizer.from_pretrained(a.base)
    model = AutoModelForSequenceClassification.from_pretrained(
        a.base, num_labels=2, id2label={0: "none", 1: a.pos_name}, label2id={"none": 0, a.pos_name: 1}).to(dev)
    tl = DataLoader(train_rows, batch_size=a.batch, shuffle=True, collate_fn=collate(tok, a.max_len),
                    generator=torch.Generator().manual_seed(a.seed))
    opt = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=0.01)
    steps = len(tl) * a.epochs_to_run
    sch = get_linear_schedule_with_warmup(opt, int(0.06 * steps), steps)
    curve = []
    t0 = time.monotonic()
    for ep in range(a.epochs_to_run):
        model.train()
        tot = 0.0
        for b in tl:
            b = {k: v.to(dev) for k, v in b.items()}
            loss = model(**b).loss
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step(); sch.step(); opt.zero_grad()
            tot += loss.item()
        rec = {"epoch": ep + 1, "train_loss": round(tot / len(tl), 4)}
        for name, rows in eval_sets.items():
            rec[name] = metrics(scores(model, rows, tok, a.max_len, dev), [r["label"] for r in rows])
        curve.append(rec)
        log(f"[{tag}] ep{ep + 1} loss {rec['train_loss']} " + " ".join(
            f"{k}:F1={v['f1']},AUC={v['auc']}" for k, v in rec.items() if isinstance(v, dict)) + f" ({time.monotonic() - t0:.0f}s)")
    return model, tok, curve


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("data_dir")
    ap.add_argument("out_dir")
    ap.add_argument("--model", choices=["m1", "m2"], required=True)
    ap.add_argument("--base", default=str(BASE / "var/hf/klue-roberta-base"))
    ap.add_argument("--folds", type=int, default=5)
    ap.add_argument("--max-epochs", type=int, default=5)
    ap.add_argument("--lr", type=float, default=2e-5)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--max-len", type=int, default=512)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--trained-data-date", default="2026-09-29")
    a = ap.parse_args()
    a.pos_name = "evasion" if a.model == "m1" else "illegal"
    dev = "mps" if torch.backends.mps.is_available() else "cpu"
    out = Path(a.out_dir); out.mkdir(parents=True, exist_ok=True)
    logf = (out / "train.log").open("a", encoding="utf-8")

    def log(msg):
        print(msg, flush=True); logf.write(msg + "\n"); logf.flush()

    names = build_names()
    dd = Path(a.data_dir)
    raw = {s: load(dd / f"{s}.jsonl") for s in ("train", "validation", "test")}
    data = {s: prep(v, names) for s, v in raw.items()}
    pool = data["train"] + data["validation"]
    test = data["test"]
    changed = sum(r["text"] != x["text"] for s in raw for r, x in zip(data[s], raw[s]))
    log(f"data {dd} pool {len(pool)} (pos {sum(r['label'] for r in pool)}) test {len(test)} (pos {sum(r['label'] for r in test)}) "
        f"deid_changed_rows {changed} names {len(names)} device {dev}")
    (out / "preprocessed_sample.jsonl").write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in pool[:20]), encoding="utf-8")

    # 2) 그룹 K겹 CV
    fold = folds_by_group(pool, a.folds, a.seed)
    fold_info = [{"fold": f, "rows": sum(x == f for x in fold), "pos": sum(r["label"] for r, x in zip(pool, fold) if x == f),
                  "groups": len({r["group"] for r, x in zip(pool, fold) if x == f})} for f in range(a.folds)]
    log(f"folds {fold_info}")
    a.epochs_to_run = a.max_epochs
    cv = []
    for f in range(a.folds):
        tr = [r for r, x in zip(pool, fold) if x != f]
        he = [r for r, x in zip(pool, fold) if x == f]
        rnd = random.Random(f)
        tr_probe = rnd.sample(tr, min(300, len(tr)))  # 학습 쪽 F1(과적합 판단)용 표본
        _, _, curve = train_run(tr, {"heldout": he, "train_probe": tr_probe}, a, dev, log, f"fold{f}")
        cv.append(curve)
        if dev == "mps":
            torch.mps.empty_cache()
    per_epoch = []
    for e in range(a.max_epochs):
        hs = [c[e]["heldout"] for c in cv]; ts = [c[e]["train_probe"] for c in cv]
        per_epoch.append({"epoch": e + 1,
                          "heldout_f1_mean": round(sum(h["f1"] for h in hs) / len(hs), 4),
                          "heldout_f1_min": min(h["f1"] for h in hs), "heldout_f1_max": max(h["f1"] for h in hs),
                          "heldout_auc_mean": round(sum(h["auc"] or 0 for h in hs) / len(hs), 4),
                          "train_f1_mean": round(sum(t["f1"] for t in ts) / len(ts), 4),
                          "train_loss_mean": round(sum(c[e]["train_loss"] for c in cv) / len(cv), 4)})
    best = max(per_epoch, key=lambda x: (x["heldout_f1_mean"], -x["epoch"]))
    log(f"cv per_epoch {per_epoch}")
    log(f"chosen epochs {best['epoch']}")

    # 3) 전체 재학습 → TEST
    a.epochs_to_run = best["epoch"]
    model, tok, final_curve = train_run(pool, {"test": test}, a, dev, log, "final")
    s_test = scores(model, test, tok, a.max_len, dev)
    s_pool = scores(model, pool, tok, a.max_len, dev)
    y_test = [r["label"] for r in test]
    res = {"test@0.5": metrics(s_test, y_test), "test_f1_ci95": bootstrap_f1(s_test, y_test),
           "test_thresholds": {str(t): metrics(s_test, y_test, t) for t in (0.3, 0.5, 0.7, 0.9)},
           "pool(train+val)@0.5": metrics(s_pool, [r["label"] for r in pool])}
    model.to("cpu").save_pretrained(out)
    tok.save_pretrained(out)
    write_card(out, mid="M1" if a.model == "m1" else "M2", name=out.name, base=a.base, trained_data_date=a.trained_data_date,
               metrics={"cv_chosen_epochs": best["epoch"], "cv_per_epoch": per_epoch, **res},
               data_counts={"pool": len(pool), "test": len(test), "folds": a.folds})
    with (out / "preds_test.jsonl").open("w", encoding="utf-8") as fh:
        for r, s in zip(test, s_test):
            fh.write(json.dumps({"id": r["id"], "group": r["group"], "label": r["label"], "label_level": r["label_level"],
                                 "score": round(s, 4), "raw_len": r["raw_len"], "ct_src": r["ct_src"]}, ensure_ascii=False) + "\n")
    with (out / "preds_pool.jsonl").open("w", encoding="utf-8") as fh:
        for r, s, f in zip(pool, s_pool, fold):
            fh.write(json.dumps({"id": r["id"], "group": r["group"], "split": r["split"], "fold": f, "label": r["label"],
                                 "label_level": r["label_level"], "score": round(s, 4), "raw_len": r["raw_len"]}, ensure_ascii=False) + "\n")
    (out / "cv_result.json").write_text(json.dumps({"folds": fold_info, "per_epoch": per_epoch, "curves": cv, "chosen": best,
                                                    "final_curve": final_curve, **res}, ensure_ascii=False, indent=1), encoding="utf-8")
    log(f"DONE test {res['test@0.5']} ci95 {res['test_f1_ci95']}")


if __name__ == "__main__":
    main()
