"""Jev(TypeSafe System One) 비교 평가 — 조항 위법·편법 여부를 noul(예/아니오 확률)로 묻고 공식 평가셋(model3_eval_gen2)으로 채점한다.

    TYPESAFE_API_KEY=... .venv/bin/python training/jev_eval.py [--dry-run] [--limit N]

- 키: 환경변수 TYPESAFE_API_KEY (없으면 model-server/.env 의 같은 이름) — Vercel AI Gateway 키. 키는 출력·기록하지 않는다
- 엔드포인트: env JEV_URL (기본 Vercel https://ai-gateway.vercel.sh/typesafe/v1/systemone), 모델 env JEV_MODEL (기본 typesafe-ai/jev)
- 비용 상한: 응답의 provider_metadata.gateway.cost 를 누적해 --budget(기본 $0.05) 또는 --max-calls(기본 1000)에 닿으면 즉시 멈춘다
- --probe: 1건만 보내 형식·비용 확인
- 외부 전송 범위: 공개 원천(공정위·표준약관·판례·의결서) 평가 행만. 실제약관 행은 보내지 않는다(policy_hold 등 외부 배포 제한 가능)
- 질문 문구 2종(PROMPTS)을 VAL 로 비교해 고르고, TEST 는 고른 문구로 1회 채점. 비교 대상 = 현재 서빙 M1·M2 점수(같은 행)
- 결과: var/models/model3/m3_round3_v1/jev/{answers.jsonl, jev_result.json}
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

BASE = Path(__file__).resolve().parents[1]
ROOT = BASE.parent
DS = ROOT / "data_source/model_3/datasets/model3_dataset_v2"
OUT = BASE / "var/models/model3/m3_round3_v1/jev"
PUBLIC = {"공정위", "표준약관", "판례", "공정위의결서(case.ftc.go.kr)"}

PROMPTS = {
    "legal": {
        "A": "다음은 소비자 계약(약관)의 한 조항이다. 이 조항의 문언 자체가 약관의 규제에 관한 법률 등 소비자 보호 법령상 무효·위법(불공정)일 위험이 있는가?",
        "B": "You are a Korean consumer-law expert. Does this Korean standard-form contract clause, as written, risk being unfair or invalid under the Korean Act on the Regulation of Terms and Conditions (e.g. excluding liability, restricting refunds or cancellation, unilateral changes, excessive penalties)?",
    },
    "evasion": {
        "A": "다음은 소비자 계약(약관)의 한 조항이다. 겉으로는 적법해 보이도록 쓰였지만 실질적으로 소비자의 권리(환불·해지·청약철회·손해배상 등)를 우회하거나 제한하는 편법 조항인가?",
        "B": "Is this Korean contract clause a loophole: written to look lawful on its face, but in substance circumventing or restricting consumer rights (refund, cancellation, withdrawal, damages) through indirect means such as procedural hurdles, conditions, or vague discretion?",
    },
}


def api_key() -> str:
    k = os.environ.get("TYPESAFE_API_KEY")
    if not k and (BASE / ".env").exists():
        for line in (BASE / ".env").read_text(encoding="utf-8").splitlines():
            if line.startswith("TYPESAFE_API_KEY="):
                k = line.split("=", 1)[1].strip()
    if not k:
        sys.exit("TYPESAFE_API_KEY 가 없습니다(model-server/.env 또는 환경변수)")
    return k


SPENT = {"usd": 0.0, "calls": 0, "tokens": 0}
LIMIT = {"usd": 0.05, "calls": 1000}


class BudgetExceeded(RuntimeError):
    pass


def ask(key: str, text: str, instr: str) -> dict:
    if SPENT["usd"] >= LIMIT["usd"] or SPENT["calls"] >= LIMIT["calls"]:
        raise BudgetExceeded(f"상한 도달 — ${SPENT['usd']:.5f}, {SPENT['calls']}건")
    body = {"model": os.environ.get("JEV_MODEL", "typesafe-ai/jev"), "state": {"clause": text},
            "questions": {"q": {"type": "noul", "instructions": instr}}}
    req = urllib.request.Request(os.environ.get("JEV_URL", "https://ai-gateway.vercel.sh/typesafe/v1/systemone"), data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                resp = json.loads(r.read())
            SPENT["calls"] += 1
            SPENT["tokens"] += int((resp.get("usage") or {}).get("input_tokens", 0))
            cost = ((resp.get("provider_metadata") or {}).get("gateway") or {}).get("cost")
            # 비용 필드가 없으면 공시 단가($0.042/100만 입력 토큰)로 추정
            SPENT["usd"] += float(cost) if cost is not None else int((resp.get("usage") or {}).get("input_tokens", 0)) * 0.042e-6
            return resp
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503) and attempt < 3:
                time.sleep(2 ** attempt); continue
            raise RuntimeError(f"Jev HTTP {e.code}: {e.read()[:200]!r}") from None
    raise RuntimeError("unreachable")


def prob(resp: dict) -> float:
    a = resp["answers"]["q"]
    v = a.get("noul", a.get("value", a.get("probability")))
    if isinstance(v, dict):
        v = v.get("yes", v.get("true"))
    return float(v)


def auc(s, y):
    pos = [a for a, b in zip(s, y) if b]; neg = [a for a, b in zip(s, y) if not b]
    return sum((p > n) + 0.5 * (p == n) for p in pos for n in neg) / (len(pos) * len(neg))


def mets(s, y, th):
    tp = sum(a >= th and b for a, b in zip(s, y)); fp = sum(a >= th and not b for a, b in zip(s, y))
    fn = sum(a < th and b for a, b in zip(s, y)); tn = len(y) - tp - fp - fn
    return {"auc": round(auc(s, y), 4), "f1": round(2 * tp / (2 * tp + fp + fn), 4) if tp else 0.0,
            "recall": round(tp / (tp + fn), 4) if tp + fn else None, "fpr": round(fp / (fp + tn), 4) if fp + tn else None}


def best_th(s, y):
    return max((i / 100 for i in range(2, 99)), key=lambda t: mets(s, y, t)["f1"])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--probe", action="store_true")
    ap.add_argument("--budget", type=float, default=0.05)
    ap.add_argument("--max-calls", type=int, default=1000)
    a = ap.parse_args()
    LIMIT.update(usd=a.budget, calls=a.max_calls)
    load = lambda p: [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l.strip()]
    sets = {"legal": "direct_legal_detector_full", "evasion": "evasion_detector"}
    data = {t: {s: [r for r in load(DS / d / f"{s}.jsonl") if r.get("데이터출처") in PUBLIC] for s in ("validation", "test")} for t, d in sets.items()}
    for t in data:
        for s in data[t]:
            if a.limit:
                data[t][s] = data[t][s][:a.limit]
            print(t, s, len(data[t][s]), "행 (양성", sum(r["label"] for r in data[t][s]), ")")
    if a.dry_run:
        r = data["legal"]["validation"][0]
        print(json.dumps({"model": "jev-latest", "state": {"clause": r["text"][:80] + "…"}, "questions": {"q": {"type": "noul", "instructions": PROMPTS["legal"]["A"]}}}, ensure_ascii=False, indent=1))
        return
    key = api_key()
    if a.probe:
        r = data["legal"]["validation"][0]
        resp = ask(key, r["text"], PROMPTS["legal"]["A"])
        print("probe label", r["label"], "answer", json.dumps(resp.get("answers"), ensure_ascii=False), "usage", resp.get("usage"), f"cost ${SPENT['usd']:.7f}")
        return
    OUT.mkdir(parents=True, exist_ok=True)
    res, lat = {}, []
    with (OUT / "answers.jsonl").open("a", encoding="utf-8") as fh:
        for t in sets:
            yv = [r["label"] for r in data[t]["validation"]]
            val = {}
            for pid, instr in PROMPTS[t].items():
                s = []
                for r in data[t]["validation"]:
                    t0 = time.monotonic(); resp = ask(key, r["text"], instr); lat.append(time.monotonic() - t0)
                    s.append(prob(resp))
                    fh.write(json.dumps({"task": t, "split": "validation", "prompt": pid, "id": r["데이터ID"], "p": s[-1], "model": resp.get("model")}, ensure_ascii=False) + "\n")
                val[pid] = s
                print(t, "VAL", pid, mets(s, yv, 0.5), flush=True)
            pid = max(val, key=lambda k: auc(val[k], yv)); th = best_th(val[pid], yv)
            yt = [r["label"] for r in data[t]["test"]]; st = []
            for r in data[t]["test"]:
                t0 = time.monotonic(); resp = ask(key, r["text"], PROMPTS[t][pid]); lat.append(time.monotonic() - t0)
                st.append(prob(resp))
                fh.write(json.dumps({"task": t, "split": "test", "prompt": pid, "id": r["데이터ID"], "p": st[-1], "model": resp.get("model")}, ensure_ascii=False) + "\n")
            res[t] = {"prompt": pid, "threshold": th, "val": {k: mets(v, yv, th) for k, v in val.items()}, "test@th": mets(st, yt, th),
                      "test@0.5": mets(st, yt, 0.5), "n_val": len(yv), "n_test": len(yt)}
            print(t, "TEST", res[t]["test@th"], flush=True)
    print(f"비용 합계 ${SPENT['usd']:.5f} · 호출 {SPENT['calls']}건 · 입력 토큰 {SPENT['tokens']}")
    res["spent"] = dict(SPENT)
    lat.sort()
    res["latency_sec"] = {"p50": round(lat[len(lat) // 2], 3), "p95": round(lat[int(len(lat) * 0.95)], 3), "calls": len(lat)}
    (OUT / "jev_result.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps(res["latency_sec"]))


if __name__ == "__main__":
    main()
