#!/usr/bin/env bash
# 게이트웨이 LaunchAgent 등록·해제 (사용자 계정, 로그인 세션).
#   ./scripts/install_launchd.sh install     # 등록·기동
#   ./scripts/install_launchd.sh uninstall   # 중지·해제
#   ./scripts/install_launchd.sh restart     # 재기동(.env·모델 교체 후)
#   ./scripts/install_launchd.sh status
#   MODEL_SERVER_PORT=18611 ./scripts/install_launchd.sh install   # 포트 변경
# Ollama 는 등록하지 않는다 — 공유 서버(127.0.0.1:11434)를 쓴다.
set -euo pipefail
LABEL=kr.crd.model-server
DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
# GUI 로그인 세션이 있으면 gui/<uid>, SSH 만 쓰는 계정(Background 세션)이면 user/<uid> 도메인에 올린다.
# user 도메인에는 LimitLoadToSessionType=Background 가 있어야 bootstrap 이 된다(없으면 "5: Input/output error").
if launchctl print "gui/$(id -u)" >/dev/null 2>&1; then DOMAIN="gui/$(id -u)"; else DOMAIN="user/$(id -u)"; fi
PORT="${MODEL_SERVER_PORT:-9542}"  # 8000 은 공유 서버의 다른 계정이 사용 중(model-serving §0.2)

case "${1:-}" in
  install)
    [ -f "$DIR/.env" ] || { echo "$DIR/.env 가 없습니다 (.env.example 참고, MODEL_API_KEY 필요)"; exit 1; }
    # 가상환경 점검 — uv sync 는 여기서 부르지 않는다(--extra classifiers 없이 돌면 torch·transformers 가 지워져
    # M1·M2 가 휴리스틱으로 떨어진다). 새로 만들 때: uv sync --frozen --extra classifiers
    [ -x "$DIR/.venv/bin/uvicorn" ] || { echo "$DIR/.venv/bin/uvicorn 이 없습니다 (uv sync --frozen --extra classifiers)"; exit 1; }
    "$DIR/.venv/bin/python" -c "import torch, transformers" 2>/dev/null \
      || echo "경고: .venv 에 torch·transformers 가 없어 M1·M2 가 휴리스틱으로 동작합니다 (uv sync --frozen --extra classifiers)"
    mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
    sed -e "s#__DIR__#$DIR#g" -e "s#__HOME__#$HOME#g" -e "s#__PORT__#$PORT#g" "$DIR/launchd/$LABEL.plist" > "$DEST"
    case "$DOMAIN" in user/*) /usr/libexec/PlistBuddy -c "Add :LimitLoadToSessionType string Background" "$DEST" ;; esac
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$DEST"
    echo "등록됨: $DOMAIN/$LABEL ← $DEST (로그 ~/Library/Logs/crd-model-server.log)"
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$DEST"
    echo "해제됨"
    ;;
  restart)
    launchctl kickstart -k "$DOMAIN/$LABEL"
    echo "재기동 요청됨"
    ;;
  status)
    launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E "state|pid|last exit" || echo "등록되지 않음"
    ;;
  *) echo "사용법: $0 install|uninstall|restart|status"; exit 2 ;;
esac
