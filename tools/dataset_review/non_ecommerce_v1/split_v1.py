"""비전자상거래 official 문제조항을 case_id 단위로 Discovery(~80%) / Holdout(~20%)로 나눈다.

- 사용하는 열은 메타데이터뿐이다(clause_id, case_id, label_status, issue_category, industry, domain).
  problem_clause·official_reason 등 본문 열은 읽어서 저장하거나 출력하지 않는다.
- 재현: 고정 seed로 후보 분할을 여러 번 만들고, Holdout 행 비율 17~23% 안에서
  issue_category·업종·도메인 판정 분포 차이가 가장 작은 분할을 고른다.

실행: python3 tools/dataset_review/non_ecommerce_v1/split_v1.py
출력: dataset_work/review/non_ecommerce_taxonomy_split_manifest.json
"""
import collections, csv, hashlib, json, random
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[3]
SRC = PROJECT / "data_source" / "v1" / "unfair_cases"
OUT = PROJECT / "dataset_work" / "review" / "non_ecommerce_taxonomy_split_manifest.json"
SEED = 20260928
TRIALS = 5000
META_COLS = ("clause_id", "case_id", "label_status", "issue_category")


def read_meta(path, cols):
    with open(path, encoding="utf-8-sig", newline="") as f:
        return [{k: r[k] for k in cols} for r in csv.DictReader(f)]


def dist(rows, key):
    c = collections.Counter(r[key] for r in rows)
    n = sum(c.values()) or 1
    return {k: v / n for k, v in c.items()}


def l1(a, b):
    return sum(abs(a.get(k, 0) - b.get(k, 0)) for k in set(a) | set(b))


def main():
    eco = {r["clause_id"] for r in read_meta(SRC / "ecommerce/case_clauses_ecommerce_domain.csv", ("clause_id", "label_status"))
           if r["label_status"] == "official"}
    allrows = read_meta(SRC / "source/case_clauses.csv", META_COLS)
    target = [r for r in allrows if r["label_status"] == "official" and r["clause_id"] not in eco]
    cases = {r["case_id"]: r for r in read_meta(SRC / "source/cases.csv", ("case_id", "industry", "decision_date"))}
    dmap = {r["case_id"]: r["domain"] for r in read_meta(SRC / "ecommerce/ecommerce_domain_map.csv", ("case_id", "domain"))}
    for r in target:
        r["industry"] = cases[r["case_id"]]["industry"] or "(미기재)"
        r["domain"] = dmap.get(r["case_id"], "(없음)")
    by_case = collections.defaultdict(list)
    for r in target:
        by_case[r["case_id"]].append(r)
    case_ids = sorted(by_case)
    n_rows = len(target)
    all_non_eco_cases = sorted(c for c, d in dmap.items() if d != "ecommerce")

    g_cat, g_ind, g_dom = dist(target, "issue_category"), dist(target, "industry"), dist(target, "domain")
    rng = random.Random(SEED)
    best = None
    for t in range(TRIALS):
        order = case_ids[:]
        rng.shuffle(order)
        hold, n = [], 0
        for c in order:
            if n / n_rows >= 0.20:
                break
            hold.append(c)
            n += len(by_case[c])
        ratio = n / n_rows
        if not 0.17 <= ratio <= 0.23:
            continue
        hrows = [r for c in hold for r in by_case[c]]
        drows = [r for c in case_ids if c not in hold for r in by_case[c]]
        score = (l1(dist(hrows, "issue_category"), g_cat) + l1(dist(drows, "issue_category"), g_cat)
                 + 0.5 * l1(dist(hrows, "industry"), g_ind) + 0.5 * l1(dist(hrows, "domain"), g_dom)
                 + 2 * abs(ratio - 0.20))
        if best is None or score < best[0]:
            best = (score, t, sorted(hold), ratio)
    score, trial, hold, ratio = best
    hold_set = set(hold)

    def summary(ids):
        rows = [r for c in ids for r in by_case[c]]
        return {"cases": len(ids), "clauses": len(rows),
                "issue_category": dict(collections.Counter(r["issue_category"] for r in rows).most_common()),
                "industry": dict(collections.Counter(r["industry"] for r in rows).most_common()),
                "domain_map": dict(collections.Counter(r["domain"] for r in rows).most_common())}

    disc = [c for c in case_ids if c not in hold_set]
    man = {
        "name": "non_ecommerce_taxonomy_split_v1",
        "purpose": "비전자상거래 official 문제조항의 회피패턴 taxonomy 탐색용 Discovery / Holdout Validation 분할(모델 학습 split 아님)",
        "unit": "case_id(같은 사건의 모든 조항은 같은 집합)",
        "population": {"definition": "unfair_cases/source/case_clauses.csv의 label_status=official 중 전자상거래 도메인 official 455개를 뺀 조항",
                       "cases_with_official_rows": len(case_ids), "clauses": n_rows,
                       "non_ecommerce_or_review_cases_in_domain_map": len(all_non_eco_cases),
                       "cases_without_official_rows": sorted(set(all_non_eco_cases) - set(case_ids))},
        "method": {"seed": SEED, "trials": TRIALS, "chosen_trial": trial, "holdout_row_ratio_range": [0.17, 0.23],
                   "objective": "Holdout·Discovery의 issue_category 분포 L1 차이 + 0.5×Holdout 업종·도메인 분포 차이 + 2×|비율-0.20| 최소",
                   "metadata_columns_used": list(META_COLS) + ["industry(cases.csv)", "domain(ecommerce_domain_map.csv)"],
                   "text_columns_read": "없음(problem_clause·official_reason·action_or_outcome 미사용)", "score": round(score, 4)},
        "discovery": {**summary(disc), "case_ids": disc,
                      "rows_per_case": {c: len(by_case[c]) for c in disc}},
        "holdout": {**summary(hold), "holdout_row_ratio": round(ratio, 4), "case_ids": hold,
                    "rows_per_case": {c: len(by_case[c]) for c in hold},
                    "access_rule": "이번 작업에서 조항 본문·판단 내용 열람 금지. 내일 정책 검토 후 별도 명령으로만 사용"},
        "clause_assignment_sha256": hashlib.sha256("\n".join(
            f"{r['clause_id']}\t{'H' if r['case_id'] in hold_set else 'D'}" for r in sorted(target, key=lambda x: x["clause_id"])
        ).encode()).hexdigest(),
        "clause_ids": {"discovery": sorted(r["clause_id"] for r in target if r["case_id"] not in hold_set),
                       "holdout": sorted(r["clause_id"] for r in target if r["case_id"] in hold_set)},
    }
    OUT.write_text(json.dumps(man, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({"population": man["population"], "discovery": {k: man["discovery"][k] for k in ("cases", "clauses")},
                      "holdout": {k: man["holdout"][k] for k in ("cases", "clauses", "holdout_row_ratio")},
                      "score": man["method"]["score"], "trial": trial}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
