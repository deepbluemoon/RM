"""/health cold·missing·fallback 사상, 기동 시 1회 예열, 폴링 금지(가이드 1.6·1.7-6)."""
import dataclasses
import threading
import time

import httpx
from fastapi.testclient import TestClient

from app.config import load_settings
from app.main import create_app

from .conftest import AUTH, GB, SHARED, assert_contract, wait_ready

CL = [{"clause_id": "c1", "text": "회원은 언제든지 해지할 수 있다."}]
JUDGE = {"clause": "환불 불가", "contract_type": "subscription", "perspective": "consumer",
         "knowledge_date": "2026-09-01", "scores": {"loophole": 0.1, "illegal": 0.1},
         "evidence": [{"id": "ev1", "source_type": "law_article", "title": "t", "text": "x"}]}


def _states(body):
    return {m["id"]: m["state"] for m in body["models"]}


def test_cold_is_not_error(client, fake):
    fake.resident.clear()
    client.app.state.crd.inventory._snap = None  # 캐시 비우기(다음 조회에서 /api/ps 를 다시 읽는다)
    r = client.get("/health", headers=AUTH)
    assert r.status_code == 200
    body = r.json()
    assert_contract("/health", "get", 200, body)
    assert body["status"] == "ready"
    assert _states(body) == {"M1": "ready", "M2": "ready", "M3": "cold", "M4": "cold"}
    # max(10, ceil(2.5GB×3)=8) = 10 — M3·M4 가 같은 모델이라 한 번만 센다
    assert body["warmup_estimate_sec"] == 10
    assert {m["id"]: m["size_mb"] for m in body["models"]}["M3"] == int(2.5 * GB / 2**20)


def test_cold_becomes_ready_after_call_without_extra_status_calls(client, fake):
    fake.resident.clear()
    client.app.state.crd.inventory._snap = None
    assert _states(client.get("/health", headers=AUTH).json())["M3"] == "cold"
    n_ps = fake.paths().count("/api/ps")
    assert client.post("/v1/judge", headers=AUTH, json=JUDGE).status_code == 200
    body = client.get("/health", headers=AUTH).json()
    assert _states(body)["M3"] == "ready" and body["warmup_estimate_sec"] is None
    assert fake.paths().count("/api/ps") == n_ps  # 호출 결과로 추론 — 추가 조회 없음


def test_health_does_not_poll_ollama(client, fake):
    for _ in range(20):
        client.get("/health", headers=AUTH)
        client.get("/v1/models", headers=AUTH)
    # 60초 캐시 — 앱 수명 동안 상태 조회는 각 1회
    assert fake.paths().count("/api/tags") == 1 and fake.paths().count("/api/ps") == 1
    assert fake.paths().count("/api/version") == 1


def test_missing_is_degraded(client, fake):
    del fake.installed[SHARED]
    client.app.state.crd.inventory._snap = None
    r = client.get("/health", headers=AUTH)
    assert r.status_code == 503
    assert_contract("/health", "get", 503, r.json())
    assert r.json()["status"] == "degraded" and _states(r.json())["M3"] == "missing"


def test_404_marks_missing_without_retry(client, fake):
    del fake.installed[SHARED]  # 캐시에는 아직 설치로 남아 있다
    assert client.post("/v1/judge", headers=AUTH, json=JUDGE).status_code == 503
    assert _states(client.get("/health", headers=AUTH).json())["M3"] == "missing"


def test_fallback_used_only_when_primary_missing(make_client, fake):
    fake.installed = {"gemma3:4b": int(3.34 * GB)}
    fake.resident = set()
    base = load_settings()
    m3 = dataclasses.replace(base.m3, fallback="gemma3:4b")
    m4 = dataclasses.replace(base.m4, fallback="gemma3:4b")
    with make_client(m3=m3, m4=m4) as c:
        wait_ready(c)
        body = c.get("/health", headers=AUTH).json()
        assert body["status"] == "ready"
        assert {m["id"]: m["model"] for m in body["models"]}["M3"] == "gemma3:4b"
        assert body["warmup_estimate_sec"] == 11  # ceil(3.34×3)
        s = c.post("/v1/summarize", headers=AUTH, json={"clauses": CL}).json()
        assert s["model_version"] == "ollama:gemma3:4b"
    fake.installed[SHARED] = 1
    with make_client(m3=m3, m4=m4) as c:
        wait_ready(c)
        assert {m["id"]: m["model"] for m in c.get("/health", headers=AUTH).json()["models"]}["M3"] == SHARED


