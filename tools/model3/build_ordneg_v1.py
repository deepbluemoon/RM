"""평범한 조항 음성 추가 실험 데이터(ordneg v1, 2026-09-30) — 공식 model3_dataset_v2 는 그대로 두고 사본을 만든다.

    python3 tools/model3/build_ordneg_v1.py

- 원천: data_source/v1/actual_terms 실제 약관 2,752조항(읽기 전용)
- 누수 차단: 공식 평가(gen2 VAL·TEST)에 쓰인 실제 약관의 플랫폼 전부 제외(같은 회사 다른 버전 약관도 제외)
- 운영사(operator) 단위로 학습 60% · 선택용(ordVAL) 20% · 최종 확인용(ordTEST) 20% (시드 고정)
- 라벨: 0(약한 라벨 — 사람 검수 안 함, label_level WEAK_ORDINARY). 20자 미만 조항 제외(판정 불가 관문에서 걸러지는 길이)
- 출력: dataset_work/model3_ordneg_v1/
  evasion_detector/{train,validation,test}.jsonl, direct_legal_detector_concat/{train,validation,test}.jsonl,
  ordinary_{train,val,test}.jsonl, BUILD_REPORT.json
"""
from __future__ import annotations

import hashlib
import json
import random
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DS = ROOT / "data_source/model_3/datasets/model3_dataset_v2"
OUT = ROOT / "dataset_work/model3_ordneg_v1"
CT = {"payment_financial": "금융", "buyer_general": "쇼핑", "marketplace_intermediation": "중개", "c2c": "중개",
      "membership_subscription": "구독", "seller": "플랫폼", "delivery_installation": "기타"}
load = lambda p: [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l.strip()]
norm = lambda t: re.sub(r"\s+", "", t or "")


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def main() -> None:
    at = load(ROOT / "data_source/v1/actual_terms/structured/terms_clauses.jsonl")
    doc2plat = {t["doc_id"]: t["platform"] for t in at}
    evalplat, evaltext = set(), set()
    for m in ("evasion_detector", "direct_legal_detector_full", "direct_legal_detector_strict"):
        for s in ("validation", "test"):
            for r in load(DS / m / f"{s}.jsonl"):
                evaltext.add(norm(r["text"]))
                if r["데이터ID"].startswith("TERMS-"):
                    evalplat.add(doc2plat[r["데이터ID"].split("-")[1]])
    # 같은 회사 계열(운영사)에 평가 플랫폼이 있으면 그 운영사 전체를 뺀다
    op_of = {t["platform"]: (t.get("operator") or t["platform"]) for t in at}
    evalops = {op_of[p] for p in evalplat}
    pool = [t for t in at if op_of[t["platform"]] not in evalops and t["platform"] not in evalplat
            and len(norm(t["clause_text"])) >= 20 and norm(t["clause_text"]) not in evaltext]
    ops = sorted({op_of[t["platform"]] for t in pool})
    random.Random(20260930).shuffle(ops)
    n = len(ops)
    split = {o: ("train" if i < round(n * 0.6) else "val" if i < round(n * 0.8) else "test") for i, o in enumerate(ops)}
    OUT.mkdir(parents=True, exist_ok=True)
    ordinary = {"train": [], "val": [], "test": []}
    for t in pool:
        o = op_of[t["platform"]]
        ordinary[split[o]].append({"데이터ID": f"ORD-{t['clause_id']}", "text": t["clause_text"], "contract_type": CT.get(t["terms_type"], "기타"),
                                   "title": t.get("clause_title"), "label": 0, "label_level": "WEAK_ORDINARY", "weak_label": True, "reviewed": False,
                                   "origin": "real", "데이터출처": "실제약관(평범한 조항)", "분할그룹ID": f"OPERATOR:{o}",
                                   "데이터분할": {"train": "TRAIN", "val": "ORD_VAL", "test": "ORD_TEST"}[split[o]],
                                   "meta": {"platform": t["platform"], "doc_id": t["doc_id"], "terms_type": t["terms_type"]}})
    for k, rows in ordinary.items():
        (OUT / f"ordinary_{k}.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")
    sets = {"evasion_detector": [DS / "evasion_detector"], "direct_legal_detector_concat": [DS / "direct_legal_detector_full", DS / "direct_legal_detector_strict"]}
    rep = {"eval_platforms_excluded": len(evalplat), "eval_operators_excluded": len(evalops), "pool": len(pool),
           "operators": {k: sorted(o for o in ops if split[o] == k) for k in ("train", "val", "test")},
           "ordinary_rows": {k: len(v) for k, v in ordinary.items()}, "datasets": {}, "sources_sha256": {}}
    for name, srcs in sets.items():
        d = OUT / name; d.mkdir(exist_ok=True)
        train = [r for s in srcs for r in load(s / "train.jsonl")] + ordinary["train"]
        (d / "train.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in train), encoding="utf-8")
        for sp in ("validation", "test"):  # 공식 평가 그대로(바이트 사본)
            (d / f"{sp}.jsonl").write_bytes((srcs[0] / f"{sp}.jsonl").read_bytes())
        rep["datasets"][name] = {"train": len(train), "train_label": dict(Counter(r["label"] for r in train))}
        for s in srcs:
            for f in ("train", "validation", "test"):
                rep["sources_sha256"][str((s / f"{f}.jsonl").relative_to(ROOT))] = sha(s / f"{f}.jsonl")
    # 누수 점검: 평범한 조항 ↔ 공식 TRAIN·평가 본문
    trains = {norm(r["text"]) for srcs in sets.values() for s in srcs for r in load(s / "train.jsonl")}
    rep["leak_check"] = {k: {"in_eval_text": sum(norm(r["text"]) in evaltext for r in v), "in_official_train_text": sum(norm(r["text"]) in trains for r in v)}
                         for k, v in ordinary.items()}
    (OUT / "BUILD_REPORT.json").write_text(json.dumps(rep, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({k: rep[k] for k in ("eval_platforms_excluded", "eval_operators_excluded", "pool", "ordinary_rows", "datasets", "leak_check")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
