"""회피패턴 탐색 분석 v1 산출물 생성기(재현용).

입력(읽기 전용): data_source/v1/unfair_cases/{ecommerce,source}/*.csv, TRANSFER_MANIFEST.json
입력(분석자 코딩): coding_v1.txt, counterexamples_v1.txt, patterns_v1.py
출력: dataset_work/review/evasion_pattern_candidates.json, evasion_pattern_examples.jsonl, evasion_pattern_stats.json

실행: python3 tools/dataset_review/evasion_pattern_v1/build_v1.py
"""
import collections, csv, hashlib, itertools, json, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parents[2]
SRC = PROJECT / "data_source" / "v1"
OUT = PROJECT / "dataset_work" / "review"
sys.path.insert(0, str(HERE))
from patterns_v1 import BASE_CONCEPT, DIRECT_TYPES, PATTERNS  # noqa: E402

ECO = "unfair_cases/ecommerce/case_clauses_ecommerce_domain.csv"
ALL = "unfair_cases/source/case_clauses.csv"
LABELS = ["예", "아니오", "불확실", "제외"]
PIDS = [p["pattern_id"] for p in PATTERNS]


def rcsv(rel):
    with open(SRC / rel, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def verify_sources():
    """사용한 원천 파일이 TRANSFER_MANIFEST의 SHA-256과 같은지 확인한다(수정 여부 점검)."""
    man = json.loads((SRC / "TRANSFER_MANIFEST.json").read_text(encoding="utf-8"))
    listed = {f["package_path"]: f["sha256"] for f in man["files"]}
    out = {}
    for rel in (ECO, ALL, "unfair_cases/ecommerce/cases_ecommerce_domain.csv"):
        out[rel] = hashlib.sha256((SRC / rel).read_bytes()).hexdigest() == listed[rel]
    return out


def parse_coding(official_ids):
    coded = {}
    for n, line in enumerate((HERE / "coding_v1.txt").read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip() or line.startswith("#"):
            continue
        parts = [p.strip() for p in line.split("|")]
        if len(parts) != 6:
            sys.exit(f"coding_v1.txt:{n} 필드 수 {len(parts)}")
        case_id, sufs, label, pats, dtype, note = parts
        if label not in LABELS:
            sys.exit(f"coding_v1.txt:{n} 판정값 {label}")
        pats = [] if pats == "-" else [p.strip() for p in pats.split(",")]
        for p in pats:
            if p not in PIDS:
                sys.exit(f"coding_v1.txt:{n} 패턴 {p}")
        if label == "예" and not pats:
            sys.exit(f"coding_v1.txt:{n} '예'인데 패턴 없음")
        if dtype != "-" and dtype not in DIRECT_TYPES:
            sys.exit(f"coding_v1.txt:{n} 직접형 {dtype}")
        for s in sufs.split(","):
            cid = f"{case_id}-{s.strip()}"
            if cid not in official_ids:
                sys.exit(f"coding_v1.txt:{n} official 조항 아님: {cid}")
            if cid in coded:
                sys.exit(f"coding_v1.txt:{n} 중복 코딩: {cid}")
            coded[cid] = {"label": label, "patterns": pats,
                          "direct_type": None if dtype == "-" else dtype, "note": note, "line": n}
    missing = sorted(set(official_ids) - set(coded))
    if missing:
        sys.exit(f"코딩 누락 {len(missing)}: {missing[:5]}")
    return coded


def split_action(action):
    """action_or_outcome을 '시정 내용'과 '시정 후 약관조항'으로 나눈다."""
    key = "시정 후 약관조항:"
    if key in action:
        head, tail = action.split(key, 1)
        return head.rstrip("; ").strip(), tail.strip()
    return action.strip(), ""


def parse_counterexamples(rows_by_id):
    refs = []
    for n, line in enumerate((HERE / "counterexamples_v1.txt").read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip() or line.startswith("#"):
            continue
        pid, cid, kind, src, note = [p.strip() for p in line.split("|")]
        if pid not in PIDS or kind not in ("반례", "경계") or src not in ("after_text", "action", "reason"):
            sys.exit(f"counterexamples_v1.txt:{n} 값 오류")
        r = rows_by_id.get(cid) or sys.exit(f"counterexamples_v1.txt:{n} 없는 clause_id {cid}")
        head, after = split_action(r["action_or_outcome"])
        text = {"after_text": after, "action": head, "reason": r["official_reason"]}[src]
        if not text:
            sys.exit(f"counterexamples_v1.txt:{n} {cid}에 {src} 텍스트 없음")
        refs.append({"pattern_id": pid, "kind": kind, "anchor_clause_id": cid, "case_id": r["case_id"],
                     "company_or_platform": r["company_or_platform"], "text_source": src,
                     "text": text, "note": note, "evidence": location(r)})
    return refs


def location(r):
    return {"source_document": r["source_document"], "source_section": r["source_section"],
            "evidence_line": r["evidence_line"], "official_url": r["official_url"],
            "case_official_url": r.get("case_official_url", "")}


def main():
    src_ok = verify_sources()
    if not all(src_ok.values()):
        sys.exit(f"원천 파일 해시 불일치: {src_ok}")
    eco = rcsv(ECO)
    rows_by_id = {r["clause_id"]: r for r in eco}
    official = [r for r in eco if r["label_status"] == "official"]
    coded = parse_coding({r["clause_id"] for r in official})
    refs = parse_counterexamples(rows_by_id)

    # 조항 레코드
    examples = []
    for r in official:
        c = coded[r["clause_id"]]
        examples.append({
            "record_type": "problem_clause",
            "clause_id": r["clause_id"], "case_id": r["case_id"],
            "company_or_platform": r["company_or_platform"] or None, "case_title": r["case_title"],
            "ecommerce_category": r["ecommerce_category"], "terms_party": r["terms_party"],
            "issue_category": r["issue_category"], "issue_type": r["issue_type"],
            "evasion_label": c["label"], "patterns": c["patterns"],
            "direct_type": c["direct_type"], "direct_type_desc": DIRECT_TYPES.get(c["direct_type"]),
            "coding_note": c["note"],
            "clause_text": r["problem_clause"], "clause_text_type": r["problem_clause_type"],
            "ftc_basis": {**location(r), "violation_basis": r["violation_basis"],
                          "legal_citations_normalized": r["legal_citations_normalized"],
                          "official_reason_excerpt": r["official_reason"][:300]},
            "label_status_source": r["label_status"],
            "source_data": "data_source/v1 (Source Data v1.0.0)",
            "coding_version": "evasion_pattern_v1",
        })
    for ref in refs:
        examples.append({"record_type": "ftc_corrected_reference", **ref,
                         "caveat": "공정위가 해당 사건 시정 과정에서 수용한 문구 또는 판단 이유이며 일반적 적법 판정이 아님",
                         "source_data": "data_source/v1 (Source Data v1.0.0)", "coding_version": "evasion_pattern_v1"})

    # 통계
    lab = collections.Counter(c["label"] for c in coded.values())
    per_pattern = {}
    for pid in PIDS:
        yes = [e for e in examples if e["record_type"] == "problem_clause" and e["evasion_label"] == "예" and pid in e["patterns"]]
        unc = [e for e in examples if e["record_type"] == "problem_clause" and e["evasion_label"] == "불확실" and pid in e["patterns"]]
        per_pattern[pid] = {
            "yes_clause_count": len(yes), "yes_case_count": len({e["case_id"] for e in yes}),
            "uncertain_clause_count": len(unc), "uncertain_case_count": len({e["case_id"] for e in unc}),
            "yes_clause_ids": [e["clause_id"] for e in yes], "yes_case_ids": sorted({e["case_id"] for e in yes}),
            "uncertain_clause_ids": [e["clause_id"] for e in unc],
            "co_risk_issue_category_yes": dict(collections.Counter(e["issue_category"] for e in yes).most_common()),
            "terms_party_yes": dict(collections.Counter(e["terms_party"] for e in yes).most_common()),
            "evidence_yes": [{"clause_id": e["clause_id"], "case_id": e["case_id"],
                              "company_or_platform": e["company_or_platform"], "issue_category": e["issue_category"],
                              "why": e["coding_note"], "ftc_basis_location": {k: e["ftc_basis"][k] for k in
                              ("source_document", "source_section", "evidence_line", "official_url")},
                              "violation_basis": e["ftc_basis"]["violation_basis"]} for e in yes],
            "counterexamples": [x for x in refs if x["pattern_id"] == pid],
        }
    yes_rows = [e for e in examples if e["record_type"] == "problem_clause" and e["evasion_label"] == "예"]
    overlap = {f"{a}+{b}": n for (a, b), n in collections.Counter(
        pair for e in yes_rows for pair in itertools.combinations(sorted(e["patterns"]), 2)).most_common()}
    npat = collections.Counter(len(e["patterns"]) for e in yes_rows)
    cat_label = collections.defaultdict(collections.Counter)
    cat_pattern = collections.defaultdict(collections.Counter)
    for e in examples:
        if e["record_type"] != "problem_clause":
            continue
        cat_label[e["issue_category"]][e["evasion_label"]] += 1
        if e["evasion_label"] in ("예", "불확실"):
            for p in e["patterns"]:
                cat_pattern[e["issue_category"]][f"{p}:{e['evasion_label']}"] += 1
    direct = collections.Counter(e["direct_type"] for e in examples
                                 if e["record_type"] == "problem_clause" and e["evasion_label"] == "아니오")
    mixed = sum(1 for e in examples if e["record_type"] == "problem_clause"
                and e["evasion_label"] in ("예", "불확실") and e["direct_type"])

    # 전체 공정위 사례(참고, 코딩하지 않음)
    allrows = rcsv(ALL)
    eco_ids = {r["clause_id"] for r in official}
    non_eco = [r for r in allrows if r["label_status"] == "official" and r["clause_id"] not in eco_ids]
    reference = {
        "all_official": sum(1 for r in allrows if r["label_status"] == "official"),
        "ecommerce_official_analyzed": len(official),
        "non_ecommerce_official_not_coded": len(non_eco),
        "non_ecommerce_cases": len({r["case_id"] for r in non_eco}),
        "non_ecommerce_issue_category": dict(collections.Counter(r["issue_category"] for r in non_eco).most_common()),
        "note": "전체 사례의 비전자상거래 official 조항은 이번 코딩 대상이 아니며 규모만 기록한다.",
    }
    stats = {
        "analyzed_official_clauses": len(official), "analyzed_cases": len({r["case_id"] for r in official}),
        "ecommerce_domain_cases_total": len(rcsv("unfair_cases/ecommerce/cases_ecommerce_domain.csv")),
        "label_counts": {k: lab.get(k, 0) for k in LABELS},
        "yes_clauses_by_pattern_count": dict(sorted(npat.items())),
        "pattern_overlap_yes": overlap,
        "per_pattern_counts": {pid: {k: v for k, v in per_pattern[pid].items() if k.endswith("_count")} for pid in PIDS},
        "issue_category_x_label": {k: dict(v) for k, v in sorted(cat_label.items(), key=lambda x: -sum(x[1].values()))},
        "issue_category_x_pattern": {k: dict(v.most_common()) for k, v in cat_pattern.items()},
        "direct_type_counts_among_no": dict(direct.most_common()),
        "yes_or_uncertain_with_direct_element": mixed,
        "counterexample_refs": dict(collections.Counter((x["pattern_id"], x["kind"]) for x in refs).most_common()) and
            {f"{p}:{k}": n for (p, k), n in collections.Counter((x["pattern_id"], x["kind"]) for x in refs).items()},
        "data_quality_excluded": [cid for cid, c in coded.items() if c["label"] == "제외"],
        "source_files_hash_match": src_ok,
        "full_ftc_reference": reference,
    }

    candidates = {
        "version": "evasion_pattern_v1", "created": "2026-09-28",
        "status": "탐색 분석 결과(라벨링 기준 초안). 사람 검토 전.",
        "source_data": "data_source/v1 (Source Data v1.0.0), unfair_cases/ecommerce official 조항",
        "base_concept": BASE_CONCEPT,
        "label_values": {"예": "패턴의 최소 조건을 문언만으로 모두 충족", "아니오": "회피 구조 없음(직접형 불공정 조항 포함)",
                         "불확실": "장치는 있으나 부담 정도·필요성·공정위 판단 흔들림 때문에 판단 보류",
                         "제외": "조항 텍스트가 아님(데이터 품질 문제)"},
        "direct_types": DIRECT_TYPES,
        "patterns": [{**p, **per_pattern[p["pattern_id"]]} for p in PATTERNS],
        "stats": stats,
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "evasion_pattern_candidates.json").write_text(json.dumps(candidates, ensure_ascii=False, indent=1), encoding="utf-8")
    with open(OUT / "evasion_pattern_examples.jsonl", "w", encoding="utf-8") as f:
        for e in examples:
            f.write(json.dumps(e, ensure_ascii=False) + "\n")
    (OUT / "evasion_pattern_stats.json").write_text(json.dumps(stats, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({k: stats[k] for k in ("analyzed_official_clauses", "analyzed_cases", "label_counts",
                      "yes_clauses_by_pattern_count", "per_pattern_counts", "pattern_overlap_yes",
                      "direct_type_counts_among_no", "yes_or_uncertain_with_direct_element",
                      "counterexample_refs", "data_quality_excluded", "source_files_hash_match")},
                     ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
