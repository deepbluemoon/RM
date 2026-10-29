"""/v1/jobs — 문서 단위 비동기 탐지(M1 ∥ M2). 메모리 안 asyncio 큐, 워커 1개(작업은 들어온 순서대로).

조항을 배치(기본 16)로 나눠 M1·M2 를 스레드에서 동시에 돌리고 결과를 조항별로 누적한다.
배치가 시간 안에 끝나지 않으면 그 조항들은 error='timeout'(E5 분석 불가)으로 남기고 다음 배치로 간다.
조항 텍스트는 작업이 끝나면 메모리에서 지운다. 작업 결과는 job_ttl_sec 뒤에 지운다.
"""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Callable

from .classifiers import Classifier, ClauseText

log = logging.getLogger("crd.jobs")


@dataclass
class Job:
    id: str
    contract_type: str
    clauses: list[ClauseText]
    status: str = "queued"
    total: int = 0
    done: int = 0
    results: list[dict] = field(default_factory=list)
    model_versions: dict[str, str] = field(default_factory=dict)
    created: float = field(default_factory=time.monotonic)

    def view(self) -> dict:
        return {"job_id": self.id, "status": self.status, "total": self.total, "done": self.done,
                "results": list(self.results), "model_versions": dict(self.model_versions),
                "knowledge_date": None}


class JobRunner:
    def __init__(self, get_models: Callable[[], tuple[Classifier, Classifier] | None],
                 batch_size: int = 16, batch_timeout_sec: float = 60, ttl_sec: float = 3600):
        self.get_models = get_models
        self.batch_size = batch_size
        self.batch_timeout = batch_timeout_sec
        self.ttl = ttl_sec
        self.jobs: dict[str, Job] = {}
        self.queue: asyncio.Queue[Job] = asyncio.Queue()
        self._worker: asyncio.Task | None = None

    def start(self) -> None:
        self._worker = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        if self._worker:
            self._worker.cancel()

    def _gc(self) -> None:
        now = time.monotonic()
        for jid in [j.id for j in self.jobs.values() if j.status in ("done", "failed") and now - j.created > self.ttl]:
            self.jobs.pop(jid, None)

    def submit(self, contract_type: str, clauses: list[ClauseText]) -> str:
        self._gc()
        job = Job(uuid.uuid4().hex, contract_type, clauses, total=len(clauses))
        self.jobs[job.id] = job
        self.queue.put_nowait(job)
        return job.id

    def get(self, job_id: str) -> Job | None:
        return self.jobs.get(job_id)

    async def _loop(self) -> None:
        while True:
            job = await self.queue.get()
            try:
                await self.run(job)
            except Exception as e:  # 예상 밖 오류 — 작업 전체 실패
                job.status = "failed"
                log.error("job %s 실패: %s", job.id, type(e).__name__)
            finally:
                job.clauses = []
                self.queue.task_done()

    async def run(self, job: Job) -> None:
        models = self.get_models()
        if models is None:
            raise RuntimeError("classifiers not ready")
        m1, m2 = models
        job.status = "running"
        job.model_versions = {"M1": m1.model_version, "M2": m2.model_version}
        for i in range(0, len(job.clauses), self.batch_size):
            chunk = job.clauses[i:i + self.batch_size]
            try:
                r1, r2 = await asyncio.wait_for(
                    asyncio.gather(asyncio.to_thread(m1.predict, job.contract_type, chunk),
                                   asyncio.to_thread(m2.predict, job.contract_type, chunk)),
                    timeout=self.batch_timeout)
                for c, a, b in zip(chunk, r1, r2):
                    a = {k: v for k, v in a.items() if k != "clause_id"}
                    b = {k: v for k, v in b.items() if k != "clause_id"}
                    job.results.append({"clause_id": c.clause_id, "loophole": a, "illegal": b, "error": None})
            except Exception as e:  # 시간 초과·추론 오류 → 조항 단위 분석 불가(계약 enum 은 timeout 하나)
                log.warning("job %s 배치 %d 실패: %s", job.id, i // self.batch_size, type(e).__name__)
                job.results.extend({"clause_id": c.clause_id, "error": "timeout"} for c in chunk)
            job.done += len(chunk)
        job.status = "done"
