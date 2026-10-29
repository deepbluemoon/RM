"""OllamaClient — 동시 1건 세마포어, 재시도 규칙, 금지 경로."""
import asyncio

import httpx
import pytest

from app.ollama_client import OllamaClient, OllamaError


async def test_semaphore_limits_to_one():
    active = peak = 0
    depths = []

    async def handler(request):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0.02)
        active -= 1
        return httpx.Response(200, json={"message": {"content": "{}"}})

    c = OllamaClient("http://x", transport=httpx.MockTransport(handler))

    async def probe():
        await asyncio.sleep(0.005)
        depths.append(c.queue_depth)

    await asyncio.gather(*(c.chat({"model": "m"}) for _ in range(5)), probe())
    await c.aclose()
    assert peak == 1
    assert depths[0] == 4  # 1건 처리 중, 4건 대기
    assert c.queue_depth == 0


async def test_warmup_shares_semaphore():
    active = peak = 0

    async def handler(request):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0.01)
        active -= 1
        return httpx.Response(200, json={"done": True})

    c = OllamaClient("http://x", transport=httpx.MockTransport(handler))
    await asyncio.gather(c.chat({}), c.warmup("m", "5m", 8192), c.chat({}))
    await c.aclose()
    assert peak == 1


async def test_404_not_retried():
    n = 0
    sleeps = []

    def handler(request):
        nonlocal n
        n += 1
        return httpx.Response(404, json={"error": "model 'x' not found"})

    async def sl(d):
        sleeps.append(d)

    c = OllamaClient("http://x", transport=httpx.MockTransport(handler), sleep=sl)
    with pytest.raises(OllamaError) as e:
        await c.chat({"model": "x"})
    assert e.value.status == 503 and e.value.upstream_status == 404
    assert n == 1 and sleeps == []


async def test_timeout_retried_then_504():
    n = 0
    sleeps = []

    def handler(request):
        nonlocal n
        n += 1
        raise httpx.ReadTimeout("slow", request=request)

    async def sl(d):
        sleeps.append(d)

    c = OllamaClient("http://x", transport=httpx.MockTransport(handler), sleep=sl)
    with pytest.raises(OllamaError) as e:
        await c.chat({})
    assert e.value.status == 504 and n == 3 and sleeps == [3, 6]


async def test_forbidden_paths_rejected():
    c = OllamaClient("http://x", transport=httpx.MockTransport(lambda r: httpx.Response(200, json={})))
    for p in ("/api/pull", "/api/create", "/api/delete", "/api/copy", "/api/push"):
        with pytest.raises(ValueError):
            await c._call("POST", p, {})
    await c.aclose()


def test_no_forbidden_calls_in_runtime_code():
    """런타임 코드(app/)에 pull·create·delete·copy·push·stop·serve 호출이 없다(참조 §8.4)."""
    import pathlib
    import re
    src = "\n".join(p.read_text(encoding="utf-8") for p in pathlib.Path(__file__).parents[1].joinpath("app").glob("*.py"))
    assert not re.search(r"[\"']/api/(pull|create|delete|copy|push)[\"']", src)
    assert not re.search(r"subprocess|os\.system", src)
