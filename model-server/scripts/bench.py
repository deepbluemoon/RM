"""착수 전 측정 — model-serving §8.2 의 1~4·6번 (공유 Ollama §0 구성에 맞춤). 실행 결과는 bench-results/*.json.

    uv run python scripts/bench.py convert            # 1. bf16 GGUF ↔ transformers 원본 출력 일치(20건, extra classifiers 필요)
    uv run python scripts/bench.py m3                 # 2. M3 처리량 — 클라이언트 동시 1·2·4·6 (게이트웨이가 1건으로 직렬화)
    uv run python scripts/bench.py m4 [--samples DIR] # 3. M4 30쪽 5건
    uv run python scripts/bench.py schema [--n 200]   # 4. 구조화 출력 스키마 준수율
    uv run python scripts/bench.py soak --hours 24    # 6. 연속 부하 — RSS·스왑·재시작 감시
    uv run python scripts/bench.py detect [--n 100]   # API 점검 C1~C5·C7 기준선 — M1 /v1/detect/loophole (Ollama 안 부름)

게이트웨이가 떠 있어야 한다(기본 http://127.0.0.1:9542, env MODEL_API_BASE_URL). 키는 env MODEL_API_KEY.
공유 서버이므로 사용자가 적은 시간대에 돌리고, 게이트웨이 밖에서 Ollama 를 병렬로 부르지 않는다.
합격 기준(§8.2 원문): 1) 분류·위험도 100% 일치 2) 30건 ≤ 85초 3) ≤ 15초 4) 위반 0건 6) 누수·스왑·재시작 없음.
동시 1건(§0)에서는 2)가 150~210초로 예상되어 불합격 가능 — 결과를 팀 결정에 올린다.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import statistics
import subprocess
import sys
import time
from pathlib import Path

import httpx

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE))
OUT = BASE / "bench-results"
URL = os.environ.get("MODEL_API_BASE_URL", "http://127.0.0.1:9542")
HDR = {"Authorization": f"Bearer {os.environ.get('MODEL_API_KEY', '')}"}

CLAUSES = [
    ("환불", "결제 후 7일이 지나면 어떠한 경우에도 환불되지 않습니다."),
    ("면책", "회사는 서비스 장애로 인한 손해에 대하여 일체의 책임을 지지 않습니다."),
    ("변경", "회사는 사전 통지 없이 요금과 서비스 내용을 변경할 수 있습니다."),
    ("위약금", "회원이 약정 기간 중 해지하는 경우 잔여 기간 이용료 전액을 위약금으로 납부합니다."),
    ("목적", "이 약관은 회사가 제공하는 구독 서비스의 이용 조건을 정합니다."),
    ("관할", "이 계약에 관한 분쟁은 회사 본점 소재지 법원을 전속 관할로 합니다."),
]
EVIDENCE = [
    {"id": "ev1", "source_type": "law_article", "title": "약관의 규제에 관한 법률 제6조",
     "text": "신의성실의 원칙을 위반하여 공정성을 잃은 약관 조항은 무효로 한다."},
    {"id": "ev2", "source_type": "law_article", "title": "약관의 규제에 관한 법률 제8조",
     "text": "고객에게 부당하게 과중한 지연 손해금 등의 손해배상 의무를 부담시키는 약관 조항은 무효로 한다."},
    {"id": "ev3", "source_type": "law_article", "title": "전자상거래 등에서의 소비자보호에 관한 법률 제17조",
     "text": "소비자는 계약내용에 관한 서면을 받은 날부터 7일 이내에 청약철회를 할 수 있다."},
]


def judge_req(i: int, perspective: str = "consumer") -> dict:
    title, text = CLAUSES[i % len(CLAUSES)]
    return {"clause": f"제{i + 1}조({title}) {text}", "contract_type": "subscription", "perspective": perspective,
            "knowledge_date": "2026-09-01", "scores": {"loophole": 0.6, "illegal": 0.5}, "evidence": EVIDENCE}


def save(name: str, data: dict) -> None:
    OUT.mkdir(exist_ok=True)
    p = OUT / f"{name}-{time.strftime('%Y%m%d-%H%M%S')}.json"
    p.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(data, ensure_ascii=False, indent=2))
    print(f"→ {p}")


# ---------------------------------------------------------------- 2. M3 처리량
async def bench_m3(args) -> None:
    res = {}
    async with httpx.AsyncClient(base_url=URL, headers=HDR, timeout=900) as c:
        await c.post("/v1/judge", json=judge_req(0))  # 적재 제외(예열)
        for conc in (1, 2, 4, 6):
            sem = asyncio.Semaphore(conc)
            lat: list[float] = []

            async def one(i):
                async with sem:
                    t = time.perf_counter()
                    r = await c.post("/v1/judge", json=judge_req(i))
                    r.raise_for_status()
                    lat.append(time.perf_counter() - t)

            t0 = time.perf_counter()
            await asyncio.gather(*(one(i) for i in range(args.n)))
            total = time.perf_counter() - t0
            per30 = total / args.n * 30
            res[f"client_conc_{conc}"] = {"n": args.n, "total_sec": round(total, 1), "per30_sec": round(per30, 1),
                                          "p50_sec": round(statistics.median(lat), 2), "pass_85s": per30 <= 85}
    save("m3-throughput", res)


# ---------------------------------------------------------------- 3. M4 30쪽
def synth_doc(pages: int = 30, doc: int = 0) -> list[dict]:
    """30쪽 ≈ 조항 100개 가정. doc 마다 조항 순서·문구가 달라 Ollama 프롬프트 캐시가 적중하지 않는다.
    실제 표본이 있으면 --samples 로 준다(각 파일 = {"clauses": [...]})."""
    out = []
    for i in range(pages * 10 // 3):
        title, text = CLAUSES[(i + doc) % len(CLAUSES)]
        body = f"{text} 이 조항은 제{doc + 1}호 표본 계약의 {i + 1}번째 조항으로, 적용 기간은 {doc + i % 12 + 1}개월로 한다."
        out.append({"clause_id": f"c{i}", "article_no": str(i + 1), "title": title, "text": (body + " ") * 2})
    return out


async def bench_m4(args) -> None:
    docs = ([json.loads(p.read_text(encoding="utf-8"))["clauses"] for p in sorted(Path(args.samples).glob("*.json"))][:5]
            if args.samples else [synth_doc(doc=k) for k in range(5)])
    rows = []
    async with httpx.AsyncClient(base_url=URL, headers=HDR, timeout=900) as c:
        await c.post("/v1/summarize", json={"clauses": synth_doc(3, doc=99)})  # 적재 제외(예열)
        for d in docs:
            t = time.perf_counter()
            r = await c.post("/v1/summarize", json={"clauses": d})
            rows.append({"clauses": len(d), "status": r.status_code, "sec": round(time.perf_counter() - t, 2)})
    save("m4-30pages", {"runs": rows, "pass_15s": all(x["status"] == 200 and x["sec"] <= 15 for x in rows)})


# ---------------------------------------------------------------- 4. 스키마 준수율
async def bench_schema(args) -> None:
    from jsonschema import Draft202012Validator

    from app.config import load_settings
    from app.llm import build_judge_schema

    tpl = json.loads(load_settings().m3.json_schema.read_text(encoding="utf-8"))
    tpl.pop("$comment", None)
    schema = build_judge_schema(tpl, [e["id"] for e in EVIDENCE])
    v = Draft202012Validator(schema)
    viol, errs, kinds = 0, 0, {}
    async with httpx.AsyncClient(base_url=URL, headers=HDR, timeout=900) as c:
        for i in range(args.n):
            r = await c.post("/v1/judge", json=judge_req(i, "consumer" if i % 2 else "business"))
            if r.status_code != 200:
                errs += 1
                kinds[str(r.status_code)] = kinds.get(str(r.status_code), 0) + 1
                continue
            b = r.json()
            body = {k: b[k] for k in ("risk_class", "risk_type", "risk_level", "confidence", "explanation")}
            if list(v.iter_errors(body)):
                viol += 1
    save("schema-compliance", {"n": args.n, "violations": viol, "http_errors": errs, "error_kinds": kinds,
                               "pass": viol == 0 and errs == 0})


# ---------------------------------------------------------------- 1. 변환 일치
def bench_convert(args) -> None:
    """transformers 원본(bf16, MPS/CPU)과 Ollama GGUF 의 판정(risk_class·risk_level) 비교. temperature 0."""
    import torch
    import yaml
    from transformers import AutoModelForCausalLM, AutoTokenizer

    from app.llm import JUDGE_SYSTEM, LlmService

    lock = yaml.safe_load((BASE / "models.lock.yaml").read_text(encoding="utf-8"))["models"]["M3"]
    src = BASE / lock["local_dir"]
    tok = AutoTokenizer.from_pretrained(src)
    dev = "mps" if torch.backends.mps.is_available() else "cpu"
    model = AutoModelForCausalLM.from_pretrained(src, torch_dtype=torch.bfloat16).to(dev).eval()
    same, rows = 0, []
    with httpx.Client(base_url=URL, headers=HDR, timeout=900) as c:
        for i in range(args.n):
            req = judge_req(i)
            ol = c.post("/v1/judge", json=req).json()
            msgs = [{"role": "system", "content": JUDGE_SYSTEM + "\n출력 키: risk_class, risk_type, risk_level, confidence, explanation"},
                    {"role": "user", "content": LlmService.judge_prompt(req)}]
            ids = tok.apply_chat_template(msgs, add_generation_prompt=True, return_tensors="pt").to(dev)
            with torch.inference_mode():
                out = model.generate(ids, max_new_tokens=700, do_sample=False)
            text = tok.decode(out[0, ids.shape[1]:], skip_special_tokens=True)
            try:
                hf = json.loads(text[text.find("{"): text.rfind("}") + 1])
            except json.JSONDecodeError:
                hf = {}
            ok = (hf.get("risk_class"), hf.get("risk_level")) == (ol.get("risk_class"), ol.get("risk_level"))
            same += ok
            rows.append({"i": i, "ollama": [ol.get("risk_class"), ol.get("risk_level")],
                         "hf": [hf.get("risk_class"), hf.get("risk_level")], "match": ok})
    # 주의: HF 쪽은 JSON 스키마 제약 없이 생성하므로 형식 차이로 불일치가 날 수 있다 — rows 를 사람이 확인한다
    save("convert-match", {"n": args.n, "match": same, "pass": same == args.n, "rows": rows})


# ---------------------------------------------------------------- 6. 연속 부하
def _gateway_pid() -> int | None:
    r = subprocess.run(["lsof", "-t", f"-iTCP:{httpx.URL(URL).port}", "-sTCP:LISTEN"], capture_output=True, text=True)
    return int(r.stdout.split()[0]) if r.stdout.strip() else None


def _rss_mb(pid: int) -> float:
    r = subprocess.run(["ps", "-o", "rss=", "-p", str(pid)], capture_output=True, text=True)
    return int(r.stdout.strip() or 0) / 1024


def _swap_used_mb() -> float:
    r = subprocess.run(["sysctl", "-n", "vm.swapusage"], capture_output=True, text=True)
    try:
        return float(r.stdout.split("used = ")[1].split("M")[0])
    except (IndexError, ValueError):
        return -1


async def bench_soak(args) -> None:
    end = time.time() + args.hours * 3600
    pid0 = _gateway_pid()
    samples, errors, restarts, i = [], 0, 0, 0
    async with httpx.AsyncClient(base_url=URL, headers=HDR, timeout=900) as c:
        while time.time() < end:
            try:
                jr = await c.post("/v1/jobs", json={"contract_type": "subscription", "clauses": synth_doc(30)})
                await c.post("/v1/summarize", json={"clauses": synth_doc(10)})
                for k in range(5):
                    await c.post("/v1/judge", json=judge_req(i + k))
                await c.get(f"/v1/jobs/{jr.json()['job_id']}")
            except httpx.HTTPError:
                errors += 1
            i += 5
            pid = _gateway_pid()
            if pid and pid0 and pid != pid0:
                restarts += 1
                pid0 = pid
            if pid and i % 50 == 0:
                samples.append({"t": int(time.time()), "rss_mb": round(_rss_mb(pid), 1), "swap_mb": _swap_used_mb()})
                print(samples[-1], flush=True)
            await asyncio.sleep(args.pause)
    rss = [s["rss_mb"] for s in samples]
    growth = (rss[-1] - rss[0]) if len(rss) > 1 else 0
    save("soak", {"hours": args.hours, "iterations": i, "errors": errors, "restarts": restarts,
                  "rss_growth_mb": round(growth, 1), "swap_max_mb": max((s["swap_mb"] for s in samples), default=0),
                  "samples": samples, "pass": restarts == 0 and growth < 200})


# ---------------------------------------------------------------- API 점검 기준선 (C1~C5·C7)
# 이 함수를 고치면 이전 숫자와 비교할 수 없다(같은 자). 재기 전: /health ready · 중복 서버 없음 · 워커 1 · 배경 작업 없음.
def _pct(xs: list[float], p: int) -> float:
    return round(sorted(xs)[max(0, len(xs) * p // 100 - 1)], 1)  # 정렬해서 p 번째(100건이면 50·95번째)


def detect_req(n: int = 1) -> dict:
    return {"contract_type": "subscription",
            "clauses": [{"clause_id": f"c{i}", "title": CLAUSES[i % len(CLAUSES)][0],
                         "text": CLAUSES[i % len(CLAUSES)][1]} for i in range(n)]}


async def bench_detect(args) -> None:
    path = "/v1/detect/loophole"
    one = detect_req(1)

    async def timed(c: httpx.AsyncClient, body: dict) -> tuple[float, int]:
        t0 = time.perf_counter()
        r = await c.post(path, json=body)
        return (time.perf_counter() - t0) * 1000, r.status_code

    async with httpx.AsyncClient(base_url=URL, headers=HDR, timeout=60) as c:
        h = await c.get("/health")
        if h.status_code != 200:
            sys.exit(f"/health {h.status_code} — ready 가 아니면 재지 않는다")
        # C2·C3 — 새 연결의 1번째 vs 2~5번째 평균
        first = [(await timed(c, one))[0] for _ in range(5)]
    async with httpx.AsyncClient(base_url=URL, headers=HDR, timeout=60) as c:
        for _ in range(5):  # 워밍업은 버린다
            await timed(c, one)
        runs = [await timed(c, one) for _ in range(args.n)]  # C1
        xs = [ms for ms, _ in runs]
        conc = await asyncio.gather(*(timed(c, one) for _ in range(10)))  # C4 동시 10
        # C5 — 32개를 역순으로 넣어 응답 순서·단건과 라벨 일치
        batch = detect_req(32)
        batch["clauses"].reverse()
        mismatch = order_ok = 0
        for kind in ("loophole", "illegal"):
            rb = (await c.post(f"/v1/detect/{kind}", json=batch)).json()["results"]
            order_ok += [x["clause_id"] for x in rb] == [x["clause_id"] for x in batch["clauses"]]
            for cl, got in zip(batch["clauses"], rb):
                s1 = (await c.post(f"/v1/detect/{kind}", json={**batch, "clauses": [cl]})).json()["results"][0]
                mismatch += (s1["label"], s1["score"], s1.get("type")) != (got["label"], got["score"], got.get("type"))
        # C7 — 조항 수 상한 초과 직후 정상 요청
        big = (await c.post(path, json={**one, "clauses": one["clauses"] * 2001})).status_code
        after = await timed(c, one)
    save("detect", {
        "url": URL, "path": path, "n": args.n, "warmup_discarded": 5,
        "c1": {"p50_ms": _pct(xs, 50), "p95_ms": _pct(xs, 95), "min_ms": round(min(xs), 1), "max_ms": round(max(xs), 1),
               "mean_ms": round(statistics.mean(xs), 1), "non200": sum(st != 200 for _, st in runs)},
        "c2": {"first_ms": round(first[0], 1), "next4_mean_ms": round(statistics.mean(first[1:]), 1),
               "ratio": round(first[0] / statistics.mean(first[1:]), 2)},
        "c3": {"second_ms": round(first[1], 1)},
        "c4": {"concurrency": 10, "fail": sum(st != 200 for _, st in conc), "max_ms": round(max(ms for ms, _ in conc), 1)},
        "c5": {"batch": 32, "reversed": True, "order_ok": f"{order_ok}/2", "label_mismatch_vs_single": mismatch},
        "c7": {"over_limit_status": big, "next_status": after[1], "next_ms": round(after[0], 1)},
        "loadavg": [round(x, 2) for x in os.getloadavg()],
    })


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["convert", "m3", "m4", "schema", "soak", "detect"])
    ap.add_argument("--n", type=int, default=None)
    ap.add_argument("--samples")
    ap.add_argument("--hours", type=float, default=24)
    ap.add_argument("--pause", type=float, default=5)
    a = ap.parse_args()
    a.n = a.n or {"convert": 20, "m3": 50, "schema": 200, "detect": 100}.get(a.what, 0)
    if a.what == "convert":
        bench_convert(a)
    else:
        asyncio.run({"m3": bench_m3, "m4": bench_m4, "schema": bench_schema, "soak": bench_soak,
                     "detect": bench_detect}[a.what](a))


if __name__ == "__main__":
    main()
