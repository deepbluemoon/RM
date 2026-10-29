"""M3(최종판정)·M4(요약) — 공유 Ollama /api/chat 호출 (model-serving §0, §5.3, §5.4).

요청마다 keep_alive 5m, think false, stream false, num_ctx 8192, temperature 0, top_k 1, seed 0,
format = JSON 스키마. M3·M4 는 채팅 모델 하나(기본 공용 qwen3:4b-instruct-2507-q4_K_M)를 같이 쓴다(가이드 1.7-4).
model_version: 이 계정이 등록한 bf16 커스텀(models.lock.yaml ollama_name) = "<version_prefix>@<revision 앞 12자>",
그 밖(공용·대체 모델) = "ollama:<이름>". 이름이 바뀌면 백엔드 판정 캐시 키가 달라져 결과가 섞이지 않는다.

적재 시간 처리(§0.1): 상주 여부를 모르는(cold) 모델을 부르는 동안 그 모델은 state=loading 으로 보고한다.
미리 올리기는 게이트웨이 기동 시 1회만 한다(가이드 1.6, 1.7-10).
"""
from __future__ import annotations

import asyncio
import copy
import json
import logging
import math
import re
import time
from dataclasses import dataclass
from pathlib import Path

import yaml

from .classifiers import CONTRACT_TYPE_KO
from .config import LlmModelCfg, Settings
from .ollama_client import Inventory, OllamaClient, OllamaError, norm_name
from .postfilter import AssertionFilter
from .summarize_input import Clause, budget, build

log = logging.getLogger("crd.llm")

NUM_CTX = 8192  # 가이드 1.3 고정값 — 미리 올리기도 같은 값(다르면 공용 모델이 다시 적재된다)


def strip_think(text: str) -> str:
    """think:false 여도 사고 과정이 섞여 나오면 '</think>' 앞부분을 버린다(가이드 1.4, 2.2 _strip_think)."""
    return text.split("</think>", 1)[1].lstrip() if "</think>" in text else text
CONTRACT_TYPES = list(CONTRACT_TYPE_KO)
RISK_TYPES_ALL = ["rights_limit", "liability_avoid", "refund_cancel_limit", "unilateral_change",
                  "excessive_penalty", "vague", "other"]


def estimate_load_sec(size_bytes: int | None) -> int:
    """cold 모델 적재 예상 초 = max(10, ceil(크기GB × 3)).
    근거: 참조 §7.4 실측 10~30초(4B Q4 ≈ 3.3GB 가 10초 안팎), 디스크→통합 메모리 적재가 크기에 비례.
    게이트웨이가 이보다 긴 load_duration 을 관측하면 그 값을 쓴다(LlmService.load_estimate)."""
    if not size_bytes:
        return 10
    return max(10, math.ceil(size_bytes / 1e9 * 3))


def build_judge_schema(tpl: dict, evidence_ids: list[str]) -> dict:
    """요청마다 evidence_ids 항목을 그 요청 근거 ID 의 enum 으로 제한한다(BR-EXP-04)."""
    sc = copy.deepcopy(tpl)
    expl = sc["properties"]["explanation"]
    if evidence_ids:
        expl["items"]["properties"]["evidence_ids"]["items"]["enum"] = list(dict.fromkeys(evidence_ids))
    else:  # 근거가 없으면 주장도 없다
        expl["maxItems"] = 0
        expl["items"]["properties"]["evidence_ids"] = {"type": "array", "items": {"type": "string"}}
    return sc


@dataclass
class Resolved:
    id: str
    name: str
    is_fallback: bool
    state: str               # ready | cold | missing | error | loading
    size: int | None = None
    digest: str | None = None


JUDGE_SYSTEM = """당신은 한국 소비자 계약 조항의 위험을 1차로 분류하는 보조 도구입니다. 법률 자문이 아니며 최종 판단은 전문가가 합니다.
규칙:
1. 제공된 조항과 근거(evidence)만 사용합니다. 근거에 없는 법 지식으로 결론을 만들지 않습니다.
2. risk_class 는 normal(정상), dispute(분쟁 가능), unfair(불공정 가능), illegal(위법 가능) 중 하나입니다.
3. risk_class 가 normal 이면 risk_type·risk_level·confidence 는 모두 null 입니다. 그 밖에는 셋 다 채웁니다.
4. risk_type: rights_limit(권리 제한), liability_avoid(책임 회피), refund_cancel_limit(환불·해지 제한), unilateral_change(일방적 변경), excessive_penalty(과도한 위약금), vague(모호한 표현), other(기타).
5. risk_level 은 high·mid·low, confidence 는 high·medium·low 입니다.
6. 관점(perspective)은 설명의 초점만 바꿉니다. consumer 이면 소비자가 확인하고 대응할 점을, business 이면 사업자가 조항을 고칠 때 볼 점을 설명합니다. 관점 때문에 risk_class·risk_type·risk_level·confidence 를 바꾸지 않습니다.
7. explanation 은 최대 3개의 쉬운 한국어 문장입니다. 각 문장에는 그 문장을 뒷받침하는 근거 id 를 evidence_ids 에 넣습니다.
8. 단정하지 않습니다. "위법이다", "무효이다", "~해야 한다" 같은 표현 대신 "~할 가능성이 있습니다", "~소지가 있습니다", "검토가 필요합니다" 처럼 씁니다.
9. 편법·위법 점수는 참고값입니다. 조항 내용과 근거를 우선합니다.
JSON 으로만 답합니다."""

