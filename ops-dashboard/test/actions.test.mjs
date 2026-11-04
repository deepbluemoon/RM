import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const loadActions = () => import('../src/actions.mjs')

test('같은 오류 코드가 여러 대상에서 발생해도 선택한 경고에만 대응한다', async () => {
  const { activeAlertFor } = await loadActions()
  const first = { id: 'cpu:api', code: 'OPS-CPU-80-001', containerId: 'api' }
  const second = { id: 'cpu:worker', code: 'OPS-CPU-80-001', containerId: 'worker' }
  const state = { alerts: [first, second] }
  assert.equal(activeAlertFor(state, second.code, second.id), second)
  assert.equal(activeAlertFor(state, second.code, 'cpu:removed'), null)
  assert.equal(activeAlertFor(state, 'OPS-MEM-80-001', second.id), null)
  assert.equal(activeAlertFor(state, first.code), first)
})

async function withDocker(callback, fails = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rm-ops-action-'))
  const dockerPath = path.join(directory, 'docker')
  await writeFile(dockerPath, `#!/usr/bin/env bash
set -euo pipefail
if [[ "${fails ? '1' : '0'}" == 1 ]]; then printf 'diagnostic Docker failure\\n' >&2; exit 1; fi
if [[ "$1" == version ]]; then printf '24.0.0\\n'; exit 0; fi
if [[ "$1" == info ]]; then printf 'containers=1 running=1 paused=0 stopped=0\\n'; exit 0; fi
exit 0
`)
  await chmod(dockerPath, 0o755)
  const previousPath = process.env.PATH
  process.env.PATH = `${directory}:${previousPath}`
  try {
    return await callback()
  } finally {
    process.env.PATH = previousPath
  }
}

test('등록된 액션과 오류코드 허용 규칙을 판정한다', async () => {
  const { ACTIONS, actionFor, canRunAction } = await loadActions()
  assert.equal(ACTIONS.length, 3)
  assert.equal(actionFor('scale-service').script, 'scale-service.sh')
  assert.equal(actionFor('collect-incident').script, 'collect-container-incident.sh')
  assert.equal(actionFor('check-docker-access').script, 'check-docker-access.sh')
  assert.equal(actionFor('unknown'), null)
  assert.deepEqual(canRunAction('unknown', { code: 'OPS-DOCKER-001' }), { allowed: false, reason: '등록되지 않은 운영 스크립트입니다' })
  assert.equal(canRunAction('collect-incident', {}).allowed, false)
  assert.equal(canRunAction('collect-incident', { code: 'OPS-DOCKER-001' }).allowed, false)
  assert.equal(canRunAction('check-docker-access', { code: 'OPS-DOCKER-001' }).allowed, true)
  assert.equal(canRunAction('scale-service', { code: 'OPS-CPU-80-001', stateful: true }).allowed, false)
  assert.match(canRunAction('scale-service', { code: 'OPS-CPU-80-001' }).reason, /서비스를 명시적으로 설정/)
  assert.equal(canRunAction('scale-service', { code: 'OPS-CPU-80-001', composeService: 'backend' }).allowed, false)
})

