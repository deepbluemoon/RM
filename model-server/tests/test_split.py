"""FR-042 분할 규칙."""
from training.split import split


def test_synthetic_never_in_eval_and_doc_disjoint():
    rows = []
    for d in range(200):
        rows.append({"doc_id": f"d{d}", "origin": "real", "reviewed": d % 3 != 0, "category": "normal"})
        rows.append({"doc_id": f"s{d}", "origin": "synthetic", "derived_from_doc": f"d{d}", "category": "unfair"})
    p = split(rows, 15, 10)
    assert p["eval"] and all(r["origin"] == "real" and r["reviewed"] for r in p["eval"])
    eval_docs = {r["doc_id"] for r in p["eval"]}
    assert not eval_docs & {r["doc_id"] for r in p["train"] + p["dev"]}
    assert not eval_docs & {r.get("derived_from_doc") for r in p["train"]}
    assert all(r["origin"] == "real" for r in p["dev"])
