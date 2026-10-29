"""계약(model-api.openapi.yaml) 응답 형태 검증 — Ollama 는 목."""
import time

from .conftest import AUTH, SHARED, assert_contract

CLAUSES = [
    {"clause_id": "c1", "article_no": "1", "title": "목적", "text": "이 약관은 구독 서비스 이용 조건을 정한다."},
    {"clause_id": "c2", "article_no": "7", "title": "환불", "text": "결제 후에는 어떠한 경우에도 환불되지 않습니다."},
    {"clause_id": "c3", "article_no": "9", "title": "변경", "text": "회사는 사전 통지 없이 요금을 임의로 변경할 수 있다."},
]
JUDGE = {
    "clause": "결제 후에는 어떠한 경우에도 환불되지 않습니다.",
    "contract_type": "subscription", "perspective": "consumer", "knowledge_date": "2026-09-01",
    "scores": {"loophole": 0.6, "illegal": 0.7},
    "evidence": [{"id": "ev1", "source_type": "law_article", "title": "약관의 규제에 관한 법률 제10조", "text": "..."}],
}


def test_health_ready(client):
    r = client.get("/health", headers=AUTH)
    assert r.status_code == 200, r.json()
    assert_contract("/health", "get", 200, r.json())
    assert r.json()["status"] == "ready"
    assert r.json()["queue_depth"] == 0


def test_models(client):
    r = client.get("/v1/models", headers=AUTH)
    assert r.status_code == 200
    assert_contract("/v1/models", "get", 200, r.json())
    ids = [m["id"] for m in r.json()["models"]]
    assert ids == ["M1", "M2", "M3", "M4"]


def test_summarize(client, fake):
    r = client.post("/v1/summarize", headers=AUTH, json={"clauses": CLAUSES})
    assert r.status_code == 200, r.json()
    body = r.json()
    assert_contract("/v1/summarize", "post", 200, body)
    assert [c["label"] for c in body["contract_type_candidates"]] == ["subscription", "ecommerce"]  # 스키마 밖 라벨 제거
    assert body["model_version"] == f"ollama:{SHARED}"  # 공용 모델 — 판정 캐시 키가 bf16 커스텀과 섞이지 않는다


def test_detect(client):
    for path in ("/v1/detect/loophole", "/v1/detect/illegal"):
        r = client.post(path, headers=AUTH, json={"clauses": CLAUSES, "contract_type": "subscription"})
        assert r.status_code == 200
        assert_contract(path, "post", 200, r.json())
        assert [x["clause_id"] for x in r.json()["results"]] == ["c1", "c2", "c3"]


def test_jobs(client):
    r = client.post("/v1/jobs", headers=AUTH, json={"clauses": CLAUSES, "contract_type": "subscription"})
    assert r.status_code == 202
    assert_contract("/v1/jobs", "post", 202, r.json())
    jid = r.json()["job_id"]
    for _ in range(200):
        g = client.get(f"/v1/jobs/{jid}", headers=AUTH)
        if g.json()["status"] == "done":
            break
        time.sleep(0.01)
    assert g.status_code == 200
    body = g.json()
    assert_contract("/v1/jobs/{id}", "get", 200, body)
    assert body["total"] == body["done"] == 3
    assert all(x["error"] is None and "loophole" in x and "illegal" in x for x in body["results"])
    assert set(body["model_versions"]) == {"M1", "M2"}


def test_job_404(client):
    r = client.get("/v1/jobs/nope", headers=AUTH)
    assert r.status_code == 404 and "detail" in r.json()


def test_judge(client, fake):
    r = client.post("/v1/judge", headers=AUTH, json=JUDGE)
    assert r.status_code == 200, r.json()
    body = r.json()
    assert_contract("/v1/judge", "post", 200, body)
    assert body["knowledge_date"] == "2026-09-01"
    # 단정 표현·근거 밖 주장은 빠진다
    assert [c["claim"] for c in body["explanation"]] == ["환불을 일률적으로 막아 소비자에게 불리할 가능성이 있습니다."]


