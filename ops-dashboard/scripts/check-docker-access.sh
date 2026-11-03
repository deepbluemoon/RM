#!/usr/bin/env bash
set -uo pipefail

printf '점검 시각: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
if ! command -v docker >/dev/null 2>&1; then
  printf 'docker_cli=missing\nengine=not_checked\n'
  exit 0
fi

printf 'docker_cli=available\n'
client_version="$(docker version --format '{{.Client.Version}}' 2>/dev/null || true)"
printf 'client_version=%s\n' "${client_version:-unknown}"
context="$(docker context show 2>/dev/null || true)"
printf 'context=%s\n' "${context:-unknown}"
if docker info >/dev/null 2>&1; then
  printf 'engine=reachable\n'
  docker info --format 'containers={{.Containers}} running={{.ContainersRunning}} paused={{.ContainersPaused}} stopped={{.ContainersStopped}}' 2>/dev/null || true
else
  printf 'engine=unreachable\n'
  printf '확인 항목: Docker Desktop/Engine 실행 상태, 선택된 context, 현재 사용자 권한\n'
fi
