"""비전자상거래 Discovery 코딩 결과로 범용 회피패턴 taxonomy 후보(candidate)와 집계를 만든다.

- 입력: dataset_work/review/non_ecommerce_discovery_coding_v1.jsonl(Discovery 383개 조항 판정)
        checkpoint의 evasion_pattern_taxonomy_v1.json(전자상거래 seed, 비교 기준)
- Holdout 조항은 입력에 없고, 분할 매니페스트로 혼입 여부만 검사한다.
- 기존 파일은 덮어쓰지 않는다(출력 파일이 있으면 중단).

실행:
  python3 tools/dataset_review/non_ecommerce_v1/build_taxonomy_candidate_v1.py --merge <scratchpad/coding>   # 최초 1회: 청크별 코딩을 합쳐 저장
  python3 tools/dataset_review/non_ecommerce_v1/build_taxonomy_candidate_v1.py
출력: dataset_work/review/non_ecommerce_discovery_stats_v1.json, evasion_taxonomy_candidate_general_v1.json
"""
import collections, glob, json, sys
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[3]
REV = PROJECT / "dataset_work" / "review"
CODING = REV / "non_ecommerce_discovery_coding_v1.jsonl"
MAN = REV / "non_ecommerce_taxonomy_split_manifest.json"
SEED = PROJECT / "dataset_work/checkpoints/evasion_seed_v1_before_non_ecommerce/evasion_pattern_taxonomy_v1.json"
OUT_STATS = REV / "non_ecommerce_discovery_stats_v1.json"
OUT_TAX = REV / "evasion_taxonomy_candidate_general_v1.json"
C = collections.Counter

