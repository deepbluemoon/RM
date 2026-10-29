"""M3 설명 주장 후처리 (BR-MDL-08, BR-EXP-04).

- 단정 표현 사전(저장소 루트 shared/assertion-terms.json — 백엔드 explanation.filter.ts 와 단일 출처)의
  정규식 중 하나라도 맞는 주장은 뺀다(대소문자 무관).
- evidence_ids 가 비었거나 요청 근거 ID 의 부분집합이 아닌 주장도 뺀다.
모든 주장이 빠지면 빈 배열을 돌려준다 — 백엔드가 G9 를 낸다.
"""
from __future__ import annotations

import json
import re
from pathlib import Path


class AssertionFilter:
    def __init__(self, terms_path: Path):
        data = json.loads(Path(terms_path).read_text(encoding="utf-8"))
        self.version: str = data.get("version", "")
        self.patterns = [re.compile(p, re.IGNORECASE | re.UNICODE) for p in data["patterns"]]

    def is_assertive(self, text: str) -> bool:
        return any(p.search(text) for p in self.patterns)

    def filter(self, claims: list[dict], evidence_ids: set[str]) -> list[dict]:
        kept: list[dict] = []
        for c in claims:
            claim = str(c.get("claim", "")).strip()
            ids = [str(i) for i in (c.get("evidence_ids") or [])]
            if not claim or not ids or not set(ids) <= evidence_ids:
                continue
            if self.is_assertive(claim):
                continue
            kept.append({"claim": claim, "evidence_ids": list(dict.fromkeys(ids))})
        return kept
