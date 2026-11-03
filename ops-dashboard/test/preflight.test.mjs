import test from 'node:test'
import assert from 'node:assert/strict'
import { access, chmod, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const script = path.resolve('scripts/preflight-ops.sh')

async function fixture({ services = 'worker\n', versionFails = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rm-ops-preflight-'))
  const dockerPath = path.join(directory, 'docker')
  const composeFile = path.join(directory, 'compose.yml')
  const dockerScript = `#!/usr/bin/env bash
set -euo pipefail
if [[ "${versionFails ? '1' : '0'}" == 1 && "$1" == version ]]; then exit 1; fi
if [[ "$1" == version ]]; then printf '24.0.0\\n'; exit 0; fi
if [[ "$1" == compose && "$2" == version ]]; then printf 'Docker Compose version v2.0.0\\n'; exit 0; fi
if [[ "$1" == compose && "$2" == -f && "$4" == config && "$5" == --services ]]; then
  printf '%s' '${services}'
  exit 0
fi
if [[ "$1" == compose && "$2" == -f && "$4" == ps && "$5" == --status ]]; then
  if [[ -f "\${OPS_TEST_LOG:-}" ]]; then count="\${OPS_SCALE_TARGET:-2}"; else count="\${OPS_TEST_CURRENT_REPLICAS:-1}"; fi
  for ((index=0; index<count; index++)); do printf 'running-%s\n' "$index"; done
  exit 0
fi
if [[ "$1" == compose && "$2" == -f && "$4" == up ]]; then
  printf 'scaled' > "\${OPS_TEST_LOG:?}"
  exit 0
fi
if [[ "$1" == inspect ]]; then printf 'no-healthcheck\n'; exit 0; fi
exit 1
`
  await writeFile(dockerPath, dockerScript)
  await chmod(dockerPath, 0o755)
  await writeFile(composeFile, 'services:\n  worker:\n    image: example/worker\n')
  return { directory, composeFile }
}

function runPreflight({ directory, composeFile, ...overrides }) {
  return spawnSync('bash', [script], {
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      OPS_COMPOSE_FILE: composeFile,
      OPS_SCALE_SERVICE: 'worker',
      OPS_SCALE_TARGET: '2',
      OPS_SCALE_MAX: '5',
      OPS_SCALE_ALLOWED_SERVICES: 'worker',
      ...overrides,
    },
    encoding: 'utf8',
  })
}

function runScale({ directory, composeFile, logFile, ...overrides }) {
  return spawnSync('bash', [path.resolve('scripts/scale-service.sh')], {
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      OPS_COMPOSE_FILE: composeFile,
      OPS_SCALE_SERVICE: 'worker',
      OPS_SCALE_TARGET: '2',
      OPS_SCALE_MAX: '5',
      OPS_SCALE_ALLOWED_SERVICES: 'worker',
      OPS_TEST_LOG: logFile,
      ...overrides,
    },
    encoding: 'utf8',
  })
}

test('정상 사전점검은 서비스와 replica 설정을 출력한다', async () => {
  const fixtureData = await fixture()
  const result = runPreflight(fixtureData)
  assert.equal(result.status, 0)
  assert.match(result.stdout, /preflight=ok/)
  assert.match(result.stdout, /compose_service=worker/)
  assert.match(result.stdout, /current_replicas=1/)
})

test('Compose 파일이 없으면 변경 전에 OPS-PREFLIGHT-001로 중단한다', async () => {
  const fixtureData = await fixture()
  const result = runPreflight({ ...fixtureData, composeFile: path.join(fixtureData.directory, 'missing.yml') })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /error_code=OPS-PREFLIGHT-001/)
  assert.match(result.stderr, /Compose 파일을 읽을 수 없습니다/)
})

test('데이터베이스 서비스는 허용 목록에 있어도 확장을 차단한다', async () => {
  const fixtureData = await fixture({ services: 'mariadb\n' })
  const result = runPreflight({ ...fixtureData, OPS_SCALE_SERVICE: 'mariadb', OPS_SCALE_ALLOWED_SERVICES: 'mariadb' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /안전 정책상 확장할 수 없는 서비스/)
})

test('replica 상한을 넘으면 Docker Compose 실행 전에 중단한다', async () => {
  const fixtureData = await fixture()
  const result = runPreflight({ ...fixtureData, OPS_SCALE_TARGET: '6' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /OPS_SCALE_MAX/)
})

test('설정된 replica 상한이 절대 안전 상한을 넘으면 중단한다', async () => {
  const fixtureData = await fixture()
  const result = runPreflight({ ...fixtureData, OPS_SCALE_MAX: '21' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /안전 상한 20/)
})

test('Docker Engine 연결 실패는 사전점검 오류로 반환한다', async () => {
  const fixtureData = await fixture({ versionFails: true })
  const result = runPreflight(fixtureData)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Docker Engine에 연결할 수 없습니다/)
})

test('scale-service.sh는 사전점검 통과 후에만 Compose scale을 실행한다', async () => {
  const fixtureData = await fixture()
  const logFile = path.join(fixtureData.directory, 'scale.log')
  const result = runScale({ ...fixtureData, logFile })
  assert.equal(result.status, 0)
  assert.equal(result.stdout.includes('preflight=ok'), true)
  assert.equal(result.stdout.includes('compose_service=worker replicas=1->2'), true)
})

test('현재 replica 수보다 작은 목표는 축소 대신 차단한다', async () => {
  const fixtureData = await fixture()
  const result = runPreflight({ ...fixtureData, OPS_TEST_CURRENT_REPLICAS: '3', OPS_SCALE_TARGET: '2' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /축소 요청을 차단했습니다: 3 -> 2/)
})

test('목표 replica 수가 현재와 같으면 변경 명령 없이 성공 처리한다', async () => {
  const fixtureData = await fixture()
  const logFile = path.join(fixtureData.directory, 'scale.log')
  const result = runScale({ ...fixtureData, logFile, OPS_TEST_CURRENT_REPLICAS: '2' })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /scale=noop current_replicas=2 target_replicas=2/)
  await assert.rejects(access(logFile))
})

test('명시적 확장 허용 목록이 없으면 사전점검을 거부한다', async () => {
  const fixtureData = await fixture()
  const result = runPreflight({ ...fixtureData, OPS_SCALE_ALLOWED_SERVICES: '' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /OPS_SCALE_ALLOWED_SERVICES가 비어 있습니다/)
})
