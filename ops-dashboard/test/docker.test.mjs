import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  assertContainerId,
  filterContainers,
  listContainers,
  listStats,
  readLogs,
  readSnapshot,
  streamLogs,
} from '../src/docker.mjs'

async function withDocker(callback, mode = 'normal') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rm-ops-docker-'))
  const dockerPath = path.join(directory, 'docker')
  const dockerScript = `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${DOCKER_FAKE_MODE:-normal}" == fail ]]; then
  printf 'fake Docker daemon failure\\n' >&2
  exit 1
fi
case "\$1" in
  ps)
    if [[ "\${DOCKER_FAKE_MODE:-normal}" == unmatched ]]; then
      printf '%s\\n' '{"ID":"other","Names":"rm-other","Image":"example/other","State":"exited"}'
    else
      printf '%s\\n' '{"ID":"abc123","Names":"rm-api","Image":"moonsangjin/tamji:be-latest","State":"running","Status":"Up","Ports":"","CreatedAt":"today"}'
    fi
    ;;
  stats)
    printf '%s\\n' '{"Container":"abc123full","Name":"rm-api","CPUPerc":"12.5%","MemPerc":"25.0%","MemUsage":"10MiB / 100MiB","NetIO":"1kB / 2kB","BlockIO":"3kB / 4kB","PIDs":"5"}'
    ;;
  logs)
    if [[ "\$2" == --follow ]]; then
      printf 'line-one\\nline-two\\npartial'
    else
      printf '2026-11-02T00:00:00Z application ready\\n'
    fi
    ;;
  version)
    printf '24.0.0\\n'
    ;;
  info)
    printf 'containers=2 running=1 paused=0 stopped=1\\n'
    ;;
  *)
    printf 'unsupported fake Docker command\\n' >&2
    exit 1
    ;;
esac
`
  await writeFile(dockerPath, dockerScript)
  await chmod(dockerPath, 0o755)
  const previousPath = process.env.PATH
  const previousMode = process.env.DOCKER_FAKE_MODE
  process.env.PATH = `${directory}:${previousPath}`
  process.env.DOCKER_FAKE_MODE = mode
  try {
    return await callback()
  } finally {
    process.env.PATH = previousPath
    if (previousMode === undefined) delete process.env.DOCKER_FAKE_MODE
    else process.env.DOCKER_FAKE_MODE = previousMode
  }
}

test('Docker 컨테이너·통계 응답을 운영 모델로 변환한다', async () => {
  await withDocker(async () => {
    assert.deepEqual(await listContainers(), [{
      id: 'abc123', name: 'rm-api', image: 'moonsangjin/tamji:be-latest', state: 'running', status: 'Up', ports: '', createdAt: 'today',
    }])
    assert.deepEqual(await listStats(), [{
      id: 'abc123full', name: 'rm-api', cpuPercent: 12.5, memoryPercent: 25, memoryUsedBytes: 10 * 1024 ** 2, memoryLimitBytes: 100 * 1024 ** 2,
      networkIo: '1kB / 2kB', blockIo: '3kB / 4kB', pids: 5,
    }])
    const snapshot = await readSnapshot()
    assert.equal(snapshot[0].running, true)
    assert.equal(snapshot[0].stats.cpuPercent, 12.5)
  })
})

test('통계와 일치하지 않는 컨테이너는 stats를 null로 둔다', async () => {
  await withDocker(async () => {
    const snapshot = await readSnapshot()
    assert.equal(snapshot[0].stats, null)
  }, 'unmatched')
})

test('로그 tail을 읽고 follow 스트림의 잔여 버퍼를 flush한다', async () => {
  await withDocker(async () => {
    const logs = await readLogs('abc123', { tail: 0, since: '1m' })
    assert.match(logs, /application ready/)

    const lines = []
    await new Promise((resolve, reject) => {
      streamLogs('abc123', {
        tail: 2,
        onData: (line) => lines.push(line),
        onError: reject,
        onClose: resolve,
      })
    })
    assert.deepEqual(lines, ['line-one', 'line-two', 'partial'])
  })
})

test('잘못된 컨테이너 ID와 Docker 명령 실패를 거부한다', async () => {
  assert.throws(() => assertContainerId('bad/id'), /유효하지 않은 컨테이너 ID/)
  await withDocker(async () => {
    await assert.rejects(listContainers(), /fake Docker daemon failure/)
    await assert.rejects(readLogs('abc123'), /fake Docker daemon failure/)
  }, 'fail')
})

test('컨테이너 범위 필터의 모든 모드와 잘못된 모드를 처리한다', () => {
  const containers = [
    { image: 'moonsangjin/tamji:be-latest', name: 'rm-backend' },
    { image: 'mariadb:12', name: 'rm-mariadb' },
    { image: 'example/other', name: 'other' },
  ]
  assert.equal(filterContainers(containers, { scope: 'all' }), containers)
  assert.deepEqual(filterContainers(containers, { scope: 'image', imagePrefixes: ['mariadb'] }).map((item) => item.name), ['rm-mariadb'])
  assert.deepEqual(filterContainers(containers, { scope: 'name', namePrefixes: ['rm-'] }).map((item) => item.name), ['rm-backend', 'rm-mariadb'])
  assert.deepEqual(filterContainers(containers, { scope: 'image-or-name', imagePrefixes: ['example'], namePrefixes: ['rm-backend'] }).map((item) => item.name), ['rm-backend', 'other'])
  assert.throws(() => filterContainers(containers, { scope: 'unsupported' }), /지원하지 않는 OPS_CONTAINER_SCOPE/)
})
