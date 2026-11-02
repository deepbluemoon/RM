"""LLM_PROVIDER=gemini|vertex — M3(판정)·M4(요약)를 Gemini(generateContent)로 돌린다.
실제 Google 호출 없이 conftest 의 transport 목으로 확인한다. 임베딩·M1·M2 는 범위 밖(그대로 Ollama)."""
import pytest

from app.gemini_client import GeminiClient
from app.ollama_client import OllamaError

from .conftest import AUTH, assert_contract
from .test_contract import CLAUSES, JUDGE

GEMINI = {"llm_provider": "gemini", "gemini_api_key": "test-gemini-key"}


def test_gemini_judge(make_client, fake):
    with make_client(**GEMINI) as c:
        r = c.post("/v1/judge", headers=AUTH, json=JUDGE)
    assert r.status_code == 200, r.text
    body = r.json()
    assert_contract("/v1/judge", "post", 200, body)
    assert body["model_version"] == "gemini:gemini-3.8-flash"
    assert body["knowledge_date"] == "2026-09-01"
    # Gemini 가 sentence 로 줘도 normalize_claims 가 claim 으로 맞춰 설명이 살아남는다(빈 배열 버그 회귀 방지)
    assert len(body["explanation"]) == 1 and body["explanation"][0]["evidence_ids"] == ["ev1"]
    # Gemini generateContent 로만 갔고 Ollama /api/chat 는 부르지 않았다
    paths = fake.paths()
    assert any(p.endswith(":generateContent") for p in paths)
    assert "/api/chat" not in paths


def test_gemini_summarize(make_client, fake):
    with make_client(**GEMINI) as c:
        r = c.post("/v1/summarize", headers=AUTH, json={"clauses": CLAUSES})
    assert r.status_code == 200, r.text
    body = r.json()
    assert_contract("/v1/summarize", "post", 200, body)
    assert body["model_version"] == "gemini:gemini-3.8-flash"


def test_gemini_missing_key_is_503(make_client, fake):
    """키가 없으면 M3·M4 는 503 — 기동은 되지만 판정·요약만 거부한다."""
    with make_client(llm_provider="gemini", gemini_api_key=None) as c:
        r = c.post("/v1/judge", headers=AUTH, json=JUDGE)
    assert r.status_code == 503


def test_gemini_health_ready_without_ollama(make_client, fake):
    """Ollama 가 꺼져 있어도 gemini 모드면 M3·M4 는 ready 로 보고된다(G5 아님)."""
    fake.up = False
    with make_client(**GEMINI) as c:
        body = c.get("/health", headers=AUTH).json()
    state = {m["id"]: m["state"] for m in body["models"]}
    assert state["M3"] == "ready" and state["M4"] == "ready"


def test_normalize_claims_field_names():
    """Ollama 의 claim 은 그대로, Gemini 의 sentence/text 는 claim 으로 맞춘다."""
    from app.llm import normalize_claims
    out = normalize_claims([
        {"claim": "올라마 주장", "evidence_ids": ["a"]},
        {"sentence": "제미나이 문장", "evidence_ids": ["b"]},
        {"text": "텍스트 필드", "evidence_ids": ["c"]},
        "문자열은 건너뜀",
    ])
    assert out == [
        {"claim": "올라마 주장", "evidence_ids": ["a"]},
        {"claim": "제미나이 문장", "evidence_ids": ["b"]},
        {"claim": "텍스트 필드", "evidence_ids": ["c"]},
    ]


def test_gemini_4xx_not_retried(make_client, fake, sleeps):
    """키 오류 등 4xx 는 503 으로 바꾸고 재시도하지 않는다."""
    fake.chat_status = [403]
    with make_client(**GEMINI) as c:
        r = c.post("/v1/judge", headers=AUTH, json=JUDGE)
    assert r.status_code == 503
    assert sleeps == []  # 재시도 대기 없음


# ---------------------------------------------------------- vertex(Google Cloud) 모드
def test_vertex_endpoint_url_and_auth():
    """vertex 모드는 aiplatform 리전 엔드포인트 + ADC Bearer 토큰으로 간다."""
    c = GeminiClient("gemini-3.8-flash", mode="vertex", project="proj-x", location="us-central1",
                     token_provider=lambda: "tok-123")
    url, headers = c._endpoint()
    assert url == ("https://us-central1-aiplatform.googleapis.com/v1/projects/proj-x"
                   "/locations/us-central1/publishers/google/models/gemini-3.8-flash:generateContent")
    assert headers["Authorization"] == "Bearer tok-123" and "x-goog-api-key" not in headers


def test_schema_only_forced_on_vertex():
    """responseJsonSchema 는 vertex 에서만 붙는다(AI Studio 는 지연 때문에 제외)."""
    schema = {"type": "object"}
    v = GeminiClient("m", mode="vertex", project="p", location="global", token_provider=lambda: "t")
    assert v._body("sys", "usr", schema)["generationConfig"].get("responseJsonSchema") == schema
    g = GeminiClient("m", mode="gemini", api_key="k")
    assert "responseJsonSchema" not in g._body("sys", "usr", schema)["generationConfig"]


def test_vertex_global_location_host():
    c = GeminiClient("m", mode="vertex", project="p", location="global", token_provider=lambda: "t")
    url, _ = c._endpoint()
    assert url.startswith("https://aiplatform.googleapis.com/v1/projects/p/locations/global/")


def test_vertex_missing_project_is_503():
    c = GeminiClient("m", mode="vertex", project=None, token_provider=lambda: "t")
    with pytest.raises(OllamaError):
        c._endpoint()


def test_vertex_judge_via_app(make_client, fake):
    """vertex 공급자로 /v1/judge 가 aiplatform 경로로 가고 model_version 이 vertex: 접두어를 쓴다."""
    with make_client(llm_provider="vertex", vertex_project="test-proj") as c:
        r = c.post("/v1/judge", headers=AUTH, json=JUDGE)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["model_version"] == "vertex:gemini-3.8-flash"
    assert len(body["explanation"]) == 1  # 정규화는 vertex 에서도 동작
    paths = fake.paths()
    assert any("/projects/test-proj/locations/" in p and p.endswith(":generateContent") for p in paths)
    assert "/api/chat" not in paths
