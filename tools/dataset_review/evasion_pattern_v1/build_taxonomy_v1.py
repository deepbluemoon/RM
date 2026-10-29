"""회피패턴 기준 v1 산출물 생성기(재현용). 탐색 결과를 읽기만 하고 덮어쓰지 않는다.

입력(읽기 전용): dataset_work/review/evasion_pattern_examples.jsonl (탐색 코딩·공정위 시정 후 참조)
입력(기준): taxonomy_v1.py, preview_overrides_v1.txt
출력(새 파일): dataset_work/review/evasion_pattern_taxonomy_v1.json, evasion_decision_examples_v1.jsonl, evasion_preview_v1_stats.json

실행: python3 tools/dataset_review/evasion_pattern_v1/build_taxonomy_v1.py
"""
import collections, hashlib, json, re, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parents[2] / "dataset_work" / "review"
sys.path.insert(0, str(HERE))
from taxonomy_v1 import BASE_DEFINITION, C_RISK_FLAGS, LABELS, MIXED_RULE, TAXONOMY  # noqa: E402
from patterns_v1 import DIRECT_TYPES  # noqa: E402

EXPLORE = OUT / "evasion_pattern_examples.jsonl"
CLS = {t["pattern_id"]: t["class"] for t in TAXONOMY}
AB = {p for p, c in CLS.items() if c in "AB"}
PRIOR = {"예": "YES", "아니오": "NO", "불확실": "UNCERTAIN", "제외": "EXCLUDED"}
ITEM = re.compile(r"[①-⑳]|(?:^|\s|/)\d{1,2}[.)]\s|(?:^|\s|/)[가-하][.)]\s|(?:^|\s)-\s")