# 기존 EP의 범용화 제안(사람 검토 전 후보). change: keep | generalize | keep_unreproduced
EP_GENERAL = {
    "EP01": ("generalize", "권리행사·보호 기간의 단축·기산점 조작·정지 부재",
             "권리 행사를 인정하면서 행사 기간·기산점·지체 효과를 정하거나, 행사할 수 없는 기간에도 기간이 흐르게 해 기간 밖에서 권리를 소멸시키는 구조.",
             "Discovery YES는 1건뿐이고 UNCERTAIN 10건 대부분이 P1(법정 기준 비교 필요) 때문이다. 재현이 약한 것은 정책 영향이 크다. 행사 불능 기간 정지 부재(NP-NO-TOLLING)를 하위 유형 후보로 둔다."),
    "EP02": ("keep", "최소 이행·수령 사실로 권리 전부 소멸",
             "환불·철회·해지권을 인정하면서 1회 이용·수령·설치 등 최소 이행 사실을 권리 전부 소멸 사유로 삼는 구조.",
             "Discovery 1건(렌탈). 전자상거래형(디지털 콘텐츠·예약) 편중 패턴으로 보인다."),
    "EP03": ("generalize", "권리행사의 비용화(공제·위약금·혜택 환원·계단형 환급)",
             "해지·철회·환불을 인정하면서 공제·수수료·위약금·면제 혜택 환원 청구·경과시점 절벽으로 실제 환급을 줄이거나 행사 비용을 높이는 구조.",
             "계속거래(렌탈·체육시설·기숙사)에서 환급 잠식이 아니라 해지 시 추가 청구(면제 설치비·정상가 환원·폐기비)로 나타나 기존 정의를 넘긴 사례가 5건이다. 경과시점 이후 환급 0(NP-REFUND-CLIFF)을 하위 유형 후보로 둔다."),
    "EP04": ("generalize", "대가·보증금·환급 지급의 수단 치환·지연·조건부 보류",
             "환급·보증금·용역 대가 지급 의무를 인정하면서 지급 수단을 사업자 내부 가치로 바꾸거나 지급 시점을 불확정 조건(대체 입주자 충원 등)에 거는 구조.",
             "환급뿐 아니라 보증금(기숙사)·용역 대가(창작 샘플 작업)까지 확장된다."),
    "EP05": ("generalize", "원칙·보장 선언 후 광범위·불명확 예외",
             "권리·보장 원칙(환불·해지뿐 아니라 요금 산정·존속기간·발효 유예 등)을 선언한 뒤 넓거나 모호하거나 사업자 통제 영역에 있는 예외로 원칙을 비우는 구조.",
             "비전자상거래에서는 원칙이 환불권이 아닌 다른 보장(요금 산정·존속기간 한정·약관 변경 유예)인 사례가 반복된다(stretched 6건)."),
    "EP06": ("keep", "권리행사 절차·경로 장벽",
             "권리를 인정하면서 행사 경로·형식 요건을 좁혀 행사를 어렵게 하거나 비용을 높이는 구조.",
             "재현은 2개 사건. 행사 요건 불충족의 불이익이 다른 조항(월 단위 공제)과 결합할 때만 드러나는 사례가 있어 짝 조항 문맥 규칙이 중요하다."),
    "EP07": ("keep", "분쟁해결 장소·방식 부담(위험 플래그)", None, "RF_VENUE로 재현. 단독 YES 불가 원칙 유지."),
    "EP08": ("generalize", "부작위·행위·합의형 문언에 의한 동의·포기 의제",
             "이용자의 부작위나 일상 행위, 또는 '더 이상 문제 삼지 않기로 한다' 같은 합의형 문언으로 동의·허락·포기 의사표시를 만들어 내는 구조.",
             "가장 강하게 재현된 패턴이다(7개 사건·7개 업종). 자동연장(MCN·렌탈·강의·출판)이 비전자상거래 전형이다. 간주 문언 없는 opt-out과 합의형 포기는 경계로 둔다."),
    "EP09": ("keep", "게시로 개별 통지 갈음(위험 플래그)", None, "RF_NOTICE 36건, 보조 장치 25건. 금융·기숙사에서 게시·도달 간주가 많다."),
    "EP10": ("generalize", "권리·보장 내용을 사업자 재량·하위정책·일방 대체에 유보",
             "이용자에게 인정한 권리·절차의 성립·범위·방식을 사업자 재량, 일방 변경 가능한 하위 규범, 또는 약관이 정한 자동 대체·일방 권한으로 비우는 구조.",
             "가장 넓게 재현됐다(9개 사건·8개 업종). 재량 문언 없이 자동 대체하거나 협의 절차를 일방 권한으로 우회하는 형태가 추가됐다."),
    "EP11": ("keep", "책임 인정 후 요건 가중·범위 축소(위험 플래그)", None, "RF_LIABILITY_LIMIT로 재현."),
    "EP12": ("keep_unreproduced", "이용자 통지·확인 의무를 조건으로 한 책임 발생 제한",
             "사업자 책임·보호를 인정하면서 그 발생을 이용자의 통지·확인 이행 이후로 제한하는 구조.",
             "Discovery에서 재현되지 않았다. 인접 구조로 부수 의무 위반 시 보장 전부 상실(NP-COVERAGE-FORFEIT)이 나왔고, '이용자 부수 의무를 조건으로 한 보호 발생·유지 제한'으로 넓힐지 검토가 필요하다."),
    "EP13": ("keep", "권리행사·종료에 결부된 부수 손실",
             "탈퇴·해지·출금 같은 권리행사에 이미 취득한 유상·정당 적립 가치의 소멸을 결부시키는 구조.",
             "재현은 2개 사건(최소 출금액 미만 잔고 소멸 등). 제재에 결부된 소멸은 기준대로 UNCERTAIN(stretched 2건)."),
    "EP14": ("keep_unreproduced", "형식적 해지권(해지 효과 이연·환급 없음)",
             "언제든 해지할 수 있다고 선언하면서 해지 효과를 결제 주기 말로 미루고 잔여 대금을 환급하지 않는 구조.",
             "Discovery에서 그대로는 재현되지 않았다. 대신 종료·삭제 효과를 사업자 이용권 존속으로 비우는 구조(GN01)가 나와 EP14의 상위 개념 후보가 된다."),
}

