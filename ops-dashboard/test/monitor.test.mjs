import test from 'node:test'
import assert from 'node:assert/strict'
import { createMonitor } from '../src/monitor.mjs'
import { filterContainers } from '../src/docker.mjs'
import { canRunAction } from '../src/actions.mjs'

const container = (id, cpuPercent, memoryPercent) => ({ id, name: id, running: true, stats: { cpuPercent, memoryPercent } })

test('80% 이상 자원은 지속 시간을 누적하고 경고를 만든다', async () => {
  let time = 1_000
  const monitor = createMonitor({ now: () => time, readSnapshot: async () => [container('api', 84.2, 31)] })
  await monitor.tick()
  time += 65_000
  const state = await monitor.tick()
  assert.equal(state.alerts.length, 1)
  assert.equal(state.alerts[0].code, 'OPS-CPU-80-001')
  assert.equal(state.alerts[0].durationSec, 65)
  assert.match(state.alerts[0].message, /1분 5초 동안 80% 이상/)
})

test('임계치 미만으로 내려가면 기존 경고 지속 시간을 초기화한다', async () => {
  let time = 1_000
  let high = true
  const monitor = createMonitor({ now: () => time, readSnapshot: async () => [container('api', high ? 81 : 40, 81)] })
  await monitor.tick()
  time += 30_000
  high = false
  const cleared = await monitor.tick()
  assert.deepEqual(cleared.alerts.map((item) => item.code), ['OPS-MEM-80-001'])
  time += 10_000
  high = true
  const restarted = await monitor.tick()
  assert.equal(restarted.alerts.find((item) => item.code === 'OPS-CPU-80-001').durationSec, 0)
})

test('Docker 조회가 실패하면 연결 오류코드를 활성화한다', async () => {
  const monitor = createMonitor({ readSnapshot: async () => { throw new Error('permission denied') } })
  const state = await monitor.tick()
  assert.equal(state.dockerAvailable, false)
  assert.equal(state.alerts[0].code, 'OPS-DOCKER-001')
  assert.match(state.alerts[0].message, /permission denied/)
})

test('MariaDB 자원 경고는 감시하지만 무조건 수평 확장하지 않는다', () => {
  const result = canRunAction('scale-service', { code: 'OPS-MEM-80-001', stateful: true })
  assert.equal(result.allowed, false)
  assert.match(result.reason, /데이터 일관성/)
})

test('현재 프로젝트 범위는 tamji 앱과 MariaDB만 선택할 수 있다', () => {
  const containers = [
    { image: 'moonsangjin/tamji:latest', name: 'rm-backend' },
    { image: 'mariadb:12', name: 'rm-mariadb' },
    { image: 'gvenzl/oracle-xe:21-slim', name: 'oracle21c' },
  ]
  const selected = filterContainers(containers, {
    scope: 'image-or-name',
    imagePrefixes: ['moonsangjin/tamji', 'mariadb'],
    namePrefixes: ['rm-'],
  })
  assert.deepEqual(selected.map((item) => item.name), ['rm-backend', 'rm-mariadb'])
})