test('확장은 명시적으로 허용한 안전 서비스와 경고 대상이 일치할 때만 허용한다', async () => {
  const previous = Object.fromEntries(['OPS_SCALE_SERVICE', 'OPS_SCALE_TARGET', 'OPS_SCALE_MAX', 'OPS_SCALE_ALLOWED_SERVICES'].map((key) => [key, process.env[key]]))
  process.env.OPS_SCALE_SERVICE = 'worker'
  process.env.OPS_SCALE_TARGET = '2'
  process.env.OPS_SCALE_MAX = '5'
  process.env.OPS_SCALE_ALLOWED_SERVICES = 'worker'
  try {
    const { canRunAction: configuredCanRun } = await import(`../src/actions.mjs?scale-policy=${Date.now()}`)
    assert.equal(configuredCanRun('scale-service', { code: 'OPS-CPU-80-001', composeService: 'worker' }).allowed, true)
    assert.equal(configuredCanRun('scale-service', { code: 'OPS-CPU-80-001', composeService: 'different' }).allowed, false)
    assert.equal(configuredCanRun('scale-service', { code: 'OPS-CPU-80-001' }).allowed, false)
    assert.equal(configuredCanRun('scale-service', { code: 'OPS-CPU-80-001', composeService: 'worker', stateful: true }).allowed, false)
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('확장 허용 목록·목표·최대 수량 안전 정책을 모두 적용한다', async () => {
  const { createActionPolicy } = await loadActions()
  const action = (overrides = {}) => ({
    id: 'scale-service', codes: ['OPS-CPU-80-001'], targetService: 'worker',
    targetReplicas: 2, maxReplicas: 5, hardMaxReplicas: 20,
    allowedServices: ['worker'], blockedServices: [], ...overrides,
  })
  assert.match(createActionPolicy([action({ allowedServices: ['other'] })]).canRunAction('scale-service', { code: 'OPS-CPU-80-001', composeService: 'worker' }).reason, /OPS_SCALE_ALLOWED_SERVICES/)
  assert.match(createActionPolicy([action({ maxReplicas: 21 })]).canRunAction('scale-service', { code: 'OPS-CPU-80-001', composeService: 'worker' }).reason, /OPS_SCALE_MAX/)
  assert.match(createActionPolicy([action({ targetReplicas: 0 })]).canRunAction('scale-service', { code: 'OPS-CPU-80-001', composeService: 'worker' }).reason, /목표 replica 수/)
  assert.match(createActionPolicy([action({ targetReplicas: 2.5 })]).canRunAction('scale-service', { code: 'OPS-CPU-80-001', composeService: 'worker' }).reason, /목표 replica 수/)
  assert.match(createActionPolicy([action({ blockedServices: ['worker'] })]).canRunAction('scale-service', { code: 'OPS-CPU-80-001', composeService: 'worker' }).reason, /안전 정책/)
})

test('액션 실행기는 인자를 전달하고 출력·실패 원인을 정규화한다', async () => {
  const { createActionRunner } = await loadActions()
  let captured
  const runner = createActionRunner(async (...args) => {
    captured = args
    return { stdout: '  diagnostic output\n' }
  })
  assert.deepEqual(await runner('collect-incident', { code: 'HTTP-5XX-RATE-001', containerId: 'abc123', includeLogs: true }), {
    actionId: 'collect-incident', code: 'HTTP-5XX-RATE-001', output: 'diagnostic output',
  })
  assert.equal(captured[0], 'bash')
  assert.equal(captured[2].env.OPS_CONTAINER_ID, 'abc123')
  assert.equal(captured[2].env.OPS_INCLUDE_LOGS, 'true')

  const stderrRunner = createActionRunner(async () => { throw Object.assign(new Error('failed'), { stderr: 'script stderr\n' }) })
  await assert.rejects(stderrRunner('check-docker-access', { code: 'OPS-DOCKER-001' }), /^Error: script stderr$/)
  const messageRunner = createActionRunner(async () => { throw new Error('') })
  await assert.rejects(messageRunner('check-docker-access', { code: 'OPS-DOCKER-001' }), /운영 스크립트 실행에 실패했습니다/)
})

test('등록되지 않은 액션과 오류코드로 실행할 수 없다', async () => {
  const { runAction } = await loadActions()
  await assert.rejects(runAction('unknown', { code: 'OPS-DOCKER-001' }), /등록되지 않은 운영 스크립트/)
  await assert.rejects(runAction('collect-incident', { code: 'OPS-DOCKER-001' }), /현재 오류코드에 허용되지 않은/)
})

test('Docker 연결 점검 액션은 결과를 반환한다', async () => {
  const { runAction } = await loadActions()
  await withDocker(async () => {
    const result = await runAction('check-docker-access', { code: 'OPS-DOCKER-001' })
    assert.equal(result.actionId, 'check-docker-access')
    assert.equal(result.code, 'OPS-DOCKER-001')
    assert.match(result.output, /24\.0\.0/)
    assert.match(result.output, /engine=reachable/)
  })
})

test('Docker 연결 점검은 Engine 연결 실패를 오류가 아닌 진단 결과로 보여준다', async () => {
  const { runAction } = await loadActions()
  await withDocker(async () => {
    const result = await runAction('check-docker-access', { code: 'OPS-DOCKER-001' })
    assert.match(result.output, /engine=unreachable/)
  }, true)
})

test('장애 보고서는 제한 권한으로 저장하고 경로 ID를 출력한다', async () => {
  const { runAction } = await loadActions()
  const directory = await import('node:fs/promises').then((fs) => fs.mkdtemp(path.join(os.tmpdir(), 'rm-ops-incident-')))
  const previous = process.env.OPS_DIAGNOSTICS_DIR
  process.env.OPS_DIAGNOSTICS_DIR = directory
  try {
    await withDocker(async () => {
      const result = await runAction('collect-incident', { code: 'HTTP-5XX-RATE-001', containerId: 'abc123', includeLogs: true })
      assert.match(result.output, /result=collected/)
      const reportPath = result.output.match(/^report=(.+)$/m)?.[1]
      assert.ok(reportPath)
      assert.match(await readFile(reportPath, 'utf8'), /HTTP-5XX-RATE-001/)
      assert.equal((await stat(reportPath)).mode & 0o777, 0o600)
    })
  } finally {
    if (previous === undefined) delete process.env.OPS_DIAGNOSTICS_DIR
    else process.env.OPS_DIAGNOSTICS_DIR = previous
  }
})

test('장애 정보 수집은 Docker 연결 실패를 호출자에게 오류로 반환한다', async () => {
  const { runAction } = await loadActions()
  await withDocker(async () => {
    await assert.rejects(runAction('collect-incident', { code: 'HTTP-5XX-RATE-001', containerId: 'abc123' }), /Docker Engine에 연결할 수 없습니다/)
  }, true)
})
