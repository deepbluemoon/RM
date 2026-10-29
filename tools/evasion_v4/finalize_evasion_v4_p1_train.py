"""Freeze Python-QC-passing P1 rows and build a versioned evasion TRAIN candidate."""
from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
V4 = ROOT / "data_source/model_3/augmentation/evasion/evasion_new_seed_rounds_v4"
HISTORY = ROOT / "data_source/model_3/augmentation/evasion/evasion_new_seed_rounds_v3_p1retry/snapshot/evasion_synthetic_positive_pool_cumulative.jsonl"
TRAIN = ROOT / "data_source/model_3/negative_eval_track/evaluation_candidate/model_dataset_v1_6_candidate/evasion_detector/train.jsonl"
VAL = ROOT / "data_source/model_3/negative_eval_track/evaluation_candidate/model_dataset_v1_6_candidate/evasion_detector/validation.jsonl"
TEST = ROOT / "data_source/model_3/negative_eval_track/evaluation_candidate/model_dataset_v1_6_candidate/evasion_detector/test.jsonl"
FINAL_POOL = ROOT / "data_source/model_3/augmentation/evasion/evasion_final_pool_v1/intake/approved_pool_v6_classified.jsonl"
OUT = ROOT / "data_source/model_3/datasets/evasion_train_candidate_v4_p1"


def read_jsonl(path: Path) -> list[dict]:
    with path.open(encoding="utf-8-sig") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def norm(text: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", text).casefold()).strip()


def main() -> None:
    qc_rows = read_jsonl(V4 / "qc/deterministic/P1_b00_python_qc_v1.jsonl")
    accepted = [row for row in qc_rows if row["python_qc_status"] == "PASS"]
    approved = {row["id"]: row for row in read_jsonl(FINAL_POOL)}
    final_rows = []
    for row in accepted:
        parent = approved[row["source_data_id"]]
        safe_parent_id = re.sub(r"[^A-Za-z0-9]+", "-", row["source_data_id"]).strip("-")
        synthetic_id = f"SYN-EV-V4-{safe_parent_id}-v{row['variant_no']:02d}"
        model_input = {
            "데이터ID": synthetic_id,
            "text": row["candidate_text"],
            "contract_type": parent["source_row"].get("platform"),
            "title": parent["source_row"].get("provenance", {}).get("issue_heading"),
            "label": 1,
            "label_level": "SYNTHETIC_SESSION_B_SEMANTIC_PASS+PYTHON_QC_PASS",
            "weak_label": False,
            "reviewed": False,
            "origin": "synthetic",
            "데이터출처": "Model3 evasion augmentation v4 P1",
            "분할그룹ID": parent["group_id"],
            "데이터분할": "TRAIN",
            "meta": {
                "case_id": parent["case_id"],
                "document_id": parent["document_id"],
                "family_id": parent["family_id"],
                "parent_seed_id": row["source_data_id"],
                "synthetic": True,
                "parent_synthetic": False,
                "source_generation_file": "data_source/model_3/augmentation/evasion/evasion_new_seed_rounds_v4/raw/gen_out/P1_b00.jsonl",
            },
        }
        final_rows.append({
            "synthetic_id": synthetic_id,
            "text": row["candidate_text"],
            "label": 1,
            "synthetic": True,
            "origin": "synthetic",
            "final_status": "FINAL_ACCEPT",
            "review_level": "SESSION_B_SEMANTIC_PASS + PYTHON_DETERMINISTIC_QC_PASS",
            "source_data_id": row["source_data_id"],
            "source_group_id": parent["group_id"],
            "source_family_id": parent["family_id"],
            "source_document_id": parent["document_id"],
            "source_case_id": parent["case_id"],
            "source_split": "TRAIN",
            "source_origin": "real",
            "source_is_synthetic": False,
            "source_pattern_or_type": parent["codes"],
            "variant_no": row["variant_no"],
            "semantic_qc_status": "PASS",
            "python_qc_status": "PASS",
            "model_input_row": model_input,
        })

    history = read_jsonl(HISTORY)
    all_ids = [row["synthetic_id"] for row in history + final_rows]
    if len(all_ids) != len(set(all_ids)):
        raise RuntimeError("Synthetic ID collision in cumulative snapshot")
    write_jsonl(OUT / "final_synthetic/evasion_v4_p1_final_synthetic_v1.jsonl", final_rows)
    write_jsonl(OUT / "final_synthetic/evasion_synthetic_positive_pool_cumulative_v4_p1.jsonl", history + final_rows)
    canonical_train = read_jsonl(TRAIN)
    historical_input = [row["model_input_row"] for row in history]
    combined_train = canonical_train + historical_input + [row["model_input_row"] for row in final_rows]
    ids = [row["데이터ID"] for row in combined_train]
    if len(ids) != len(set(ids)):
        raise RuntimeError("Duplicate training row ID in versioned candidate")
    if any(norm(row["text"]) == "" for row in combined_train):
        raise RuntimeError("Empty text in versioned training candidate")
    write_jsonl(OUT / "evasion_detector/train.jsonl", combined_train)
    write_jsonl(OUT / "evasion_detector/validation.jsonl", read_jsonl(VAL))
    write_jsonl(OUT / "evasion_detector/test.jsonl", read_jsonl(TEST))

    counts = Counter(row["label"] for row in combined_train)
    stats = {
        "version": "evasion_train_candidate_v4_p1",
        "real_train": len(canonical_train),
        "real_positive": sum(row["label"] == 1 for row in canonical_train),
        "real_negative": sum(row["label"] == 0 for row in canonical_train),
        "historical_final_synthetic": len(history),
        "new_final_synthetic": len(final_rows),
        "total_final_synthetic": len(history) + len(final_rows),
        "train_total": len(combined_train),
        "positive": counts[1],
        "negative": counts[0],
        "real_total_to_synthetic_ratio": f"{len(canonical_train)}:{len(history) + len(final_rows)}",
        "real_positive_to_synthetic_positive_ratio": f"{sum(row['label'] == 1 for row in canonical_train)}:{len(history) + len(final_rows)}",
        "positive_to_negative_ratio": round(counts[1] / counts[0], 6),
        "augmentation_parent_total": len(final_rows),
        "newly_used_parent_count": len(final_rows),
        "unused_eligible_parent_count": 0,
    }
    write_json(OUT / "statistics.json", stats)
    manifest = {
        "version": "evasion_train_candidate_v4_p1",
        "policy": "Versioned candidate only; existing official datasets are unmodified.",
        "inputs": {
            str(TRAIN.relative_to(ROOT)): sha256(TRAIN),
            str(HISTORY.relative_to(ROOT)): sha256(HISTORY),
            str((V4 / 'qc/deterministic/P1_b00_python_qc_v1.jsonl').relative_to(ROOT)): sha256(V4 / "qc/deterministic/P1_b00_python_qc_v1.jsonl"),
        },
        "outputs": {},
    }
    for path in (OUT / "final_synthetic").glob("*.jsonl"):
        manifest["outputs"][str(path.relative_to(ROOT))] = sha256(path)
    for path in (OUT / "evasion_detector").glob("*.jsonl"):
        manifest["outputs"][str(path.relative_to(ROOT))] = sha256(path)
    write_json(OUT / "EXPORT_MANIFEST.json", manifest)
    print(json.dumps(stats, ensure_ascii=True))


if __name__ == "__main__":
    main()