def load_overrides():
    ov = {}
    for n, line in enumerate((HERE / "preview_overrides_v1.txt").read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip() or line.startswith("#"):
            continue
        cid, s1, s2, pats, why = [p.strip() for p in line.split("|")]
        if s1 not in ("YES", "NO", "UNCERTAIN") or s2 not in ("YES", "NO", "UNCERTAIN"):
            sys.exit(f"preview_overrides_v1.txt:{n} 판정값")
        if cid in ov:
            sys.exit(f"preview_overrides_v1.txt:{n} 중복 {cid}")
        ov[cid] = {"s1": s1, "s2": s2, "pats": pats, "why": why}
    return ov


def main():
    digest_before = hashlib.sha256(EXPLORE.read_bytes()).hexdigest()
    recs = [json.loads(l) for l in EXPLORE.read_text(encoding="utf-8").splitlines()]
    clauses = [r for r in recs if r["record_type"] == "problem_clause"]
    refs = [r for r in recs if r["record_type"] == "ftc_corrected_reference"]
    ids = {c["clause_id"] for c in clauses}
    ov = load_overrides()
    unknown = set(ov) - ids
    if unknown:
        sys.exit(f"overrides에 없는 clause_id: {unknown}")

    preview = []
    for c in clauses:
        prior = PRIOR[c["evasion_label"]]
        ab = [p for p in c["patterns"] if p in AB]
        flags = [C_RISK_FLAGS[p] for p in c["patterns"] if p in C_RISK_FLAGS]
        o = ov.get(c["clause_id"])
        if prior == "EXCLUDED":
            s1 = s2 = "EXCLUDED"; why = "조항 텍스트 아님(데이터 품질) — 판정 대상 제외"; applied = []
        elif o:
            s1, s2, why = o["s1"], o["s2"], o["why"]
            applied = ab if o["pats"] == "=" else ([] if o["pats"] == "-" else o["pats"].split(","))
        elif not ab:
            s1 = s2 = "NO"; applied = []
            why = ("C 패턴만 있음 → 위험 플래그로만 기록" if c["patterns"] else "직접형 — 회피 구조 없음")
        else:
            s1 = s2 = prior; applied = ab
            why = "A·B 패턴 조건 충족(탐색 판정 유지)" if prior == "YES" else "탐색 단계 불확실 사유 유지"
        text = c["clause_text"]
        items = len(ITEM.findall(text))
        resplit = []
        if c["direct_type"] and s1 in ("YES", "UNCERTAIN"):
            resplit.append("혼합형(직접형 요소와 회피 장치가 한 조항에 있음)")
        if items >= 2 and (applied or flags):
            resplit.append(f"항·호 표지 {items}개")
        preview.append({
            "record_type": "preview_application", "clause_id": c["clause_id"], "case_id": c["case_id"],
            "issue_category": c["issue_category"], "terms_party": c["terms_party"],
            "ecommerce_category": c["ecommerce_category"],
            "prior_label": prior, "prior_patterns": c["patterns"],
            "preview_label_S1": s1, "preview_label_S2": s2,
            "applied_patterns": applied, "supporting_or_flags": flags,
            "changed_S1": s1 != prior, "changed_S2": s2 != prior, "change_reason": why,
            "evasion_part": c["coding_note"] if applied else None,
            "direct_part": ({"direct_type": c["direct_type"], "desc": DIRECT_TYPES[c["direct_type"]]}
                            if c["direct_type"] else None),
            "resplit_candidate": bool(resplit), "resplit_reason": resplit,
            "source": "evasion_pattern_examples.jsonl(탐색 v1) 재적용 미리보기 — 탐색 판정을 덮어쓰지 않음",
        })

    # 집계
    labels = ["YES", "NO", "UNCERTAIN", "EXCLUDED"]
    cnt = lambda key: {k: sum(p[key] == k for p in preview) for k in labels}
    trans = lambda key: {f"{a}→{b}": n for (a, b), n in sorted(collections.Counter(
        (p["prior_label"], p[key]) for p in preview).items())}
    per_ep = {}
    for t in TAXONOMY:
        pid = t["pattern_id"]
        row = {"class": t["class"],
               "prior_yes": sum(pid in p["prior_patterns"] and p["prior_label"] == "YES" for p in preview),
               "prior_uncertain": sum(pid in p["prior_patterns"] and p["prior_label"] == "UNCERTAIN" for p in preview)}
        for s in ("S1", "S2"):
            row[f"{s}_yes"] = sum(pid in p["applied_patterns"] and p[f"preview_label_{s}"] == "YES" for p in preview)
            row[f"{s}_uncertain"] = sum(pid in p["applied_patterns"] and p[f"preview_label_{s}"] == "UNCERTAIN" for p in preview)
        if pid in C_RISK_FLAGS:
            row["risk_flag_clauses"] = sum(C_RISK_FLAGS[pid] in p["supporting_or_flags"] for p in preview)
            row["flag_with_AB_yes_S1"] = sum(C_RISK_FLAGS[pid] in p["supporting_or_flags"] and p["preview_label_S1"] == "YES" for p in preview)
        per_ep[pid] = row
    stats = {
        "note": "기준 v1을 탐색 판정 455개에 다시 적용한 미리보기. 탐색 결과 파일은 수정하지 않았다.",
        "scenarios": {"S1": "법정 기준표를 판정 기준으로 채택", "S2": "법정 기준표 미채택(외부 기준 비교 의존 조항은 UNCERTAIN)"},
        "prior_counts": {k: sum(p["prior_label"] == k for p in preview) for k in labels},
        "S1_counts": cnt("preview_label_S1"), "S2_counts": cnt("preview_label_S2"),
        "S1_transitions": trans("preview_label_S1"), "S2_transitions": trans("preview_label_S2"),
        "S1_change_reasons": dict(collections.Counter(p["change_reason"].split(" — ")[0] for p in preview if p["changed_S1"]).most_common()),
        "per_pattern": per_ep,
        "resplit_candidates": sum(p["resplit_candidate"] for p in preview),
        "resplit_mixed": sum(any(r.startswith("혼합형") for r in p["resplit_reason"]) for p in preview),
        "yes_cases_S1": len({p["case_id"] for p in preview if p["preview_label_S1"] == "YES"}),
        "yes_cases_S2": len({p["case_id"] for p in preview if p["preview_label_S2"] == "YES"}),
        "S1_yes_by_party": dict(collections.Counter(p["terms_party"] for p in preview if p["preview_label_S1"] == "YES")),
        "upgrade_candidates_not_counted": [{"clause_id": "FTC-2020-01-15-41373-S04-1",
            "why": "청구권 포기 + ‘소비자 보호 권리를 제한하지 않습니다’ 보장 문구 — 유보 문구를 S로 볼지 결정되면 NO→UNCERTAIN 가능"}],
    }

    # 택소노미 JSON
    by_id = {p["clause_id"]: p for p in preview}
    ctext = {c["clause_id"]: c for c in clauses}
    tax = []
    for t in TAXONOMY:
        pid = t["pattern_id"]
        pos = [p for p in preview if pid in p["applied_patterns"] and p["preview_label_S1"] == "YES"]
        unc = [p for p in preview if pid in p["applied_patterns"] and p["preview_label_S1"] == "UNCERTAIN"]
        flagged = [p for p in preview if C_RISK_FLAGS.get(pid) in p["supporting_or_flags"]] if pid in C_RISK_FLAGS else []
        base_pool = pos if pos else flagged
        rep, seen = [], set()
        for p in base_pool:
            if p["case_id"] in seen:
                continue
            seen.add(p["case_id"])
            c = ctext[p["clause_id"]]
            rep.append({"clause_id": p["clause_id"], "company_or_platform": c["company_or_platform"],
                        "clause_excerpt": re.sub(r"\s+", " ", c["clause_text"])[:160],
                        "why": c["coding_note"], "preview_label_S1": p["preview_label_S1"],
                        "ftc_basis_location": {k: c["ftc_basis"][k] for k in ("source_document", "source_section", "evidence_line", "official_url")}})
            if len(rep) == 5:
                break
        cats = collections.Counter(ctext[p["clause_id"]]["issue_category"] for p in (pos + unc + flagged))
        tax.append({
            **t,
            "positive_examples": {"count_S1": len(pos), "case_count_S1": len({p["case_id"] for p in pos}),
                                  "clause_ids_S1": [p["clause_id"] for p in pos], "representative": rep if pos else []},
            "risk_flag_examples": ({"count": len(flagged), "clause_ids": [p["clause_id"] for p in flagged],
                                    "representative": rep} if pid in C_RISK_FLAGS else None),
            "counterexamples": [{"anchor_clause_id": r["anchor_clause_id"], "text_source": r["text_source"],
                                 "note": r["note"], "text_excerpt": re.sub(r"\s+", " ", r["text"])[:200]}
                                for r in refs if r["pattern_id"] == pid and r["kind"] == "반례"] or "현재 데이터에서 확인되지 않음",
            "boundary_cases": {
                "ftc_accepted_similar_structure": [{"anchor_clause_id": r["anchor_clause_id"], "note": r["note"]}
                                                   for r in refs if r["pattern_id"] == pid and r["kind"] == "경계"],
                "uncertain_clauses_S1": [{"clause_id": p["clause_id"], "why": p["change_reason"] if p["changed_S1"] else ctext[p["clause_id"]]["coding_note"]} for p in unc],
            },
            "related_issue_category": dict(cats.most_common()),
            "coverage": {"S1_yes": len(pos), "S2_yes": sum(pid in p["applied_patterns"] and p["preview_label_S2"] == "YES" for p in preview),
                         "S1_uncertain": len(unc),
                         "terms_party": dict(collections.Counter(p["terms_party"] for p in (pos or flagged))),
                         "ecommerce_category": dict(collections.Counter(p["ecommerce_category"] for p in (pos or flagged))),
                         "scope_note": "전자상거래 도메인 official 조항 455개에서만 확인. 비전자상거래·실제 약관 미적용."},
        })
    taxonomy = {
        "version": "evasion_taxonomy_v1", "created": "2026-09-28",
        "status": "회피패턴 기준 v1(확정안). 라벨링 적용 전 사람 결정 쟁점이 남아 있음(open_issues).",
        "basis": "evasion_pattern_v1 탐색 결과(전자상거래 official 455개, 35사건) 재정리. 비전자상거래 479개·실제 약관 2,752개 미사용.",
        "base_definition": BASE_DEFINITION,
        "structure_test": "표면적 권리·보장·선택(S) → 제한 장치(M) → 실질적 효과 약화(E), S와 M의 연결(L) 확인",
        "labels": LABELS, "mixed_rule": MIXED_RULE,
        "class_definitions": {"A": "구조 자체가 회피패턴의 강한 지표", "B": "특정 조건을 만족할 때만 회피패턴",
                              "C": "위험 유형이지만 회피패턴과 별도 관리(단독으로 YES 불가, 위험 플래그)"},
        "c_risk_flags": C_RISK_FLAGS, "direct_types": DIRECT_TYPES,
        "patterns": tax, "preview": stats,
    }
    (OUT / "evasion_pattern_taxonomy_v1.json").write_text(json.dumps(taxonomy, ensure_ascii=False, indent=1), encoding="utf-8")
    (OUT / "evasion_preview_v1_stats.json").write_text(json.dumps(stats, ensure_ascii=False, indent=1), encoding="utf-8")

    # 판정 예시 JSONL: EP별 선별 예시 + 455개 미리보기
    ex = []
    for t in tax:
        pid = t["pattern_id"]
        for r in t["positive_examples"]["representative"][:3]:
            ex.append({"record_type": "decision_example", "pattern_id": pid, "class": t["class"], "example_type": "positive",
                       "decision": "YES", "clause_id": r["clause_id"], "text": r["clause_excerpt"], "text_source": "problem_clause",
                       "reasoning": r["why"], "ftc_basis_location": r["ftc_basis_location"]})
        if t["risk_flag_examples"]:
            for r in t["risk_flag_examples"]["representative"][:3]:
                ex.append({"record_type": "decision_example", "pattern_id": pid, "class": "C", "example_type": "risk_flag_only",
                           "decision": by_id[r["clause_id"]]["preview_label_S1"], "clause_id": r["clause_id"],
                           "text": r["clause_excerpt"], "text_source": "problem_clause",
                           "reasoning": f"{C_RISK_FLAGS[pid]} 기록. C 패턴 단독으로는 YES 아님"})
        dc = ctext[t["direct_contrast_clause"]]
        ex.append({"record_type": "decision_example", "pattern_id": pid, "class": t["class"], "example_type": "direct_contrast",
                   "decision": "NO", "clause_id": dc["clause_id"], "text": re.sub(r"\s+", " ", dc["clause_text"])[:160],
                   "text_source": "problem_clause", "reasoning": f"직접형({dc['direct_type']}) — {t['vs_direct']}"})
        if isinstance(t["counterexamples"], list):
            for r in t["counterexamples"][:3]:
                ex.append({"record_type": "decision_example", "pattern_id": pid, "class": t["class"], "example_type": "counterexample",
                           "decision": "NO", "clause_id": r["anchor_clause_id"], "text": r["text_excerpt"],
                           "text_source": f"ftc_{r['text_source']}", "reasoning": r["note"],
                           "caveat": "공정위가 해당 사건 시정에서 수용한 문구·판단 이유이며 일반적 적법 판정이 아님"})
        for r in t["boundary_cases"]["ftc_accepted_similar_structure"][:2]:
            ex.append({"record_type": "decision_example", "pattern_id": pid, "class": t["class"], "example_type": "boundary_ftc",
                       "decision": "UNCERTAIN", "clause_id": r["anchor_clause_id"], "text_source": "ftc_after_text",
                       "reasoning": r["note"]})
        for r in t["boundary_cases"]["uncertain_clauses_S1"][:3]:
            ex.append({"record_type": "decision_example", "pattern_id": pid, "class": t["class"], "example_type": "uncertain",
                       "decision": "UNCERTAIN", "clause_id": r["clause_id"],
                       "text": re.sub(r"\s+", " ", ctext[r["clause_id"]]["clause_text"])[:160],
                       "text_source": "problem_clause", "reasoning": r["why"]})
    with open(OUT / "evasion_decision_examples_v1.jsonl", "w", encoding="utf-8") as f:
        for e in ex + preview:
            f.write(json.dumps(e, ensure_ascii=False) + "\n")

    if hashlib.sha256(EXPLORE.read_bytes()).hexdigest() != digest_before:
        sys.exit("탐색 결과 파일이 변경됨")
    print(json.dumps({k: stats[k] for k in ("prior_counts", "S1_counts", "S2_counts", "S1_transitions", "S2_transitions",
                      "S1_change_reasons", "per_pattern", "resplit_candidates", "resplit_mixed", "yes_cases_S1", "yes_cases_S2",
                      "S1_yes_by_party")}, ensure_ascii=False, indent=1), "\ndecision examples:", len(ex))


if __name__ == "__main__":
    main()
