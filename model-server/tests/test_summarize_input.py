"""M4 입력 절단 규칙(§5.4)."""
from app.summarize_input import Clause, build, est_tokens


def test_short_document_not_truncated():
    cl = [Clause("c1", "짧은 조항", "1", "목적")]
    b = build(cl, 1000)
    assert not b.truncated and "제1조 목적" in b.text


def test_long_document_truncated_with_titles_and_keywords():
    cl = [Clause(f"c{i}", "일반 조항 본문입니다. " * 40, str(i), f"조{i}") for i in range(1, 101)]
    cl[80] = Clause("c81", "회원이 해지하면 위약금을 부과한다. " * 5, "81", "해지")
    b = build(cl, 3000)
    assert b.truncated and b.est_tokens <= 3000
    assert "## 조 제목 목록" in b.text and "제100조 조100" in b.text  # ① 모든 제목
    assert "[제1조 조1]" in b.text                                 # ② 앞쪽 본문
    assert "[제81조 해지]" in b.text                               # ③ 키워드 조항
    assert b.included < b.total


def test_est_tokens():
    assert est_tokens("가" * 15) == 10