# 신규 후보: 에이전트가 붙인 임시 ID(tmp_id)를 묶는다. status: candidate | subtype | watchlist
NEW = [
    {"id": "GN01", "status": "candidate", "class_candidate": "B",
     "name": "종료·삭제 효과의 무력화(사업자 이용권 존속·불확정 이연)",
     "definition": "계약 종료·해지·콘텐츠 삭제로 상대방이 얻어야 할 효과(이용허락 소멸·권리 복귀)를 인정하면서, 종료 후 사업자 이용권 존속·무기한 허락·'합리적 기간' 같은 불확정 이연으로 그 효과를 비우는 구조.",
     "S": "종료·해지·삭제 권리 또는 존속기간 한정", "M": "종료 후 존속 조항·영구 라이선스·불확정 소멸 시점", "E": "종료해도 권리가 돌아오지 않음",
     "tmp_ids": ["NP-POST-TERM-SURVIVAL", "NP-PERPETUAL-LICENSE", "NP-EFFECT-DEFER"],
     "relation": "EP14(해지 효과 이연·환급 없음)의 상위 개념 후보. EP14는 B2C 요금·환급에 한정된 특수형으로 볼 수 있다.",
     "before_adoption": ["정당한 존속 조항(이미 발행된 2차적저작물 판매 등)과의 구분 기준", "EP14 흡수 여부 결정"]},
    {"id": "GN02", "status": "candidate", "class_candidate": "A",
     "name": "권리행사·선택에 다른 권리 포기 결부",
     "definition": "환불 신청·촬영 거부 같은 권리행사나 선택을 인정하면서, 그 행사에 손해배상청구·고소·이의 제기 같은 다른 권리의 포기를 조건으로 붙이는 구조.",
     "S": "환불·거부 선택권", "M": "민·형사 책임 불추궁·이의 금지 동의", "E": "권리 하나를 쓰려면 다른 권리를 잃음",
     "tmp_ids": ["NP-REFUND-RELEASE"],
     "relation": "EP13(가치 소멸 결부)과 같은 결부 구조지만 소멸 대상이 적립 가치가 아니라 법적 청구권이다. D_WAIVER(직접 포기)와 달리 권리행사에 결부된다.",
     "before_adoption": ["단일 사건(의원) 근거라 다른 업종 사례 확보 필요", "EP13과 '권리행사 결부 손실' 상위 범주로 묶을지 결정"]},
    {"id": "GN03", "status": "candidate", "class_candidate": "B",
     "name": "제3자 거래 허용 후 사업자 조건 구속",
     "definition": "상대방의 제3자 거래를 허용한다고 하면서 사업자 제시 조건을 하한으로 고정하거나 사업자 우선 유통 동의를 선행 조건으로 붙여 제3자 거래를 사실상 막는 구조.",
     "S": "제3자와 계약할 자유", "M": "우선협상 결렬 후에도 사업자 조건 이하 계약 금지·우선권 동의 전제", "E": "제3자 거래 불가",
     "tmp_ids": ["NP-THIRDPARTY-TIE"],
     "relation": "B2B(창작자·콘텐츠 제공자) 특유 패턴. EP10(재량 유보)과 달리 사업자 조건을 하한으로 박는다.",
     "before_adoption": ["B2B 포함 여부(P2) 확정", "정상적인 우선협상권과의 구분(결렬 후 구속 여부)"]},
    {"id": "GN04", "status": "candidate", "class_candidate": "B",
     "name": "선택 동의권의 묶음·필수화",
     "definition": "선택 동의를 거부할 수 있다고 하면서 선택 항목을 필수 동의와 한 칸으로 묶거나, 선택 항목 거부에도 계약 거절 같은 불이익을 붙여 선택권을 비우는 구조.",
     "S": "동의 거부권(선택 항목)", "M": "동의란 묶음·필수 분류·거부 시 계약 불가", "E": "선택 동의가 사실상 강제됨",
     "tmp_ids": ["NP-FORCED-CONSENT"],
     "relation": "EP08과 가깝지만 간주 문언 없이 동의 구조 자체로 선택권을 비운다. 개인정보 영역 특수형일 수 있다.",
     "before_adoption": ["단일 사건(렌탈) 근거", "개인정보보호법상 판단과 회피패턴 판단의 분리 방식"]},
    {"id": "GN05", "status": "candidate", "class_candidate": "B",
     "name": "권리 성립 요건·대상 범위의 과소·모호 한정",
     "definition": "환불·양도 등 권리를 허용한다고 하면서 성립 요건을 '부득이한 사유' 같은 추상 요건으로만 두거나, 행사 상대·대상을 과도하게 좁혀 실질을 비우는 구조.",
     "S": "환불·양도 허용", "M": "추상 요건·상대방 1인 한정", "E": "허용 선언에도 실제 행사 여지 축소",
     "tmp_ids": ["NP-VAGUE-GATE", "NP-NARROW-GRANT"],
     "relation": "EP05는 원칙 뒤 예외 목록, EP06은 경로·형식 장벽이다. 이 후보는 권리 자체의 요건·범위를 좁힌다. EP11 '범위 축소'의 이용자 권리판.",
     "before_adoption": ["EP05에 흡수할지 결정", "합리적 범위 한정(본인 확인 목적 등)과의 구분"]},
    {"id": "GN06", "status": "candidate", "class_candidate": "A",
     "name": "권리 귀속 인정 후 행사 주체 이전",
     "definition": "권리가 상대방(또는 공동)에게 귀속된다고 인정하면서 그 행사권·대표권을 사업자에게 일임하게 해 귀속을 명목화하는 구조.",
     "S": "저작권 등 권리 귀속", "M": "사업자 단독 대표 행사·대리권 부여", "E": "권리자가 자기 권리를 행사하지 못함",
     "tmp_ids": ["NP-HOLD-NO-EXERCISE"],
     "relation": "EP10(권리 내용 재량 유보)의 하위 유형으로 둘 수도 있다.",
     "before_adoption": ["단일 사건(웹툰 B2B) 근거", "EP10 하위 유형으로 흡수할지 결정"]},
    {"id": "EP01-sub-a", "status": "subtype", "parent": "EP01", "class_candidate": "B",
     "name": "행사 불능 기간의 기간 정지 부재",
     "definition": "유효기간·유예기간을 두면서 공급 중단 등 이용자가 행사할 수 없는 기간에도 기간이 흐르고 정지·연장 규정이 없는 구조.",
     "S": "적립 가치·유예기간", "M": "기간 정지 장치 부재", "E": "행사할 수 없는 동안 권리 소멸",
     "tmp_ids": ["NP-NO-TOLLING"], "relation": "EP01의 기간 조작 개념을 '정지 부재'로 넓힌다.",
     "before_adoption": ["단일 사건(항공 마일리지) 근거", "P1: 기간 길이 자체는 외부 기준 필요"]},
    {"id": "EP03-sub-a", "status": "subtype", "parent": "EP03", "class_candidate": "B",
     "name": "경과시점 절벽형 환급(잔여기간 몰수)",
     "definition": "중도해지 환급을 인정하면서 일정 경과 시점 이후 환급을 0으로 만들어 잔여 이용가치 전부를 몰수하는 계단형 구조.",
     "S": "중도해지 환급", "M": "경과시점 이후 환급 없음", "E": "잔여기간 가치 전부 상실",
     "tmp_ids": ["NP-REFUND-CLIFF"], "relation": "EP03 공제와 EP01 기간이 결합된 계속거래형.",
     "before_adoption": ["단일 사건(기숙사) 근거", "법정 반환 기준표(P1) 비교 필요"]},
    {"id": "EP12-adj", "status": "subtype", "parent": "EP12", "class_candidate": "B",
     "name": "부수 의무 위반을 이유로 한 보장 전부 상실",
     "definition": "보험·보장 적용을 전제하면서 협조·신고·운영정책 같은 부수 의무 위반 하나로 인과관계·귀책과 무관하게 보장 전체를 배제하는 구조.",
     "S": "보험·보장 적용", "M": "부수 의무 위반 시 보장 배제", "E": "보장이 사실상 조건부로 축소",
     "tmp_ids": ["NP-COVERAGE-FORFEIT"], "relation": "EP12를 '이용자 부수 의무를 조건으로 한 보호 발생·유지 제한'으로 넓힐 때 흡수 후보.",
     "before_adoption": ["단일 사건(카셰어링) 근거", "S가 문맥상 전제라 UNCERTAIN만 있음"]},
    {"id": "WL-FORMAL-CURE", "status": "watchlist", "name": "시정 기회 없는 형식적 사전통지 후 불이익", "tmp_ids": ["NP-FORMAL-CURE"],
     "relation": "사업자 불이익 조치 앞 보호 절차의 형식화. EP06의 사업자 측 대응형."},
    {"id": "WL-DORMANCY-STOP", "status": "watchlist", "name": "장기 미사용 자동중단·복원 경로 제한", "tmp_ids": ["NP-DORMANCY-STOP"],
     "relation": "EP08(부작위 트리거)+EP06(복원 경로) 결합형일 가능성."},
    {"id": "WL-DRIP-PRICING", "status": "watchlist", "name": "필수 구성요소 분리 과금", "tmp_ids": ["NP-DRIP-PRICING"],
     "relation": "급부 보장(패키지)을 필수 옵션 분리로 비움. 표시·광고 영역과 경계."},
    {"id": "WL-INSURANCE-SUBST", "status": "watchlist", "name": "배상책임 인정 후 보험 처리로 범위 치환", "tmp_ids": ["NP-INSURANCE-SUBST"],
     "relation": "EP11(C) 책임 범위 축소의 암묵형일 가능성."},
]


