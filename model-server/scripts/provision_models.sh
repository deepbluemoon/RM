#!/usr/bin/env bash
# 공유 Ollama 에 M3·M4 서비스 모델을 등록한다 — 배포 전 "수동 1회" 단계 (참조 §7.5 ②, §8.4).
# 서비스 런타임(게이트웨이)은 create·pull·rm·stop·serve 를 부르지 않는다. 이 스크립트만 create 를 쓴다.
#
#   ./scripts/provision_models.sh            # M3, M4
#   ./scripts/provision_models.sh M4         # 하나만
#   DRY_RUN=1 ./scripts/provision_models.sh  # 점검만
#
# 선행: uv run python scripts/fetch_models.py → uv run python scripts/convert_bf16.py (var/gguf/*.gguf 생성)
# 단계별 예상 소요 (M1 Ultra, 내장 SSD 기준 추정):
#   1) 원본 다운로드   M3 8.1GB·M4 3.4GB — 회선에 따라 수 분~수십 분 (fetch_models.py)
#   2) bf16 GGUF 변환  M3 약 3~5분, M4 약 1~2분 (convert_bf16.py)
#   3) ollama create   GGUF 를 서버 저장소로 복사·해시 — M3 약 1~3분, M4 약 30초~1분 (이 스크립트)
#   4) 검증 호출 1회   첫 적재 포함 M3 약 20~40초, M4 약 10~20초 (이 스크립트)
set -euo pipefail

ME="$(whoami)"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
OLLAMA_URL="${OLLAMA_URL:-http://127.0.0.1:11434}"
LIMIT_BYTES=$((10 * 1024 * 1024 * 1024))
TARGETS=("$@"); [ ${#TARGETS[@]} -eq 0 ] && TARGETS=(M3 M4)

say() { printf '%s\n' "$*"; }
now() { date +%s; }

say "=================================================================="
say " 공유 Ollama 모델 등록 — 배포 전 수동 1회 단계입니다."
say " 등록한 모델은 서버 전체에 보입니다. 이름은 반드시 '${ME}-' 로 시작합니다."
say " 서버: ${OLLAMA_URL}   (ollama serve 를 실행하지 않습니다)"
say "=================================================================="

command -v ollama >/dev/null || { say "ollama CLI 가 없습니다. 관리자에게 문의하세요."; exit 2; }
curl -fsS --max-time 5 "${OLLAMA_URL}/api/version" >/dev/null \
  || { say "공유 Ollama 에 연결할 수 없습니다 — 관리자 확인 필요 (직접 serve 금지)"; exit 2; }

TOTAL_T0=$(now)
for MID in "${TARGETS[@]}"; do
  case "$MID" in
    M3) NAME="${OLLAMA_M3_MODEL:-${ME}-crd-m3:v1}"; MF="$HERE/modelfiles/M3.Modelfile"; PREDICT=700 ;;
    M4) NAME="${OLLAMA_M4_MODEL:-${ME}-crd-m4:v1}"; MF="$HERE/modelfiles/M4.Modelfile"; PREDICT=600 ;;
    *) say "알 수 없는 대상: $MID (M3|M4)"; exit 2 ;;
  esac
  say ""
  say "── [$MID] $NAME"
  case "$NAME" in
    "${ME}-"*) ;;
    *) say "   이름이 '${ME}-' 로 시작하지 않습니다 — 다른 사람 모델을 덮어쓸 수 있어 중단합니다."; exit 3 ;;
  esac

  # 1) 중복 확인 — 같은 이름이 있으면 덮어쓰지 않는다(새 버전은 :v2 로)
  T0=$(now)
  if ollama list | awk 'NR>1 {print $1}' | grep -Fxq "$NAME"; then
    say "   이미 등록돼 있습니다. 건너뜁니다. (새 버전이면 태그를 :v2 로 올려 OLLAMA_${MID}_MODEL 을 바꾸세요)"
    continue
  fi
  say "   [1/4] 중복 없음 ($(( $(now) - T0 ))초)"

  # 2) GGUF 확인 — 10GB 한도(참조 §7.5)
  FROM_REL="$(awk '/^FROM /{print $2; exit}' "$MF")"
  GGUF="$(cd "$(dirname "$MF")" && cd "$(dirname "$FROM_REL")" 2>/dev/null && pwd)/$(basename "$FROM_REL")"
  [ -f "$GGUF" ] || { say "   GGUF 가 없습니다: $FROM_REL — fetch_models.py → convert_bf16.py 를 먼저 실행하세요."; exit 4; }
  SIZE=$(stat -f%z "$GGUF" 2>/dev/null || stat -c%s "$GGUF")
  say "   [2/4] GGUF $(awk -v s="$SIZE" 'BEGIN{printf "%.2f", s/1e9}')GB — $GGUF"
  [ "$SIZE" -le "$LIMIT_BYTES" ] || { say "   10GB 초과 — 등록하지 않습니다. 관리자와 협의하세요."; exit 5; }

  if [ -n "${DRY_RUN:-}" ]; then say "   DRY_RUN — create 생략"; continue; fi

  # 3) 등록
  say "   [3/4] ollama create 진행 중… (GGUF 복사·해시, 수십 초~수 분)"
  T0=$(now)
  ollama create "$NAME" -f "$MF"
  say "   [3/4] 등록 완료 ($(( $(now) - T0 ))초)"

  # 4) 검증 호출 1회 — 공유 규칙 그대로(keep_alive 5m, think false, num_ctx 8192)
  say "   [4/4] 검증 호출 (첫 적재 시간 포함)…"
  T0=$(now)
  RESP="$(curl -fsS --max-time 300 "${OLLAMA_URL}/api/chat" -d "{\"model\":\"${NAME}\",\"stream\":false,\"think\":false,\"keep_alive\":\"5m\",\"format\":\"json\",\"options\":{\"num_ctx\":8192,\"num_predict\":${PREDICT},\"temperature\":0},\"messages\":[{\"role\":\"user\",\"content\":\"{\\\"ok\\\":true} 를 그대로 JSON 으로 답하세요\"}]}")" \
    || { say "   검증 실패 — ollama show $NAME 로 확인하세요."; exit 6; }
  LOAD=$(printf '%s' "$RESP" | python3 -c 'import json,sys; print(round(json.load(sys.stdin).get("load_duration",0)/1e9,1))')
  printf '%s' "$RESP" | grep -q '<think>' && say "   경고: 응답에 <think> 가 있습니다(사고 모드 확인 필요)."
  say "   [4/4] 응답 정상 ($(( $(now) - T0 ))초, 그중 적재 ${LOAD}초)"
  DIGEST=$(curl -fsS "${OLLAMA_URL}/api/tags" | python3 -c "import json,sys; n='$NAME'; print(next((m['digest'][:12] for m in json.load(sys.stdin)['models'] if m['name']==n),'?'))")
  say "   digest ${DIGEST} — model_card.json 의 ollama_digest 에 기록하세요."
done

say ""
say "끝 (총 $(( $(now) - TOTAL_T0 ))초). 게이트웨이 /health 에서 M3·M4 가 cold 또는 ready 인지 확인하세요."
say "모델을 내리지 않습니다(ollama stop 금지) — keep_alive 5분 뒤 서버가 알아서 내립니다."
