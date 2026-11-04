import test from 'node:test'
import assert from 'node:assert/strict'
import { summarizeMetrics, formatPercent, topContainerMetrics } from '../src/public/metric-display.js'

test('연결 실패와 통계 누락은 0이 아니라 수집 불가로 표시한다', () => {
  const stopped = { running: false, stats: null }
  const running = { running: true, stats: null }
  assert.deepEqual(summarizeMetrics({ dockerAvailable: false, containers: [running] }), { running: null, total: null, cpu: null, memory: null })
  assert.deepEqual(summarizeMetrics({ dockerAvailable: true, containers: [stopped] }), { running: 0, total: 1, cpu: null, memory: null })
  assert.deepEqual(summarizeMetrics({ dockerAvailable: true, containers: [running] }), { running: 1, total: 1, cpu: null, memory: null })
  assert.equal(formatPercent(null), '수집 불가')
  assert.equal(formatPercent(null, '-'), '-')
})

test('사용량 상위 5개는 측정된 실행 컨테이너만 내림차순으로 정렬한다', () => {
  const containers = Array.from({length:7}, (_, index) => ({id:`id-${index}`,name:`container-${index}`,running:true,stats:{cpuPercent:index*20,memoryUsedBytes:(8-index)*1024,memoryPercent:index}}))
  containers.push({id:'stopped',name:'stopped',running:false,stats:{cpuPercent:999,memoryUsedBytes:999999}})
  containers.push({id:'missing',name:'missing',running:true,stats:null})
  const originalOrder = containers.map(item=>item.id)
  const overview = {dockerAvailable:true,containers}
  assert.deepEqual(topContainerMetrics(overview,'cpu').items.map(item=>item.id), ['id-6','id-5','id-4','id-3','id-2'])
  assert.deepEqual(topContainerMetrics(overview,'memory').items.map(item=>item.id), ['id-0','id-1','id-2','id-3','id-4'])
  assert.equal(topContainerMetrics(overview,'cpu').measuredCount,7)
  assert.equal(topContainerMetrics(overview,'cpu').runningCount,8)
  assert.deepEqual(containers.map(item=>item.id),originalOrder)
  assert.equal(topContainerMetrics({...overview,dockerAvailable:false},'cpu').items.length,0)
  assert.equal(topContainerMetrics({dockerAvailable:true,containers:[containers[0]]},'cpu').items[0].value,0)
})

test('측정된 0과 실제 수치 및 부분 수집을 구분한다', () => {
  const first = { running: true, stats: { cpuPercent: 0, memoryUsedBytes: 0, memoryLimitBytes: 100 } }
  const second = { running: true, stats: { cpuPercent: 12.5, memoryUsedBytes: 50, memoryLimitBytes: 100 } }
  assert.deepEqual(summarizeMetrics({ dockerAvailable: true, containers: [first] }), { running: 1, total: 1, cpu: 0, memory: 0 })
  assert.deepEqual(summarizeMetrics({ dockerAvailable: true, containers: [first, second] }), { running: 2, total: 2, cpu: 12.5, memory: 25 })
  assert.equal(summarizeMetrics({ dockerAvailable: true, containers: [first, { running: true, stats: null }] }).cpu, null)
  assert.deepEqual(summarizeMetrics({ dockerAvailable: true, containers: [{ running: true, stats: { cpuPercent: 7 } }] }), { running: 1, total: 1, cpu: 7, memory: null })
  assert.deepEqual(summarizeMetrics({ dockerAvailable: true, containers: [{ running: true, stats: { memoryUsedBytes: 40, memoryLimitBytes: 100 } }] }), { running: 1, total: 1, cpu: null, memory: 40 })
  assert.equal(formatPercent(0), '0.0%')
  assert.equal(formatPercent(0, '-'), '0.0%')
})
