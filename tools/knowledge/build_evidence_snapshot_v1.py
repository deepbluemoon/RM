"""근거 DB 초기 적재용 스냅숏(v1) — 실제 공개 자료만. 원천 CSV 는 읽기만 한다.

    python3 tools/knowledge/build_evidence_snapshot_v1.py [--date 2026-09-29]

출력: dataset_work/knowledge/evidence_snapshot_v1.json  (backend/scripts/bootstrap-knowledge.ts 가 읽는다)
      dataset_work/knowledge/evidence_snapshot_v1_report.json

근거 3종(evidence_item.source_type)
- law_article : v2_prep 법령 13개(법·시행령·시행규칙)의 조문 → 조 단위 원문. 항 분리는 적재 스크립트가 백엔드 splitLaw 로 한다.
                v2_prep 행정규칙 중 표준약관이 아닌 고시·예규의 조문(조 번호가 있는 것)도 law_article 로 넣는다(2026-09-29 결정).
                제외: 삭제 조문, 법령서식(빈 서식), 별표(표·초대형 본문 — 발췌 한도 2,000자로 담을 수 없음)
- std_terms   : v2_prep 정부 표준약관 3종의 조항(구조 헤더 제외)
- ftc_case    : v1 공정위 official 문제조항 중 판단 이유와 근거 법조가 모두 있는 행. 사례 3구분 = 사실관계(문제 조항) /
                판단(공정위 판단 이유) / 근거(위반 법조). 사건명 = 보도자료 제목, 식별정보 = 보도자료 기반 조항 ID
가상·합성 데이터는 넣지 않는다(2026-09-29 사용자 지시: DB 에는 실제 데이터만).
"""
from __future__ import annotations

import argparse
import collections
import csv
import datetime as dt
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
V2P = ROOT / "data_source/v2_prep/data"
V1 = ROOT / "data_source/v1/unfair_cases/source"
OUT = ROOT / "dataset_work/knowledge"
csv.field_size_limit(10 ** 9)


