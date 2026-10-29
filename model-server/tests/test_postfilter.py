"""단정 표현 후처리(BR-MDL-08)."""
from app.config import load_settings
from app.postfilter import AssertionFilter

pf = AssertionFilter(load_settings().assertion_terms_path)


def test_assertive_dropped_hedged_kept():
    claims = [
        {"claim": "이 조항은 위법입니다.", "evidence_ids": ["e1"]},
        {"claim": "명백히 무효인 조항입니다.", "evidence_ids": ["e1"]},
        {"claim": "사업자는 조항을 삭제해야 합니다.", "evidence_ids": ["e1"]},
        {"claim": "This clause IS ILLEGAL.", "evidence_ids": ["e1"]},
        {"claim": "소비자에게 불리하게 해석될 가능성이 있습니다.", "evidence_ids": ["e1"]},
        {"claim": "위법 소지가 있어 검토가 필요합니다.", "evidence_ids": ["e1", "e2"]},
    ]
    kept = pf.filter(claims, {"e1", "e2"})
    assert [c["claim"] for c in kept] == ["소비자에게 불리하게 해석될 가능성이 있습니다.", "위법 소지가 있어 검토가 필요합니다."]


def test_evidence_subset_required():
    claims = [{"claim": "검토가 필요합니다.", "evidence_ids": ["e9"]},
              {"claim": "검토가 필요합니다.", "evidence_ids": []},
              {"claim": "검토가 필요합니다.", "evidence_ids": ["e1"]}]
    assert len(pf.filter(claims, {"e1"})) == 1
