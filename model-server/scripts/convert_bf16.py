"""HF safetensors → bf16 GGUF 형식 변환(양자화 아님) + SHA-256 기록 (배포 전 수동 1회, T047).

    LLAMA_CPP=~/src/llama.cpp uv run python scripts/convert_bf16.py          # M3·M4
    LLAMA_CPP=~/src/llama.cpp uv run python scripts/convert_bf16.py M4

llama.cpp 의 convert_hf_to_gguf.py 를 쓴다(llama.cpp 저장소 체크아웃과 그 requirements 필요).
예상 소요: M4(3.4GB) 약 1~2분, M3(8.1GB) 약 3~5분 + SHA-256 계산 수십 초(디스크 속도에 비례).
결과 GGUF 는 10GB 이하여야 공유 Ollama 에 등록할 수 있다(참조 §7.5).
"""
from __future__ import annotations

import hashlib
import os
import subprocess
import sys
import time
from pathlib import Path

import yaml

BASE = Path(__file__).resolve().parents[1]
LIMIT = 10 * 1024**3


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 24), b""):
            h.update(chunk)
    return h.hexdigest()


def main(argv: list[str]) -> int:
    llama = Path(os.environ.get("LLAMA_CPP", "")).expanduser()
    conv = llama / "convert_hf_to_gguf.py"
    if not conv.is_file():
        print("LLAMA_CPP 환경변수에 llama.cpp 체크아웃 경로를 준다(convert_hf_to_gguf.py 필요)", file=sys.stderr)
        return 2
    lock_path = BASE / "models.lock.yaml"
    lock = yaml.safe_load(lock_path.read_text(encoding="utf-8"))
    for mid in argv or ["M3", "M4"]:
        m = lock["models"][mid]
        src, out = BASE / m["local_dir"], BASE / m["gguf"]
        if not (src / "config.json").is_file():
            print(f"[{mid}] 원본이 없다: {src} — 먼저 scripts/fetch_models.py", file=sys.stderr)
            return 1
        out.parent.mkdir(parents=True, exist_ok=True)
        t0 = time.monotonic()
        print(f"[{mid}] 변환 시작 → {out}")
        subprocess.run([sys.executable, str(conv), str(src), "--outtype", "bf16", "--outfile", str(out)], check=True)
        t1 = time.monotonic()
        size = out.stat().st_size
        digest = sha256(out)
        print(f"[{mid}] 변환 {t1 - t0:.0f}초, 크기 {size / 1e9:.2f}GB, sha256 {digest[:16]}… ({time.monotonic() - t1:.0f}초)")
        if size > LIMIT:
            print(f"[{mid}] 경고: 10GB 초과 — 공유 Ollama 등록 불가, 관리자 협의 필요", file=sys.stderr)
        m["gguf_sha256"] = digest
    # 주석을 보존하지 않고 다시 쓴다 — gguf_sha256 만 바뀐다
    lock_path.write_text(yaml.safe_dump(lock, allow_unicode=True, sort_keys=False), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