def read(p: Path) -> list[dict]:
    with p.open(encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def nz(v: str | None) -> str | None:
    v = (v or "").strip()
    return None if v in ("", "null", "None") else v


def laws(report: dict) -> list[dict]:
    rows = [r for r in read(V2P / "law_articles.csv") if r["출처유형"] == "법령조문"]
    groups: dict[tuple, list[dict]] = collections.OrderedDict()
    skipped = collections.Counter()
    for r in rows:
        if r["삭제조문"] == "true":
            skipped["삭제 조문"] += 1
            continue
        if not nz(r["조문표기"]):
            skipped["조 번호 없음"] += 1
            continue
        groups.setdefault((r["법령명"], r["조문표기"]), []).append(r)
    out = []
    for (name, art), rs in groups.items():
        head = f"{art}({rs[0]['조제목']})" if nz(rs[0]["조제목"]) else art
        lines = [x["내용"].strip() for x in rs if nz(x["내용"])]
        text = "\n".join(lines)
        if not text.startswith(art.replace(" ", "")[:2]):   # 조 머리 행이 없으면 붙인다
            text = f"{head}\n{text}"
        out.append({"sourceType": "law_article", "sourceName": name, "identifier": art, "rawText": text, "split": "law",
                    "sourceUrl": rs[0]["공개링크"], "effectiveDate": rs[0]["시행일자"], "publishedDate": None})
    report["law_article(법령)"] = {"articles": len(out), "rows_used": sum(len(v) for v in groups.values()),
                                   "skipped_rows": dict(skipped), "laws": len({k[0] for k in groups})}
    return out


def admin_rules(report: dict) -> list[dict]:
    meta = {r["행정규칙ID"]: r for r in read(V2P / "admin_rules.csv")}
    rows = read(V2P / "admin_rule_articles.csv")
    std, notice, skipped = [], [], collections.Counter()
    for r in rows:
        m = meta.get(r["행정규칙ID"], {})
        if r.get("구조헤더") == "true":
            skipped["구조 헤더(장·절)"] += 1
            continue
        if nz(r.get("별표번호")) or nz(r.get("별표제목")):
            skipped["별표"] += 1
            continue
        art = nz(r["조문표기"])
        body = (r["내용"] or "").strip()
        if not art or len(body) < 5:
            skipped["조 번호·본문 없음"] += 1
            continue
        is_std = m.get("표준약관여부") == "true" and "표지" not in r["행정규칙명"]   # '표준약관표지의 사용에 관한 고시'는 고시
        if is_std:
            ident = f"{art}({r['조제목']})" if nz(r["조제목"]) else art
            std.append({"sourceType": "std_terms", "sourceName": r["행정규칙명"], "identifier": ident, "rawText": body,
                        "split": "std", "sourceUrl": r["공개링크"] or m.get("공개링크"),
                        "effectiveDate": r["시행일자"] or m.get("시행일자"), "publishedDate": None})
        else:
            notice.append({"sourceType": "law_article", "sourceName": r["행정규칙명"], "identifier": art, "rawText": body,
                           "split": "law", "sourceUrl": r["공개링크"] or m.get("공개링크"),
                           "effectiveDate": r["시행일자"] or m.get("시행일자"), "publishedDate": None})
    report["std_terms(표준약관)"] = {"clauses": len(std), "terms": len({x["sourceName"] for x in std})}
    report["law_article(고시·예규)"] = {"articles": len(notice), "rules": len({x["sourceName"] for x in notice})}
    report["admin_skipped_rows"] = dict(skipped)
    return std + notice


def ftc_cases(report: dict) -> list[dict]:
    cases = {c["case_id"]: c for c in read(V1 / "cases.csv")}
    out, skipped = [], collections.Counter()
    for r in read(V1 / "case_clauses.csv"):
        if r["label_status"] != "official":
            skipped["official 아님"] += 1
            continue
        clause = re.sub(r"\s*/\s*", "\n", r["problem_clause"]).strip()
        reason = re.sub(r"[□■]\s*", "", r["official_reason"]).strip()
        basis = (r["violation_basis"] or r["legal_basis"] or "").strip()
        if not clause or not reason or not basis:
            skipped["문제 조항·판단 이유·근거 법조 중 빈 값"] += 1
            continue
        c = cases.get(r["case_id"], {})
        if not nz(c.get("decision_date")):
            skipped["공개일 없음"] += 1
            continue
        title = (c.get("case_title") or "").strip() or r["case_id"]
        out.append({"sourceType": "ftc_case", "sourceName": f"{title} ({r['case_id']})", "identifier": r["clause_id"],
                    "rawText": f"사실관계\n{clause}\n판단\n{reason}\n근거\n{basis}", "split": "case",
                    "caseSections": {"facts": clause, "judgment": reason, "basis": basis},
                    "sourceUrl": r["official_url"] or c.get("official_url"), "effectiveDate": None,
                    "publishedDate": c["decision_date"], "issueType": r["issue_type"], "caseId": r["case_id"]})
    report["ftc_case(공정위 사례)"] = {"clauses": len(out), "cases": len({x["caseId"] for x in out}), "skipped": dict(skipped)}
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=dt.date.today().isoformat())
    a = ap.parse_args()
    report: dict = {}
    deltas = laws(report) + admin_rules(report) + ftc_cases(report)
    bad = [d for d in deltas if not d["sourceUrl"] or not (d["effectiveDate"] or d["publishedDate"])]
    for d in bad:
        report.setdefault("dropped_missing_url_or_date", []).append(f"{d['sourceType']}|{d['sourceName']}|{d['identifier']}")
    deltas = [d for d in deltas if d not in bad]
    keys = collections.Counter((d["sourceType"], d["sourceName"], d["identifier"]) for d in deltas)
    report["duplicate_keys"] = [list(k) for k, n in keys.items() if n > 1][:20]
    snap = {"knowledgeDate": a.date, "analysisBasisVersion": f"KB-{a.date.replace('-', '.')}",
            "source": "v2_prep(법령·행정규칙) + v1 공정위 official 문제조항 — 실제 공개 자료만", "deltas": deltas}
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "evidence_snapshot_v1.json").write_text(json.dumps(snap, ensure_ascii=False), encoding="utf-8")
    report["total_deltas"] = len(deltas)
    report["by_type"] = dict(collections.Counter(d["sourceType"] for d in deltas))
    (OUT / "evidence_snapshot_v1_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
