"""Preserve Session B raw output and run deterministic QC on its semantic PASS rows."""
from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
V4 = ROOT / "data_source/model_3/augmentation/evasion/evasion_new_seed_rounds_v4"
FINAL_POOL = ROOT / "data_source/model_3/augmentation/evasion/evasion_final_pool_v1"
DATASET = ROOT / "data_source/model_3/negative_eval_track/evaluation_candidate/model_dataset_v1_6_candidate/evasion_detector"
MASTER = ROOT / "data_source/model_3/registry/master_real_registry_v1/master_real_registry_v1.jsonl"

REJECT_IDS = {
    "ftcv5:R2005-019-002",
    "ftcv5:R2005-094-001",
    "ftcv5:R2007-046-001",
    "ftcv5:R2007-105-001",
}


def read_jsonl(path: Path) -> list[dict]:
    with path.open(encoding="utf-8-sig") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for part in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(part)
    return h.hexdigest()


def norm(text: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", text).casefold()).strip()


def tokens(text: str) -> set[str]:
    words = re.findall(r"\w+", norm(text), flags=re.UNICODE)
    return {" ".join(words[index:index + 3]) for index in range(max(0, len(words) - 2))} or set(words)


def similarity(left: str, right: str) -> tuple[float, float]:
    a, b = tokens(left), tokens(right)
    if not a or not b:
        return 0.0, 0.0
    intersection = len(a & b)
    return intersection / len(a | b), intersection / min(len(a), len(b))


def get_text(row: dict) -> str | None:
    for key in ("candidate_text", "text", "text_clean", "clause_text", "unit_text"):
        value = row.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return None


def main() -> None:
    batch_path = V4 / "raw/gen_in/P1_b00.json"
    raw_path = V4 / "raw/gen_out/P1_b00.jsonl"
    batch = json.loads(batch_path.read_text(encoding="utf-8-sig"))
    raw_before = digest(raw_path)
    generated = read_jsonl(raw_path)
    input_by_id = {row["source_data_id"]: row for row in batch["items"]}
    approved_by_id = {row["id"]: row for row in read_jsonl(FINAL_POOL / "intake/approved_pool_v6_classified.jsonl")}

    semantic_rows = []
    for row in generated:
        parent_id = row.get("source_data_id")
        semantic_rows.append({
            "source_data_id": parent_id,
            "variant_no": row.get("variant_no"),
            "semantic_status": "REJECT" if parent_id in REJECT_IDS else "PASS",
            "semantic_reason": "Session B: source similarity too high or unnatural generated language" if parent_id in REJECT_IDS else "Session B semantic PASS",
            "source_generation_file": raw_path.relative_to(ROOT).as_posix(),
        })
    semantic_path = V4 / "raw/semantic_qc/P1_b00_semantic_qc_v1.jsonl"
    write_jsonl(semantic_path, semantic_rows)
    semantic_manifest = {
        "version": "session_b_semantic_qc_v1",
        "raw_generation_file": raw_path.relative_to(ROOT).as_posix(),
        "raw_generation_sha256": raw_before,
        "total": len(semantic_rows),
        "counts": dict(Counter(row["semantic_status"] for row in semantic_rows)),
        "unresolved": 0,
        "semantic_reject_parent_ids": sorted(REJECT_IDS),
        "raw_file_modified": False,
    }
    write_json(V4 / "raw/semantic_qc/P1_b00_semantic_qc_manifest_v1.json", semantic_manifest)

    # The complete candidate corpus used for text checks: canonical v1_6 splits,
    # historical final synthetic snapshots, and all 14 current input parents.
    train_rows = read_jsonl(DATASET / "train.jsonl")
    validation_rows = read_jsonl(DATASET / "validation.jsonl")
    test_rows = read_jsonl(DATASET / "test.jsonl")
    train_texts = [("train", row, get_text(row)) for row in train_rows if get_text(row)]
    eval_texts = [("validation", row, get_text(row)) for row in validation_rows if get_text(row)]
    eval_texts += [("test", row, get_text(row)) for row in test_rows if get_text(row)]
    synthetic_texts = []
    for path in ROOT.glob("data_source/model_3/augmentation/evasion/**/snapshot/*.jsonl"):
        for row in read_jsonl(path):
            text = get_text(row)
            if text:
                synthetic_texts.append((path.relative_to(ROOT).as_posix(), row, text))
    parent_texts = [(item["source_data_id"], item["source_text"]) for item in batch["items"]]

    holdout_cases, holdout_docs, holdout_families = set(), set(), set()
    eval_cases, eval_docs, eval_families = set(), set(), set()
    for row in read_jsonl(MASTER):
        if row.get("split_owner") == "HOLDOUT":
            holdout_cases.update(row.get("case_ids") or [])
            holdout_docs.update(row.get("document_ids") or [])
            holdout_families.update(row.get("family_ids") or [])
        if row.get("split_owner") == "EVAL_ONLY":
            eval_cases.update(row.get("case_ids") or [])
            eval_docs.update(row.get("document_ids") or [])
            eval_families.update(row.get("family_ids") or [])

    seen_pairs: set[tuple[str, object]] = set()
    pass_rows = [row for row in generated if row.get("source_data_id") not in REJECT_IDS]
    qc_rows = []
    for row in pass_rows:
        parent_id = row.get("source_data_id")
        candidate = row.get("candidate_text")
        parent = approved_by_id.get(parent_id)
        item = input_by_id.get(parent_id)
        failures: list[str] = []
        notes: dict[str, object] = {}
        if not isinstance(parent_id, str) or parent_id not in input_by_id:
            failures.append("PARENT_NOT_IN_BATCH")
        if not isinstance(row.get("variant_no"), int) or row.get("variant_no") < 1:
            failures.append("INVALID_VARIANT_NO")
        pair = (parent_id, row.get("variant_no"))
        if pair in seen_pairs:
            failures.append("DUPLICATE_CANDIDATE_ID")
        seen_pairs.add(pair)
        if not isinstance(candidate, str) or not candidate.strip():
            failures.append("MISSING_CANDIDATE_TEXT")
            candidate = ""
        if parent is None:
            failures.append("PARENT_NOT_IN_APPROVED_POOL")
        else:
            if parent["source_row"].get("synthetic") is not False:
                failures.append("SYNTHETIC_AS_SEED")
            if not parent["train_ownership"].startswith("TRAIN"):
                failures.append("PARENT_NOT_TRAIN_OWNED")
            if parent["eval_registry_conflicts"]:
                failures.append("PARENT_EVAL_CONFLICT")
            if not all(parent.get(key) for key in ("case_id", "document_id", "family_id")):
                failures.append("INCOMPLETE_PARENT_LINEAGE")
            if parent["case_id"] in holdout_cases or parent["document_id"] in holdout_docs or parent["family_id"] in holdout_families:
                failures.append("HOLDOUT_GROUP_OVERLAP")
            if parent["case_id"] in eval_cases or parent["document_id"] in eval_docs or parent["family_id"] in eval_families:
                failures.append("EVAL_GROUP_OVERLAP")
        if item is None:
            failures.append("MISSING_INPUT_LINEAGE")
        elif not item.get("parent_metadata", {}).get("source_approval"):
            failures.append("MISSING_SOURCE_APPROVAL")

        candidate_norm = norm(candidate)
        source_text = item["source_text"] if item else ""
        if candidate_norm and candidate_norm == norm(source_text):
            failures.append("EXACT_DUPLICATE_PARENT")
        exact_sets = {
            "TRAIN": {norm(text) for _, _, text in train_texts},
            "EVAL": {norm(text) for _, _, text in eval_texts},
            "SYNTHETIC": {norm(text) for _, _, text in synthetic_texts},
        }
        for label, values in exact_sets.items():
            if candidate_norm and candidate_norm in values:
                failures.append(f"EXACT_DUPLICATE_{label}")

        comparisons = [("PARENT", parent_id, source_text)]
        comparisons += [("TRAIN", None, text) for _, _, text in train_texts]
        comparisons += [("EVAL", None, text) for _, _, text in eval_texts]
        comparisons += [("SYNTHETIC", None, text) for _, _, text in synthetic_texts]
        comparisons += [("BATCH_PARENT", identifier, text) for identifier, text in parent_texts if identifier != parent_id]
        max_jaccard, max_containment, max_kind = 0.0, 0.0, None
        for kind, _, reference in comparisons:
            jaccard, containment = similarity(candidate, reference)
            if jaccard > max_jaccard:
                max_jaccard, max_containment, max_kind = jaccard, containment, kind
            if jaccard >= 0.90 or containment >= 0.80:
                failures.append(f"NEAR_DUPLICATE_{kind}")
        notes["max_jaccard_3gram"] = round(max_jaccard, 6)
        notes["max_containment_3gram"] = round(max_containment, 6)
        notes["nearest_kind"] = max_kind
        if source_text:
            ratio = len(candidate) / max(1, len(source_text))
            notes["length_ratio_to_parent"] = round(ratio, 6)
            if ratio < 0.60 or ratio > 1.60:
                failures.append("LENGTH_ANOMALY")
        qc_rows.append({
            "source_data_id": parent_id,
            "variant_no": row.get("variant_no"),
            "candidate_text": candidate,
            "semantic_status": "PASS",
            "python_qc_status": "FAIL" if failures else "PASS",
            "failures": sorted(set(failures)),
            "lineage": {key: parent.get(key) if parent else None for key in ("case_id", "document_id", "family_id")},
            "checks": notes,
            "source_generation_file": raw_path.relative_to(ROOT).as_posix(),
        })

    qc_path = V4 / "qc/deterministic/P1_b00_python_qc_v1.jsonl"
    write_jsonl(qc_path, qc_rows)
    final_rows = [row for row in qc_rows if row["python_qc_status"] == "PASS"]
    write_jsonl(V4 / "final_candidates/P1_b00_final_synthetic_candidates_v1.jsonl", final_rows)
    raw_after = digest(raw_path)
    report = {
        "version": "evasion_v4_p1_deterministic_qc_v1",
        "raw_generation": {"path": raw_path.relative_to(ROOT).as_posix(), "sha256_before": raw_before, "sha256_after": raw_after, "preserved": raw_before == raw_after},
        "semantic": semantic_manifest,
        "python_qc": {"input_semantic_pass": len(pass_rows), "pass": len(final_rows), "fail": len(qc_rows) - len(final_rows), "checks": ["schema", "missing_field", "candidate_id_uniqueness", "parent_existence", "parent_real", "synthetic_as_seed", "exact_duplicate", "normalized_duplicate", "near_duplicate", "existing_synthetic_overlap", "train_eval_leakage", "holdout_overlap", "case_document_family_conflict", "lineage_completeness", "length_anomaly"]},
        "outputs": {"semantic_qc": semantic_path.relative_to(ROOT).as_posix(), "python_qc": qc_path.relative_to(ROOT).as_posix(), "final_candidates": (V4 / "final_candidates/P1_b00_final_synthetic_candidates_v1.jsonl").relative_to(ROOT).as_posix()},
    }
    write_json(V4 / "qc/deterministic/P1_b00_python_qc_report_v1.json", report)
    print(json.dumps({"semantic": semantic_manifest["counts"], "python_qc": report["python_qc"], "raw_preserved": raw_before == raw_after}, ensure_ascii=True))


if __name__ == "__main__":
    main()
