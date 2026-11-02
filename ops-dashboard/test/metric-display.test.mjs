import test from 'node:test'
import assert from 'node:assert/strict'
import { summarizeMetrics, formatPercent } from '../src/public/metric-display.js'

test('연결 실패와 통계 누락은 0이 아니라 수집 불가로 표시한다', () => {
  const stopped = { running: false, stats: null }
  const running = { running: true, stats: null }
  assert.deepEqual(summarizeMetrics({ dockerAvailable: false, containers: [running] }), { running: null, total: null, cpu: null, memory: null })
  assert.deepEqual(summarizeMetrics({ dockerAvailable: true, containers: [stopped] }), { running: 0, total: 1, cpu: null, memory: null })
  assert.deepEqual(summarizeMetrics({ dockerAvailable: true, containers: [running] }), { running: 1, total: 1, cpu: null, memory: null })
  assert.equal(formatPercent(null), '수집 불가')
  assert.equal(formatPercent(null, '-'), '-')
})

test('측정된 0과 실제 수치 및 부분 수집을 구분한다', () => {
  const first = { running: true, stats: { cpuPercent: 0, memoryUsedBytes: 0, memoryLimitBytes: 100 } }
  const second = { running: true, stats: { cpuPercent: 12.5, memoryUsedBytes: 50, memoryLimitBytes: 100 } }
  assert.deepEqual(summarizeMetrics({ dockerAvailable: true, containers: [first] }), { running: 1, total: 1, cpu: 0, memory: 0 })
  assert.deepEqual(summarizeMetrics({ dockerAvailable: true, containers: [first, second] }), { running: 2, total: 2, cpu: 12.5, memory: 25 })
  assert.equal(summarizeMetrics({ dockerAvailable: true, containers: [first, { running: true, stats: null }] }).cpu, null)
  assert.equal(formatPercent(0), '0.0%')
  assert.equal(formatPercent(0, '-'), '0.0%')
})
