"""Leakage audit for the versioned evasion v4 P1 training candidate."""
from __future__ import annotations

import json
import re
import unicodedata
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
DATASET = ROOT / "data_source/model_3/datasets/evasion_train_candidate_v4_p1/evasion_detector"
MASTER = ROOT / "data_source/model_3/registry/master_real_registry_v1/master_real_registry_v1.jsonl"
OUT = DATASET.parent / "leakage_audit_v1.json"


def read_jsonl(path: Path) -> list[dict]:
    with path.open(encoding="utf-8-sig") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def norm(text: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", text).casefold()).strip()


def grams(text: str) -> set[str]:
    words = re.findall(r"\w+", norm(text), flags=re.UNICODE)
    return {" ".join(words[i:i + 3]) for i in range(max(0, len(words) - 2))} or set(words)


def near(left: str, right: str) -> bool:
    a, b = grams(left), grams(right)
    if not a or not b:
        return False
    overlap = len(a & b)
    return overlap / len(a | b) >= 0.90 or overlap / min(len(a), len(b)) >= 0.80


def units(row: dict, mapping: dict[str, tuple[set[str], set[str], set[str]]]) -> tuple[set[str], set[str], set[str]]:
    meta = row.get("meta") or {}
    case = set(filter(None, [meta.get("case_id")]))
    doc = set(filter(None, [meta.get("document_id")]))
    family = set(filter(None, [meta.get("family_id")]))
    identifier = row.get("데이터ID")
    if identifier in mapping:
        a, b, c = mapping[identifier]
        case.update(a); doc.update(b); family.update(c)
    return case, doc, family


def main() -> None:
    source_map: dict[str, tuple[set[str], set[str], set[str]]] = {}
    for row in read_jsonl(MASTER):
        value = (set(row.get("case_ids") or []), set(row.get("document_ids") or []), set(row.get("family_ids") or []))
        for identifier in row.get("native_ids") or []:
            if isinstance(identifier, str):
                source_map[identifier] = value
    train, val, test = (read_jsonl(DATASET / f"{name}.jsonl") for name in ("train", "validation", "test"))
    train_exact = {norm(row["text"]) for row in train}
    val_exact = {norm(row["text"]) for row in val}
    test_exact = {norm(row["text"]) for row in test}
    train_units = [units(row, source_map) for row in train]
    val_units = [units(row, source_map) for row in val]
    test_units = [units(row, source_map) for row in test]
    def union(index: int, rows: list[tuple[set[str], set[str], set[str]]]) -> set[str]:
        return set().union(*(row[index] for row in rows)) if rows else set()
    train_case, train_doc, train_family = (union(i, train_units) for i in range(3))
    val_case, val_doc, val_family = (union(i, val_units) for i in range(3))
    test_case, test_doc, test_family = (union(i, test_units) for i in range(3))
    def near_count(left: list[dict], right: list[dict]) -> int:
        return sum(1 for a in left for b in right if near(a["text"], b["text"]))
    report = {
        "version": "evasion_train_candidate_v4_p1_leakage_audit_v1",
        "counts": {"train": len(train), "validation": len(val), "test": len(test)},
        "train_vs_validation": {
            "exact_normalized_text_overlap": len(train_exact & val_exact),
            "near_duplicate_pairs": near_count(train, val),
            "case_overlap": len(train_case & val_case),
            "document_overlap": len(train_doc & val_doc),
            "family_overlap": len(train_family & val_family),
        },
        "train_vs_test": {
            "exact_normalized_text_overlap": len(train_exact & test_exact),
            "near_duplicate_pairs": near_count(train, test),
            "case_overlap": len(train_case & test_case),
            "document_overlap": len(train_doc & test_doc),
            "family_overlap": len(train_family & test_family),
        },
        "validation_vs_test": {
            "exact_normalized_text_overlap": len(val_exact & test_exact),
            "near_duplicate_pairs": near_count(val, test),
            "case_overlap": len(val_case & test_case),
            "document_overlap": len(val_doc & test_doc),
            "family_overlap": len(val_family & test_family),
        },
    }
    report["status"] = "PASS" if all(value == 0 for section in ("train_vs_validation", "train_vs_test") for value in report[section].values()) else "FAIL"
    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": report["status"], "train_val": report["train_vs_validation"], "train_test": report["train_vs_test"]}, ensure_ascii=True))


if __name__ == "__main__":
    main()
