#!/usr/bin/env bash
set -euo pipefail

printf 'error_code=%s\n' "${OPS_ERROR_CODE:-unknown}"
printf 'container_id=%s\n' "${OPS_CONTAINER_ID:-unknown}"
docker version --format 'server={{.Server.Version}}'
docker info --format 'containers={{.Containers}} running={{.ContainersRunning}} paused={{.ContainersPaused}} stopped={{.ContainersStopped}}'
