"""M1·M2 베이스라인(v0) 학습 데이터 — 지금 있는 CSV/JSONL 만으로 만든다(DB 미사용).

    python3 tools/dataset_build/baseline_v0/build_v0.py

라벨은 잠정(v0)이다. 확정 라벨이 아니며 편법 기준 v1 사람 결정 7항목이 나오면 다시 만든다.
- 양성: v1 공정위 official 문제조항(코딩 결과로 범주 결정)
    회피형(예/YES)  → category=unfair  (M1 양성, M2 음성)
    직접형(아니오/NO) → category=illegal (M1·M2 양성)
    불확실/UNC     → category=dispute (M1 양성, M2 음성)
- 음성(category=normal, 약한 라벨): v1 실제 약관 조항, v2 표준약관 조문, 공정위 시정 후 문구(ftc_corrected_reference)
- 제외: 비전자상거래 Holdout 96개(봉인 유지), official 외 행, 공정위 양성과 거의 같은 실제 약관 조항
- 분할: 그룹(공정위=case_id, 약관=platform, 표준약관=행정규칙ID) 해시 80/10/10. eval 에도 약한 음성이 들어간다.
원천(data_source/v1·v2)은 읽기만 한다. 산출: dataset_work/master/baseline_v0/
"""
from __future__ import annotations

import csv
import hashlib
import json
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
V1 = ROOT / "data_source/v1"
V2 = ROOT / "data_source/v2/data"
REVIEW = ROOT / "dataset_work/review"
OUT = ROOT / "dataset_work/master/baseline_v0"

LAWS = {  # model-server/app/classifiers.py LAWS 와 같은 문자열
    "약관법": "약관의 규제에 관한 법률",
    "전자상거래법": "전자상거래 등에서의 소비자보호에 관한 법률",
    "소비자기본법": "소비자기본법",
    "할부거래법": "할부거래에 관한 법률",
    "방문판매법": "방문판매 등에 관한 법률",
}
LAW_ALIASES = {
    "약관법": ("약관법", "약관의 규제"),
    "전자상거래법": ("전자상거래법", "전자상거래 등에서의"),
    "소비자기본법": ("소비자기본법",),
    "할부거래법": ("할부거래법", "할부거래에 관한"),
    "방문판매법": ("방문판매법", "방문판매 등에 관한"),
}

# 공정위 issue_category 19종 → risk_type 7종 (잠정)
RISK_MAP = {
    "liability_exemption": "liability_avoid",
    "customer_liability_expansion": "liability_avoid",
    "personal_information": "liability_avoid",
    "refund_withdrawal_restriction": "refund_cancel_limit",
    "unilateral_termination": "rights_limit",
    "user_content_rights": "rights_limit",
    "rights_restriction": "rights_limit",
    "transfer_resale_restriction": "rights_limit",
    "jurisdiction_dispute": "rights_limit",
    "unilateral_change": "unilateral_change",
    "terms_change_notice": "unilateral_change",
    "deemed_consent_auto_renewal": "unilateral_change",
    "notice_method": "unilateral_change",
    "policy_precedence": "unilateral_change",
    "fee_charge": "excessive_penalty",
    "settlement_fee": "excessive_penalty",
    "interpretation_favoring_business": "vague",
    "confidentiality": "other",
    "other": "other",
}

TERMS_TYPE_MAP = {
    "membership_subscription": "subscription",
    "payment_financial": "general_consumer",
    "seller": "out_of_scope",
}
INDUSTRY_MAP = {
    "subscription_content": "subscription", "subscription_education": "subscription", "fan_membership": "subscription",
    "ticketing_membership": "subscription", "fitness": "subscription", "telecom": "subscription",
    "finance": "general_consumer", "crypto_exchange": "general_consumer", "automobile": "general_consumer",
    "medical_clinic": "general_consumer", "wedding": "general_consumer", "postnatal_care": "general_consumer",
    "pet_care": "general_consumer", "travel_agency": "general_consumer", "education": "general_consumer",
    "open_market_seller": "out_of_scope",
}

