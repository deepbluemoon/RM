"""analysis_template_v1.md + evasion_pattern_candidates.json → dataset_work/review/evasion_pattern_analysis.md"""
import json, re
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parents[2] / "dataset_work" / "review"
cand = json.loads((OUT / "evasion_pattern_candidates.json").read_text(encoding="utf-8"))
recs = [json.loads(l) for l in (OUT / "evasion_pattern_examples.jsonl").read_text(encoding="utf-8").splitlines()]
clauses = {r["clause_id"]: r for r in recs if r["record_type"] == "problem_clause"}
st = cand["stats"]
P = cand["patterns"]


def table(header, rows):
    out = ["| " + " | ".join(header) + " |", "|" + "---|" * len(header)]
    out += ["| " + " | ".join(str(c) for c in r) + " |" for r in rows]
    return "\n".join(out)


def clip(s, n=90):
    s = re.sub(r"\s+", " ", s).replace("|", "/")
    return s if len(s) <= n else s[:n] + "…"


def pattern_section(p):
    lines = [f"### {p['pattern_id']} {p['pattern_name']}", "",
             f"- **정의**: {p['definition']}",
             f"- **작동 구조**: {p['mechanism']}",
             "- **예로 볼 수 있는 최소 조건**(모두 충족):"]
    lines += [f"  {i}. {c}" for i, c in enumerate(p["min_yes"], 1)]
    lines += [f"- **직접 금지와의 차이**: {p['vs_direct']}", "- **아니오가 되는 반례**:"]
    lines += [f"  - {c}" for c in p["no_cases"]]
    refs = p["counterexamples"]
    if refs:
        lines.append("  - 근거 문구(공정위 시정 후 문구·판단 이유):")
        lines += [f"    - [{r['kind']}] `{r['anchor_clause_id']}` — {r['note']}" for r in refs]
    else:
        lines.append("  - 현재 데이터에서 확인되지 않음.")
    lines.append("- **불확실로 남길 경우**:")
    lines += [f"  - {c}" for c in p["uncertain_cases"]]
    if p.get("note"):
        lines.append(f"- **메모**: {p['note']}")
    co = ", ".join(f"{k} {v}" for k, v in p["co_risk_issue_category_yes"].items()) or "없음"
    lines += [f"- **함께 나타나는 위험유형**(예 조항의 issue_category): {co}",
              f"- **근거 규모**: 예 {p['yes_clause_count']}조항 / {p['yes_case_count']}사건, 불확실 {p['uncertain_clause_count']}조항 / {p['uncertain_case_count']}사건",
              f"- **FTC case_id(예)**: {', '.join(p['yes_case_ids']) or '없음'}",
              f"- **clause_id(예)**: {', '.join(p['yes_clause_ids']) or '없음'}",
              f"- **clause_id(불확실)**: {', '.join(p['uncertain_clause_ids']) or '없음'}",
              "- **대표 근거**(사건별 1개, 최대 5개):", ""]
    seen, rows = set(), []
    for e in p["evidence_yes"]:
        if e["case_id"] in seen:
            continue
        seen.add(e["case_id"])
        loc = e["ftc_basis_location"]
        rows.append([f"`{e['clause_id']}`", e["company_or_platform"] or "(미기재)",
                     clip(clauses[e["clause_id"]]["clause_text"]), clip(e["why"], 80),
                     f"{loc['source_document']} / {loc['source_section']} / {loc['evidence_line']}"])
        if len(rows) == 5:
            break
    lines.append(table(["clause_id", "사업자", "조항(발췌)", "이 패턴으로 본 이유", "공정위 근거 위치"], rows) if rows else "없음")
    return "\n".join(lines) + "\n"


lab = st["label_counts"]
over = table(["패턴", "핵심 구조", "예 조항", "예 사건", "불확실 조항", "반례/경계 참조"],
             [[p["pattern_id"] + " " + p["pattern_name"], clip(p["mechanism"], 70), p["yes_clause_count"], p["yes_case_count"],
               p["uncertain_clause_count"],
               f"{sum(r['kind']=='반례' for r in p['counterexamples'])}/{sum(r['kind']=='경계' for r in p['counterexamples'])}"] for p in P])
overlap = table(["조합", "예 조항 수"], [[k, v] for k, v in st["pattern_overlap_yes"].items()])
direct = table(["직접형 유형", "설명", "조항 수"],
               [[k, cand["direct_types"][k], v] for k, v in st["direct_type_counts_among_no"].items()])
catrows = []
for k, v in st["issue_category_x_label"].items():
    pats = st["issue_category_x_pattern"].get(k, {})
    top = ", ".join(f"{pk}({n})" for pk, n in list(pats.items())[:6]) or "-"
    catrows.append([k, sum(v.values()), v.get("예", 0), v.get("불확실", 0), v.get("아니오", 0), v.get("제외", 0), top])
cat = table(["issue_category", "조항", "예", "불확실", "아니오", "제외", "주요 패턴(판정)"], catrows)
ref = st["full_ftc_reference"]
noneco = table(["issue_category", "조항 수"], [[k, v] for k, v in ref["non_ecommerce_issue_category"].items()])
yes = [c for c in clauses.values() if c["evasion_label"] == "예"]
excl_impact = sum(1 for c in yes if set(c["patterns"]) <= {"EP07", "EP09", "EP11"})
n_boundary = sum(1 for p in P for r in p["counterexamples"] if r["kind"] == "경계")

vals = {
    "N_CLAUSES": st["analyzed_official_clauses"], "N_CASES": st["analyzed_cases"], "N_PATTERNS": len(P),
    "L_YES": lab["예"], "L_NO": lab["아니오"], "L_UNC": lab["불확실"], "L_EXC": lab["제외"],
    "MULTI2": st["yes_clauses_by_pattern_count"].get("2", 0), "MULTI3": st["yes_clauses_by_pattern_count"].get("3", 0),
    "MIXED": st["yes_or_uncertain_with_direct_element"], "EXCL_IMPACT": excl_impact, "N_BOUNDARY": n_boundary,
    "ALL_OFFICIAL": ref["all_official"], "NON_ECO": ref["non_ecommerce_official_not_coded"],
    "NON_ECO_CASES": ref["non_ecommerce_cases"],
    "TABLE_OVERVIEW": over, "TABLE_OVERLAP": overlap, "TABLE_DIRECT": direct, "TABLE_CATEGORY": cat,
    "TABLE_NONECO": noneco, "PATTERN_SECTIONS": "\n".join(pattern_section(p) for p in P),
}
text = (HERE / "analysis_template_v1.md").read_text(encoding="utf-8")
for k, v in vals.items():
    text = text.replace("{{" + k + "}}", str(v))
left = re.findall(r"\{\{[A-Z0-9_]+\}\}", text)
if left:
    raise SystemExit(f"치환 안 된 자리표시자: {left}")
(OUT / "evasion_pattern_analysis.md").write_text(text, encoding="utf-8")
print("written", OUT / "evasion_pattern_analysis.md", len(text), "chars; excl_impact", excl_impact, "boundary", n_boundary)
