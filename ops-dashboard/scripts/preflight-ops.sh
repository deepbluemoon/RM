#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'error_code=OPS-PREFLIGHT-001\nreason=%s\n' "$1" >&2
  exit 1
}

compose_file="${OPS_COMPOSE_FILE:-}"
service="${OPS_SCALE_SERVICE:-}"
target="${OPS_SCALE_TARGET:-2}"
max_target="${OPS_SCALE_MAX:-5}"
allowed_raw="${OPS_SCALE_ALLOWED_SERVICES:-backend,frontend,model-server}"

[[ -n "$compose_file" ]] || fail 'OPS_COMPOSE_FILE 환경변수가 필요합니다'
[[ -f "$compose_file" && -r "$compose_file" ]] || fail "Compose 파일을 읽을 수 없습니다: $compose_file"
[[ -n "$service" ]] || fail 'OPS_SCALE_SERVICE 환경변수가 필요합니다'
[[ "$service" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || fail 'OPS_SCALE_SERVICE에 허용되지 않은 서비스 이름이 있습니다'

command -v docker >/dev/null 2>&1 || fail 'Docker CLI를 찾을 수 없습니다'
docker version --format '{{.Server.Version}}' >/dev/null 2>&1 || fail 'Docker Engine에 연결할 수 없습니다'
docker compose version >/dev/null 2>&1 || fail 'Docker Compose 플러그인을 사용할 수 없습니다'

service_lower="$(printf '%s' "$service" | tr '[:upper:]' '[:lower:]')"
case "$service_lower" in
  mariadb|mysql|*mariadb*|*mysql*|database|db)
    fail 'MariaDB/MySQL 또는 데이터베이스 서비스는 자동 수평 확장 대상이 아닙니다'
    ;;
esac

[[ "$target" =~ ^[1-9][0-9]*$ ]] || fail 'OPS_SCALE_TARGET는 양의 정수여야 합니다'
[[ "$max_target" =~ ^[1-9][0-9]*$ ]] || fail 'OPS_SCALE_MAX는 양의 정수여야 합니다'
(( target <= max_target )) || fail "OPS_SCALE_TARGET가 OPS_SCALE_MAX를 초과했습니다: $target > $max_target"

allowed=false
IFS=',' read -r -a allowed_services <<< "$allowed_raw"
for allowed_service in "${allowed_services[@]}"; do
  [[ "$allowed_service" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || fail 'OPS_SCALE_ALLOWED_SERVICES에 허용되지 않은 서비스 이름이 있습니다'
  if [[ "$allowed_service" == "$service" ]]; then
    allowed=true
  fi
done
[[ "$allowed" == true ]] || fail "허용 목록에 없는 서비스입니다: $service"

compose_services="$(docker compose -f "$compose_file" config --services 2>/dev/null)" || fail 'Compose 서비스 목록을 확인할 수 없습니다'
printf '%s\n' "$compose_services" | grep -Fqx -- "$service" || fail "Compose 파일에 서비스가 없습니다: $service"

printf 'preflight=ok\n'
printf 'compose_file=%s\n' "$compose_file"
printf 'compose_service=%s\n' "$service"
printf 'scale_target=%s\n' "$target"
printf 'scale_max=%s\n' "$max_target"