def test_judge_normal_nulls(client, fake):
    fake.judge_reply = {"risk_class": "normal", "risk_type": "vague", "risk_level": "low", "confidence": "high", "explanation": []}
    body = client.post("/v1/judge", headers=AUTH, json=JUDGE).json()
    assert body["risk_class"] == "normal" and body["risk_type"] is None and body["risk_level"] is None and body["confidence"] is None


def test_judge_request_shape(client, fake):
    client.post("/v1/judge", headers=AUTH, json=JUDGE)
    body = [b for p, b in fake.calls if p == "/api/chat"][-1]
    assert body["keep_alive"] == "5m" and body["think"] is False and body["stream"] is False
    assert body["model"] == SHARED
    assert "/no_think" not in body["messages"][-1]["content"]  # instruct 판은 사고 모드가 없다
    o = body["options"]
    assert o["num_ctx"] == 8192 and o["temperature"] == 0 and o["top_k"] == 1 and o["seed"] == 0 and o["num_predict"] == client.app.state.crd.settings.m3.num_predict
    ev = body["format"]["properties"]["explanation"]
    m3 = client.app.state.crd.settings.m3  # 설명 문장 수·길이 상한이 설정값대로 스키마에 들어간다(판정 속도 개선 2026-09-30)
    if m3.explain_max_items is not None:
        assert ev["maxItems"] == m3.explain_max_items
    if m3.explain_max_chars is not None:
        assert ev["items"]["properties"]["claim"]["maxLength"] == m3.explain_max_chars
    assert ev["items"]["properties"]["evidence_ids"]["items"]["enum"] == ["ev1"]


def test_errors(client, fake):
    assert client.get("/health").status_code == 401
    r = client.post("/v1/judge", headers={"Authorization": "Bearer wrong"}, json=JUDGE)
    assert r.status_code == 401
    assert_contract("/v1/judge", "post", 400, r.json())  # ErrorBody 형태
    r = client.post("/v1/judge", headers=AUTH, json={**JUDGE, "perspective": "robot"})
    assert r.status_code == 400 and "robot" not in r.json()["detail"]  # 입력값을 되돌리지 않는다
    many = [{"clause_id": str(i), "text": "x"} for i in range(2001)]
    assert client.post("/v1/jobs", headers=AUTH, json={"clauses": many, "contract_type": "ecommerce"}).status_code == 413


def test_model_not_found_is_503_and_not_retried(client, fake, sleeps):
    fake.chat_status = [404]
    r = client.post("/v1/judge", headers=AUTH, json=JUDGE)
    assert r.status_code == 503
    assert "not found" in r.json()["detail"] and "환불" not in r.json()["detail"]
    assert fake.paths().count("/api/chat") == 1 and sleeps == []


def test_5xx_retried_then_ok(client, fake, sleeps):
    fake.chat_status = [500, 502]
    r = client.post("/v1/judge", headers=AUTH, json=JUDGE)
    assert r.status_code == 200
    assert fake.paths().count("/api/chat") == 3 and sleeps == [3, 6]


def test_ollama_down_is_503(client, fake):
    fake.up = False
    r = client.post("/v1/judge", headers=AUTH, json=JUDGE)
    assert r.status_code == 503
    h = client.get("/health", headers=AUTH)
    assert h.status_code == 503 and h.json()["status"] == "degraded"
    assert {m["id"]: m["state"] for m in h.json()["models"]}["M3"] == "error"


# ------------------------------------------------------------------ /v1/embed (하이브리드 RAG, 2026-09-29)
def test_embed(client, fake):
    r = client.post("/v1/embed", headers=AUTH, json={"texts": ["약관의 규제에 관한 법률 제6조", "환불되지 않습니다."]})
    assert r.status_code == 200, r.json()
    assert_contract("/v1/embed", "post", 200, r.json())
    body = r.json()
    assert body["dim"] == 1024 and len(body["embeddings"]) == 2
    assert body["model_version"].startswith("bge-m3@")
    for v in body["embeddings"]:  # L2 정규화
        assert abs(sum(x * x for x in v) - 1.0) < 1e-3
    assert [p for p in fake.paths() if p == "/api/embed"] == ["/api/embed"]
    sent = [b for p, b in fake.calls if p == "/api/embed"][0]
    assert sent["keep_alive"] == "5m" and sent["model"] == "bge-m3"


