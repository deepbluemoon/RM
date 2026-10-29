"""M1·M2 결정성과 응답 사상."""
from app.classifiers import (HeuristicIllegal, HeuristicLoophole, ClauseText, LAWS, RISK_TYPES, format_input)

CL = [ClauseText("a", "회사는 어떠한 경우에도 책임을 지지 않으며 환불되지 않습니다.", "면책"),
      ClauseText("b", "이 약관은 서비스 이용 조건을 정한다.", "목적"),
      ClauseText("c", "할부금 연체 시 기한의 이익을 상실하고 위약금을 부과한다.", "연체")]


def test_deterministic_repeat_and_batch_independent():
    for m in (HeuristicLoophole(), HeuristicIllegal()):
        a = m.predict("installment", CL)
        b = m.predict("installment", CL)
        single = [m.predict("installment", [c])[0] for c in CL]
        assert a == b == single


def test_scores_shape():
    for r in HeuristicLoophole().predict("ecommerce", CL):
        assert 0 <= r["score"] <= 1 and round(r["score"], 4) == r["score"]
        assert r["type"] is None or r["type"] in RISK_TYPES
    res = HeuristicIllegal().predict("installment", CL)
    for r in res:
        assert len(r["related_laws"]) <= 3 and set(r["related_laws"]) <= set(LAWS)
    assert "할부거래에 관한 법률" in res[2]["related_laws"]
    assert res[0]["score"] > res[1]["score"]


def test_format_input():
    assert format_input("subscription", "환불", "본문") == "구독 [SEP] 환불 [SEP] 본문"


# ---- 3회차(Model 3) 서빙 형식 ----
def test_rescale_threshold_maps_to_half_and_keeps_order():
    from app.classifiers import rescale

    assert rescale(0.3, 0.3) == 0.5
    assert rescale(0.0, 0.3) == 0.0 and rescale(1.0, 0.3) == 1.0
    xs = [i / 20 for i in range(21)]
    ys = [rescale(x, 0.27) for x in xs]
    assert ys == sorted(ys)
    assert rescale(0.42, None) == 0.42  # 임계값 없는 이전 체크포인트는 그대로


def test_char_wb_ngrams_matches_sklearn_rules():
    from app.classifiers import char_wb_ngrams

    # sklearn: 단어 양끝 공백, 2~4-gram, 짧은 단어는 한 번만
    assert char_wb_ngrams("가 AB") == [" 가", "가 ", " 가 ", " a", "ab", "b ", " ab", "ab ", " ab "]


def test_tfidf_proba_is_logistic_of_normalized_tfidf():
    import math

    from app.classifiers import tfidf_proba

    vocab = {" 가": 0, "가 ": 1}
    p = tfidf_proba(["가", "없음"], vocab, [1.0, 2.0], [1.0, -1.0], 0.5)
    v = [1.0, 2.0]
    n = math.sqrt(5)
    assert abs(p[0] - 1 / (1 + math.exp(-(0.5 + v[0] / n - v[1] / n)))) < 1e-12
    assert abs(p[1] - 1 / (1 + math.exp(-0.5))) < 1e-12  # 어휘 없음 → 절편만
