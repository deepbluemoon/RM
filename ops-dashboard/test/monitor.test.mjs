import test from 'node:test'
import assert from 'node:assert/strict'
import { createMonitor } from '../src/monitor.mjs'
import { filterContainers } from '../src/docker.mjs'
import { canRunAction } from '../src/actions.mjs'
import { createHttpStatusAggregator, HTTP_LOG_ADAPTERS, HTTP_STATUS_CODES, parseHttpLogLine, parseHttpStatusLine, summarizeHttpStatusLines } from '../src/http-status.mjs'

const container = (id, cpuPercent, memoryPercent) => ({ id, name: id, running: true, stats: { cpuPercent, memoryPercent } })

test('누락된 통계만 마지막 실측값으로 잠시 표시하고 경고에는 사용하지 않는다', async () => {
  let time = 1000
  let stats = { cpuPercent: 85, memoryUsedBytes: 20, memoryLimitBytes: 100 }
  const monitor = createMonitor({ now: () => time, readSnapshot: async () => [{ id: 'api', name: 'api', running: true, stats }] })
  await monitor.tick()
  time += 5000
  stats = { cpuPercent: null, memoryUsedBytes: 0, memoryLimitBytes: 100 }
  const partial = await monitor.tick()
  assert.equal(partial.containers[0].stats.cpuPercent, 85)
  assert.equal(partial.containers[0].stats.memoryUsedBytes, 0)
  assert.equal(partial.containers[0].statsRetained, true)
  assert.deepEqual(partial.alerts, [])
  time += 11000
  const expired = await monitor.tick()
  assert.equal(expired.containers[0].stats.cpuPercent, null)
  assert.equal(expired.containers[0].statsRetained, undefined)
})

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

test('상태코드 로그 수집이 실패해도 Docker 자원 모니터링은 유지한다', async () => {
  const monitor = createMonitor({ readSnapshot: async () => [container('api', 20, 30)], readStatusLogs: async () => { throw new Error('log permission denied') } })
  const state = await monitor.tick()
  assert.equal(state.dockerAvailable, true)
  assert.deepEqual(state.statusCodes.collectionErrors, ['log permission denied'])
})