def test_loading_while_classifiers_init(fake):
    gate = threading.Event()

    def slow_loader(s):
        gate.wait(5)
        from app.classifiers import HeuristicIllegal, HeuristicLoophole
        return HeuristicLoophole(), HeuristicIllegal()

    app = create_app(dataclasses.replace(load_settings(), api_key="test-key", warmup_on_start=False),
                     transport=httpx.MockTransport(fake.handler), classifier_loader=slow_loader)
    with TestClient(app) as c:
        r = c.get("/health", headers=AUTH)
        assert r.status_code == 503 and r.json()["status"] == "loading"
        assert c.post("/v1/jobs", headers=AUTH, json={"clauses": CL, "contract_type": "ecommerce"}).status_code == 503
        gate.set()
        wait_ready(c)
        assert c.get("/health", headers=AUTH).json()["status"] == "ready"


def _wait_generate(fake, n=1, timeout=2.0):
    t0 = time.monotonic()
    while fake.paths().count("/api/generate") < n and time.monotonic() - t0 < timeout:
        time.sleep(0.01)
    return fake.paths().count("/api/generate")


def test_warmup_once_on_start_when_cold(make_client, fake):
    fake.resident = set()
    fake.load_duration_ns = int(12.5e9)
    with make_client(warmup_on_start=True) as c:
        wait_ready(c)
        assert _wait_generate(fake) == 1
        gen = [b for p, b in fake.calls if p == "/api/generate"][0]
        assert gen["model"] == SHARED and "prompt" not in gen and gen["keep_alive"] == "5m"
        assert gen["options"] == {"num_ctx": 8192}
        assert c.app.state.crd.llm.observed_load_sec[SHARED] == 12.5
        # 요청을 처리해도 다시 예열하지 않는다 — 요청 자체가 keep_alive 를 연장한다
        c.post("/v1/summarize", headers=AUTH, json={"clauses": CL})
        c.post("/v1/jobs", headers=AUTH, json={"clauses": CL, "contract_type": "ecommerce"})
        time.sleep(0.1)
        assert fake.paths().count("/api/generate") == 1
        body = c.get("/health", headers=AUTH).json()
        assert _states(body)["M3"] == "ready"


def test_warmup_skipped_when_resident(make_client, fake):
    with make_client(warmup_on_start=True) as c:
        wait_ready(c)
        time.sleep(0.1)
        assert fake.paths().count("/api/generate") == 0


def test_observed_load_used_for_estimate(client, fake):
    fake.resident.clear()
    fake.load_duration_ns = int(21e9)
    client.app.state.crd.inventory._snap = None
    client.post("/v1/judge", headers=AUTH, json=JUDGE)          # cold 호출 — 21초 적재 관측
    st = client.app.state.crd
    st.inventory._local_until.clear()                          # 5분이 지나 내려갔다고 가정(21초 > 크기 기반 10초 → 관측값)
    fake.resident.clear()
    st.inventory._snap = None
    assert client.get("/health", headers=AUTH).json()["warmup_estimate_sec"] == 21


def test_short_observed_load_does_not_shrink_estimate(client, fake):
    fake.resident.clear()
    fake.load_duration_ns = int(1.1e9)  # 디스크 캐시 덕에 1.1초 만에 올라온 관측
    client.app.state.crd.inventory._snap = None
    client.post("/v1/judge", headers=AUTH, json=JUDGE)
    st = client.app.state.crd
    st.inventory._local_until.clear()
    fake.resident.clear()
    st.inventory._snap = None
    assert client.get("/health", headers=AUTH).json()["warmup_estimate_sec"] == 10  # 크기 기반 하한
