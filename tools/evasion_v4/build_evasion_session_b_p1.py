"""Create a deterministic Session B P1 handoff from the approved evasion v6 delta."""
from __future__ import annotations

import json
from collections import Counter, defaultdict
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
EVASION = ROOT / "data_source/model_3/augmentation/evasion"
FINAL_POOL = EVASION / "evasion_final_pool_v1"
V4 = EVASION / "evasion_new_seed_rounds_v4"
LOCAL = ROOT / "local_work/evasion_augmentation"


def read_jsonl(path: Path) -> list[dict]:
    with path.open(encoding="utf-8-sig") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    existing = read_jsonl(FINAL_POOL / "seed_registry/existing_augmented_seeds_v1.jsonl")
    approved = read_jsonl(FINAL_POOL / "intake/approved_pool_v6_classified.jsonl")
    lineage = read_jsonl(ROOT / "data_source/model_3/registry/master_real_registry_v1/synthetic_lineage_index_v1.jsonl")

    evasion_lineage = [row for row in lineage if row["model"] == "evasion"]
    final_by_parent = Counter(
        row["parent_native_id"] for row in evasion_lineage if row["final_status"] == "FINAL_ACCEPT"
    )
    used_parent_ids = {row["parent_native_id"] for row in evasion_lineage}

    audit_rows: list[dict] = []
    existing_ids = {row["data_id"] for row in existing}
    for row in existing:
        parent_id = row["data_id"]
        audit_rows.append({
            "parent_seed_id": parent_id,
            "source": "existing_augmented_seeds_v1",
            "classification": "ZERO_PASS_PREVIOUS_PARENT" if final_by_parent[parent_id] == 0 else "APPROVED_PARENT_ALREADY_USED",
            "used_in_synthetic": parent_id in used_parent_ids,
            "final_synthetic_count": final_by_parent[parent_id],
            "case_id": row["case_id"],
            "document_id": row["document_id"],
            "family_id": row["family_id"],
        })

    selected: list[dict] = []
    axes = [
        ["조건·순서 위치 변경", "문장 나누기"],
        ["주체 표현 변경", "조문체 표현(~한다)"],
        ["목적어 위치 변경", "다른 구문 구조"],
        ["문장 합치기", "능동·수동 전환"],
    ]
    for index, row in enumerate(approved):
        parent_id = row["id"]
        is_new = row["relation"] == "NEW"
        train_ok = row["train_ownership"].startswith("TRAIN")
        eval_ok = not row["eval_registry_conflicts"]
        if is_new and train_ok and eval_ok and row["source_row"]["synthetic"] is False:
            classification = "TRAIN_ELIGIBLE_NEW_PARENT"
            selected.append(row)
        elif final_by_parent[parent_id] == 0:
            classification = "ZERO_PASS_PREVIOUS_PARENT"
        else:
            classification = "APPROVED_PARENT_ALREADY_USED"
        audit_rows.append({
            "parent_seed_id": parent_id,
            "source": "approved_pool_v6_classified",
            "classification": classification,
            "relation": row["relation"],
            "augment_target": row["augment_target"],
            "real": row["source_row"]["synthetic"] is False,
            "train_ownership": row["train_ownership"],
            "eval_registry_conflicts": row["eval_registry_conflicts"],
            "final_synthetic_count": final_by_parent[parent_id],
            "case_id": row["case_id"],
            "document_id": row["document_id"],
            "family_id": row["family_id"],
        })

    # The v6 new delta is intentionally the only augmentation target. Existing/zero-pass
    # parents remain frozen under generation_control_v1 and the final closeout.
    items = []
    for index, row in enumerate(selected):
        source = row["source_row"]
        items.append({
            "source_data_id": row["id"],
            "n": 1,
            "variants": [{"variant_no": 1, "assigned_axes": axes[index % len(axes)]}],
            "target_label": 1,
            "contract_type": source.get("platform"),
            "title": source.get("provenance", {}).get("issue_heading"),
            "source_text": row["text_clean"],
            "pattern_codes": row["codes"],
            "pattern_names": [],
            "evasion_rationale": source.get("first_rationale"),
            "direct_types": [],
            "risk_flags": [],
            "existing_candidates": [],
            "parent_metadata": {
                "case_id": row["case_id"],
                "document_id": row["document_id"],
                "family_id": row["family_id"],
                "train_ownership": row["train_ownership"],
                "eval_registry_conflicts": row["eval_registry_conflicts"],
                "synthetic": False,
                "source_approval": source.get("approval"),
            },
        })

    batch_path = V4 / "raw/gen_in/P1_b00.json"
    batch = {"target_model": "evasion_detector", "round": "P1", "items": items}
    write_json(batch_path, batch)
    LOCAL.mkdir(parents=True, exist_ok=True)
    audit_path = LOCAL / "evasion_real_seed_audit_v1.jsonl"
    audit_path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in audit_rows), encoding="utf-8")

    counts = Counter(row["classification"] for row in audit_rows)
    summary = {
        "usable_real_seed_total": len(audit_rows),
        "existing_parent_used_count": sum(1 for row in audit_rows if row["classification"] in {"APPROVED_PARENT_ALREADY_USED", "ZERO_PASS_PREVIOUS_PARENT"}),
        "existing_successful_parent_count": counts["APPROVED_PARENT_ALREADY_USED"],
        "zero_pass_parent_count": counts["ZERO_PASS_PREVIOUS_PARENT"],
        "completely_unused_parent_count": counts["TRAIN_ELIGIBLE_NEW_PARENT"],
        "policy_excluded_count": 0,
        "eval_conflict_count": 0,
        "augmentation_eligible_new_parent_count": len(selected),
        "extra_train_positive_16_audit": "NOT_AUDITABLE: Model 2 canonical TRAIN input is absent from this local package",
        "unknown_requires_semantic_review": [],
        "selection_policy": "Only v6 NEW rows are selected; historical parents, including zero-pass parents, remain frozen.",
    }
    write_json(LOCAL / "evasion_real_seed_audit_summary_v1.json", summary)

    handoff = f"""# SESSION B — Evasion augmentation P1\n\n## Input\n\n- Batch: `{batch_path.relative_to(ROOT).as_posix()}`\n- Parents: {len(selected)} approved REAL, TRAIN-owned v6 delta rows\n- Expected output: `{(V4 / 'raw/gen_out/P1_b00.jsonl').relative_to(ROOT).as_posix()}`\n\n## Required references\n\n- `data_source/model_3/augmentation/evasion/evasion_new_seed_rounds_v4/prompts/gen_common.md`\n- `data_source/model_3/augmentation/evasion/evasion_new_seed_rounds_v4/prompts/gen_evasion.md`\n- `data_source/model_3/augmentation/evasion/evasion_new_seed_rounds_v4/prompts/gen_round_supplement.md`\n\nGenerate exactly one candidate per input item, preserving its mechanism, values, conditions, and source structure. Do not use synthetic text as a parent. Emit JSONL only, one row per candidate, with `source_data_id`, `variant_no`, `candidate_text`, and `variation_axes`.\n\n## Semantic QC\n\nReturn a separate result for each candidate: `PASS`, `HOLD`, or `REJECT`. PASS requires preserved evasion mechanism, natural contract language, meaningful wording/structure variation, and no factual addition. HOLD is for ambiguity requiring semantic judgment; REJECT is for meaning drift, near-copying, template-like text, or unnatural language.\n\nPython QC is authoritative for schema, parent reality, duplicate, lineage, evaluation/holdout overlap, and group-overlap failures.\n"""
    (LOCAL / "HANDOFF_BATCH_P1.md").write_text(handoff, encoding="utf-8")
    print(json.dumps({"summary": summary, "batch": str(batch_path.relative_to(ROOT)), "handoff": str((LOCAL / 'HANDOFF_BATCH_P1.md').relative_to(ROOT))}, ensure_ascii=True))


if __name__ == "__main__":
    main()
