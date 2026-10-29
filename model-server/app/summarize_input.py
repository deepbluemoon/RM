"""M4 입력 만들기 — 토큰 추정과 절단 규칙(model-serving §5.4, §0: M4 num_ctx 8192).

토큰 추정: Qwen 토크나이저에서 한국어는 대략 1.5자당 1토큰이다. 정확한 토크나이저를 싣지 않고
ceil(글자 수 / 1.5) 로 어림한다(영문·숫자는 실제보다 크게 잡히므로 안전 쪽).

예산 = num_ctx(8192) − 출력 상한(600) − 지시문 토큰 − 여유(SAFETY).
넘치면 ① 모든 조 제목 목록 → ② 앞쪽 조항 본문(남은 예산의 절반까지) → ③ 해지·환불·위약금·변경 키워드 조항
→ (남으면) ② 를 이어서 채운다. 본문은 원래 순서로 다시 정렬한다.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

CHARS_PER_TOKEN = 1.5
SAFETY_TOKENS = 128
KEYWORDS = ("해지", "환불", "위약금", "변경", "청약철회", "취소")


def est_tokens(text: str) -> int:
    return math.ceil(len(text) / CHARS_PER_TOKEN)


@dataclass
class Clause:
    clause_id: str
    text: str
    article_no: str | None = None
    title: str | None = None

    def heading(self) -> str:
        no = self.article_no
        if no and not str(no).startswith("제"):
            no = f"제{no}조"
        return " ".join(p for p in (no, self.title) if p) or self.clause_id

    def block(self) -> str:
        return f"[{self.heading()}]\n{self.text.strip()}"


@dataclass
class BuiltInput:
    text: str
    truncated: bool
    est_tokens: int
    included: int
    total: int


def budget(num_ctx: int, num_predict: int, instruction: str) -> int:
    return num_ctx - num_predict - est_tokens(instruction) - SAFETY_TOKENS


def _cut(text: str, tokens: int) -> str:
    return text[: max(0, int(tokens * CHARS_PER_TOKEN))]


def build(clauses: list[Clause], budget_tokens: int) -> BuiltInput:
    full = "\n\n".join(c.block() for c in clauses)
    if est_tokens(full) <= budget_tokens:
        return BuiltInput(full, False, est_tokens(full), len(clauses), len(clauses))

    # ① 조 제목 목록
    titles = "## 조 제목 목록\n" + "\n".join(f"- {c.heading()}" for c in clauses)
    if est_tokens(titles) > budget_tokens:
        titles = _cut(titles, budget_tokens)
        return BuiltInput(titles, True, est_tokens(titles), 0, len(clauses))
    left = budget_tokens - est_tokens(titles) - 10  # 머리말 몫
    chosen: set[int] = set()

    def take(idx: int, cap: int) -> int:
        cost = est_tokens(clauses[idx].block()) + 1
        if cost <= cap:
            chosen.add(idx)
            return cost
        return 0

    # ② 앞쪽 본문 — 절반까지
    half, used = left // 2, 0
    for i in range(len(clauses)):
        c = take(i, half - used)
        if not c:
            break
        used += c
    left -= used
    # ③ 키워드 조항
    for i, cl in enumerate(clauses):
        if i in chosen:
            continue
        if any(k in (cl.title or "") or k in cl.text for k in KEYWORDS):
            left -= take(i, left)
    # 남은 예산으로 ② 를 이어서
    for i in range(len(clauses)):
        if i not in chosen:
            c = take(i, left)
            if not c:
                break
            left -= c
    body = "\n\n".join(clauses[i].block() for i in sorted(chosen))
    text = f"{titles}\n\n## 조항 본문(일부 — 문서가 길어 발췌)\n{body}"
    return BuiltInput(text, True, est_tokens(text), len(chosen), len(clauses))
