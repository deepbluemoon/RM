"""baseline_v0 체크포인트(M1·M2) 서빙 경로 테스트 — 결과는 같은 폴더 results.json.

    cd model-server && .venv/bin/python reports/baseline_v0/run_model_test.py

학습 세션 보고서(dataset_work/reports/baseline_v0/ROUND1_REPORT.md)와 겹치지 않게, 게이트웨이가 실제로 쓰는 코드
(app.classifiers.load_classifiers · app.main.create_app)로 불러 적재·재현성·결정성·지연·강건성을 본다.
데이터는 읽기만 한다. 06 TEST 분할은 3회차까지 고정이라 쓰지 않는다. 공유 Ollama 는 호출하지 않는다.
"""
from __future__ import annotations

import json
import os
import resource
import secrets
import statistics
import sys
import time
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
MS = HERE.parents[1]
ROOT = MS.parent
sys.path.insert(0, str(MS))

from app.classifiers import ClauseText, load_classifiers  # noqa: E402

MODEL_ROOT = MS / "var/models/baseline_v0"
SPLIT = ROOT / "dataset_work/master/baseline_v0/split"
D06 = ROOT / "workspace/06_model_dataset/direct_legal_detector"
OUT: dict = {}


def load(p: Path) -> list[dict]:
    return [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l.strip()]


def rss_mb() -> float:
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024 / 1024  # macOS: bytes


def auc(scores: list[float], y: list[int]) -> float | None:
    pos = [s for s, t in zip(scores, y) if t]
    neg = [s for s, t in zip(scores, y) if not t]
    if not pos or not neg:
        return None
    win = sum((p > n) + 0.5 * (p == n) for p in pos for n in neg)
    return round(win / (len(pos) * len(neg)), 4)


def metrics(scores: list[float], y: list[int], th: float = 0.5) -> dict:
    pred = [s >= th for s in scores]
    tp = sum(p and t for p, t in zip(pred, y))
    fp = sum(p and not t for p, t in zip(pred, y))
    fn = sum(t and not p for p, t in zip(pred, y))
    tn = len(y) - tp - fp - fn
    pr = tp / (tp + fp) if tp + fp else 0.0
    rc = tp / (tp + fn) if tp + fn else 0.0
    return {"n": len(y), "pos": sum(y), "tp": tp, "fp": fp, "fn": fn, "tn": tn,
            "accuracy": round((tp + tn) / len(y), 4), "precision": round(pr, 4), "recall": round(rc, 4),
            "f1": round(2 * pr * rc / (pr + rc), 4) if pr + rc else 0.0, "auc": auc(scores, y)}


def predict_rows(model, rows: list[dict]) -> tuple[list[dict], float]:
    """계약 유형별로 묶어 서빙과 같은 predict 호출. (결과를 원래 순서로, 걸린 초)"""
    by_ct: dict[str, list[int]] = defaultdict(list)
    for i, r in enumerate(rows):
        by_ct[r["contract_type"]].append(i)
    out: list[dict | None] = [None] * len(rows)
    t0 = time.perf_counter()
    for ct, idx in by_ct.items():
        res = model.predict(ct, [ClauseText(rows[i]["id"], rows[i]["text"], rows[i].get("title") or None) for i in idx])
        for i, r in zip(idx, res):
            out[i] = r
    return out, time.perf_counter() - t0  # type: ignore[return-value]


# ------------------------------------------------------------------ 1. 적재
t0 = time.perf_counter()
m1, m2 = load_classifiers(MODEL_ROOT, "loophole-klue-roberta-base", "illegal-klue-roberta-base",
                          threads=6, batch=16, max_len=512, nd=4)
OUT["load"] = {"sec": round(time.perf_counter() - t0, 2), "rss_mb_after_load": round(rss_mb()),
               "m1": {"class": type(m1).__name__, **m1.info()}, "m2": {"class": type(m2).__name__, **m2.info()}}
print("load", OUT["load"], flush=True)

