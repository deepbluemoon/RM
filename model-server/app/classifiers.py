"""M1(편법)·M2(위법) 분류기 — model-serving §5.1·§5.2.

체크포인트({model_root}/loophole-klue-roberta-base, .../illegal-klue-roberta-base + model_card.json)와
torch·transformers(extra `classifiers`)가 있으면 CPU fp32 로 추론한다(6스레드, 배치 16, 최대 512토큰, 결정적).
없으면 키워드 휴리스틱 분류기로 대신한다. 휴리스틱은 파인튜닝 전 파이프라인 전체를 돌려 보기 위한 것이며
버전 문자열(`*-heuristic@날짜`)이 달라 백엔드 판정 캐시·평가 결과가 실제 모델과 섞이지 않는다.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

log = logging.getLogger("crd.classifiers")

HEURISTIC_DATE = "2026-09-28"

CONTRACT_TYPE_KO = {
    "ecommerce": "전자상거래",
    "subscription": "구독",
    "installment": "할부",
    "door_to_door": "방문판매",
    "general_consumer": "일반 소비자 거래",
    "out_of_scope": "범위 밖",
}
RISK_TYPES = ["rights_limit", "liability_avoid", "refund_cancel_limit", "unilateral_change",
              "excessive_penalty", "vague", "other"]
M1_LABELS = ["none", *RISK_TYPES]  # 8클래스 헤드 순서
LAWS = [
    "약관의 규제에 관한 법률",
    "전자상거래 등에서의 소비자보호에 관한 법률",
    "소비자기본법",
    "할부거래에 관한 법률",
    "방문판매 등에 관한 법률",
]


@dataclass(frozen=True)
class ClauseText:
    clause_id: str
    text: str
    title: str | None = None


def format_input(contract_type: str, title: str | None, text: str) -> str:
    """"{계약유형 한글} [SEP] {조 제목} [SEP] {조항}" — 학습(training/)과 같은 형식."""
    ko = CONTRACT_TYPE_KO.get(contract_type, contract_type)
    return f"{ko} [SEP] {title or ''} [SEP] {text}"


def _round(x: float, nd: int) -> float:
    return round(min(1.0, max(0.0, float(x))), nd)


def rescale(p: float, th: float | None) -> float:
    """VALIDATION 에서 고른 임계값 th 가 0.5 에 오도록 단조(구간 선형) 변환 — 순서(AUC)는 그대로, 백엔드 기준 0.5 를 바꾸지 않는다.
    th 가 없으면(이전 체크포인트) 그대로."""
    if th is None or not 0.0 < th < 1.0:
        return p
    return 0.5 * p / th if p < th else 0.5 + 0.5 * (p - th) / (1.0 - th)


class Classifier:
    id: str
    name: str
    model_version: str
    base: str = "klue/roberta-base"
    path: str | None = None
    trained_data_date: str | None = None
    kind: str = "heuristic"

    def predict(self, contract_type: str, clauses: list[ClauseText]) -> list[dict]:
        raise NotImplementedError

    def info(self) -> dict:
        return {"id": self.id, "name": self.name, "base": self.base, "path": self.path,
                "model_version": self.model_version, "trained_data_date": self.trained_data_date}


# ---------------------------------------------------------------- 휴리스틱
def _hits(text: str, words: Iterable[str]) -> int:
    return sum(1 for w in words if w in text)


LOOPHOLE_KW: dict[str, tuple[str, ...]] = {
    "rights_limit": ("청구할 수 없", "이의를 제기할 수 없", "권리를 포기", "행사할 수 없", "제기하지 않기로"),
    "liability_avoid": ("책임을 지지 않", "책임지지 않", "면책", "일체의 책임", "어떠한 책임도"),
    "refund_cancel_limit": ("환불되지 않", "환불하지 않", "환불 불가", "반환하지 않", "취소할 수 없", "해지할 수 없", "청약철회가 불가"),
    "unilateral_change": ("임의로 변경", "사전 통지 없이", "사전 고지 없이", "일방적으로", "회사의 재량"),
    "excessive_penalty": ("위약금", "손해배상액의 예정", "배액", "잔여 기간 전액", "위약벌"),
    "vague": ("등의 사유", "상당한 이유", "필요하다고 인정", "회사가 정하는", "기타 회사"),
}

ILLEGAL_STRONG = ("청약철회를 할 수 없", "청약철회가 불가", "환불되지 않", "환불하지 않", "일체의 책임을 지지",
                  "어떠한 경우에도", "고의 또는 중대한 과실이 있더라도", "사전 통지 없이", "전액을 배상")
LAW_KW: dict[str, tuple[str, ...]] = {
    LAWS[0]: ("책임", "면책", "일방적", "위약금", "관할", "임의로", "변경"),
    LAWS[1]: ("청약철회", "배송", "사이버몰", "전자상거래", "7일", "통신판매"),
    LAWS[2]: ("피해보상", "소비자", "분쟁"),
    LAWS[3]: ("할부", "할부금", "기한의 이익", "할부수수료"),
    LAWS[4]: ("방문판매", "전화권유", "다단계", "14일"),
}
LAW_PRIOR: dict[str, dict[str, float]] = {
    "ecommerce": {LAWS[1]: 0.2},
    "subscription": {LAWS[1]: 0.15},
    "installment": {LAWS[3]: 0.2},
    "door_to_door": {LAWS[4]: 0.2},
}


class HeuristicLoophole(Classifier):
    id = "M1"
    name = "loophole-heuristic"
    model_version = f"loophole-heuristic@{HEURISTIC_DATE}"
    base = "keyword-rules"

    def __init__(self, nd: int = 4):
        self.nd = nd

    def predict(self, contract_type: str, clauses: list[ClauseText]) -> list[dict]:
        out = []
        for c in clauses:
            text = f"{c.title or ''} {c.text}"
            counts = {t: _hits(text, kw) for t, kw in LOOPHOLE_KW.items()}
            h = sum(counts.values())
            score = 1 - 0.85 * (0.5 ** h)  # 0건 0.15, 1건 0.575, 2건 0.7875 …
            best = max(RISK_TYPES, key=lambda t: (counts.get(t, 0), -RISK_TYPES.index(t))) if h else None
            out.append({"clause_id": c.clause_id, "label": "loophole" if score >= 0.5 else "none",
                        "type": best, "score": _round(score, self.nd)})
        return out


class HeuristicIllegal(Classifier):
    id = "M2"
    name = "illegal-heuristic"
    model_version = f"illegal-heuristic@{HEURISTIC_DATE}"
    base = "keyword-rules"

    def __init__(self, nd: int = 4):
        self.nd = nd

    def predict(self, contract_type: str, clauses: list[ClauseText]) -> list[dict]:
        out = []
        prior = LAW_PRIOR.get(contract_type, {})
        for c in clauses:
            text = f"{c.title or ''} {c.text}"
            strong = _hits(text, ILLEGAL_STRONG)
            score = 1 - 0.9 * (0.55 ** strong)  # 0건 0.10, 1건 0.505, 2건 0.7278 …
            probs = {law: min(0.95, 0.1 * (law == LAWS[0]) + prior.get(law, 0.0)
                              + 0.2 * _hits(text, LAW_KW[law]) + (0.15 if strong else 0.0))
                     for law in LAWS}
            related = [law for law in sorted(LAWS, key=lambda x: (-probs[x], LAWS.index(x))) if probs[law] >= 0.5][:3]
            out.append({"clause_id": c.clause_id, "label": "illegal" if score >= 0.5 else "none",
                        "type": related[0] if related else None, "related_laws": related,
                        "score": _round(score, self.nd)})
        return out


# ---------------------------------------------------------------- PyTorch
def _read_card(path: Path) -> dict:
    return json.loads((path / "model_card.json").read_text(encoding="utf-8"))


class _TorchBase(Classifier):
    kind = "pytorch"

    def __init__(self, mid: str, path: Path, threads: int, batch: int, max_len: int, nd: int):
        import torch  # extra `classifiers`

        torch.set_num_threads(threads)
        torch.use_deterministic_algorithms(True)
        torch.manual_seed(0)
        card = _read_card(path)
        self.id = mid
        self.name = card.get("name", path.name)
        self.model_version = card.get("model_version") or f"{path.name}@{card.get('trained_data_date')}"
        self.base = card.get("source", "klue/roberta-base")
        self.path = path.name
        self.trained_data_date = card.get("trained_data_date")
        self.batch, self.max_len, self.nd = batch, max_len, nd
        self.threshold = (card.get("serving") or {}).get("threshold")
        self._torch = torch

    def _batches(self, contract_type: str, clauses: list[ClauseText]):
        for i in range(0, len(clauses), self.batch):
            chunk = clauses[i:i + self.batch]
            texts = [format_input(contract_type, c.title, c.text) for c in chunk]
            enc = self.tok(texts, padding=True, truncation=True, max_length=self.max_len, return_tensors="pt")
            yield chunk, enc


class TorchLoophole(_TorchBase):
    def __init__(self, path: Path, **kw):
        super().__init__("M1", path, **kw)
        from transformers import AutoModelForSequenceClassification, AutoTokenizer

        self.tok = AutoTokenizer.from_pretrained(path)
        self.model = AutoModelForSequenceClassification.from_pretrained(path, torch_dtype=self._torch.float32).eval()
        id2label = {int(k): v for k, v in self.model.config.id2label.items()}
        self.labels = [id2label[i] for i in range(len(id2label))]
        if "none" not in self.labels:
            raise ValueError("M1 체크포인트 id2label 에 'none' 이 없다")

    def predict(self, contract_type: str, clauses: list[ClauseText]) -> list[dict]:
        torch, out = self._torch, []
        none_idx = self.labels.index("none")
        with torch.inference_mode():
            for chunk, enc in self._batches(contract_type, clauses):
                probs = torch.softmax(self.model(**enc).logits, dim=-1)
                for c, p in zip(chunk, probs):
                    score = rescale(1.0 - float(p[none_idx]), self.threshold)
                    p2 = p.clone()
                    p2[none_idx] = -1
                    best = self.labels[int(p2.argmax())]
                    out.append({"clause_id": c.clause_id, "label": "loophole" if score >= 0.5 else "none",
                                "type": best if best in RISK_TYPES else "other", "score": _round(score, self.nd)})
        return out


class TorchIllegal(_TorchBase):
    def __init__(self, path: Path, **kw):
        super().__init__("M2", path, **kw)
        from transformers import AutoTokenizer

        from .m2_model import IllegalModel

        self.tok = AutoTokenizer.from_pretrained(path)
        self.model = IllegalModel.load(path).eval()

    def predict(self, contract_type: str, clauses: list[ClauseText]) -> list[dict]:
        torch, out = self._torch, []
        with torch.inference_mode():
            for chunk, enc in self._batches(contract_type, clauses):
                bin_logit, law_logits = self.model(**enc)
                p_ill = torch.sigmoid(bin_logit).squeeze(-1)
                p_law = torch.sigmoid(law_logits)
                for c, pi, pl in zip(chunk, p_ill, p_law):
                    probs = {LAWS[j]: float(pl[j]) for j in range(len(LAWS))}
                    related = [l for l in sorted(LAWS, key=lambda x: -probs[x]) if probs[l] >= 0.5][:3]
                    top = max(LAWS, key=lambda x: probs[x])
                    out.append({"clause_id": c.clause_id, "label": "illegal" if float(pi) >= 0.5 else "none",
                                "type": top, "related_laws": related, "score": _round(float(pi), self.nd)})
        return out


class TorchBinaryIllegal(_TorchBase):
    """3회차(Model 3) 위법 모델 — 2클래스 {none, illegal} 분류(법률 헤드 없음). related_laws 는 비운다(근거 검색 힌트만 빠짐)."""

    def __init__(self, path: Path, **kw):
        super().__init__("M2", path, **kw)
        from transformers import AutoModelForSequenceClassification, AutoTokenizer

        self.tok = AutoTokenizer.from_pretrained(path)
        self.model = AutoModelForSequenceClassification.from_pretrained(path, torch_dtype=self._torch.float32).eval()
        labels = {int(k): v for k, v in self.model.config.id2label.items()}
        if labels.get(0) != "none" or len(labels) != 2:
            raise ValueError("M2 이진 체크포인트 id2label 은 {0: none, 1: illegal} 이어야 한다")

    def predict(self, contract_type: str, clauses: list[ClauseText]) -> list[dict]:
        torch, out = self._torch, []
        with torch.inference_mode():
            for chunk, enc in self._batches(contract_type, clauses):
                probs = torch.softmax(self.model(**enc).logits, dim=-1)[:, 1]
                for c, p in zip(chunk, probs):
                    score = _round(rescale(float(p), self.threshold), self.nd)
                    out.append({"clause_id": c.clause_id, "label": "illegal" if score >= 0.5 else "none",
                                "type": None, "related_laws": [], "score": score})
        return out


def char_wb_ngrams(text: str, lo: int = 2, hi: int = 4) -> list[str]:
    """sklearn TfidfVectorizer(analyzer="char_wb", lowercase=True) 와 같은 글자 n-gram(단어 양끝에 공백을 붙여 단어 안에서만)."""
    out: list[str] = []
    for w in text.lower().split():
        w = f" {w} "
        for n in range(lo, hi + 1):
            off = 0
            out.append(w[off:off + n])
            while off + n < len(w):
                off += 1
                out.append(w[off:off + n])
            if off == 0:  # 짧은 단어는 한 번만
                break
    return out


def tfidf_proba(texts: list[str], vocab: dict[str, int], idf, coef, intercept: float) -> list[float]:
    """sublinear tf × idf → L2 정규화 → 로지스틱 회귀 확률(sklearn predict_proba 와 같은 값)."""
    import math

    res = []
    for t in texts:
        tf: dict[int, int] = {}
        for g in char_wb_ngrams(t):
            j = vocab.get(g)
            if j is not None:
                tf[j] = tf.get(j, 0) + 1
        vals = {j: (1.0 + math.log(c)) * float(idf[j]) for j, c in tf.items()}
        norm = math.sqrt(sum(v * v for v in vals.values())) or 1.0
        dec = intercept + sum(v / norm * float(coef[j]) for j, v in vals.items())
        res.append(1.0 / (1.0 + math.exp(-dec)))
    return res


class EnsembleIllegal(_TorchBase):
    """3회차(Model 3) 위법 모델 — CONCAT 미세조정(2클래스) + TF-IDF 로지스틱 회귀. VAL 로 고른 가중 평균(표준화 점수),
    점수 = sigmoid((결합 − 임계값)/척도) 라 임계값이 0.5. 법률 헤드는 없어 related_laws 는 비운다."""

    def __init__(self, path: Path, **kw):
        super().__init__("M2", path, **kw)
        import numpy as np
        from transformers import AutoModelForSequenceClassification, AutoTokenizer

        enc = path / "encoder"
        self.tok = AutoTokenizer.from_pretrained(enc)
        self.model = AutoModelForSequenceClassification.from_pretrained(enc, torch_dtype=self._torch.float32).eval()
        z = np.load(path / "tfidf.npz")
        self.idf, self.coef, self.b = z["idf"], z["coef"], float(z["intercept"])
        self.vocab = json.loads((path / "tfidf_vocab.json").read_text(encoding="utf-8"))
        self.cfg = _read_card(path)["serving"]

    def predict(self, contract_type: str, clauses: list[ClauseText]) -> list[dict]:
        import math

        torch, c, out = self._torch, self.cfg, []
        with torch.inference_mode():
            for chunk, enc in self._batches(contract_type, clauses):
                p_ft = torch.softmax(self.model(**enc).logits, dim=-1)[:, 1].tolist()
                p_tf = tfidf_proba([x.text for x in chunk], self.vocab, self.idf, self.coef, self.b)
                for cl, a, b in zip(chunk, p_ft, p_tf):
                    comb = c["w_finetune"] * (a - c["ft_mean"]) / c["ft_std"] + (1 - c["w_finetune"]) * (b - c["tfidf_mean"]) / c["tfidf_std"]
                    score = _round(1.0 / (1.0 + math.exp(-(comb - c["threshold_comb"]) / c["scale"])), self.nd)
                    out.append({"clause_id": cl.clause_id, "label": "illegal" if score >= 0.5 else "none",
                                "type": None, "related_laws": [], "score": score})
        return out


class EmbedSvmLoophole(Classifier):
    """3회차(Model 3) 편법 모델 — bge-m3 조항 임베딩(L2 정규화) + RBF SVM(numpy 로 계산, sklearn 불필요).
    점수 = Platt 확률(VALIDATION 적합) → rescale(VALIDATION 임계값 → 0.5). 임베딩은 게이트웨이 공유 Ollama 경로(embed_fn)로 받는다."""
    kind = "embed_svm"

    def __init__(self, path: Path, nd: int = 4, **_):
        import numpy as np

        card = _read_card(path)
        z = np.load(path / "svm.npz")
        self.np = np
        self.sv, self.coef = z["support_vectors"].astype(np.float32), z["dual_coef"].astype(np.float32).ravel()
        self.intercept, self.gamma = float(z["intercept"]), float(z["gamma"])
        self.platt_a, self.platt_b = float(z["platt_a"]), float(z["platt_b"])
        self.sv_sq = (self.sv * self.sv).sum(1)
        sv = card.get("serving") or {}
        self.threshold, self.embed_batch = sv.get("threshold"), int(sv.get("embed_batch", 32))
        self.id, self.name = "M1", card.get("name", path.name)
        self.model_version = card["model_version"]
        self.base = card.get("source", "bge-m3 + svm")
        self.path, self.trained_data_date, self.nd = path.name, card.get("trained_data_date"), nd
        self.embed_fn = None

    def bind_embed(self, fn) -> None:
        self.embed_fn = fn

    def prob(self, X) -> "list[float]":
        np = self.np
        d2 = self.sv_sq[None, :] + (X * X).sum(1)[:, None] - 2.0 * X @ self.sv.T
        dec = np.exp(-self.gamma * np.maximum(d2, 0.0)) @ self.coef + self.intercept
        return (1.0 / (1.0 + np.exp(self.platt_a * dec + self.platt_b))).tolist()

    def predict(self, contract_type: str, clauses: list[ClauseText]) -> list[dict]:
        if self.embed_fn is None:
            raise RuntimeError("M1 임베딩 경로가 연결되지 않았다")
        np, out = self.np, []
        for i in range(0, len(clauses), self.embed_batch):
            chunk = clauses[i:i + self.embed_batch]
            X = np.asarray(self.embed_fn([c.text for c in chunk]), dtype=np.float32)
            X /= np.linalg.norm(X, axis=1, keepdims=True) + 1e-12
            for c, p in zip(chunk, self.prob(X)):
                score = _round(rescale(p, self.threshold), self.nd)
                out.append({"clause_id": c.clause_id, "label": "loophole" if score >= 0.5 else "none", "type": None, "score": score})
        return out


def _torch_available() -> bool:
    try:
        import torch  # noqa: F401
        import transformers  # noqa: F401
        return True
    except ImportError:
        return False


def load_classifiers(model_root: Path, m1_dir: str, m2_dir: str, threads: int = 6, batch: int = 16,
                     max_len: int = 512, nd: int = 4) -> tuple[Classifier, Classifier]:
    """체크포인트가 있으면 PyTorch, 없으면 휴리스틱. 동기 함수 — 시작 시 스레드에서 부른다."""
    has_torch = _torch_available()
    kw = dict(threads=threads, batch=batch, max_len=max_len, nd=nd)
    loaded: list[Classifier] = []
    for d, torch_cls, heur_cls in ((m1_dir, TorchLoophole, HeuristicLoophole), (m2_dir, TorchIllegal, HeuristicIllegal)):
        path = model_root / d
        kind = ((_read_card(path).get("serving") or {}).get("kind") if (path / "model_card.json").is_file() else None)
        if kind == "embed_svm":  # 3회차 편법 — torch 불필요
            loaded.append(EmbedSvmLoophole(path, nd=nd))
        elif has_torch and kind == "ensemble_binary" and torch_cls is TorchIllegal:  # 3회차 위법 앙상블
            loaded.append(EnsembleIllegal(path, **kw))
        elif has_torch and kind == "seqcls_binary" and torch_cls is TorchIllegal:  # 3회차 위법 — 법률 헤드 없음
            loaded.append(TorchBinaryIllegal(path, **kw))
        elif has_torch and (path / "model_card.json").is_file():
            loaded.append(torch_cls(path, **kw))
        else:
            if (path / "model_card.json").is_file():
                log.warning("%s 체크포인트가 있으나 torch 가 없어 휴리스틱을 쓴다 (uv sync --extra classifiers)", d)
            loaded.append(heur_cls(nd))
        log.info("%s 적재: %s", loaded[-1].id, loaded[-1].model_version)
    return loaded[0], loaded[1]
