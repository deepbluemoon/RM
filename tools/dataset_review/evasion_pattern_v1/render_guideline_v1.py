"""guideline_template_v1.md + evasion_pattern_taxonomy_v1.json → dataset_work/review/evasion_labeling_guideline_v1.md"""
import json, re
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parents[2] / "dataset_work" / "review"
tax = json.loads((OUT / "evasion_pattern_taxonomy_v1.json").read_text(encoding="utf-8"))
st = tax["preview"]
ex = [json.loads(l) for l in (OUT / "evasion_decision_examples_v1.jsonl").read_text(encoding="utf-8").splitlines()]
n_ex = sum(e["record_type"] == "decision_example" for e in ex)
n_override = sum(1 for l in (HERE / "preview_overrides_v1.txt").read_text(encoding="utf-8").splitlines()
                 if l.strip() and not l.startswith("#"))


def table(h, rows):
    return "\n".join(["| " + " | ".join(h) + " |", "|" + "---|" * len(h)] +
                     ["| " + " | ".join(str(c) for c in r) + " |" for r in rows])


def ids(lst, n=8):
    return ", ".join(f"`{x}`" for x in lst[:n]) + (f" 외 {len(lst) - n}건" if len(lst) > n else "") if lst else "없음"


def ep_section(p):
    L = [f"### {p['pattern_id']} {p['pattern_name']} — 분류 {p['class']}", "",
         f"- **정의**: {p['definition']}",
         f"- **구조**: S {p['structure']['S']} → M {p['structure']['M']} → E {p['structure']['E']}",
         "- **YES 최소조건**:"] + [f"  {i}. {c}" for i, c in enumerate(p["yes_min"], 1)]
    L += ["- **NO 조건**:"] + [f"  - {c}" for c in p["no_conditions"]]
    L += ["- **UNCERTAIN 조건**:"] + [f"  - {c}" for c in p["uncertain_conditions"]]
    L += [f"- **직접형 위험과의 구분**: {p['vs_direct']} (대조 조항 `{p['direct_contrast_clause']}`)"]
    pe = p["positive_examples"]
    if p["class"] == "C":
        rf = p["risk_flag_examples"]
        L.append(f"- **실제 사례(위험 플래그 대상)**: {rf['count']}조항 — {ids(rf['clause_ids'])}")
    else:
        L.append(f"- **실제 positive 사례(미리보기 S1 YES)**: {pe['count_S1']}조항 / {pe['case_count_S1']}사건 — {ids(pe['clause_ids_S1'])}")
    for r in (pe["representative"] or (p["risk_flag_examples"] or {}).get("representative", []))[:3]:
        loc = r["ftc_basis_location"]
        L.append(f"  - `{r['clause_id']}` {r['company_or_platform'] or ''}: “{r['clause_excerpt'][:110].replace('|', '/')}…” — {r['why']} "
                 f"(공정위 근거: {loc['source_document']} / {loc['source_section']} / {loc['evidence_line']})")
    ce = p["counterexamples"]
    if isinstance(ce, list):
        L.append("- **확인된 반례**(공정위 시정 후 문구·판단 이유):")
        L += [f"  - `{r['anchor_clause_id']}` {r['note']}" for r in ce]
    else:
        L.append(f"- **확인된 반례**: {ce}")
    b = p["boundary_cases"]
    L.append("- **경계 사례**:")
    if b["ftc_accepted_similar_structure"]:
        L += [f"  - [시정 후 같은 구조 수용] `{r['anchor_clause_id']}` {r['note']}" for r in b["ftc_accepted_similar_structure"]]
    if b["uncertain_clauses_S1"]:
        L += [f"  - [UNCERTAIN] `{r['clause_id']}` {r['why']}" for r in b["uncertain_clauses_S1"][:6]]
    if not b["ftc_accepted_similar_structure"] and not b["uncertain_clauses_S1"]:
        L.append("  - 현재 데이터에서 확인되지 않음")
    cats = ", ".join(f"{k} {v}" for k, v in p["related_issue_category"].items()) or "없음"
    cov = p["coverage"]
    L += [f"- **관련 issue_category**: {cats}",
          f"- **현재 확인된 적용 범위**: S1 YES {cov['S1_yes']} · S2 YES {cov['S2_yes']} · S1 UNCERTAIN {cov['S1_uncertain']}; "
          f"이용자 구분 {cov['terms_party']}; 업종 {cov['ecommerce_category']}. {cov['scope_note']}",
          "- **아직 결정이 필요한 쟁점**:"] + [f"  - {q}" for q in p["open_issues"]]
    return "\n".join(L) + "\n"


cls = lambda c: ", ".join(f"{p['pattern_id']} {p['pattern_name']}" for p in tax["patterns"] if p["class"] == c)
lab = ["YES", "NO", "UNCERTAIN", "EXCLUDED"]
preview = table(["", "YES", "NO", "UNCERTAIN", "EXCLUDED"],
                [["탐색 판정(예/아니오/불확실/제외)"] + [st["prior_counts"][k] for k in lab],
                 ["기준 v1 — S1"] + [st["S1_counts"][k] for k in lab],
                 ["기준 v1 — S2"] + [st["S2_counts"][k] for k in lab]])
keys = sorted(set(st["S1_transitions"]) | set(st["S2_transitions"]))
trans = table(["경로", "S1", "S2"], [[k, st["S1_transitions"].get(k, 0), st["S2_transitions"].get(k, 0)] for k in keys])
per = table(["패턴", "분류", "탐색 예", "탐색 불확실", "S1 YES", "S1 UNC", "S2 YES", "S2 UNC", "위험 플래그 조항"],
            [[pid, r["class"], r["prior_yes"], r["prior_uncertain"], r["S1_yes"], r["S1_uncertain"], r["S2_yes"],
              r["S2_uncertain"], r.get("risk_flag_clauses", "-")] for pid, r in st["per_pattern"].items()])
vals = {
    "N_EX": n_ex, "CLASS_A": cls("A"), "CLASS_B": cls("B"), "CLASS_C": cls("C"),
    "EP_SECTIONS": "\n".join(ep_section(p) for p in tax["patterns"]),
    "EP09_WITH": st["per_pattern"]["EP09"]["flag_with_AB_yes_S1"],
    "RESPLIT": st["resplit_candidates"], "RESPLIT_MIXED": st["resplit_mixed"],
    "TABLE_PREVIEW": preview, "TABLE_TRANS": trans, "TABLE_PER_EP": per,
    "YES_TO_NO": st["S1_transitions"].get("YES→NO", 0), "YES_TO_UNC_S1": st["S1_transitions"].get("YES→UNCERTAIN", 0),
    "YES_TO_UNC_S2": st["S2_transitions"].get("YES→UNCERTAIN", 0), "UNC_TO_NO": st["S1_transitions"].get("UNCERTAIN→NO", 0),
    "YES_CASES_S1": st["yes_cases_S1"], "YES_CASES_S2": st["yes_cases_S2"], "N_OVERRIDE": n_override,
    "S1_YES": st["S1_counts"]["YES"], "S2_YES": st["S2_counts"]["YES"],
    "SELLER_YES": st["S1_yes_by_party"].get("seller_partner", 0),
}
text = (HERE / "guideline_template_v1.md").read_text(encoding="utf-8")
for k, v in vals.items():
    text = text.replace("{{" + k + "}}", str(v))
left = re.findall(r"\{\{[A-Z0-9_]+\}\}", text)
if left:
    raise SystemExit(f"치환 안 된 자리표시자: {left}")
(OUT / "evasion_labeling_guideline_v1.md").write_text(text, encoding="utf-8")
print("written", len(text), "chars")
