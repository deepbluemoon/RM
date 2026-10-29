"""베이스라인(v0) 전 흐름 평가 — M1·M2 → 3구간 → CSV 근거 검색 → M3(/v1/judge). DB 를 쓰지 않는다.

    model-server/.venv/bin/python tools/dataset_build/baseline_v0/pipeline_eval_v0.py [--split eval] [--t-low 0.2] [--limit N]
        [--evidence db|csv] [--db team|env] [--bm25-only]

- 근거(2026-09-29 변경, 기본 db): 서비스와 같은 DB 검색(backend searchEvidence — 명시 참조 + BM25 + bge-m3 하이브리드)을
  `npm run knowledge:search-batch` 로 한 번에 부른다. --db team = 팀 DB(Intent-Plan.md 접속 정보, 비밀번호는 출력하지 않음),
  --db env = backend/.env 의 DB. --evidence csv 면 아래의 예전 CSV 직접 조회.

- 3구간(2026-09-29 결정): max(M1, M2) < t_low → M3 없이 정상 / 그 밖 → M3 판정.
- 근거 = CSV 직접 조회: data_source/v2/data/raw/law_articles.csv(법령 조 단위로 합침) + v1 공정위 case_clauses.csv.
  백엔드 search.ts(R-09)와 같은 한글 2-gram BM25 + 유형 힌트. 상위 5(출처별 최대 3).
  누수 방지: dev/eval 분할에 속한 사건(case_id)의 공정위 조항은 근거에서 뺀다.
  원문 링크는 넘기지 않는다(v2 링크에 법제처 OC 키가 박혀 있음).
- 게이트웨이 키는 model-server/.env 의 MODEL_API_KEY 에서 읽기만 한다(출력·기록 안 함).
산출: dataset_work/reports/baseline_v0/pipeline_{split}.json, pipeline_{split}_rows.jsonl
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import math
import re
import sys
import time
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
MS = ROOT / "model-server"
sys.path.insert(0, str(MS))
from app.classifiers import ClauseText, TorchIllegal, TorchLoophole  # noqa: E402

DATA = ROOT / "dataset_work/master/baseline_v0"
MODELS = MS / "var/models/baseline_v0"
REPORT = ROOT / "dataset_work/reports/baseline_v0"
GATEWAY = "http://127.0.0.1:9542"
CATS = ["normal", "dispute", "unfair", "illegal"]

RISK_HINT_TERMS = {  # backend/src/modules/evidence/search.ts 와 같다
    "rights_limit": "권리 제한 배제 소송 제기 항변권 포기 입증책임",
    "liability_avoid": "책임 배제 면책 손해배상 범위 제한 고의 과실",
    "refund_cancel_limit": "청약철회 환급 해제 해지 원상회복 반환",
    "unilateral_change": "일방적 변경 급부 내용 중지 사전 고지 통지",
    "excessive_penalty": "손해배상 위약금 과중 지연 손해금",
    "vague": "해석 명백 불리 설명",
    "other": "공정성 신의성실",
}


def tokenize(text: str) -> list[str]:
    out: list[str] = []
    norm = text.lower()
    for run in re.findall(r"[가-힣]+", norm):
        if len(run) == 1:
            out.append(run)
        out.extend(run[i:i + 2] for i in range(len(run) - 1))
    out.extend(re.findall(r"[a-z0-9]+", norm))
    return out


def read_csv(p: Path) -> list[dict]:
    with p.open(encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


class CsvEvidence:
    """CSV 직접 조회 근거 색인(BM25, k1=1.2, b=0.75)."""

    def __init__(self, exclude_cases: set[str]):
        docs: list[dict] = []
        arts: dict[tuple, list[str]] = defaultdict(list)
        titles: dict[tuple, str] = {}
        for r in read_csv(ROOT / "data_source/v2/data/raw/law_articles.csv"):
            if r["출처유형"] != "법령조문" or not r["조번호"]:
                continue
            k = (r["법령명"], r["조번호"])
            titles.setdefault(k, r["조제목"])
            if r["내용"] and r["내용"] not in arts[k]:
                arts[k].append(r["내용"])
        for (law, no), parts in arts.items():
            docs.append({"id": f"law:{law}:제{no}조", "source_type": "law_article",
                         "title": f"{law} 제{no}조({titles[(law, no)]})", "text": " ".join(parts)[:700]})
        n_ex = 0
        for r in read_csv(ROOT / "data_source/v1/unfair_cases/source/case_clauses.csv"):
            if r["label_status"] != "official" or not r["problem_clause"].strip():
                continue
            if r["case_id"] in exclude_cases:
                n_ex += 1
                continue
            reason = re.sub(r"\s+", " ", r["official_reason"])[:300]
            docs.append({"id": f"ftc:{r['clause_id']}", "source_type": "ftc_case",
                         "title": f"공정위 시정 사례 — {r['issue_type']} ({r['violation_basis'] or r['legal_basis']})",
                         "text": f"문제 조항: {r['problem_clause'][:300]} / 판단 이유: {reason}"})
        self.docs = docs
        self.excluded_ftc = n_ex
        self.tf = []
        df: Counter = Counter()
        for d in docs:
            c = Counter(tokenize(f"{d['title']} {d['text']}"))
            self.tf.append(c)
            df.update(c.keys())
        self.df = df
        self.avg = sum(sum(c.values()) for c in self.tf) / max(1, len(docs))

    def search(self, clause: str, risk_type: str | None, laws: list[str], k: int = 5, per_src: int = 3) -> list[dict]:
        q = Counter(tokenize(clause))
        if risk_type:
            for t in tokenize(RISK_HINT_TERMS.get(risk_type, "")):
                q[t] += 2
        law_boost = set(laws)
        n = len(self.docs)
        scored = []
        for i, (d, tf) in enumerate(zip(self.docs, self.tf)):
            ln = sum(tf.values())
            s = 0.0
            for t, qf in q.items():
                f = tf.get(t)
                if not f:
                    continue
                idf = math.log(1 + (n - self.df[t] + 0.5) / (self.df[t] + 0.5))
                s += qf * idf * f * 2.2 / (f + 1.2 * (1 - 0.75 + 0.75 * ln / self.avg))
            if s and d["source_type"] == "law_article" and any(d["title"].startswith(l) for l in law_boost):
                s *= 1.3
            if s:
                scored.append((-s, i))
        scored.sort()
        out, per = [], Counter()
        for _, i in scored:
            d = self.docs[i]
            if per[d["source_type"]] >= per_src:
                continue
            per[d["source_type"]] += 1
            out.append(d)
            if len(out) == k:
                break
        return out


def api_key() -> str:
    for line in (MS / ".env").read_text(encoding="utf-8").splitlines():
        if line.startswith("MODEL_API_KEY="):
            return line.split("=", 1)[1].strip().strip('"')
    raise SystemExit("MODEL_API_KEY 없음")


def judge(body: dict, key: str) -> dict:
    req = urllib.request.Request(f"{GATEWAY}/v1/judge", data=json.dumps(body, ensure_ascii=False).encode(),
                                 headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=320) as r:
                return json.loads(r.read())
        except Exception as e:  # noqa: BLE001
            if attempt == 2:
                return {"error": str(e)[:200]}
            time.sleep(3 * (attempt + 1))
    return {"error": "unreachable"}


def metrics(gold: list[str], pred: list[str]) -> dict:
    per = {}
    for c in CATS:
        tp = sum(g == c and p == c for g, p in zip(gold, pred))
        fp = sum(g != c and p == c for g, p in zip(gold, pred))
        fn = sum(g == c and p != c for g, p in zip(gold, pred))
        pr = tp / (tp + fp) if tp + fp else 0.0
        rc = tp / (tp + fn) if tp + fn else 0.0
        per[c] = {"precision": round(pr, 4), "recall": round(rc, 4), "f1": round(2 * pr * rc / (pr + rc), 4) if pr + rc else 0.0,
                  "support": sum(g == c for g in gold)}
    gr = [g != "normal" for g in gold]
    pr_ = [p != "normal" for p in pred]
    tp = sum(a and b for a, b in zip(gr, pr_)); fp = sum(b and not a for a, b in zip(gr, pr_)); fn = sum(a and not b for a, b in zip(gr, pr_))
    P = tp / (tp + fp) if tp + fp else 0.0; R = tp / (tp + fn) if tp + fn else 0.0
    present = [c for c in CATS if per[c]["support"]]
    return {"accuracy_4class": round(sum(g == p for g, p in zip(gold, pred)) / len(gold), 4),
            "macro_f1_4class": round(sum(per[c]["f1"] for c in present) / len(present), 4),
            "risk_binary": {"precision": round(P, 4), "recall": round(R, 4), "f1": round(2 * P * R / (P + R), 4) if P + R else 0.0},
            "per_class": per, "confusion": dict(Counter(f"{g}->{p}" for g, p in zip(gold, pred)))}


def team_db_env() -> dict:
    """팀 DB 접속값(Intent-Plan.md [데이터베이스 설정]) — 자식 프로세스 환경에만 넣는다. 비밀번호는 출력하지 않는다."""
    import os
    text = (ROOT / "Intent-Plan.md").read_text(encoding="utf-8")
    pw = re.search(r"비밀번호:\s*(\S+)", text)
    if not pw:
        raise SystemExit("Intent-Plan.md 에서 팀 DB 비밀번호를 찾지 못했습니다")
    return {**os.environ, "DB_HOST": "mis.iptime.org", "DB_PORT": "23306", "DB_USER": "pioneer2",
            "DB_NAME": "ABC10pioneer2", "DB_PASSWORD": pw.group(1)}


def db_search(queries: list[dict], db: str, bm25_only: bool) -> dict[str, dict]:
    """backend 일괄 검색(서비스와 같은 searchEvidence). id → {kv_id, knowledge_date, mode, evidence, hits}"""
    import os
    import subprocess
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        qi, qo = Path(td) / "q.jsonl", Path(td) / "r.jsonl"
        qi.write_text("\n".join(json.dumps(q, ensure_ascii=False) for q in queries) + "\n", encoding="utf-8")
        cmd = ["npm", "run", "-s", "knowledge:search-batch", "--", "--in", str(qi), "--out", str(qo)] + (["--bm25-only"] if bm25_only else [])
        env = team_db_env() if db == "team" else dict(os.environ)
        p = subprocess.run(cmd, cwd=ROOT / "backend", env=env, capture_output=True, text=True)
        if p.returncode != 0:
            raise SystemExit(f"DB 검색 실패: {p.stderr[-500:]}")
        return {r["id"]: r for r in (json.loads(l) for l in qo.read_text(encoding="utf-8").splitlines() if l.strip())}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--split", default="eval")
    ap.add_argument("--t-low", type=float, default=0.2)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--evidence", choices=["db", "csv"], default="db")
    ap.add_argument("--db", choices=["team", "env"], default="team")
    ap.add_argument("--bm25-only", action="store_true")
    a = ap.parse_args()
    rows = [json.loads(l) for l in (DATA / "split" / f"{a.split}.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
    if a.limit:
        rows = rows[:a.limit]
    all_rows = [json.loads(l) for l in (DATA / "clauses.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]
    held = {r["group"] for r in all_rows if r["split"] in ("dev", "eval") and r["source"].startswith("ftc")}
    ev = CsvEvidence(exclude_cases=held) if a.evidence == "csv" else None
    kw = dict(threads=6, batch=16, max_len=512, nd=4)
    m1, m2 = TorchLoophole(MODELS / "loophole-klue-roberta-base", **kw), TorchIllegal(MODELS / "illegal-klue-roberta-base", **kw)
    key = api_key()
    today = dt.date.today().isoformat()
    out_rows, t0, n_m3, n_err = [], time.monotonic(), 0, 0
    # 1) M1·M2 → 3구간
    for r in rows:
        c = [ClauseText(r["id"], r["text"], r.get("title"))]
        p1, p2 = m1.predict(r["contract_type"], c)[0], m2.predict(r["contract_type"], c)[0]
        band = "skip" if max(p1["score"], p2["score"]) < a.t_low else "m3"
        # M1·M2 만 쓴 경우의 4범주(비교용): M2≥0.5 → illegal, M1≥0.5 → unfair, 그 밖 normal
        m12 = "illegal" if p2["score"] >= 0.5 else "unfair" if p1["score"] >= 0.5 else "normal"
        out_rows.append({"id": r["id"], "source": r["source"], "gold": r["category"], "m1": p1["score"], "m1_type": p1.get("type"),
                         "m2": p2["score"], "m2_laws": p2.get("related_laws"), "band": band, "pred_m12": m12,
                         "_row": r, "_p1": p1, "_p2": p2})
    # 2) 근거: DB 일괄 검색(누수 방지 — dev·eval 사건의 공정위 사례 제외) 또는 CSV
    todo = [x for x in out_rows if x["band"] == "m3"]
    found: dict[str, dict] = {}
    if ev is None and todo:
        found = db_search([{"id": x["id"], "text": x["_row"]["text"], "riskType": x["_p1"].get("type"),
                            "relatedLaws": x["_p2"].get("related_laws") or [], "excludeCaseIds": sorted(held)} for x in todo],
                          a.db, a.bm25_only)
    kv_info = next(iter(found.values()), {}) if found else {}
    today = kv_info.get("knowledge_date") or today
    # 3) M3 판정
    for i, rec in enumerate(out_rows):
        r, p1, p2 = rec.pop("_row"), rec.pop("_p1"), rec.pop("_p2")
        if rec["band"] == "skip":
            rec["pred"] = "normal"
        else:
            if ev is None:
                evid = found[rec["id"]]["evidence"]
                rec["evidence_mode"] = found[rec["id"]]["mode"]
            else:
                evid = ev.search(r["text"], p1.get("type"), p2.get("related_laws") or [])
            res = judge({"clause": r["text"], "contract_type": r["contract_type"], "perspective": "consumer",
                         "knowledge_date": today, "scores": {"loophole": p1["score"], "illegal": p2["score"]},
                         "evidence": evid}, key)
            n_m3 += 1
            if "error" in res or "risk_class" not in res:
                n_err += 1
                rec["pred"], rec["m3_error"] = rec["pred_m12"], str(res)[:200]
            else:
                rec["pred"] = res["risk_class"]
                rec["m3"] = {k: res.get(k) for k in ("risk_class", "risk_type", "risk_level", "confidence")}
                rec["m3_explanation_n"] = len(res.get("explanation") or [])
            rec["evidence_ids"] = [e["id"] for e in evid]
            rec["evidence_types"] = [e["source_type"] for e in evid]
        if (i + 1) % 25 == 0:
            print(f"{i + 1}/{len(rows)} m3 {n_m3} err {n_err} ({time.monotonic() - t0:.0f}s)", flush=True)
    gold = [x["gold"] for x in out_rows]
    report = {
        "split": a.split, "n": len(out_rows), "t_low": a.t_low, "m3_calls": n_m3, "m3_errors": n_err,
        "evidence_source": a.evidence if a.evidence == "csv" else f"db:{a.db}(kv {kv_info.get('kv_id')}, {kv_info.get('knowledge_date')})",
        "evidence_mode": dict(Counter(x.get("evidence_mode") for x in out_rows if x["band"] == "m3")),
        "evidence_types_in_top5": dict(Counter(t for x in out_rows for t in x.get("evidence_types", []))),
        "evidence_docs": len(ev.docs) if ev else None, "evidence_ftc_excluded_cases": len(held),
        "elapsed_sec": round(time.monotonic() - t0, 1),
        "pipeline(M1·M2→3구간→M3)": metrics(gold, [x["pred"] for x in out_rows]),
        "M1·M2 only": metrics(gold, [x["pred_m12"] for x in out_rows]),
        "band_by_gold": dict(Counter(f"{x['gold']}:{x['band']}" for x in out_rows)),
        "m3_on_ftc_corrected(after_text)": dict(Counter(x["pred"] for x in out_rows if x["source"] == "ftc_corrected")),
    }
    REPORT.mkdir(parents=True, exist_ok=True)
    (REPORT / f"pipeline_{a.split}{'' if a.evidence == 'csv' else '_db'}.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    with (REPORT / f"pipeline_{a.split}{'' if a.evidence == 'csv' else '_db'}_rows.jsonl").open("w", encoding="utf-8") as f:
        for x in out_rows:
            f.write(json.dumps(x, ensure_ascii=False) + "\n")
    print(json.dumps({k: report[k] for k in report if k not in ("band_by_gold",)}, ensure_ascii=False, indent=1)[:3000])


if __name__ == "__main__":
    main()
