# M1·M2 파인튜닝 (T055)

코드만 있다. 학습 데이터와 실행은 팀이 준비한다. 서빙은 `app/classifiers.py` 가 이 결과물을 읽는다.

```bash
uv sync --extra classifiers --extra tools
uv run python scripts/fetch_models.py BASE                       # klue/roberta-base (revision 고정)
uv run python training/split.py data/clauses.jsonl data/split     # FR-042 분할
uv run python training/train.py m1 data/split var/models/loophole-klue-roberta-base --trained-data-date 2026-09-20
uv run python training/train.py m2 data/split var/models/illegal-klue-roberta-base --trained-data-date 2026-09-20
```

학습은 PyTorch **MPS**(Apple GPU)로 한다. 수만 건 × 3에폭 기준 수십 분~수 시간(추정). 서빙은 CPU fp32 이다.

## 데이터 형식 (JSONL, 한 줄 = 조항 1개)

```json
{"id": "c-000123", "doc_id": "d-0042", "contract_type": "subscription",
 "title": "환불", "text": "<비식별화 완료 조항 원문>",
 "category": "unfair", "risk_type": "refund_cancel_limit",
 "laws": ["약관의 규제에 관한 법률"],
 "origin": "real", "reviewed": true}
```

| 필드 | 값 |
|---|---|
| `contract_type` | `ecommerce`·`subscription`·`installment`·`door_to_door`·`general_consumer`·`out_of_scope` |
| `category` | 4범주 `normal`·`dispute`·`unfair`·`illegal` (FR-042 라벨링) |
| `risk_type` | `normal` 이면 `null`, 그 밖에는 7종 중 하나 |
| `laws` | 5개 법률 중 관련된 것(0개 이상) — `app/classifiers.py` `LAWS` 와 같은 문자열 |
| `origin` | `real`(실제 계약·공정위 사례·표준약관) · `synthetic`(인위 변형 조항) |
| `reviewed` | 법률 전문가 검수 여부 |

모델 입력은 서빙과 같은 `"{계약유형 한글} [SEP] {조 제목} [SEP] {조항}"`(`format_input`), 최대 512토큰.

| 모델 | 목표 |
|---|---|
| M1 (8클래스) | `category == normal` → `none`, 그 밖 → `risk_type` |
| M2 이진 | `category == illegal` |
| M2 다중 레이블 5 | `laws` 멀티핫 |

## FR-042 분할 규칙 (`split.py`)

1. **평가 데이터는 학습과 분리**: `doc_id` 단위로 나눈다(같은 문서 조항이 양쪽에 섞이지 않게). `sha256(doc_id)` 기반이라 다시 돌려도 같은 결과.
2. **평가 데이터는 `origin == real` 이고 `reviewed == true` 인 조항만**. 검수 안 된 실제 조항은 학습으로 보낸다.
3. **인위 변형 조항(`synthetic`)은 학습에만**. 평가 문서 `doc_id` 에서 파생된 변형 조항(`derived_from_doc`)도 누수를 막기 위해 버린다.
4. 검증(dev) 세트는 학습 쪽에서 다시 doc 단위로 10% 떼어 낸다(조기 종료용).

## 산출물

`{MODEL_ROOT}/{loophole|illegal}-klue-roberta-base/` 에 가중치·토크나이저와 `model_card.json`
(`model_version = <이름>@<trained_data_date>`, `trained_data_date`, 평가 지표, 데이터 건수, 베이스 revision) 을 만든다.
