"""로그에 요청 본문이 남지 않는다(BR-MDL-01)."""
import logging
import time

from .conftest import AUTH

SECRET = "비밀조항본문XYZ-7731"


def test_no_request_body_in_logs(client, caplog):
    caplog.set_level(logging.DEBUG)
    cl = [{"clause_id": "c1", "title": SECRET, "text": f"{SECRET} 환불되지 않습니다."}]
    client.post("/v1/summarize", headers=AUTH, json={"clauses": cl})
    client.post("/v1/detect/loophole", headers=AUTH, json={"clauses": cl, "contract_type": "ecommerce"})
    jid = client.post("/v1/jobs", headers=AUTH, json={"clauses": cl, "contract_type": "ecommerce"}).json()["job_id"]
    time.sleep(0.1)
    client.get(f"/v1/jobs/{jid}", headers=AUTH)
    client.post("/v1/judge", headers=AUTH, json={
        "clause": SECRET, "contract_type": "ecommerce", "perspective": "consumer", "knowledge_date": "2026-09-01",
        "scores": {}, "evidence": [{"id": "ev1", "source_type": "law_article", "title": SECRET, "text": SECRET}]})
    client.post("/v1/judge", headers=AUTH, json={"clause": SECRET, "perspective": 1})  # 400 경로
    text = "\n".join(r.getMessage() for r in caplog.records)
    assert SECRET not in text
    access = [r.getMessage() for r in caplog.records if r.name == "crd.access"]
    assert access and all("rid=" in m and "status=" in m and "latency_ms=" in m for m in access)
