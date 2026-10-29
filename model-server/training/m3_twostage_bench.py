"""M3 2단계(범주 먼저 → 설명 나중) 속도·일치 비교(2026-09-30). 같은 요청을 공유 Ollama 에 1건씩 보낸다.

    .venv/bin/python training/m3_twostage_bench.py <requests.jsonl> <meta.jsonl> <out.json>

A current  : 현재 서빙(설명 1문장 + 범주, num_predict 300)
B classonly: 설명 0개(explanation maxItems 0) — 범주만. 1단계
C stage2   : B 가 위험(normal 아님)으로 본 조항만, 범주를 고정(enum 1개)하고 설명 1문장 생성. 2단계
Ollama 는 JSON 필드를 알파벳 순서로 쓴다(confidence → explanation → risk_class …) — A 는 설명을 쓴 뒤 범주를 정한다
"""
from __future__ import annotations

import copy
import json
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.llm import JUDGE_SYSTEM, LlmService, build_judge_schema  # noqa: E402

MODEL = "qwen3:4b-instruct-2507-q4_K_M"
TPL = json.loads((Path(__file__).resolve().parents[1] / "schemas/judge.json").read_text(encoding="utf-8"))


def chat(user, schema, npred):
    body = {"model": MODEL, "messages": [{"role": "system", "content": JUDGE_SYSTEM}, {"role": "user", "content": user}],
            "stream": False, "think": False, "keep_alive": "5m", "format": schema,
            "options": {"temperature": 0, "top_k": 1, "seed": 0, "num_ctx": 8192, "num_predict": npred}}
    t0 = time.monotonic()
    req = urllib.request.Request("http://127.0.0.1:11434/api/chat", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        resp = json.loads(r.read())
    return json.loads(resp["message"]["content"]), time.monotonic() - t0, resp.get("eval_count")


def schema(ids, n_items, fixed=None):
    sc = copy.deepcopy(TPL)
    sc["properties"]["explanation"]["maxItems"] = n_items
    if n_items:
        sc["properties"]["explanation"]["minItems"] = 1
    if fixed:  # 2단계: 1단계 범주·유형·수준·확신도를 고정
        for k in ("risk_class", "risk_type", "risk_level", "confidence"):
            sc["properties"][k] = {"type": "string", "enum": [fixed[k]]} if fixed.get(k) else {"type": "null"}
    return build_judge_schema(sc, ids) if n_items else _no_expl(sc)


def _no_expl(sc):
    sc["properties"]["explanation"] = {"type": "array", "maxItems": 0, "items": {"type": "object"}}
    return sc


def main():
    reqs = [json.loads(l) for l in open(sys.argv[1], encoding="utf-8") if l.strip()]
    meta = {m["id"]: m for m in (json.loads(l) for l in open(sys.argv[2], encoding="utf-8") if l.strip())}
    out = []
    for i, q in enumerate(reqs):
        m = meta[q["id"]]
        user = LlmService.judge_prompt({"contract_type": m["ct"], "knowledge_date": q["knowledge_date"], "perspective": "consumer",
                                        "scores": {}, "clause": m["text"], "evidence": q["evidence"]})
        ids = [str(e["id"]) for e in q["evidence"]]
        a, ta, _ = chat(user, schema(ids, 1), 300)
        b, tb, gb = chat(user, schema(ids, 0), 60)
        rec = {"id": q["id"], "label": m["label"], "A": a.get("risk_class"), "A_t": round(ta, 3), "A_claim": (a.get("explanation") or [{}])[0].get("claim"),
               "B": b.get("risk_class"), "B_t": round(tb, 3), "B_tokens": gb, "C_t": 0.0, "C_claim": None}
        if b.get("risk_class") not in (None, "normal"):
            fixed = {k: b.get(k) for k in ("risk_class", "risk_type", "risk_level", "confidence")}
            c, tc, _ = chat(user + f"\n\n판정(확정): {b['risk_class']} — 이 판정의 이유를 설명하세요.", schema(ids, 1, fixed), 300)
            ex = (c.get("explanation") or [{}])[0]
            rec.update(C_t=round(tc, 3), C_claim=ex.get("claim"), C_has_ev=bool(ex.get("evidence_ids")), C_class=c.get("risk_class"))
        out.append(rec)
        print(f"{i + 1}/{len(reqs)} A {rec['A']}/{ta:.1f}s  B {rec['B']}/{tb:.1f}s  C {rec['C_t']:.1f}s", flush=True)
    Path(sys.argv[3]).write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
