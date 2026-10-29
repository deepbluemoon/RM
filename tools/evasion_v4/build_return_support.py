"""Write versioned lineage and closure evidence for the Model 3 return package."""
from __future__ import annotations

import hashlib
import json
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
V4 = ROOT / "data_source/model_3/augmentation/evasion/evasion_new_seed_rounds_v4"
DATASET = ROOT / "data_source/model_3/datasets/evasion_train_candidate_v4_p1"


def rows(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8-sig").splitlines() if line.strip()]


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_jsonl(path: Path, value: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in value), encoding="utf-8")


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def main() -> None:
    raw = V4 / "raw/gen_out/P1_b00.jsonl"
    semantic = V4 / "raw/semantic_qc/P1_b00_semantic_qc_v1.jsonl"
    qc = V4 / "qc/deterministic/P1_b00_python_qc_v1.jsonl"
    new_final = DATASET / "final_synthetic/evasion_v4_p1_final_synthetic_v1.jsonl"
    cumulative = DATASET / "final_synthetic/evasion_synthetic_positive_pool_cumulative_v4_p1.jsonl"
    train = DATASET / "evasion_detector/train.jsonl"
    generated, semantic_rows, qc_rows = rows(raw), rows(semantic), rows(qc)
    new_rows, cumulative_rows, train_rows = rows(new_final), rows(cumulative), rows(train)
    assert len(generated) == 14 and len(semantic_rows) == 14
    assert Counter(r["semantic_status"] for r in semantic_rows) == {"PASS": 10, "REJECT": 4}
    assert len(qc_rows) == 10 and all(r["python_qc_status"] == "PASS" for r in qc_rows)
    assert len(new_rows) == 10 and len(cumulative_rows) == 251 and len(train_rows) == 783
    assert Counter(r["label"] for r in train_rows) == {1: 359, 0: 424}
    assert sha(raw) == json.loads((V4 / "raw/semantic_qc/P1_b00_semantic_qc_manifest_v1.json").read_text(encoding="utf-8"))["raw_generation_sha256"]

    lineage = []
    for row in cumulative_rows:
        lineage.append({
            "synthetic_id": row["synthetic_id"],
            "parent_seed_id": row["source_data_id"],
            "parent_origin": row.get("source_origin"),
            "parent_is_synthetic": row.get("source_is_synthetic"),
            "source_group_id": row.get("source_group_id"),
            "source_family_id": row.get("source_family_id"),
            "source_document_id": row.get("source_document_id"),
            "source_case_id": row.get("source_case_id"),
            "source_split": row.get("source_split"),
            "final_status": row.get("final_status"),
            "pool_origin": row.get("pool_origin", "evasion_new_seed_rounds_v4/P1"),
        })
    assert len({r["synthetic_id"] for r in lineage}) == 251
    assert all(r["parent_is_synthetic"] is False and r["source_split"] == "TRAIN" for r in lineage)
    lineage_path = DATASET / "final_synthetic/evasion_synthetic_lineage_v4_p1.jsonl"
    write_jsonl(lineage_path, lineage)

    report = {
        "version": "evasion_augmentation_v4_p1_closeout",
        "input_parents": 14,
        "generated": 14,
        "semantic_pass": 10,
        "semantic_reject": 4,
        "semantic_hold": 0,
        "semantic_unresolved": 0,
        "python_qc_pass": 10,
        "python_qc_fail": 0,
        "new_final_synthetic": 10,
        "cumulative_final_synthetic": 251,
        "raw_generation_is_not_final": True,
        "additional_augmentation_performed": False,
        "source_paths": [rel(raw), rel(semantic), rel(qc), rel(new_final), rel(cumulative), rel(lineage_path)],
    }
    report_path = V4 / "reports/P1_closeout_v1.json"
    write_json(report_path, report)
    manifest = {
        "version": "evasion_augmentation_v4_p1_return_manifest_v1",
        "file_sha256": {rel(path): sha(path) for path in (raw, semantic, qc, new_final, cumulative, lineage_path, report_path)},
    }
    manifest_path = V4 / "reports/P1_return_manifest_v1.json"
    write_json(manifest_path, manifest)

    leakage = json.loads((DATASET / "leakage_audit_v1.json").read_text(encoding="utf-8"))
    promo = json.loads((ROOT / "local_work/promotion_gate_report_v1.json").read_text(encoding="utf-8"))
    legal_train = ROOT / "data_source/model_3/negative_eval_track/evaluation_candidate/model_dataset_v1_6_candidate/direct_legal_detector/train.jsonl"
    legal_counts = Counter(r["label"] for r in rows(legal_train))
    closeout = f"""# Model 3 local final closeout — 2026-09-30

## Final status

SAFE_CHECKPOINT_CLOSED. The local follow-up is complete. Official evaluation promotion is deferred for both tasks. Existing official Validation and Test are unchanged.

## Legal TRAIN

Canonical v1_6 candidate TRAIN remains {sum(legal_counts.values())} rows (P {legal_counts[1]}, N {legal_counts[0]}). It was not changed locally. Source: `{rel(legal_train)}`; SHA-256 `{sha(legal_train)}`.

## Evasion TRAIN

Versioned candidate `{rel(train)}` has 783 rows (P 359, N 424): REAL P 108, REAL N 424, and cumulative synthetic P 251. P1 added 10 FINAL synthetic rows. Lineage `{rel(lineage_path)}` covers all 251 synthetic rows with REAL TRAIN parents and unique IDs. Leakage audit `{rel(DATASET / 'leakage_audit_v1.json')}`: **{leakage['status']}**; TRAIN versus Validation/Test normalized text, near duplicate, case, document and family overlap are zero. Statistics: `{rel(DATASET / 'statistics.json')}`. Export manifest: `{rel(DATASET / 'EXPORT_MANIFEST.json')}`.

## Evasion augmentation P1

Input parent 14; generated 14; semantic PASS 10, REJECT 4, HOLD 0, UNRESOLVED 0; Python QC PASS 10, FAIL 0; FINAL 10. The raw generation `{rel(raw)}` contains 14 candidates and is not a FINAL pool. Semantic QC: `{rel(semantic)}`; Python QC: `{rel(qc)}`; FINAL: `{rel(new_final)}`; cumulative FINAL: `{rel(cumulative)}`; report: `{rel(report_path)}`; augmentation manifest: `{rel(manifest_path)}`.

## Evaluation

Legal: **DO_NOT_PROMOTE** — {promo['legal']['reason']}. Evasion: **DO_NOT_PROMOTE** — {len(promo['evasion']['human_review_blockers'])} candidate rows require human review. Promotion gate record: `local_work/promotion_gate_report_v1.json`. No official Validation/Test was replaced.

## Deferred

- Recover and review legal evaluation candidate, then evaluate promotion gates.
- Human review of three evasion evaluation candidates, then evaluate promotion gates.

## Not performed

P2; retry of 12 zero-PASS parents; further source collection; Holdout reading; relabeling; legal or evasion evaluation promotion; Model 2 modification.

## Source of truth

This document, `{rel(DATASET / 'EXPORT_MANIFEST.json')}`, `{rel(DATASET / 'leakage_audit_v1.json')}`, `{rel(lineage_path)}`, `{rel(new_final)}`, `{rel(cumulative)}`, `{rel(raw)}`, `{rel(semantic)}`, and `{rel(qc)}`.
"""
    closeout_path = ROOT / "local_work/MODEL3_LOCAL_FINAL_CLOSEOUT_2026-09-30.md"
    closeout_path.write_text(closeout, encoding="utf-8")
    print(json.dumps({"lineage": rel(lineage_path), "report": rel(report_path), "manifest": rel(manifest_path), "closeout": rel(closeout_path)}, ensure_ascii=True))


if __name__ == "__main__":
    main()
