"""공식 모델 원본을 고정 revision 으로 받는다 (배포 전 수동 1회, T047).

    uv sync --extra tools
    uv run python scripts/fetch_models.py            # M3·M4·BASE 전부
    uv run python scripts/fetch_models.py M3         # 하나만

models.lock.yaml 의 revision 이 "<commit-sha>" 이면 받지 않고 멈춘다(재현성 — 떠도는 main 브랜치 금지).
예상 크기: M3 약 8.1GB, M4 약 3.4GB, klue/roberta-base 약 0.45GB. 100MB/s 기준 M3 약 1.5분, 느린 회선(10MB/s)은 약 15분.
"""
from __future__ import annotations

import re
import sys
import time
from pathlib import Path

import yaml

BASE = Path(__file__).resolve().parents[1]


def main(argv: list[str]) -> int:
    try:
        from huggingface_hub import HfApi, snapshot_download
    except ImportError:
        print("huggingface_hub 가 없다: uv sync --extra tools", file=sys.stderr)
        return 2
    lock = yaml.safe_load((BASE / "models.lock.yaml").read_text(encoding="utf-8"))["models"]
    targets = argv or list(lock)
    api = HfApi()
    for mid in targets:
        m = lock[mid]
        rev = str(m["revision"])
        if not re.fullmatch(r"[0-9a-f]{40}", rev):
            print(f"[{mid}] revision 이 고정되지 않았다({rev}). models.lock.yaml 에 커밋 SHA 40자를 넣는다.", file=sys.stderr)
            print(f"       확인: https://huggingface.co/{m['repo']}/commits/main", file=sys.stderr)
            return 1
        try:
            info = api.model_info(m["repo"], revision=rev, files_metadata=True)
            size = sum((s.size or 0) for s in info.siblings or [])
            print(f"[{mid}] {m['repo']}@{rev[:12]} — 약 {size / 1e9:.2f}GB")
        except Exception as e:  # 크기 조회 실패는 치명적이지 않다
            print(f"[{mid}] {m['repo']}@{rev[:12]} — 예상 약 {m.get('est_download_gb', '?')}GB (크기 조회 실패: {type(e).__name__})")
        dest = BASE / m["local_dir"]
        dest.mkdir(parents=True, exist_ok=True)
        t0 = time.monotonic()
        snapshot_download(repo_id=m["repo"], revision=rev, local_dir=dest,
                          allow_patterns=["*.json", "*.safetensors", "*.txt", "*.model", "tokenizer*", "merges.txt", "vocab*"])
        print(f"[{mid}] 완료 → {dest} ({time.monotonic() - t0:.0f}초)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
