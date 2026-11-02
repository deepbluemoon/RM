#!/usr/bin/env bash
set -euo pipefail

: "${OPS_COMPOSE_FILE:?OPS_COMPOSE_FILE 환경변수가 필요합니다}"
: "${OPS_SCALE_SERVICE:?OPS_SCALE_SERVICE 환경변수가 필요합니다}"

target="${OPS_SCALE_TARGET:-2}"
if ! [[ "$target" =~ ^[1-9][0-9]*$ ]]; then
  echo "OPS_SCALE_TARGET must be a positive integer" >&2
  exit 2
fi

docker compose -f "$OPS_COMPOSE_FILE" up -d --scale "$OPS_SCALE_SERVICE=$target" "$OPS_SCALE_SERVICE"
printf 'compose service %s scaled to %s\n' "$OPS_SCALE_SERVICE" "$target"