HEADER = re.compile(r"^\s*제\s*\d+\s*조(?:\s*의\s*\d+)?\s*(?:[(\[【<][^)\]】>]{0,40}[)\]】>])?\s*")
DEID = [
    (re.compile(r"https?://\S+|www\.\S+"), "[URL]"),
    (re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+"), "[이메일]"),
    (re.compile(r"\b0\d{1,2}[-. ]?\d{3,4}[-. ]?\d{4}\b|\b1[568]\d{2}-\d{4}\b"), "[전화]"),
    (re.compile(r"\(주\)\s*[\w가-힣]+|㈜\s*[\w가-힣]+|[\w가-힣]+\s*주식회사|주식회사\s*[\w가-힣]+"), "[회사]"),
]


def deid(text: str, names: set[str]) -> str:
    for n in sorted((n for n in names if n and len(n) >= 2), key=len, reverse=True):
        text = text.replace(n, "[회사]")
    for pat, rep in DEID:
        text = pat.sub(rep, text)
    return text


def normalize(text: str) -> str:
    text = text.replace(" ", " ").replace("“", '"').replace("”", '"').replace("‘", "'").replace("’", "'")
    text = re.sub(r"\s*/\s*", " ", text)          # 공정위 표 추출의 ' / ' 줄바꿈 흔적
    text = re.sub(r"[□■◦○●▶※]+", " ", text)
    text = HEADER.sub("", text, count=1)            # 약관 쪽에만 있는 '제N조(제목)' 머리 — 출처 지름길 제거
    return re.sub(r"\s+", " ", text).strip()


def grams(text: str, n: int = 4) -> set[str]:
    t = re.sub(r"\s+", "", text)
    return {t[i:i + n] for i in range(max(0, len(t) - n + 1))}


def laws_of(*fields: str) -> list[str]:
    s = " ".join(fields)
    return [LAWS[k] for k, al in LAW_ALIASES.items() if any(a in s for a in al)]


def split_of(group: str) -> str:
    h = int(hashlib.sha256(group.encode()).hexdigest(), 16) % 100
    return "eval" if h < 10 else "dev" if h < 20 else "train"


def read_csv(p: Path) -> list[dict]:
    with p.open(encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((REVIEW / "non_ecommerce_taxonomy_split_manifest.json").read_text(encoding="utf-8"))
    holdout = set(manifest["clause_ids"]["holdout"])

    coding: dict[str, str] = {}
    corrected = []
    for l in (REVIEW / "evasion_pattern_examples.jsonl").read_text(encoding="utf-8").splitlines():
        r = json.loads(l)
        if r["record_type"] == "problem_clause":
            coding[r["clause_id"]] = {"예": "unfair", "아니오": "illegal", "불확실": "dispute"}.get(r["evasion_label"], "drop")
        else:
            corrected.append(r)
    for l in (REVIEW / "non_ecommerce_discovery_coding_v1.jsonl").read_text(encoding="utf-8").splitlines():
        r = json.loads(l)
        coding[r["clause_id"]] = {"YES": "unfair", "NO": "illegal", "UNC": "dispute", "UNCERTAIN": "dispute"}.get(r["decision"], "drop")

    cases = {c["case_id"]: c for c in read_csv(V1 / "unfair_cases/source/cases.csv")}
    ftc_names = {c["company_or_platform"] for c in cases.values()}
    terms = [json.loads(l) for l in (V1 / "actual_terms/structured/terms_clauses.jsonl").read_text(encoding="utf-8").splitlines()]
    term_names = {t["platform"] for t in terms} | {t["operator"] for t in terms}
    names = {n for n in ftc_names | term_names if n}

    rows, drops = [], Counter()
    # ---- 양성: 공정위 official 문제조항
    for r in read_csv(V1 / "unfair_cases/source/case_clauses.csv"):
        cid = r["clause_id"]
        if r["label_status"] != "official":
            drops["ftc_not_official"] += 1; continue
        if cid in holdout:
            drops["ftc_holdout_sealed"] += 1; continue
        if not r["problem_clause"].strip() or r["problem_clause_type"] in ("described", "none"):
            drops["ftc_no_verbatim"] += 1; continue
        cat = coding.get(cid, "missing")
        if cat in ("drop", "missing"):
            drops[f"ftc_coding_{cat}"] += 1; continue
        case = cases.get(r["case_id"], {})
        laws = laws_of(r["legal_basis"], r["violation_basis"], r["article_paragraph_item"]) or [LAWS["약관법"]]
        rows.append({
            "id": cid, "doc_id": r["case_id"], "group": r["case_id"], "source": "ftc",
            "contract_type": INDUSTRY_MAP.get(case.get("industry", ""), "ecommerce"),
            "title": "", "text": deid(normalize(r["problem_clause"]), names),
            "category": cat, "risk_type": RISK_MAP.get(r["issue_category"], "other"),
            "laws": laws, "origin": "real", "reviewed": True, "label_source": "official+coding_v1",
        })
    pos_grams = [grams(r["text"]) for r in rows]

    # ---- 음성: 공정위 시정 후 문구
    for r in corrected:
        if r.get("text_source") != "after_text" or not r.get("text", "").strip():
            drops["corrected_not_after_text"] += 1; continue
        rows.append({
            "id": f"{r['anchor_clause_id']}-after-{r['pattern_id']}", "doc_id": r["case_id"], "group": r["case_id"],
            "source": "ftc_corrected", "contract_type": INDUSTRY_MAP.get(cases.get(r["case_id"], {}).get("industry", ""), "ecommerce"),
            "title": "", "text": deid(normalize(r["text"]), names), "category": "normal", "risk_type": None, "laws": [],
            "origin": "real", "reviewed": False, "label_source": "weak:ftc_after_text",
        })

    # ---- 음성: 실제 약관 조항 (약한 라벨)
    seen: set[str] = set()
    for t in terms:
        text = deid(normalize(t["clause_text"]), names)
        key = hashlib.sha256(re.sub(r"\s+", "", text).encode()).hexdigest()
        if len(text) < 20:
            drops["terms_too_short"] += 1; continue
        if key in seen:
            drops["terms_duplicate_text"] += 1; continue
        seen.add(key)
        g = grams(text)
        if g and any(len(g & p) / min(len(g), len(p) or 1) >= 0.5 for p in pos_grams if p):
            drops["terms_near_ftc_positive"] += 1; continue
        rows.append({
            "id": t["clause_id"], "doc_id": t["doc_id"], "group": f"platform:{t['platform']}", "source": "terms",
            "contract_type": TERMS_TYPE_MAP.get(t["terms_type"], "ecommerce"),
            "title": "", "text": text, "category": "normal", "risk_type": None, "laws": [],
            "origin": "real", "reviewed": False, "label_source": "weak:actual_terms_assumed_normal",
        })

    # ---- 음성: 표준약관 조문 (v2)
    for r in read_csv(V2 / "master/admin_rule_articles_master.csv"):
        text = deid(normalize(r["조항원문"]), names)
        if len(text) < 20:
            drops["std_too_short"] += 1; continue
        rows.append({
            "id": r["데이터ID"], "doc_id": r["원본문서ID"], "group": f"admrul:{r['원본문서ID']}", "source": "standard_terms",
            "contract_type": "ecommerce", "title": "", "text": text, "category": "normal", "risk_type": None, "laws": [],
            "origin": "real", "reviewed": False, "label_source": "weak:standard_terms",
        })

    for r in rows:
        r["split"] = split_of(r["group"])
    with (OUT / "clauses.jsonl").open("w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    sd = OUT / "split"
    sd.mkdir(exist_ok=True)
    for s in ("train", "dev", "eval"):
        with (sd / f"{s}.jsonl").open("w", encoding="utf-8") as f:
            for r in rows:
                if r["split"] == s:
                    f.write(json.dumps(r, ensure_ascii=False) + "\n")

    report = {
        "version": "baseline_v0", "rows": len(rows), "drops": dict(drops),
        "by_split_source_category": {s: dict(Counter(f"{r['source']}/{r['category']}" for r in rows if r["split"] == s))
                                     for s in ("train", "dev", "eval")},
        "risk_type": dict(Counter(r["risk_type"] for r in rows if r["risk_type"])),
        "laws": dict(Counter(l for r in rows for l in r["laws"])),
        "contract_type": dict(Counter(r["contract_type"] for r in rows)),
    }
    (OUT / "build_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