test('MariaDB 자원 경고는 감시하지만 무조건 수평 확장하지 않는다', () => {
  const result = canRunAction('scale-service', { code: 'OPS-MEM-80-001', stateful: true })
  assert.equal(result.allowed, false)
  assert.match(result.reason, /데이터베이스 컨테이너/)
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

test('표준 HTTP access log와 JSON 로그에서 상태코드 태그를 추출한다', () => {
  assert.equal(parseHttpStatusLine('"GET /health HTTP/1.1" 200 41').tag, 'HTTP-200')
  assert.equal(parseHttpStatusLine('{"statusCode": 404, "message": "not found"}').tag, 'HTTP-404')
  assert.equal(parseHttpStatusLine('responseStatus=503').tag, 'HTTP-503')
  assert.equal(parseHttpStatusLine('not an access log 999'), null)
  const summary = summarizeHttpStatusLines(['HTTP/1.1 200', 'HTTP/1.1 404', 'HTTP/1.1 500'])
  assert.deepEqual(summary.classCounts, { '1xx': 0, '2xx': 1, '3xx': 0, '4xx': 1, '5xx': 1 })
})

test('로그 어댑터가 지원 형식을 정규화하고 query·잘못된 ID를 제거한다', () => {
  assert.equal(HTTP_LOG_ADAPTERS.length, 3)
  const combined = parseHttpLogLine('127.0.0.1 - - [date] "POST /api/contracts/42?token=secret HTTP/1.1" 202 18')
  assert.equal(combined.status.tag, 'HTTP-202')
  assert.equal(combined.method, 'POST')
  assert.equal(combined.path, '/api/contracts/42')
  const json = parseHttpLogLine(JSON.stringify({
    response: { status: 503 }, request: { method: 'get', url: '/health?key=hidden', id: 'request-123' },
    trace: { id: 'trace_456' }, deploymentVersion: '2026.11.03',
  }))
  assert.equal(json.status.tag, 'HTTP-503')
  assert.equal(json.method, 'GET')
  assert.equal(json.path, '/health')
  assert.equal(json.requestId, 'request-123')
  assert.equal(json.traceId, 'trace_456')
  assert.equal(json.deploymentVersion, '2026.11.03')
  assert.equal(parseHttpLogLine(JSON.stringify({ status: 200, requestId: 'contains spaces', path: '/ok' })).requestId, '')
  assert.equal(parseHttpLogLine(JSON.stringify({ status: 200, path: `/api/${'x'.repeat(520)}` })).path, '')
  assert.equal(parseHttpLogLine('{bad json'), null)
  assert.equal(parseHttpStatusLine('unrecognized 777'), null)
})

test('등록된 전체 HTTP 상태코드를 태그 카탈로그로 제공한다', () => {
  assert.ok(HTTP_STATUS_CODES.some((item) => item.tag === 'HTTP-202'))
  assert.ok(HTTP_STATUS_CODES.some((item) => item.tag === 'HTTP-403'))
  assert.ok(HTTP_STATUS_CODES.some((item) => item.tag === 'HTTP-404'))
  assert.ok(HTTP_STATUS_CODES.some((item) => item.tag === 'HTTP-511'))
  assert.equal(new Set(HTTP_STATUS_CODES.map((item) => item.code)).size, HTTP_STATUS_CODES.length)
})

test('HTTP 5xx 비율이 지속되면 운영 경고를 만들고 단일 404는 무시한다', () => {
  let time = 1_000
  const monitor = createHttpStatusAggregator({ now: () => time, alertDurationMs: 30_000 })
  const containers = [{ id: 'api', name: 'api', image: 'moonsangjin/tamji:latest', running: true }]
  const lines = Array.from({ length: 10 }, (_, index) => `HTTP/1.1 ${index === 0 ? 500 : 200}`)
  monitor.observe(containers, { api: lines }, time)
  time += 30_000
  const state = monitor.observe(containers, { api: lines }, time)
  assert.equal(state.alerts[0].code, 'HTTP-5XX-RATE-001')
  assert.equal(state.alerts[0].count, 1)
  const single404 = monitor.observe(containers, { api: ['HTTP/1.1 404'] }, time + 30_000)
  assert.equal(single404.alerts.length, 0)
})

test('HTTP 응답을 Compose 서비스와 명시된 route template별로 집계한다', () => {
  const aggregator = createHttpStatusAggregator()
  const containers = [
    { id: 'api-1', name: 'rm-api-1', composeService: 'backend', running: true },
    { id: 'api-2', name: 'rm-api-2', composeService: 'backend', running: true },
    { id: 'web', name: 'rm-web', composeService: 'frontend', running: true },
  ]
  const state = aggregator.observe(containers, {
    'api-1': [
      JSON.stringify({ status: 200, method: 'GET', route: '/api/contracts/{contractId}' }),
      '"GET /private-user-value?secret=hidden HTTP/1.1" 404 0',
    ],
    'api-2': [JSON.stringify({ status: 500, method: 'GET', route: '/api/contracts/{contractId}' })],
    web: [JSON.stringify({ status: 204, method: 'GET', route: '/health' })],
  })
  assert.equal(state.totals.total, 4)
  assert.deepEqual(state.services.map(({ service, total }) => [service, total]), [['backend', 3], ['frontend', 1]])
  assert.deepEqual(state.routes.map(({ service, method, route, total }) => [service, method, route, total]), [
    ['backend', 'GET', '/api/contracts/{contractId}', 2],
    ['frontend', 'GET', '/health', 1],
  ])
  assert.equal(JSON.stringify(state.routes).includes('private-user-value'), false)
})

test('배포 버전과 유효한 trace·request ID를 요청 이벤트에 연결한다', () => {
  const aggregator = createHttpStatusAggregator({ deploymentVersion: 'release-2026.11' })
  const containers = [{ id: 'backend-1', name: 'rm-backend-1', composeService: 'backend', running: true }]
  const state = aggregator.observe(containers, {
    'backend-1': [
      JSON.stringify({ status: 500, method: 'POST', route: '/api/analyze', requestId: 'req-123', traceId: 'trace_456' }),
      JSON.stringify({ status: 200, method: 'GET', route: '/health', requestId: 'x'.repeat(129), deploymentVersion: 'build-7' }),
      JSON.stringify({ status: 200, path: '/raw/path?token=secret' }),
    ],
  })
  assert.equal(state.correlations.length, 3)
  assert.deepEqual(state.correlations[0], {
    service: 'backend', containerName: 'rm-backend-1', status: 200, method: '', route: '',
    requestId: '', traceId: '', deploymentVersion: 'release-2026.11',
  })
  assert.deepEqual(state.correlations[1], {
    service: 'backend', containerName: 'rm-backend-1', status: 200, method: 'GET', route: '/health',
    requestId: '', traceId: '', deploymentVersion: 'build-7',
  })
  assert.deepEqual(state.correlations[2], {
    service: 'backend', containerName: 'rm-backend-1', status: 500, method: 'POST', route: '/api/analyze',
    requestId: 'req-123', traceId: 'trace_456', deploymentVersion: 'release-2026.11',
  })
  assert.equal(JSON.stringify(state.correlations).includes('token=secret'), false)
})

test('상위 모니터가 설정된 배포 버전을 상관관계로 전달한다', async () => {
  const monitor = createMonitor({
    deploymentVersion: 'release-8',
    readSnapshot: async () => [{ id: 'api', name: 'api', composeService: 'backend', running: true }],
    readStatusLogs: async () => ({ logs: { api: [JSON.stringify({ status: 200, requestId: 'req-8' })] }, errors: [] }),
  })
  const state = await monitor.tick()
  assert.equal(state.statusCodes.correlations[0].deploymentVersion, 'release-8')
  assert.equal(state.statusCodes.correlations[0].requestId, 'req-8')
})