# ------------------------------------------------------------------ 2. baseline_v0 dev·eval 재현 + 결정성
ev, dv = load(SPLIT / "eval.jsonl"), load(SPLIT / "dev.jsonl")
OUT["reproduce"] = {}
cache: dict[str, dict] = {}
for name, rows in (("eval", ev), ("dev", dv)):
    p1, t1 = predict_rows(m1, rows)
    p2, t2 = predict_rows(m2, rows)
    cache[name] = {"m1": p1, "m2": p2}
    y1 = [int(r["category"] != "normal") for r in rows]
    y2 = [int(r["category"] == "illegal") for r in rows]
    s1, s2 = [p["score"] for p in p1], [p["score"] for p in p2]
    rep = {"m1": metrics(s1, y1), "m2": metrics(s2, y2), "sec": {"m1": round(t1, 1), "m2": round(t2, 1)}}
    # 임계값별
    rep["m1_threshold"] = {str(th): {k: metrics(s1, y1, th)[k] for k in ("precision", "recall", "f1")} for th in (0.2, 0.3, 0.5, 0.7, 0.9)}
    rep["m2_threshold"] = {str(th): {k: metrics(s2, y2, th)[k] for k in ("precision", "recall", "f1")} for th in (0.2, 0.3, 0.5, 0.7, 0.9)}
    # 출처·정답별 판정률
    grp: dict[str, list[int]] = defaultdict(list)
    for i, r in enumerate(rows):
        grp[f"{r['source']}/{r['category']}"].append(i)
    rep["by_group"] = {g: {"n": len(ix), "m1_pos_rate": round(sum(s1[i] >= .5 for i in ix) / len(ix), 3),
                           "m2_pos_rate": round(sum(s2[i] >= .5 for i in ix) / len(ix), 3)} for g, ix in sorted(grp.items())}
    # M1 유형 정확도(정답이 위험인 행에서 type 일치)
    risk_ix = [i for i, r in enumerate(rows) if r["category"] != "normal" and r.get("risk_type")]
    rep["m1_type_acc_on_risky"] = round(sum(p1[i]["type"] == rows[i]["risk_type"] for i in risk_ix) / len(risk_ix), 3)
    # M2 법률 top-1(정답 법률이 있는 illegal 행)
    law_ix = [i for i, r in enumerate(rows) if r["category"] == "illegal" and r.get("laws")]
    rep["m2_law_top1_acc_on_illegal"] = round(sum(p2[i]["type"] in rows[i]["laws"] for i in law_ix) / len(law_ix), 3)
    rep["m2_related_laws_seen"] = sorted({l for p in p2 for l in p["related_laws"]})
    OUT["reproduce"][name] = rep
    print(name, rep["m1"], rep["m2"], flush=True)

# 결정성: eval 을 한 번 더 돌려 완전 일치 확인
r1, _ = predict_rows(m1, ev)
r2, _ = predict_rows(m2, ev)
OUT["determinism"] = {"m1_identical": r1 == cache["eval"]["m1"], "m2_identical": r2 == cache["eval"]["m2"]}

# 배치 불변성: 배치 1 vs 16 (패딩 차이로 점수가 흔들리는지 — 판정 캐시 일관성)
sub = ev[:96]
for m in (m1, m2):
    m.batch = 1
b1 = {"m1": predict_rows(m1, sub)[0], "m2": predict_rows(m2, sub)[0]}
for m in (m1, m2):
    m.batch = 16
bi = {}
for k, ref in (("m1", cache["eval"]["m1"][:96]), ("m2", cache["eval"]["m2"][:96])):
    d = [abs(a["score"] - b["score"]) for a, b in zip(b1[k], ref)]
    flips = sum((a["score"] >= .5) != (b["score"] >= .5) for a, b in zip(b1[k], ref))
    bi[k] = {"n": len(d), "max_abs_diff": round(max(d), 5), "rows_differ": sum(x > 0 for x in d), "label_flips": flips}
OUT["batch_invariance"] = bi
print("determinism", OUT["determinism"], "batch", bi, flush=True)

# ------------------------------------------------------------------ 3. 지연·처리량 (CPU 6스레드, 배치 16)
lat: dict = {}
tok = m1.tok
lens = [len(tok(r["text"])["input_ids"]) for r in ev]
lat["eval_token_len"] = {"median": statistics.median(lens), "p90": sorted(lens)[int(.9 * len(lens))],
                         "max": max(lens), "over_512": sum(l > 512 for l in lens)}
for name, sec in (("m1", OUT["reproduce"]["eval"]["sec"]["m1"]), ("m2", OUT["reproduce"]["eval"]["sec"]["m2"])):
    lat[f"{name}_eval363_sec"] = sec
    lat[f"{name}_clauses_per_sec"] = round(len(ev) / sec, 1)
buckets = {"short(<150자)": [r for r in ev if len(r["text"]) < 150],
           "mid(150~400자)": [r for r in ev if 150 <= len(r["text"]) < 400],
           "long(>=400자)": [r for r in ev if len(r["text"]) >= 400]}
lat["by_length_batch16"] = {}
for b, rows in buckets.items():
    rows = rows[:48]
    _, t = predict_rows(m1, rows)
    lat["by_length_batch16"][b] = {"n": len(rows), "m1_ms_per_clause": round(1000 * t / len(rows), 1)}
# 단건(배치 1개에 조항 1개) 지연 — /v1/detect 로 조항 1개 보낼 때
one = ev[0]
ts = []
for _ in range(10):
    t = time.perf_counter()
    m1.predict(one["contract_type"], [ClauseText("x", one["text"], None)])
    ts.append(time.perf_counter() - t)
