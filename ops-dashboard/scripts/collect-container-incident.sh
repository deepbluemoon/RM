#!/usr/bin/env bash
set -euo pipefail

container_id="${OPS_CONTAINER_ID:-}"
if [[ ! "$container_id" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]]; then
  printf '유효한 대상 컨테이너 ID가 필요합니다.\n' >&2
  exit 2
fi

command -v docker >/dev/null 2>&1 || { printf 'Docker CLI를 찾을 수 없습니다.\n' >&2; exit 1; }
docker info >/dev/null 2>&1 || { printf 'Docker Engine에 연결할 수 없습니다.\n' >&2; exit 1; }

root="${OPS_DIAGNOSTICS_DIR:-${TMPDIR:-/tmp}/rm-ops-diagnostics}"
umask 077
mkdir -p "$root"
bundle="$(mktemp -d "$root/incident.XXXXXXXX")"
chmod 700 "$bundle"

{
  printf '수집 시각: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  printf '오류 코드: %s\n' "${OPS_ERROR_CODE:-unknown}"
  printf '컨테이너 ID: %s\n\n' "$container_id"
  printf '%s\n' '## 컨테이너 상태'
  docker inspect --format 'name={{.Name}} image={{.Config.Image}} state={{.State.Status}} exit_code={{.State.ExitCode}} finished_at={{.State.FinishedAt}} restart_count={{.RestartCount}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}not-configured{{end}}' "$container_id"
  printf '\n%s\n' '## 최근 로그'
  if [[ "${OPS_INCLUDE_LOGS:-false}" == true ]]; then
    printf '%s\n' '로그는 알려진 비밀값 패턴을 제한적으로 마스킹했지만, 공유 전에 반드시 직접 확인하세요.'
    docker logs --timestamps --tail 100 "$container_id" 2>&1 \
      | sed -E \
        -e 's/(password|passwd|token|secret|api[_-]?key|authorization)(["[:space:]]*[:=]["[:space:]]*)[^[:space:],"}]+/\1\2[REDACTED]/Ig' \
        -e 's/(Bearer[[:space:]]+)[A-Za-z0-9._~+\/-]+=*/\1[REDACTED]/Ig' \
      | awk 'BEGIN { size = 0; limit = 262144; truncated = 0 } { line_size = length($0) + 1; if (size + line_size > limit) { if (!truncated) print "[로그 생략: 256 KiB 제한]"; truncated = 1; next } print; size += line_size }'
  else
    printf '%s\n' '로그 수집을 선택하지 않았습니다.'
  fi
} >"$bundle/incident.txt"
chmod 600 "$bundle/incident.txt"

printf 'result=collected\nreport=%s\nlogs_included=%s\n' "$bundle/incident.txt" "${OPS_INCLUDE_LOGS:-false}"
