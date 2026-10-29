"""공통 픽스처 — 공유 Ollama 는 httpx.MockTransport 로 흉내 낸다(실제 서버 호출 없음)."""
from __future__ import annotations

import dataclasses
import json
import time
from pathlib import Path

import httpx
import pytest
import yaml
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator

from app.config import load_settings
from app.main import create_app

ROOT = Path(__file__).resolve().parents[2]
OPENAPI = yaml.safe_load((ROOT / "specs/002-contract-risk-detection/contracts/model-api.openapi.yaml").read_text(encoding="utf-8"))
API_KEY = "test-key"
AUTH = {"Authorization": f"Bearer {API_KEY}"}
GB = 1_000_000_000
SHARED = "qwen3:4b-instruct-2507-q4_K_M"   # config.yaml 기본 — M3·M4 공용 채팅 모델


class FakeOllama:
    def __init__(self):
        self.installed: dict[str, int] = {SHARED: int(2.5 * GB), "gemma3:4b": int(3.34 * GB), "bge-m3:latest": int(1.16 * GB)}
        self.resident: set[str] = {SHARED}
        self.calls: list[tuple[str, dict | None]] = []
        self.chat_status: list[int] = []   # 앞에서부터 꺼내 쓰는 오류 상태
        self.judge_reply: dict = {
            "risk_class": "unfair", "risk_type": "refund_cancel_limit", "risk_level": "high", "confidence": "medium",
            "explanation": [
                {"claim": "환불을 일률적으로 막아 소비자에게 불리할 가능성이 있습니다.", "evidence_ids": ["ev1"]},
                {"claim": "이 조항은 위법이다.", "evidence_ids": ["ev1"]},
                {"claim": "근거 밖 주장입니다.", "evidence_ids": ["ev-x"]},
            ],
        }
        self.summary_reply: dict = {"summary": "구독 계약의 요약입니다.",
                                    "contract_type_candidates": [{"label": "subscription", "score": 0.8},
                                                                 {"label": "bogus", "score": 0.5},
                                                                 {"label": "ecommerce", "score": 0.15}]}
        self.load_duration_ns = 0
        self.up = True

    def paths(self) -> list[str]:
        return [p for p, _ in self.calls]

    def handler(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        self.calls.append((request.url.path, body))
        if not self.up:
            raise httpx.ConnectError("refused", request=request)
        p = request.url.path
        if p == "/api/version":
            return httpx.Response(200, json={"version": "0.34.0"})
        if p == "/api/tags":
            return httpx.Response(200, json={"models": [{"name": n, "size": s, "digest": "d" * 64} for n, s in self.installed.items()]})
        if p == "/api/ps":
            return httpx.Response(200, json={"models": [{"name": n, "model": n, "size_vram": self.installed.get(n, 0)} for n in self.resident]})
        if p in ("/api/chat", "/api/generate"):
            if self.chat_status:
                code = self.chat_status.pop(0)
                return httpx.Response(code, json={"error": f"model '{body['model']}' not found" if code == 404 else "boom"})
            if body["model"] not in self.installed:
                return httpx.Response(404, json={"error": f"model '{body['model']}' not found"})
            self.resident.add(body["model"])
            if p == "/api/generate":
                return httpx.Response(200, json={"response": "", "done": True, "load_duration": self.load_duration_ns})
            reply = self.judge_reply if "risk_class" in body["format"]["properties"] else self.summary_reply
            return httpx.Response(200, json={"message": {"role": "assistant", "content": json.dumps(reply, ensure_ascii=False)},
                                             "done": True, "load_duration": self.load_duration_ns})
        if p == "/api/embed":
            if body["model"] not in self.installed and f"{body['model']}:latest" not in self.installed:
                return httpx.Response(404, json={"error": f"model '{body['model']}' not found"})
            # 결정적 가짜 벡터(1024차원): 글자 수에 따라 달라진다 — 정규화는 게이트웨이가 한다
            return httpx.Response(200, json={"embeddings": [[float((len(t) + i) % 7) + 1.0 for i in range(1024)] for t in body["input"]]})
        return httpx.Response(404, json={"error": "unknown path"})


@pytest.fixture
def fake() -> FakeOllama:
    return FakeOllama()


@pytest.fixture
def sleeps() -> list[float]:
    return []


@pytest.fixture
def make_client(fake, sleeps, monkeypatch):
    def _make(**overrides) -> TestClient:
        overrides.setdefault("warmup_on_start", False)  # 예열은 test_health 에서만 켠다
        s = dataclasses.replace(load_settings(), api_key=API_KEY, **overrides)

        async def fake_sleep(d: float) -> None:
            sleeps.append(d)

        return TestClient(create_app(s, transport=httpx.MockTransport(fake.handler), sleep=fake_sleep))
    return _make


@pytest.fixture
def client(make_client):
    with make_client() as c:
        wait_ready(c)
        yield c


def wait_ready(c: TestClient, timeout: float = 30.0) -> None:  # 실제 체크포인트 2개(roberta) 적재 — 5초로는 부족
    t0 = time.monotonic()
    while c.app.state.crd.classifiers is None:
        if time.monotonic() - t0 > timeout:
            raise TimeoutError("classifiers not loaded")
        time.sleep(0.01)


# ------------------------------------------------------------------ OpenAPI 응답 검증
def _nullable(node):
    """OpenAPI 3.0 nullable → JSON Schema 타입 배열."""
    if isinstance(node, dict):
        node = {k: _nullable(v) for k, v in node.items() if k not in ("example",)}
        if node.pop("nullable", False):
            if "type" in node:
                node["type"] = [node["type"], "null"]
            if "enum" in node and None not in node["enum"]:
                node["enum"] = [*node["enum"], None]
        if node.get("format") in ("date",):
            node.pop("format")
        return node
    if isinstance(node, list):
        return [_nullable(v) for v in node]
    return node


_DOC = _nullable(OPENAPI)


def response_schema(path: str, method: str, status: int) -> dict:
    resp = _DOC["paths"][path][method]["responses"][str(status)]
    while "$ref" in resp:
        name = resp["$ref"].split("/")[-1]
        resp = _DOC["components"]["responses"][name]
    return resp["content"]["application/json"]["schema"]


def assert_contract(path: str, method: str, status: int, body) -> None:
    schema = {**response_schema(path, method, status), "components": _DOC["components"]}
    errors = sorted(Draft202012Validator(schema).iter_errors(body), key=str)
    assert not errors, [f"{list(e.path)}: {e.message}" for e in errors]
