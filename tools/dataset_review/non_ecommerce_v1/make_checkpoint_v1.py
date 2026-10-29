"""전자상거래 seed taxonomy 산출물을 checkpoint 폴더로 복사하고 매니페스트를 만든다(1회용, 기존 폴더가 있으면 중단)."""
import datetime, hashlib, json, shutil
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[3]
CP = PROJECT / "dataset_work/checkpoints/evasion_seed_v1_before_non_ecommerce"
FILES = ["evasion_pattern_analysis.md", "evasion_pattern_candidates.json", "evasion_pattern_examples.jsonl",
         "evasion_pattern_stats.json", "evasion_labeling_guideline_v1.md", "evasion_pattern_taxonomy_v1.json",
         "evasion_decision_examples_v1.jsonl"]


def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def main():
    if CP.exists():
        raise SystemExit(f"이미 존재: {CP} (checkpoint는 수정하지 않음)")
    CP.mkdir(parents=True)
    entries, missing = [], []
    for name in FILES:
        src = PROJECT / "dataset_work/review" / name
        if not src.exists():
            missing.append(str(src.relative_to(PROJECT)))
            continue
        dst = CP / name
        shutil.copy2(src, dst)
        a, b = sha(src), sha(dst)
        entries.append({"original_path": str(src.relative_to(PROJECT)), "checkpoint_path": str(dst.relative_to(PROJECT)),
                        "bytes": src.stat().st_size, "sha256_original": a, "sha256_copy": b, "match": a == b})
    man = {"checkpoint_name": "evasion_seed_v1_before_non_ecommerce",
           "created_at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
           "description": "비전자상거래 분석 전, 전자상거래 455개만을 이용한 seed taxonomy",
           "status": "immutable — 이후 수정 금지",
           "files": entries, "missing": missing, "all_match": all(e["match"] for e in entries),
           "reproduction_code_reference": "tools/dataset_review/evasion_pattern_v1/ (복사하지 않음)"}
    (CP / "CHECKPOINT_MANIFEST.json").write_text(json.dumps(man, ensure_ascii=False, indent=1), encoding="utf-8")
    print(len(entries), "files copied; missing", missing, "; all_match", man["all_match"])


if __name__ == "__main__":
    main()
