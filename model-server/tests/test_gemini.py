"""LLM_PROVIDER=gemini — M3(판정)·M4(요약)를 Gemini(generateContent)로 돌린다.
실제 Google 호출 없이 conftest 의 transport 목으로 확인한다. 임베딩·M1·M2 는 범위 밖(그대로 Ollama)."""
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