def tier(n_cases):
    return "strong" if n_cases >= 5 else "moderate" if n_cases >= 2 else "weak" if n_cases == 1 else "none"


def merge(src_dir):
    if CODING.exists():
        raise SystemExit(f"이미 존재: {CODING}")
    rows = [l for f in sorted(glob.glob(str(Path(src_dir) / "chunk_*.jsonl")))
            for l in open(f, encoding="utf-8") if l.strip()]
    CODING.write_text("".join(l if l.endswith("\n") else l + "\n" for l in rows), encoding="utf-8")
    print("merged", len(rows), "->", CODING.relative_to(PROJECT))


def main():
    for p in (OUT_STATS, OUT_TAX):
        if p.exists():
            raise SystemExit(f"이미 존재: {p}")
    R = [json.loads(l) for l in open(CODING, encoding="utf-8") if l.strip()]
    man = json.loads(MAN.read_text(encoding="utf-8"))
    D, H = set(man["clause_ids"]["discovery"]), set(man["clause_ids"]["holdout"])
    ids = [r["clause_id"] for r in R]
    assert len(ids) == len(set(ids)) and set(ids) == D and not set(ids) & H, "coding ≠ Discovery"
    seed = json.loads(SEED.read_text(encoding="utf-8"))
    seedp = {p["pattern_id"]: p for p in seed["patterns"]}

    def ex(rs, k=5):
        return [{"clause_id": r["clause_id"], "industry": r["industry"], "decision": r["decision"], "S": r["S"], "M": r["M"]} for r in rs[:k]]

    def pinfo(rs):
        return {"clauses": len(rs), "cases": len({r["case_id"] for r in rs}),
                "decision": dict(C(r["decision"] for r in rs)), "industry": dict(C(r["industry"] for r in rs).most_common()),
                "party_scope": dict(C(r["party_scope"] for r in rs))}

    eps = []
    for i in range(1, 15):
        ep = f"EP{i:02d}"
        sp = seedp[ep]
        yes = [r for r in R if r["decision"] == "YES" and ep in r["patterns"]]
        unc = [r for r in R if r["decision"] == "UNCERTAIN" and ep in r["patterns"]]
        st = [r for r in R if ep in r["patterns"] and r["ep_fit"] == "stretched"]
        change, gname, gdef, note = EP_GENERAL[ep]
        rf = {"EP07": "RF_VENUE", "EP09": "RF_NOTICE", "EP11": "RF_LIABILITY_LIMIT"}.get(ep)
        eps.append({
            "pattern_id": ep, "seed_name": sp["pattern_name"], "class": sp["class"],
            "change": change, "general_name_candidate": gname,
            "general_definition_candidate": gdef or sp["definition"],
            "reproduction": {
                "seed_ecommerce_S2_yes": sp["coverage"]["S2_yes"],
                "discovery_yes": len(yes), "discovery_primary_yes": sum(r["patterns"][:1] == [ep] for r in yes),
                "discovery_uncertain": len(unc), "discovery_yes_cases": len({r["case_id"] for r in yes}),
                "discovery_yes_industries": dict(C(r["industry"] for r in yes).most_common()),
                "discovery_yes_party": dict(C(r["party_scope"] for r in yes)),
                "stretched": len(st), "as_supporting": sum(ep in (r["supporting"] or []) for r in R),
                **({"risk_flag": rf, "risk_flag_count": sum(rf in r["risk_flags"] for r in R)} if rf else {})},
            "reproducibility": ("flag_reproduced" if rf else tier(len({r["case_id"] for r in yes}))),
            "generalization_note": note,
            "stretched_examples": [{"clause_id": r["clause_id"], "note": r["ep_fit_note"]} for r in st],
            "representative_yes": ex(yes), "uncertain_examples": ex(unc, 3)})

    news = []
    for n in NEW:
        rs = [r for r in R if r["new_pattern"] and r["new_pattern"]["tmp_id"] in n["tmp_ids"]]
        news.append({**n, "evidence": pinfo(rs), "evidence_clause_ids": [r["clause_id"] for r in rs],
                     "single_case": len({r["case_id"] for r in rs}) == 1})
    mapped = {t for n in NEW for t in n["tmp_ids"]}
    unmapped = sorted({r["new_pattern"]["tmp_id"] for r in R if r["new_pattern"]} - mapped)
    assert not unmapped, unmapped

    yes_by_case = C(r["case_id"] for r in R if r["decision"] == "YES")
    stats = {
        "name": "non_ecommerce_discovery_stats_v1", "created": "2026-09-28",
        "scope": "비전자상거래 Discovery 31사건 383조항(Holdout 10사건 96조항 미열람)",
        "policy": "evasion_provisional_policy_v1(P1 S2·P2 B2B 포함·P3·P4)",
        "decision": dict(C(r["decision"] for r in R)),
        "decision_by_party": {p: dict(C(r["decision"] for r in R if r["party_scope"] == p)) for p in ("B2C", "B2B", "기타/불명")},
        "decision_by_industry": {ind: dict(C(r["decision"] for r in R if r["industry"] == ind))
                                 for ind, _ in C(r["industry"] for r in R).most_common()},
        "yes_without_existing_ep": sum(1 for r in R if r["decision"] == "YES" and not r["patterns"]),
        "ep_fit": dict(C(r["ep_fit"] for r in R if r["patterns"])),
        "risk_flags": dict(C(f for r in R for f in r["risk_flags"])),
        "direct_types": dict(C(f for r in R for f in r["direct_types"]).most_common()),
        "cross_review_candidate": dict(C(f for r in R for f in r["cross_review"])),
        "mixed_resplit_candidates": sum(1 for r in R if r["mixed"] and r["mixed"].get("resplit_candidate")),
        "legal_risk_note_count": sum(1 for r in R if r["legal_risk_note"]),
        "new_pattern_tmp_ids": dict(C(r["new_pattern"]["tmp_id"] for r in R if r["new_pattern"]).most_common()),
        "yes_concentration": {"cases_with_yes": len(yes_by_case), "top": yes_by_case.most_common(5),
                              "top1_share": round(yes_by_case.most_common(1)[0][1] / sum(yes_by_case.values()), 3)},
        "seed_comparison_note": "전자상거래 seed(455개) S2: YES 105 · UNCERTAIN 44. 조항 수·업종 구성이 달라 비율 비교는 참고용.",
    }
    tax = {
        "version": "evasion_taxonomy_candidate_general_v1", "created": "2026-09-28",
        "status": "candidate — Discovery만으로 만든 후보. Holdout 검증·사람 검토 전이며 확정 taxonomy가 아니다. 라벨링·학습에 쓰지 않는다.",
        "basis": {"seed": "dataset_work/checkpoints/evasion_seed_v1_before_non_ecommerce(전자상거래 official 455개, 수정 금지)",
                  "discovery": "비전자상거래 official 479개 중 Discovery 31사건 383조항",
                  "split_manifest": "dataset_work/review/non_ecommerce_taxonomy_split_manifest.json",
                  "policy": "dataset_work/review/evasion_provisional_policy_v1.md",
                  "coding": "dataset_work/review/non_ecommerce_discovery_coding_v1.jsonl"},
        "not_used": ["Holdout 10사건 96조항 본문", "실제 가입약관 2,752개", "Master Dataset·학습 split·합성데이터·RAG·모델"],
        "structure_test": seed["structure_test"], "labels": list(seed["labels"]),
        "direct_types": seed["direct_types"], "c_risk_flags": seed["c_risk_flags"],
        "reproducibility_scale": {"strong": "Discovery YES 5개 사건 이상", "moderate": "2~4개 사건", "weak": "1개 사건",
                                  "none": "YES 없음", "flag_reproduced": "C 패턴, 위험 플래그로 재현"},
        "existing_patterns": eps, "new_pattern_candidates": news,
        "caveats": [
            "코딩은 청크별 7개 판정자(같은 지침)가 나눠 수행했고 두 번째 판정자 교차검토는 하지 않았다(P4).",
            f"YES가 사건 하나(FTC-2025-05-16-46090, 웹툰 B2B)에 {yes_by_case.most_common(1)[0][1]}건 몰려 있다. GN03·GN06·GN01 일부가 이 사건에 의존한다.",
            "신규 후보 대부분이 단일 사건 근거다. Holdout 검증 전에는 채택하지 않는다.",
            "P1(S2) 때문에 EP01·EP03 재현이 낮게 나온다. 법정 기준표가 정해지면 다시 봐야 한다.",
            "C27(FTC-2025-10-17-46511) '시정 후 약관조항' 칸이 원문과 같거나 순서가 섞여 있다는 데이터 품질 관찰이 있다.",
        ],
        "open_issues_for_human": [
            "EP14를 GN01(종료·삭제 효과 무력화)의 하위 유형으로 둘지",
            "EP03을 '권리행사의 비용화'로 넓혀 해지 시 추가 청구까지 포함할지",
            "EP05·EP10 정의의 '원칙·권리' 범위를 환불·해지 밖(요금 산정·존속기간·협의 절차)으로 넓힐지",
            "GN02(권리행사에 포기 결부)와 EP13을 '권리행사 결부 손실' 상위 범주로 묶을지",
            "GN05를 EP05에, GN06을 EP10에 흡수할지",
            "EP12를 '부수 의무를 조건으로 한 보호 제한'으로 넓힐지",
            "B2B 전용 후보(GN03·GN06)를 범용 taxonomy에 둘지(P2)",
        ],
    }
    OUT_STATS.write_text(json.dumps(stats, ensure_ascii=False, indent=1), encoding="utf-8")
    OUT_TAX.write_text(json.dumps(tax, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({"decision": stats["decision"], "reproducibility": {e["pattern_id"]: e["reproducibility"] for e in eps},
                      "new": {n["id"]: (n["evidence"]["clauses"], n["evidence"]["cases"]) for n in news}}, ensure_ascii=False))


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--merge":
        merge(sys.argv[2])
    else:
        main()
