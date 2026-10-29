"""Discovery 사건의 official 조항만 분석 순서대로 덤프한다(scratchpad용 읽기 자료).

- 분할 매니페스트의 discovery.case_ids에 속한 행만 본문 열을 읽는다. Holdout 행은 case_id 확인 즉시 건너뛴다.
- 분석 순서: 사건 결정일(decision_date) 오름차순, 같은 날은 case_id 순. 이 순서로 구간(초기/중간/후반)을 나눈다.

실행: python3 tools/dataset_review/non_ecommerce_v1/dump_discovery_v1.py <출력폴더>
"""
import collections, csv, json, re, sys
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[3]
SRC = PROJECT / "data_source" / "v1" / "unfair_cases"
MAN = PROJECT / "dataset_work" / "review" / "non_ecommerce_taxonomy_split_manifest.json"


def clip(s, n):
    s = re.sub(r"\s+", " ", s)
    return s if len(s) <= n else s[:n] + "…"


def main(outdir):
    man = json.loads(MAN.read_text(encoding="utf-8"))
    disc = set(man["discovery"]["case_ids"])
    disc_ids = set(man["clause_ids"]["discovery"])
    cases = {}
    with open(SRC / "source/cases.csv", encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            if r["case_id"] in disc:
                cases[r["case_id"]] = {k: r[k] for k in ("case_id", "case_title", "decision_date", "industry", "company_or_platform", "terms_scope")}
    rows = []
    with open(SRC / "source/case_clauses.csv", encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            if r["case_id"] not in disc:      # Holdout·전자상거래 사건은 본문을 보지 않고 건너뜀
                continue
            if r["clause_id"] in disc_ids:
                rows.append(r)
    assert len(rows) == len(disc_ids), (len(rows), len(disc_ids))
    order = sorted(disc, key=lambda c: (cases[c]["decision_date"], c))
    Path(outdir).mkdir(parents=True, exist_ok=True)
    out, idx = [], 0
    for ci, c in enumerate(order, 1):
        m = cases[c]
        out.append(f"\n######## C{ci:02d} {c} | {m['decision_date']} | {m['industry']} | {m['case_title']} | {m['company_or_platform']} | scope={m['terms_scope']}")
        units = collections.OrderedDict()
        for r in rows:
            if r["case_id"] == c:
                units.setdefault((r["issue_no"], r["issue_type"]), []).append(r)
        for (no, it), rs in units.items():
            r0 = rs[0]
            out.append(f"## {no} {it} | cat={r0['issue_category']} | {r0['violation_basis'] or r0['article_paragraph_item']}")
            for rr in dict.fromkeys(x["official_reason"] for x in rs):
                out.append("  REASON: " + clip(rr, 600))
            for a in dict.fromkeys(x["action_or_outcome"] for x in rs):
                out.append("  ACTION: " + clip(a, 380))
            for x in rs:
                idx += 1
                out.append(f"  - {x['clause_id']}: {clip(x['problem_clause'], 850)}")
    txt = "\n".join(out)
    (Path(outdir) / "disc_dump.txt").write_text(txt, encoding="utf-8")
    (Path(outdir) / "disc_order.json").write_text(json.dumps(order), encoding="utf-8")
    lines, chunks, cur, n = txt.split("\n"), [], [], 0
    for l in lines:
        if l.startswith("######## C") and n > 24000:
            chunks.append(cur); cur, n = [], 0
        cur.append(l); n += len(l) + 1
    chunks.append(cur)
    for i, ch in enumerate(chunks):
        (Path(outdir) / f"disc_chunk_{i:02d}.txt").write_text("\n".join(ch), encoding="utf-8")
    print("cases", len(order), "clauses", idx, "chars", len(txt), "chunks", len(chunks))


if __name__ == "__main__":
    main(sys.argv[1])
