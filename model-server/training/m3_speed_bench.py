"""M3 판정 속도·품질 비교(2026-09-30) — 같은 요청을 설정별로 공유 Ollama 에 직접 보내 입력 처리·생성 시간과 판정 일치를 잰다.

    .venv/bin/python training/m3_speed_bench.py <requests.jsonl(search-batch 출력)> <meta.jsonl> <out.json>

- 게이트웨이와 같은 본문(temperature 0·seed 0·num_ctx 8192·keep_alive 5m·JSON 스키마). 한 번에 1건(가이드 동시 1건)
- 설정: base(현재) · short2(설명 ≤2개·문장 ≤80자·num_predict 350) · short1(설명 1개·≤80자·num_predict 250)
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


def variant(n_items: int | None, max_len: int | None, num_predict: int, keep_prompt: bool = False):
    sysm = JUDGE_SYSTEM
    if n_items and not keep_prompt:
        rule = f"7. explanation 은 {'1개' if n_items == 1 else f'최대 {n_items}개'}의 짧고 쉬운 한국어 문장입니다(각 {max_len}자 이내). 각 문장에는 그 문장을 뒷받침하는 근거 id 를 evidence_ids 에 넣습니다."
        sysm = "\n".join(rule if l.startswith("7. ") else l for l in JUDGE_SYSTEM.splitlines())

    def schema(ids):
        sc = copy.deepcopy(TPL)
        if n_items:
            sc["properties"]["explanation"]["maxItems"] = n_items
            sc["properties"]["explanation"]["items"]["properties"]["claim"]["maxLength"] = max_len
        return build_judge_schema(sc, ids)
    return sysm, schema, num_predict


ALL = {"base": variant(None, None, 700), "short2": variant(2, 80, 350), "short1": variant(1, 80, 250),
       # 안내문은 그대로, 출력 스키마만 줄임 → 범주(risk_class)는 base 와 같은 토큰이 먼저 생성된다
       "schema2": variant(2, 80, 350, keep_prompt=True), "schema1": variant(1, 80, 250, keep_prompt=True)}
VARIANTS = {k: ALL[k] for k in (sys.argv[4].split(",") if len(sys.argv) > 4 else ["base", "short2", "short1"])}


def chat(body):
    req = urllib.request.Request("http://127.0.0.1:11434/api/chat", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read())


def main():
    reqs = [json.loads(l) for l in open(sys.argv[1], encoding="utf-8") if l.strip()]
    meta = {m["id"]: m for m in (json.loads(l) for l in open(sys.argv[2], encoding="utf-8") if l.strip())}
    out = {k: [] for k in VARIANTS}
    for i, q in enumerate(reqs):
        m = meta[q["id"]]
        user = LlmService.judge_prompt({"contract_type": m["ct"], "knowledge_date": q["knowledge_date"], "perspective": "consumer",
                                        "scores": {}, "clause": m["text"], "evidence": q["evidence"]})
        ids = [str(e["id"]) for e in q["evidence"]]
        for name, (sysm, schema, npred) in VARIANTS.items():
            body = {"model": MODEL, "messages": [{"role": "system", "content": sysm}, {"role": "user", "content": user}],
                    "stream": False, "think": False, "keep_alive": "5m", "format": schema(ids),
                    "options": {"temperature": 0, "top_k": 1, "seed": 0, "num_ctx": 8192, "num_predict": npred}}
            t0 = time.monotonic(); r = chat(body); wall = time.monotonic() - t0
            try:
                d = json.loads(r["message"]["content"]); rc = d.get("risk_class"); ex = d.get("explanation") or []
            except Exception:
                rc, ex = "PARSE_ERROR", []
            out[name].append({"id": q["id"], "label": m["label"], "risk_class": rc, "n_claims": len(ex),
                              "claim_chars": sum(len(c.get("claim", "")) for c in ex if isinstance(c, dict)),
                              "claims_with_evidence": sum(1 for c in ex if isinstance(c, dict) and c.get("evidence_ids")),
                              "wall": round(wall, 3), "load": round(r.get("load_duration", 0) / 1e9, 3),
                              "prompt_tokens": r.get("prompt_eval_count"), "prompt_sec": round(r.get("prompt_eval_duration", 0) / 1e9, 3),
                              "gen_tokens": r.get("eval_count"), "gen_sec": round(r.get("eval_duration", 0) / 1e9, 3)})
        print(f"{i + 1}/{len(reqs)} " + " ".join(f"{k}:{v[-1]['risk_class']}/{v[-1]['wall']:.1f}s" for k, v in out.items()), flush=True)
    Path(sys.argv[3]).write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
