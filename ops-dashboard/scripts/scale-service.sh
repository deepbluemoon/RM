#!/usr/bin/env bash
set -euo pipefail

script_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
"$script_dir/preflight-ops.sh"

target="${OPS_SCALE_TARGET:-2}"

docker compose -f "$OPS_COMPOSE_FILE" up -d --scale "$OPS_SCALE_SERVICE=$target" "$OPS_SCALE_SERVICE"
printf 'compose service %s scaled to %s\n' "$OPS_SCALE_SERVICE" "$target"