SUMMARIZE_SYSTEM = """당신은 한국어 계약서 요약 도구입니다. 비식별화된 조항 목록을 읽고 JSON 으로만 답합니다.
- summary: 핵심 조건, 당사자 의무, 해지·환불 조건을 5~8문장의 쉬운 한국어로 요약합니다. 조항에 없는 내용을 지어내지 않고, 위법·무효 같은 법적 판단은 하지 않습니다.
- contract_type_candidates: 계약 유형 후보 최대 3개(score 0~1, 높은 순). label 은 ecommerce(전자상거래), subscription(구독), installment(할부), door_to_door(방문판매), general_consumer(일반 소비자 거래), out_of_scope(범위 밖 — 소비자 계약이 아님) 중 하나입니다."""


class LlmService:
    def __init__(self, s: Settings, client: OllamaClient, inventory: Inventory, pf: AssertionFilter):
        self.s = s
        self.client = client
        self.inv = inventory
        self.pf = pf
        self.lock = yaml.safe_load(s.models_lock_path.read_text(encoding="utf-8"))["models"] if s.models_lock_path.is_file() else {}
        self.judge_tpl = json.loads(s.m3.json_schema.read_text(encoding="utf-8"))
        # 판정 속도(2026-09-30): 설명 문장 수·길이를 줄이면 생성 토큰이 줄어 판정 1건 3.8s → 2.1s(40건 측정, training/m3_speed_bench.py)
        expl = self.judge_tpl["properties"]["explanation"]
        if s.m3.explain_max_items is not None:
            expl["maxItems"] = s.m3.explain_max_items
        if s.m3.explain_max_chars is not None:
            expl["items"]["properties"]["claim"]["maxLength"] = s.m3.explain_max_chars
        self.judge_tpl.pop("$comment", None)
        self.sum_schema = json.loads(s.m4.json_schema.read_text(encoding="utf-8"))
        self.sum_schema.pop("$comment", None)
        self.observed_load_sec: dict[str, float] = {}
        self.loading: set[str] = set()   # 적재 중(cold 호출·예열 진행 중)인 모델 이름
        self._tasks: set[asyncio.Task] = set()

    # ---------------------------------------------------------- 모델 해석
    def cfg(self, mid: str) -> LlmModelCfg:
        return self.s.m3 if mid == "M3" else self.s.m4

    async def resolve(self, mid: str) -> Resolved:
        cfg = self.cfg(mid)
        snap = await self.inv.snapshot()
        if not snap.ok:
            return Resolved(mid, cfg.model, False, "error")
        for name, fb in ((cfg.model, False), (cfg.fallback, True)):
            if name and norm_name(name) in snap.installed:
                meta = snap.installed[norm_name(name)]
                if norm_name(name) in self.loading:
                    state = "loading"
                else:
                    state = "ready" if self.inv.is_resident(name) else "cold"
                return Resolved(mid, name, fb, state, meta.get("size"), meta.get("digest"))
        return Resolved(mid, cfg.model, False, "missing")

    def model_version(self, r: Resolved) -> str:
        lk = self.lock.get(r.id, {})
        if r.is_fallback or not lk.get("ollama_name") or norm_name(r.name) != norm_name(lk["ollama_name"]):
            return f"ollama:{r.name}"
        prefix = lk.get("version_prefix", r.name)
        rev = str(lk.get("revision") or "")
        return f"{prefix}@{rev[:12] if re.fullmatch(r'[0-9a-f]{12,40}', rev) else 'unpinned'}"

    def load_estimate(self, r: Resolved) -> int:
        # 관측값이 크기 기반 추정보다 길 때만 쓴다 — 다른 사용자 덕에 디스크 캐시에서 1초 만에 올라온 관측이
        # 완전히 내려간 뒤의 실제 적재(10~30초)를 짧게 안내하지 않도록(가이드 1.4)
        seen = self.observed_load_sec.get(r.name) or 0
        return max(estimate_load_sec(r.size), math.ceil(seen))

    # ---------------------------------------------------------- 호출
    def _body(self, cfg: LlmModelCfg, name: str, system: str, user: str, schema: dict) -> dict:
        return {
            "model": name,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "stream": False,
            "think": False,
            "keep_alive": self.s.keep_alive,
            "format": schema,
            "options": {"temperature": 0, "top_k": 1, "seed": 0,
                        "num_ctx": NUM_CTX, "num_predict": cfg.num_predict},
        }

    def _record_load(self, name: str, resp: dict) -> None:
        ld = (resp.get("load_duration") or 0) / 1e9
        if ld >= 1.0:  # 1초 이상이면 실제 적재가 일어난 것으로 본다
            self.observed_load_sec[name] = ld
            log.info("모델 적재 관측 %s %.1fs", name, ld)

    async def _call_chat(self, r: Resolved, body: dict) -> dict:
        """호출 결과로 상주·설치·연결 상태를 고친다(추가 조회 없음 — 가이드 1.7-6)."""
        n = norm_name(r.name)
        cold = r.state == "cold"
        if cold:
            self.loading.add(n)
        try:
            resp = await self.client.chat(body)
        except OllamaError as e:
            if e.upstream_status == 404:
                self.inv.note_missing(r.name)
            elif e.upstream_status is None:
                self.inv.note_down(e.detail)
            raise
        finally:
            if cold:
                self.loading.discard(n)
        self._record_load(r.name, resp)
        self.inv.note_success(r.name)
        return resp

    async def _chat_json(self, mid: str, system: str, user: str, schema: dict) -> tuple[dict, Resolved]:
        r = await self.resolve(mid)
        if r.state == "missing":
            raise OllamaError(503, f"{mid} 모델 미설치({r.name}) — ollama list 로 이름을 확인하세요(런타임은 모델을 받지 않는다)")
        if r.state == "error":
            raise OllamaError(503, "공유 Ollama 연결 불가 — 관리자 확인 필요")
        resp = await self._call_chat(r, self._body(self.cfg(mid), r.name, system, user, schema))
        content = strip_think((resp.get("message") or {}).get("content", "")).strip()
        try:
            data = json.loads(content)
        except json.JSONDecodeError:
            raise OllamaError(503, f"{mid} 출력이 JSON 형식이 아님") from None
        if not isinstance(data, dict):
            raise OllamaError(503, f"{mid} 출력이 객체가 아님")
        return data, r

    # ---------------------------------------------------------- M3 판정
    def judge_schema(self, evidence_ids: list[str]) -> dict:
        return build_judge_schema(self.judge_tpl, evidence_ids)

    @staticmethod
    def judge_prompt(req: dict) -> str:
        ct = req["contract_type"]
        sc = req.get("scores") or {}
        lines = [
            f"계약 유형: {CONTRACT_TYPE_KO.get(ct, ct)} ({ct})",
            f"지식 기준일: {req['knowledge_date']}",
            f"관점: {req['perspective']}",
            f"참고 점수: 편법 {sc.get('loophole', '-')}, 위법 {sc.get('illegal', '-')}",
            "", "조항:", "<<<", req["clause"].strip(), ">>>", "", "근거:",
        ]
        for ev in req.get("evidence") or []:
            lines += [f"[id={ev['id']}] ({ev['source_type']}) {ev['title']}", ev["text"].strip(), ""]
        if not req.get("evidence"):
            lines.append("(근거 없음 — explanation 은 빈 배열)")
        return "\n".join(lines)

    async def judge(self, req: dict) -> dict:
        ev_ids = [str(e["id"]) for e in req.get("evidence") or []]
        data, r = await self._chat_json("M3", JUDGE_SYSTEM, self.judge_prompt(req), self.judge_schema(ev_ids))
        rc = data.get("risk_class")
        if rc not in ("normal", "dispute", "unfair", "illegal"):
            raise OllamaError(503, "M3 risk_class 가 스키마 밖")
        if rc == "normal":  # DDL chk: normal 이면 세 필드 NULL
            rt = rl = cf = None
        else:  # DDL chk: 그 밖이면 세 필드 NOT NULL — 빠졌으면 보수적으로 채운다
            rt = data.get("risk_type") if data.get("risk_type") in RISK_TYPES_ALL else "other"
            rl = data.get("risk_level") if data.get("risk_level") in ("high", "mid", "low") else "low"
            cf = data.get("confidence") if data.get("confidence") in ("high", "medium", "low") else "low"
        claims = data.get("explanation") if isinstance(data.get("explanation"), list) else []
        explanation = self.pf.filter([c for c in claims if isinstance(c, dict)][:3], set(ev_ids))
        return {"risk_class": rc, "risk_type": rt, "risk_level": rl, "confidence": cf,
                "explanation": explanation, "model_version": self.model_version(r),
                "knowledge_date": req["knowledge_date"]}

    # ---------------------------------------------------------- M4 요약
    async def summarize(self, clauses: list[dict]) -> dict:
        cfg = self.s.m4
        cl = [Clause(c["clause_id"], c["text"], c.get("article_no"), c.get("title")) for c in clauses]
        built = build(cl, budget(cfg.num_ctx, cfg.num_predict, SUMMARIZE_SYSTEM))
        user = f"다음 계약서 조항을 요약하세요.\n\n{built.text}"
        data, r = await self._chat_json("M4", SUMMARIZE_SYSTEM, user, self.sum_schema)
        cands = []
        for c in data.get("contract_type_candidates") or []:
            if isinstance(c, dict) and c.get("label") in CONTRACT_TYPES:
                try:
                    score = round(min(1.0, max(0.0, float(c.get("score", 0)))), 4)
                except (TypeError, ValueError):
                    score = 0.0
                cands.append({"label": c["label"], "score": score})
        cands.sort(key=lambda x: -x["score"])
        return {"summary": str(data.get("summary", "")).strip(), "contract_type_candidates": cands[:3],
                "model_version": self.model_version(r), "knowledge_date": None}

    # ---------------------------------------------------------- 예열(기동 시 1회)
    def start_warmup(self) -> None:
        """게이트웨이 기동 시 1회만 부른다. M3·M4 가 같은 모델이므로 하나만 올린다."""
        t = asyncio.create_task(self.warmup("M3"))
        self._tasks.add(t)
        t.add_done_callback(self._tasks.discard)

    async def warmup(self, mid: str) -> None:
        """설치됐지만 상주 중이 아닐 때만 빈 프롬프트 /api/generate(keep_alive 5m, num_ctx 8192). 같은 세마포어를 거친다."""
        r = await self.resolve(mid)
        if r.state != "cold":
            if r.state in ("missing", "error"):
                log.warning("예열 건너뜀 %s: %s (%s)", mid, r.state, r.name)
            return
        n = norm_name(r.name)
        self.loading.add(n)
        t0 = time.monotonic()
        try:
            resp = await self.client.warmup(r.name, self.s.keep_alive, NUM_CTX)
            self._record_load(r.name, resp)
            self.inv.note_success(r.name)
            log.info("예열 완료 %s %.1fs", r.name, time.monotonic() - t0)
        except OllamaError as e:
            log.warning("예열 실패 %s: %s", r.name, e.detail)
        finally:
            self.loading.discard(n)

    # ---------------------------------------------------------- 임베딩(근거 검색 — 하이브리드 RAG)
    async def embed(self, texts: list[str]) -> dict:
        """bge-m3 임베딩. 설치된 모델만 쓴다(런타임에서 받지 않음). 벡터는 L2 정규화(코사인 = 내적)해 돌려준다.
        model_version = "<이름>@<digest 앞 12자>" — 백엔드가 evidence_embedding.model 로 저장해 모델이 바뀌면 섞이지 않게 한다."""
        name = self.s.embed_model
        snap = await self.inv.snapshot()
        if not snap.ok:
            raise OllamaError(503, "공유 Ollama 연결 불가 — 관리자 확인 필요")
        meta = snap.installed.get(norm_name(name))
        if meta is None:
            raise OllamaError(503, f"임베딩 모델 미설치({name}) — ollama list 로 이름을 확인하세요(런타임은 모델을 받지 않는다)")
        try:
            resp = await self.client.embed(name, texts, self.s.keep_alive)
        except OllamaError as e:
            if e.upstream_status == 404:
                self.inv.note_missing(name)
            elif e.upstream_status is None:
                self.inv.note_down(e.detail)
            raise
        vecs = resp.get("embeddings") or []
        if len(vecs) != len(texts) or any(len(v) != self.s.embed_dim for v in vecs):
            raise OllamaError(503, f"임베딩 차원·개수 불일치(기대 {self.s.embed_dim}차원 × {len(texts)})")
        out = []
        for v in vecs:
            n = math.sqrt(sum(x * x for x in v)) or 1.0
            out.append([round(x / n, 6) for x in v])
        digest = str(meta.get("digest") or "").split(":")[-1]
        return {"model_version": f"{name.removesuffix(':latest')}@{digest[:12] or 'unknown'}", "dim": self.s.embed_dim, "embeddings": out}

    async def aclose(self) -> None:
        for t in list(self._tasks):
            t.cancel()
