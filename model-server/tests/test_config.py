"""config.validate — 공유 Ollama 규칙(가이드 1.2·1.3·1.7) 위반 설정은 기동을 거부한다."""
import dataclasses

import pytest

from app.config import load_settings, validate


def _with(**kw):
    s = load_settings()
    m3 = dataclasses.replace(s.m3, **kw.pop("m3", {}))
    m4 = dataclasses.replace(s.m4, **kw.pop("m4", {}))
    return dataclasses.replace(s, m3=m3, m4=m4, **kw)


def test_default_config_is_valid():
    s = load_settings()
    validate(s)
    assert s.m3.model == s.m4.model == "qwen3:4b-instruct-2507-q4_K_M"
    assert s.status_cache_sec >= 60 and s.keep_alive == "5m" and s.concurrency == 1


@pytest.mark.parametrize("name", ["qwen3:4b", "gemma3:12b", "qwen3-coder-next:cloud", "qwen3:8b-64k", "x-128k"])
def test_forbidden_models(name):
    with pytest.raises(ValueError):
        validate(_with(m3={"model": name}, m4={"model": name}))


@pytest.mark.parametrize("kw", [
    {"m3": {"model": "gemma3:4b"}},                        # 채팅 모델 2개
    {"m3": {"num_ctx": 16384}, "m4": {"num_ctx": 16384}},  # num_ctx 고정 8192
    {"m3": {"num_predict": 2048}},
    {"status_cache_sec": 5},                              # 폴링 금지
    {"keep_alive": "-1"}, {"keep_alive": "10m"},
    {"concurrency": 2}, {"timeout_sec": 60},
])
def test_rule_violations(kw):
    with pytest.raises(ValueError):
        validate(_with(**kw))