lat["single_clause_ms_median"] = round(1000 * statistics.median(ts), 1)
# 100조항 문서 가정: M1 ∥ M2 는 jobs 에서 스레드 동시 실행 — 여기서는 직렬 합으로 상한만
doc = (ev * 1)[:100]
_, ta = predict_rows(m1, doc)
_, tb = predict_rows(m2, doc)
lat["doc100_serial_sec"] = round(ta + tb, 1)
lat["rss_mb_peak"] = round(rss_mb())
OUT["latency"] = lat
print("latency", lat, flush=True)

# ------------------------------------------------------------------ 4. 강건성 탐침 (직접 만든 합성 조항)
NEUTRAL = ("회원은 서비스 이용 시 관계 법령과 본 약관의 규정, 이용안내 및 서비스와 관련하여 공지한 주의사항을 준수하여야 하며, "
           "회사가 서비스 화면에 게시하는 운영정책과 개별 서비스의 이용 조건을 확인하여야 합니다. 회사는 회원이 서비스를 원활하게 "
           "이용할 수 있도록 고객센터를 운영하며, 문의 사항은 전화, 전자우편, 서비스 내 문의하기 기능을 통해 접수할 수 있습니다. ")
PAIRS = [  # (이름, 위험 문구, 시정 문구)
    ("면책", "회사는 서비스 이용과 관련하여 회원에게 발생한 어떠한 손해에 대하여도 책임을 지지 않습니다.",
     "회사는 서비스 이용과 관련하여 회원에게 발생한 손해에 대하여 회사의 고의 또는 과실이 있는 경우 책임을 집니다."),
    ("환불불가", "구매한 이용권은 어떠한 경우에도 환불되지 않습니다.",
     "구매한 이용권은 구매일로부터 7일 이내에 사용하지 않은 경우 전액 환불받을 수 있습니다."),
    ("일방변경", "회사는 사전 통지 없이 서비스 내용과 이용요금을 임의로 변경할 수 있습니다.",
     "회사는 서비스 내용과 이용요금을 변경하는 경우 적용일 30일 전에 회원에게 개별 통지합니다."),
    ("위약금", "회원이 중도에 해지하는 경우 잔여 기간 이용요금 전액을 위약금으로 지급하여야 합니다.",
     "회원이 중도에 해지하는 경우 이미 이용한 기간의 요금과 잔여 요금의 10%를 공제한 금액을 환급합니다."),
    ("권리제한", "회원은 회사의 결정에 대하여 어떠한 이의도 제기할 수 없습니다.",
     "회원은 회사의 결정에 이의가 있는 경우 고객센터를 통해 이의를 제기할 수 있으며 회사는 7일 이내에 답변합니다."),
    ("청약철회", "디지털 콘텐츠는 결제 즉시 청약철회를 할 수 없습니다.",
     "디지털 콘텐츠는 제공이 개시되지 않은 경우 결제일로부터 7일 이내에 청약철회를 할 수 있습니다."),
]
probe = {"pairs": [], "length_padding": [], "contract_type": {}, "title": [], "truncation": {}, "edge": {}}


def sc(ct: str, texts: list[tuple[str, str | None]]) -> tuple[list[float], list[float]]:
    cl = [ClauseText(f"p{i}", t, ti) for i, (t, ti) in enumerate(texts)]
    return [r["score"] for r in m1.predict(ct, cl)], [r["score"] for r in m2.predict(ct, cl)]


for name, bad, good in PAIRS:
    a1, a2 = sc("ecommerce", [(bad, None), (good, None), (NEUTRAL + bad, None), (bad + " " + NEUTRAL, None)])
    probe["pairs"].append({"name": name, "m1_bad": a1[0], "m1_fixed": a1[1], "m2_bad": a2[0], "m2_fixed": a2[1]})
    probe["length_padding"].append({"name": name, "m1_alone": a1[0], "m1_neutral_before": a1[2], "m1_neutral_after": a1[3],
                                    "m2_alone": a2[0], "m2_neutral_before": a2[2], "m2_neutral_after": a2[3]})
for ct in ("ecommerce", "subscription", "installment", "door_to_door", "general_consumer", "out_of_scope"):
    a1, a2 = sc(ct, [(b, None) for _, b, _ in PAIRS] + [(g, None) for _, _, g in PAIRS])
    probe["contract_type"][ct] = {"m1_bad_mean": round(statistics.mean(a1[:6]), 3), "m1_fixed_mean": round(statistics.mean(a1[6:]), 3),
                                  "m2_bad_mean": round(statistics.mean(a2[:6]), 3), "m2_fixed_mean": round(statistics.mean(a2[6:]), 3)}
for name, bad, _ in PAIRS[:3]:
    a1, a2 = sc("ecommerce", [(bad, None), (bad, name), (bad, "목적")])
    probe["title"].append({"name": name, "m1": a1, "m2": a2})
