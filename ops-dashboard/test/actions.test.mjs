import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ACTIONS, actionFor, canRunAction, runAction } from '../src/actions.mjs'

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

test('등록된 액션과 오류코드 허용 규칙을 판정한다', () => {
  assert.equal(ACTIONS.length, 2)
  assert.equal(actionFor('scale-service').script, 'scale-service.sh')
  assert.equal(actionFor('unknown'), null)
  assert.deepEqual(canRunAction('unknown', { code: 'OPS-DOCKER-001' }), { allowed: false, reason: '등록되지 않은 운영 스크립트입니다' })
  assert.equal(canRunAction('collect-diagnostics', {}).allowed, false)
  assert.equal(canRunAction('collect-diagnostics', { code: 'OPS-CPU-80-001' }).allowed, false)
  assert.equal(canRunAction('collect-diagnostics', { code: 'OPS-DOCKER-001' }).allowed, true)
  assert.equal(canRunAction('scale-service', { code: 'OPS-CPU-80-001', stateful: true }).allowed, false)
})

test('등록되지 않은 액션과 오류코드로 실행할 수 없다', async () => {
  await assert.rejects(runAction('unknown', { code: 'OPS-DOCKER-001' }), /등록되지 않은 운영 스크립트/)
  await assert.rejects(runAction('collect-diagnostics', { code: 'OPS-CPU-80-001' }), /현재 오류코드에 허용되지 않은/)
})

test('진단 액션은 Docker 출력을 반환한다', async () => {
  await withDocker(async () => {
    const result = await runAction('collect-diagnostics', { code: 'OPS-DOCKER-001', containerId: 'abc123' })
    assert.equal(result.actionId, 'collect-diagnostics')
    assert.equal(result.code, 'OPS-DOCKER-001')
    assert.match(result.output, /24\.0\.0/)
    assert.match(result.output, /container_id=abc123/)
  })
})

test('진단 액션의 Docker 실패를 오류로 반환한다', async () => {
  await withDocker(async () => {
    await assert.rejects(runAction('collect-diagnostics', { code: 'OPS-DOCKER-001' }), /diagnostic Docker failure/)
  }, true)
})
