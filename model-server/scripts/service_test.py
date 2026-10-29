"""실행 중인 게이트웨이(기본 http://127.0.0.1:9542) 종합 점검 — 계약(model-api.openapi.yaml) 스키마로 응답 검증.

    cd model-server && .venv/bin/python scripts/service_test.py            # 전체(M3·M4 는 공유 Ollama 2~3회 호출)
    .venv/bin/python scripts/service_test.py --no-llm                       # M3·M4 호출 생략
    MODEL_API_BASE_URL=http://127.0.0.1:9542 .venv/bin/python scripts/service_test.py --out docs/service-test-result.json

키는 model-server/.env 의 MODEL_API_KEY 를 읽기만 한다(출력·저장하지 않음). 요청 본문은 합성 조항만 쓴다.
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import datetime as dt
import json
import os
import sys
import time
import uuid
from pathlib import Path

import httpx
import jsonschema
import yaml

MS = Path(__file__).resolve().parents[1]
CONTRACT = MS.parent / "specs/002-contract-risk-detection/contracts/model-api.openapi.yaml"
LOG = Path.home() / "Library/Logs/crd-model-server.log"

BAD = "회사는 서비스 이용과 관련하여 회원에게 발생한 어떠한 손해에 대하여도 책임을 지지 않습니다."
GOOD = "회원은 아이디와 비밀번호를 제3자에게 이용하게 하여서는 안 됩니다."
REFUND = "구매한 이용권은 어떠한 경우에도 환불되지 않습니다."


def api_key() -> str:
    if os.environ.get("MODEL_API_KEY"):
        return os.environ["MODEL_API_KEY"]
    for line in (MS / ".env").read_text(encoding="utf-8").splitlines():
        if line.startswith("MODEL_API_KEY="):
            return line.partition("=")[2].strip().strip('"').strip("'")
    sys.exit("MODEL_API_KEY 를 찾을 수 없습니다(.env)")


class Contract:
    """OpenAPI 의 $ref 를 풀어 응답 스키마를 jsonschema 로 검증한다(nullable → type 배열)."""

    def __init__(self, path: Path):
        self.doc = yaml.safe_load(path.read_text(encoding="utf-8"))

    def _resolve(self, node):
        if isinstance(node, dict):
            if "$ref" in node:
                cur = self.doc
                for part in node["$ref"].lstrip("#/").split("/"):
                    cur = cur[part]
                return self._resolve(cur)
            out = {k: self._resolve(v) for k, v in node.items() if k not in ("example", "description")}
            if out.pop("nullable", False) and "type" in out:
                out["type"] = [out["type"], "null"]
            return out
        if isinstance(node, list):
            return [self._resolve(x) for x in node]
        return node

    def schema(self, path: str, method: str, code: str) -> dict:
        resp = self._resolve(self.doc["paths"][path][method]["responses"][code])
        return resp["content"]["application/json"]["schema"]


class Runner:
    def __init__(self, base: str, key: str, llm: bool):
        self.c = httpx.Client(base_url=base, timeout=330)
        self.h = {"Authorization": f"Bearer {key}"}
        self.contract = Contract(CONTRACT)
        self.llm = llm
        self.results: list[dict] = []

    def check(self, tid: str, name: str, fn) -> None:
        t0 = time.perf_counter()
        try:
            detail = fn() or ""
            ok = True
        except AssertionError as e:
            ok, detail = False, f"실패: {e}"
        except Exception as e:  # noqa: BLE001
            ok, detail = False, f"오류: {type(e).__name__}: {e}"
        ms = round((time.perf_counter() - t0) * 1000)
        self.results.append({"id": tid, "name": name, "ok": ok, "ms": ms, "detail": detail})
        print(f"{'PASS' if ok else 'FAIL'} {tid} {name} ({ms}ms) {detail}", flush=True)

    def validate(self, body, path: str, method: str, code: str) -> None:
        jsonschema.validate(body, self.contract.schema(path, method, code))

    def detect_body(self, n: int = 3, ct: str = "ecommerce") -> dict:
        texts = [BAD, GOOD, REFUND]
        return {"contract_type": ct,
                "clauses": [{"clause_id": f"c{i}", "text": texts[i % 3], "title": None} for i in range(n)]}

    # ---------------------------------------------------------------- 점검 항목
    def run(self) -> None:
        c, h = self.c, self.h

        def t_health():
            r = c.get("/health", headers=h)
            assert r.status_code == 200, f"status {r.status_code}"
            b = r.json()
            self.validate(b, "/health", "get", "200")
            m = {x["id"]: x for x in b["models"]}
            assert "heuristic" not in m["M1"]["model"] and "heuristic" not in m["M2"]["model"], \
                f"M1·M2 가 휴리스틱: {m['M1']['model']}, {m['M2']['model']}"
            return f"status={b['status']} M1={m['M1']['model']} M2={m['M2']['model']} M3={m['M3']['state']} queue={b['queue_depth']}"
        self.check("T01", "GET /health — 200·계약 스키마·M1·M2 실모델", t_health)

        def t_models():
            r = c.get("/v1/models", headers=h)
            assert r.status_code == 200
            b = r.json()
            self.validate(b, "/v1/models", "get", "200")
            v = {x["id"]: x["model_version"] for x in b["models"]}
            return json.dumps(v, ensure_ascii=False)
        self.check("T02", "GET /v1/models — 모델 버전", t_models)

        def t_auth():
            paths = [("get", "/health"), ("get", "/v1/models"), ("post", "/v1/detect/loophole"), ("post", "/v1/detect/illegal"),
                     ("post", "/v1/jobs"), ("get", "/v1/jobs/x"), ("post", "/v1/judge"), ("post", "/v1/summarize")]
            bad = []
            for m, p in paths:
                for hdr in ({}, {"Authorization": "Bearer wrong-key"}, {"Authorization": "Basic abc"}):
                    r = c.request(m, p, headers=hdr, json={})
                    if r.status_code != 401:
                        bad.append(f"{m} {p} {hdr and list(hdr.values())[0][:6]} → {r.status_code}")
            assert not bad, "; ".join(bad)
            return f"{len(paths)}개 엔드포인트 × 3가지(없음·틀린 키·Basic) 모두 401"
        self.check("T03", "인증 — 키 없음·틀림은 401", t_auth)

        def t_detect(path: str, mid: str):
            def f():
                body = self.detect_body(3)
                r = c.post(path, headers=h, json=body)
                assert r.status_code == 200, f"status {r.status_code} {r.text[:200]}"
                b = r.json()
                self.validate(b, path, "post", "200")
                assert [x["clause_id"] for x in b["results"]] == ["c0", "c1", "c2"], "순서·ID 불일치"
                s = [x["score"] for x in b["results"]]
                assert s[0] >= 0.5 and s[1] < 0.5, f"예상 판정과 다름: {s}"
                return f"{b['model_version']} scores={s} labels={[x['label'] for x in b['results']]}"
            return f
        self.check("T04", "POST /v1/detect/loophole — M1", t_detect("/v1/detect/loophole", "M1"))
        self.check("T05", "POST /v1/detect/illegal — M2", t_detect("/v1/detect/illegal", "M2"))

        def t_m2_laws():
            b = c.post("/v1/detect/illegal", headers=h, json=self.detect_body(1)).json()
            x = b["results"][0]
            assert isinstance(x["related_laws"], list) and x["type"], "related_laws·type 없음"
            return f"type={x['type']} related_laws={x['related_laws']}"
        self.check("T06", "M2 관련 법률 필드", t_m2_laws)

        def t_determinism():
            body = self.detect_body(6)
            a = c.post("/v1/detect/loophole", headers=h, json=body).json()["results"]
            b = c.post("/v1/detect/loophole", headers=h, json=body).json()["results"]
            one = c.post("/v1/detect/loophole", headers=h, json={"contract_type": "ecommerce", "clauses": [body["clauses"][2]]}).json()["results"][0]
            assert a == b, "같은 요청 두 번의 결과가 다름"
            assert one["score"] == a[2]["score"], f"단건({one['score']})과 배치({a[2]['score']}) 점수 다름"
            return "반복·단건/배치 점수 일치"
        self.check("T07", "결정성 — 반복·배치 크기와 무관", t_determinism)

        def t_validation():
            cases = {
                "contract_type 없음": {"clauses": [{"clause_id": "a", "text": BAD}]},
                "clauses 빈 배열": {"contract_type": "ecommerce", "clauses": []},
                "clause_id 없음": {"contract_type": "ecommerce", "clauses": [{"text": BAD}]},
                "text 숫자형": {"contract_type": "ecommerce", "clauses": [{"clause_id": "a", "text": 1}]},
            }
            bad = []
            for name, body in cases.items():
                r = c.post("/v1/detect/loophole", headers=h, json=body)
                if r.status_code != 400:
                    bad.append(f"{name}→{r.status_code}")
                elif BAD in r.text:
                    bad.append(f"{name}: 오류 응답에 입력 원문이 들어감")
            r = c.post("/v1/detect/loophole", headers={**h, "content-type": "application/json"}, content=b"{not json")
            if r.status_code != 400:
                bad.append(f"깨진 JSON→{r.status_code}")
            assert not bad, "; ".join(bad)
            return f"{len(cases) + 1}가지 잘못된 입력 모두 400, 응답에 원문 없음"
        self.check("T08", "입력 검증 — 400", t_validation)

        def t_limits():
            body = {"contract_type": "ecommerce", "clauses": [{"clause_id": f"c{i}", "text": "가"} for i in range(2001)]}
            r1 = c.post("/v1/detect/loophole", headers=h, json=body)
            r2 = c.post("/v1/jobs", headers=h, json=body)
            big = json.dumps({"contract_type": "ecommerce", "clauses": [{"clause_id": "a", "text": "가" * 7_000_000}]}).encode()
            r3 = c.post("/v1/detect/loophole", headers={**h, "content-type": "application/json"}, content=big)
            codes = (r1.status_code, r2.status_code, r3.status_code)
            assert codes == (413, 413, 413), f"2001조항 detect·jobs, 20MB 초과 본문 → {codes}"
            return f"2001조항 detect·jobs 413, 본문 {len(big) / 1e6:.0f}MB → 413"
        self.check("T09", "크기 한도 — 413", t_limits)

        def t_jobs():
            n = 100
            texts = [BAD, GOOD, REFUND, GOOD + " " + GOOD]
            body = {"contract_type": "subscription",
                    "clauses": [{"clause_id": f"j{i}", "text": texts[i % 4]} for i in range(n)]}
            t0 = time.perf_counter()
            r = c.post("/v1/jobs", headers=h, json=body)
            assert r.status_code == 202, f"status {r.status_code}"
            self.validate(r.json(), "/v1/jobs", "post", "202")
            jid = r.json()["job_id"]
            while True:
                g = c.get(f"/v1/jobs/{jid}", headers=h)
                b = g.json()
                if b["status"] in ("done", "failed"):
                    break
                assert time.perf_counter() - t0 < 120, "120초 안에 끝나지 않음"
                time.sleep(0.3)
            sec = time.perf_counter() - t0
            self.validate(b, "/v1/jobs/{id}", "get", "200")
            assert b["status"] == "done" and b["done"] == n and len(b["results"]) == n, f"{b['status']} {b['done']}/{n}"
            errs = sum(1 for x in b["results"] if x.get("error"))
            assert errs == 0, f"오류 {errs}건"
            return f"100조항 {sec:.1f}초, 오류 0, versions={b['model_versions']}"
        self.check("T10", "POST /v1/jobs → GET /v1/jobs/{id} — 100조항 문서", t_jobs)

        def t_job404():
            r = c.get(f"/v1/jobs/{uuid.uuid4().hex}", headers=h)
            assert r.status_code == 404, f"status {r.status_code}"
            return "404"
        self.check("T11", "없는 작업 조회 — 404", t_job404)

        def t_concurrency():
            def one(i):
                return c.post("/v1/detect/illegal", headers=h, json=self.detect_body(16)).status_code
            with cf.ThreadPoolExecutor(8) as ex:
                codes = list(ex.map(one, range(8)))
            assert all(x == 200 for x in codes), f"{codes}"
            return "동시 8요청(각 16조항) 모두 200"
        self.check("T12", "동시 요청", t_concurrency)

        def t_request_id():
            rid = "svc-test-" + uuid.uuid4().hex[:8]
            r = c.get("/health", headers={**h, "x-request-id": rid})
            assert r.headers.get("x-request-id") == rid, "x-request-id 되돌림 없음"
            r2 = c.get("/health", headers=h)
            assert r2.headers.get("x-request-id"), "x-request-id 자동 생성 없음"
            return "지정 ID 되돌림·미지정 시 생성"
        self.check("T13", "요청 ID 헤더", t_request_id)

        def t_contract_type():
            out = {}
            for ct in ("ecommerce", "subscription", "installment", "door_to_door", "general_consumer", "out_of_scope", "unknown_type"):
                r = c.post("/v1/detect/illegal", headers=h, json={"contract_type": ct, "clauses": [{"clause_id": "a", "text": BAD}]})
                assert r.status_code == 200, f"{ct} → {r.status_code}"
                out[ct] = r.json()["results"][0]["score"]
            return json.dumps(out, ensure_ascii=False)
        self.check("T14", "계약 유형 6종 + 미정의 값", t_contract_type)

        if self.llm:
            def t_judge():
                body = {"clause": BAD, "contract_type": "ecommerce", "perspective": "business",
                        "knowledge_date": dt.date.today().isoformat(), "scores": {"loophole": 0.92, "illegal": 0.90},
                        "evidence": [{"id": "ev-1", "source_type": "law_article", "title": "약관의 규제에 관한 법률 제7조",
                                      "text": "사업자, 이행 보조자 또는 피고용자의 고의 또는 중대한 과실로 인한 법률상의 책임을 배제하는 조항은 무효로 한다."}]}
                t0 = time.perf_counter()
                r = c.post("/v1/judge", headers=h, json=body)
                assert r.status_code == 200, f"status {r.status_code} {r.text[:200]}"
                b = r.json()
                self.validate(b, "/v1/judge", "post", "200")
                ids = {i for e in b["explanation"] for i in e["evidence_ids"]}
                assert ids <= {"ev-1"}, f"없는 근거 ID 인용: {ids}"
                return f"{time.perf_counter() - t0:.1f}초 risk_class={b['risk_class']} level={b.get('risk_level')} 설명 {len(b['explanation'])}개 {b['model_version']}"
            self.check("T15", "POST /v1/judge — M3 (공유 Ollama)", t_judge)

            def t_judge_invalid():
                base = {"clause": BAD, "contract_type": "ecommerce", "perspective": "business", "knowledge_date": "2026-09-29",
                        "scores": {}, "evidence": []}
                bad = []
                for name, patch in {"관점 오류": {"perspective": "admin"}, "점수 범위 초과": {"scores": {"loophole": 1.5}},
                                    "근거 11개": {"evidence": [{"id": str(i), "source_type": "law_article", "title": "t", "text": "x"} for i in range(11)]},
                                    "날짜 형식": {"knowledge_date": "어제"}, "빈 조항": {"clause": ""}}.items():
                    r = c.post("/v1/judge", headers=h, json={**base, **patch})
                    if r.status_code != 400:
                        bad.append(f"{name}→{r.status_code}")
                assert not bad, "; ".join(bad)
                return "5가지 잘못된 입력 모두 400(Ollama 호출 없음)"
            self.check("T16", "POST /v1/judge 입력 검증", t_judge_invalid)

            def t_summarize():
                body = {"clauses": [{"clause_id": "s1", "title": "목적", "text": "이 약관은 회사가 제공하는 구독형 동영상 서비스의 이용 조건을 정합니다."},
                                    {"clause_id": "s2", "title": "요금", "text": "이용요금은 매월 결제일에 등록된 결제수단으로 자동 결제됩니다."},
                                    {"clause_id": "s3", "title": "환불", "text": REFUND}]}
                t0 = time.perf_counter()
                r = c.post("/v1/summarize", headers=h, json=body)
                assert r.status_code == 200, f"status {r.status_code} {r.text[:200]}"
                b = r.json()
                self.validate(b, "/v1/summarize", "post", "200")
                cands = [x["label"] for x in b["contract_type_candidates"]]
                return f"{time.perf_counter() - t0:.1f}초 후보={cands} 요약 {len(b['summary'])}자"
            self.check("T17", "POST /v1/summarize — M4 (공유 Ollama)", t_summarize)

        def t_docs():
            a = c.get("/openapi.json")
            d = c.get("/docs")
            assert a.status_code == 200 and d.status_code == 200
            paths = sorted(a.json()["paths"])
            return f"/docs·/openapi.json 200 (인증 없음), 경로 {paths}"
        self.check("T18", "API 문서 페이지", t_docs)

        def t_log_privacy():
            if not LOG.is_file():
                return "로그 파일 없음 — 건너뜀"
            txt = LOG.read_text(encoding="utf-8", errors="ignore")
            for s in (BAD, GOOD, REFUND, "구독형 동영상"):
                assert s not in txt, "로그에 요청 조항 원문이 남음"
            assert "Bearer " not in txt, "로그에 인증 헤더가 남음"
            return f"로그({LOG.name})에 조항 원문·키 없음"
        self.check("T19", "로그에 원문·키가 남지 않음", t_log_privacy)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=os.environ.get("MODEL_API_BASE_URL", "http://127.0.0.1:9542"))
    ap.add_argument("--no-llm", action="store_true", help="M3·M4(공유 Ollama) 호출 점검 생략")
    ap.add_argument("--out", help="결과 JSON 저장 경로")
    a = ap.parse_args()
    r = Runner(a.base, api_key(), not a.no_llm)
    t0 = time.perf_counter()
    r.run()
    passed = sum(x["ok"] for x in r.results)
    summary = {"base": a.base, "at": dt.datetime.now().isoformat(timespec="seconds"), "passed": passed,
               "total": len(r.results), "sec": round(time.perf_counter() - t0, 1), "results": r.results}
    print(f"\n{passed}/{len(r.results)} 통과 ({summary['sec']}초)")
    if a.out:
        Path(a.out).write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    sys.exit(0 if passed == len(r.results) else 1)


if __name__ == "__main__":
    main()
