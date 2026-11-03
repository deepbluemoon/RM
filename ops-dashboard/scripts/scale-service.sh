#!/usr/bin/env bash
set -euo pipefail

script_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
target="${OPS_SCALE_TARGET:-2}"
preflight_output="$("$script_dir/preflight-ops.sh")"
printf '%s\n' "$preflight_output"
current="$(printf '%s\n' "$preflight_output" | sed -n 's/^current_replicas=//p')"

if [[ "$target" == "$current" ]]; then
  printf 'scale=noop current_replicas=%s target_replicas=%s\n' "$current" "$target"
  exit 0
fi

docker compose -f "$OPS_COMPOSE_FILE" up -d --scale "$OPS_SCALE_SERVICE=$target" "$OPS_SCALE_SERVICE"
printf 'compose_service=%s replicas=%s->%s\n' "$OPS_SCALE_SERVICE" "$current" "$target"

wait_seconds="${OPS_SCALE_WAIT_SECONDS:-30}"
[[ "$wait_seconds" =~ ^[1-9][0-9]*$ ]] && (( wait_seconds <= 300 )) || { printf 'postcheck=invalid_wait_timeout\n' >&2; exit 2; }
elapsed=0
while (( elapsed <= wait_seconds )); do
  running_ids="$(docker compose -f "$OPS_COMPOSE_FILE" ps --status running -q "$OPS_SCALE_SERVICE")"
  running_count="$(printf '%s\n' "$running_ids" | sed '/^[[:space:]]*$/d' | wc -l | tr -d '[:space:]')"
  if [[ "$running_count" == "$target" ]]; then
    health_waiting=false
    while IFS= read -r container_id; do
      [[ -n "$container_id" ]] || continue
      health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$container_id")"
      case "$health" in
        unhealthy) printf 'postcheck=unhealthy container=%s\n' "$container_id" >&2; exit 1 ;;
        starting) health_waiting=true ;;
      esac
    done <<< "$running_ids"
    if [[ "$health_waiting" == false ]]; then
      printf 'postcheck=ok running_replicas=%s\n' "$running_count"
      exit 0
    fi
  fi
  sleep 2
  elapsed=$((elapsed + 2))
done
printf 'postcheck=timeout expected_replicas=%s actual_replicas=%s; verify the service before retrying\n' "$target" "${running_count:-0}" >&2
exit 1
