#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'error_code=OPS-PREFLIGHT-001\nreason=%s\n' "$1" >&2
  exit 1
}

script_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
compose_file="${OPS_COMPOSE_FILE:-}"
service="${OPS_SCALE_SERVICE:-}"
target="${OPS_SCALE_TARGET:-2}"
max_target="${OPS_SCALE_MAX:-5}"
allowed_raw="${OPS_SCALE_ALLOWED_SERVICES:-}"
blocked_raw="${OPS_SCALE_BLOCKED_SERVICES:-frontend,model-server,mariadb,mysql,database,db,backend-init,backend-embed}"

[[ -n "$compose_file" ]] || fail 'OPS_COMPOSE_FILE 환경변수가 필요합니다'
[[ -f "$compose_file" && -r "$compose_file" ]] || fail "Compose 파일을 읽을 수 없습니다: $compose_file"
[[ -n "$service" ]] || fail 'OPS_SCALE_SERVICE 환경변수가 필요합니다'
[[ "$service" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || fail 'OPS_SCALE_SERVICE에 허용되지 않은 서비스 이름이 있습니다'

command -v docker >/dev/null 2>&1 || fail 'Docker CLI를 찾을 수 없습니다'
docker version --format '{{.Server.Version}}' >/dev/null 2>&1 || fail 'Docker Engine에 연결할 수 없습니다'
docker compose version >/dev/null 2>&1 || fail 'Docker Compose 플러그인을 사용할 수 없습니다'

[[ "$target" =~ ^[1-9][0-9]*$ ]] || fail 'OPS_SCALE_TARGET는 양의 정수여야 합니다'
[[ "$max_target" =~ ^[1-9][0-9]*$ ]] || fail 'OPS_SCALE_MAX는 양의 정수여야 합니다'
(( target <= max_target )) || fail "OPS_SCALE_TARGET가 OPS_SCALE_MAX를 초과했습니다: $target > $max_target"
(( max_target <= 20 )) || fail "OPS_SCALE_MAX는 안전 상한 20을 초과할 수 없습니다: $max_target"

[[ -n "$allowed_raw" ]] || fail 'OPS_SCALE_ALLOWED_SERVICES가 비어 있습니다. 안전성을 검토한 서비스를 명시해야 합니다'
allowed=false
IFS=',' read -r -a allowed_services <<< "$allowed_raw"
for allowed_service in "${allowed_services[@]}"; do
  [[ "$allowed_service" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || fail 'OPS_SCALE_ALLOWED_SERVICES에 허용되지 않은 서비스 이름이 있습니다'
  if [[ "$allowed_service" == "$service" ]]; then
    allowed=true
  fi
done
[[ "$allowed" == true ]] || fail "허용 목록에 없는 서비스입니다: $service"

IFS=',' read -r -a blocked_services <<< "$blocked_raw"
for blocked_service in "${blocked_services[@]}"; do
  [[ "$blocked_service" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || fail 'OPS_SCALE_BLOCKED_SERVICES에 허용되지 않은 서비스 이름이 있습니다'
  [[ "$blocked_service" != "$service" ]] || fail "현재 프로젝트 안전 정책상 확장할 수 없는 서비스입니다: $service"
done

compose_services="$(docker compose -f "$compose_file" config --services 2>/dev/null)" || fail 'Compose 서비스 목록을 확인할 수 없습니다'
printf '%s\n' "$compose_services" | grep -Fqx -- "$service" || fail "Compose 파일에 서비스가 없습니다: $service"

running_ids="$(docker compose -f "$compose_file" ps --status running -q "$service" 2>/dev/null)" || fail '현재 실행 중인 replica 수를 확인할 수 없습니다'
current="$(printf '%s\n' "$running_ids" | sed '/^[[:space:]]*$/d' | wc -l | tr -d '[:space:]')"
current="${current:-0}"
(( target >= current )) || fail "목표 replica 수가 현재 실행 수보다 작아 축소 요청을 차단했습니다: $current -> $target"
if [[ "$service" == backend && "$target" -gt "$current" ]]; then
  "$script_dir/check-active-analyses.sh" "$compose_file" || fail '진행 중인 분석이 있거나 분석 상태를 확인할 수 없어 백엔드 확장을 차단했습니다'
fi

printf 'preflight=ok\n'
printf 'compose_file=%s\n' "$compose_file"
printf 'compose_service=%s\n' "$service"
printf 'current_replicas=%s\n' "$current"
printf 'scale_target=%s\n' "$target"
printf 'scale_max=%s\n' "$max_target"
if (( target == current )); then printf 'change=noop\n'; else printf 'change=scale_up\n'; fi