def test_embed_limits(client):
    assert client.post("/v1/embed", headers=AUTH, json={"texts": []}).status_code == 400
    assert client.post("/v1/embed", headers=AUTH, json={"texts": ["x"] * 33}).status_code == 413
    assert client.post("/v1/embed", headers=AUTH, json={"texts": [" "]}).status_code == 400
    assert client.post("/v1/embed", headers=AUTH, json={"texts": ["가" * 8001]}).status_code == 400


def test_embed_model_missing_is_503(client, fake):
    del fake.installed["bge-m3:latest"]
    r = client.post("/v1/embed", headers=AUTH, json={"texts": ["a"]})
    assert r.status_code == 503


# ------------------------------------------------------------------ 입력 계약 (API 점검 2026-09-30 B3·B5·B6·B7, A5)
DETECT = {"clauses": CLAUSES, "contract_type": "subscription"}


def test_unknown_fields_rejected(client):  # B3
    for body in ({**DETECT, "foo": 1},
                 {**DETECT, "clauses": [{**CLAUSES[0], "secret_note": "x"}]}):
        r = client.post("/v1/detect/loophole", headers=AUTH, json=body)
        assert r.status_code == 400, r.json()
    r = client.post("/v1/judge", headers=AUTH, json={**JUDGE, "scores": {"loophole": 0.1, "typo": 0.2}})
    assert r.status_code == 400
    assert client.post("/v1/embed", headers=AUTH, json={"texts": ["가"], "extra": 1}).status_code == 400


def test_contract_type_enum(client):  # B5
    for path, body in (("/v1/detect/loophole", {**DETECT, "contract_type": "zzz_not_a_type"}),
                       ("/v1/jobs", {**DETECT, "contract_type": "zzz_not_a_type"}),
                       ("/v1/judge", {**JUDGE, "contract_type": "zzz_not_a_type"})):
        r = client.post(path, headers=AUTH, json=body)
        assert r.status_code == 400 and "zzz_not_a_type" not in r.json()["detail"], path


def test_blank_clause_rejected(client):  # B7
    for text in ("", "   \n\t"):
        body = {**DETECT, "clauses": [{"clause_id": "c1", "text": text}]}
        assert client.post("/v1/detect/illegal", headers=AUTH, json=body).status_code == 400
        assert client.post("/v1/summarize", headers=AUTH, json={"clauses": body["clauses"]}).status_code == 400
    assert client.post("/v1/judge", headers=AUTH, json={**JUDGE, "clause": "   "}).status_code == 400


def test_clause_length_limit(client):  # B6·B8 — 자르지 않고 추론 전에 거절, 상한까지는 통과
    n = client.app.state.crd.settings.max_clause_chars
    ok = {**DETECT, "clauses": [{"clause_id": "c1", "text": "가" * n}]}
    over = {**DETECT, "clauses": [{"clause_id": "c1", "text": "가" * (n + 1)}]}
    assert client.post("/v1/detect/loophole", headers=AUTH, json=ok).status_code == 200
    assert client.post("/v1/detect/loophole", headers=AUTH, json=over).status_code == 400
    assert client.post("/v1/jobs", headers=AUTH, json=over).status_code == 400
    assert client.post("/v1/judge", headers=AUTH, json={**JUDGE, "clause": "가" * (n + 1)}).status_code == 400
    assert client.get("/health", headers=AUTH).status_code == 200


def test_unhandled_error_is_500_not_503(client, monkeypatch):  # A5 — 고장(500) ≠ 준비 안 됨(503)
    def boom(*_a, **_k):
        raise RuntimeError("/secret/path")
    monkeypatch.setattr(client.app.state.crd.classifiers[0], "predict", boom)
    r = client.post("/v1/detect/loophole", headers=AUTH, json=DETECT)
    assert r.status_code == 500
    assert r.json() == {"detail": "내부 오류"} and r.headers.get("x-request-id")
