"""본문 길이 제한은 Content-Length 없이 전달되는 요청에도 적용되어야 한다."""
import asyncio

from fastapi.testclient import TestClient

from app.auth import require_bearer
from app.main import BodySizeLimit, MAX_EVIDENCE_TEXT_CHARS, create_app


def _run(chunks: list[bytes], limit: int, declared: bytes | None = None):
    seen: list[bytes] = []
    sent: list[dict] = []
    scope = {"type": "http", "method": "POST", "path": "/v1/judge", "headers": []}
    if declared is not None:
        scope["headers"].append((b"content-length", declared))

    async def receive():
        chunk = chunks.pop(0)
        return {"type": "http.request", "body": chunk, "more_body": bool(chunks)}

    async def send(message):
        sent.append(message)

    async def handler(_scope, receive, send):
        while True:
            message = await receive()
            seen.append(message["body"])
            if not message.get("more_body"):
                break
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    asyncio.run(BodySizeLimit(handler, limit)(scope, receive, send))
    return sent[0]["status"], seen


def test_streaming_body_limit_without_content_length():
    assert _run([b"abc", b"def"], 5) == (413, [])
    assert _run([b"abc", b"de"], 5) == (200, [b"abc", b"de"])


def test_declared_body_limit_rejects_before_reading():
    assert _run([b"ignored"], 5, b"100") == (413, [])


def test_slow_stream_times_out_before_handler():
    sent: list[dict] = []
    called = False

    async def receive():
        await asyncio.sleep(0.1)
        return {"type": "http.request", "body": b"x", "more_body": False}

    async def send(message):
        sent.append(message)

    async def handler(_scope, _receive, _send):
        nonlocal called
        called = True

    asyncio.run(BodySizeLimit(handler, 5, read_timeout_sec=0.01)(
        {"type": "http", "method": "POST", "path": "/v1/judge", "headers": []}, receive, send,
    ))
    assert sent[0]["status"] == 408 and not called


def test_judge_evidence_length_is_bounded_before_model_call():
    app = create_app()
    app.dependency_overrides[require_bearer] = lambda: None
    client = TestClient(app)
    body = {
        "clause": "환불은 허용하지 않는다.", "contract_type": "subscription", "perspective": "consumer",
        "knowledge_date": "2026-11-04", "scores": {},
        "evidence": [{"id": "1", "source_type": "law_article", "title": "근거", "text": "가" * (MAX_EVIDENCE_TEXT_CHARS + 1)}],
    }
    assert client.post("/v1/judge", json=body).status_code == 400
    body["evidence"] = [
        {"id": str(i), "source_type": "law_article", "title": "근거", "text": "가" * MAX_EVIDENCE_TEXT_CHARS}
        for i in range(6)
    ]
    assert client.post("/v1/judge", json=body).status_code == 413