# 512토큰 절단: 위험 문장을 긴 중립 문단 뒤(맨 끝)에 붙이면?
long_neutral = NEUTRAL * 6
n_tok = len(tok(long_neutral)["input_ids"])
a1, a2 = sc("ecommerce", [(PAIRS[0][1], None), (long_neutral + PAIRS[0][1], None), (PAIRS[0][1] + " " + long_neutral, None)])
probe["truncation"] = {"neutral_tokens": n_tok, "m1": {"alone": a1[0], "risk_at_end": a1[1], "risk_at_start": a1[2]},
                       "m2": {"alone": a2[0], "risk_at_end": a2[1], "risk_at_start": a2[2]}}
a1, a2 = sc("ecommerce", [("", None), ("가", None), ("The company shall not be liable for any damages whatsoever.", None),
                          ("제1조(목적)", None), (NEUTRAL, None)])
probe["edge"] = {k: {"m1": a1[i], "m2": a2[i]} for i, k in enumerate(["empty", "one_char", "english_disclaimer", "heading_only", "neutral_only"])}
OUT["probes"] = probe
print("probes done", flush=True)

# ------------------------------------------------------------------ 5. 06 direct_legal VALIDATION 참고(누수 사건 제외)
train_docs = {r["doc_id"] for r in load(SPLIT / "train.jsonl")} | {r["doc_id"] for r in dv}
v06 = load(D06 / "validation.jsonl")
rows06 = [{"id": r["데이터ID"], "text": r["text"], "title": r.get("title"), "contract_type": "ecommerce", "label": r["label"],
           "leak": (r.get("meta") or {}).get("case_id") in train_docs} for r in v06]
p06, _ = predict_rows(m2, rows06)
s06 = [p["score"] for p in p06]
y06 = [r["label"] for r in rows06]
clean = [i for i, r in enumerate(rows06) if not r["leak"]]
OUT["d06_validation_m2"] = {
    "note": "target 정의 다름(06=법적위험있음, v0=직접형). contract_type 은 ecommerce 로 고정. TEST 는 쓰지 않음",
    "all": metrics(s06, y06), "leak_rows": sum(r["leak"] for r in rows06),
    "no_leak": metrics([s06[i] for i in clean], [y06[i] for i in clean]),
    "contract_type_values_in_06": sorted({r.get("contract_type") for r in v06 if r.get("contract_type")}),
}
print("06", OUT["d06_validation_m2"], flush=True)

# ------------------------------------------------------------------ 6. 게이트웨이 E2E (별도 앱 인스턴스, 포트 없음)
os.environ.update({"MODEL_ROOT": str(MODEL_ROOT), "OLLAMA_WARMUP_ON_START": "false",
                   "MODEL_API_KEY": secrets.token_hex(16)})  # 테스트용 임시 키 — 실제 키를 읽지 않는다
from fastapi.testclient import TestClient  # noqa: E402

from app.main import create_app  # noqa: E402

e2e: dict = {}
with TestClient(create_app()) as c:
    h = {"Authorization": f"Bearer {os.environ['MODEL_API_KEY']}"}
    for _ in range(120):
        if c.app.state.crd.classifiers is not None:
            break
        time.sleep(0.5)
    e2e["v1_models"] = c.get("/v1/models", headers=h).json()
    body = {"contract_type": "ecommerce", "clauses": [{"clause_id": "c1", "text": PAIRS[0][1]}, {"clause_id": "c2", "text": PAIRS[0][2]}]}
    e2e["detect_loophole"] = c.post("/v1/detect/loophole", json=body, headers=h).json()
    e2e["detect_illegal"] = c.post("/v1/detect/illegal", json=body, headers=h).json()
    jb = {"contract_type": "ecommerce", "clauses": [{"clause_id": f"c{i}", "text": r["text"]} for i, r in enumerate(ev[:40])]}
    t = time.perf_counter()
    jid = c.post("/v1/jobs", json=jb, headers=h).json()["job_id"]
    while (j := c.get(f"/v1/jobs/{jid}", headers=h).json())["status"] not in ("done", "failed"):
        time.sleep(0.2)
    e2e["job40"] = {"status": j["status"], "done": j["done"], "total": j["total"], "sec": round(time.perf_counter() - t, 1),
                    "model_versions": j["model_versions"], "errors": sum(1 for r in j["results"] if r.get("error"))}
    e2e["unauthorized_status"] = c.post("/v1/detect/loophole", json=body).status_code
OUT["gateway_e2e"] = e2e
print("e2e", e2e["job40"], flush=True)

(HERE / "results.json").write_text(json.dumps(OUT, ensure_ascii=False, indent=2), encoding="utf-8")
print("저장:", HERE / "results.json")
