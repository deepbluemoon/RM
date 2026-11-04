import test from 'node:test'
import assert from 'node:assert/strict'
import { httpChartData, httpResponseDetails } from '../src/public/http-chart.js'

test('HTTP 응답이 수집된 상태군만 수치와 비율로 표시한다', () => {
  const status = { totals: { classCounts: { '1xx': 0, '2xx': 8, '3xx': 0, '4xx': 2, '5xx': 0 } }, collectionErrors: [] }
  assert.deepEqual(httpChartData(status, true), { state: 'ready', total: 10, bars: [{ label: '2xx', count: 8, percent: 80 }, { label: '4xx', count: 2, percent: 20 }] })
  assert.equal(httpChartData({ ...status, collectionErrors: ['failed'] }, true).state, 'partial')
})

test('수집 실패, 잘못된 값, 응답 없음을 구분한다', () => {
  const empty = { totals: { classCounts: { '1xx': 0, '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 } }, collectionErrors: [] }
  assert.equal(httpChartData(empty, true).state, 'empty')
  assert.equal(httpChartData(empty, false).state, 'unavailable')
  assert.equal(httpChartData({ ...empty, collectionErrors: ['failed'] }, true).state, 'unavailable')
  assert.equal(httpChartData({ totals: { classCounts: { '2xx': -1 } } }, true).state, 'unavailable')
})

test('상태군의 실제 응답 코드와 건수, 수집된 요청 출처를 구분한다', () => {
  const status = {
    totals: { counts: { 200: 8, 302: 1, 304: 1, 404: 0 } },
    routes: [{ service: 'api', method: 'GET', route: '/login', counts: { 302: 1 } }],
    containers: [{ name: 'api-container', counts: { 302: 1 } }, { name: 'web-container', counts: { 304: 1 } }],
  }
  assert.deepEqual(httpResponseDetails(status, '3xx', [{ code: 302, description: 'Found' }, { code: 304, description: 'Not Modified' }]), [
    { code: 302, count: 1, description: 'Found', sources: ['api-container (1건)'] },
    { code: 304, count: 1, description: 'Not Modified', sources: ['web-container (1건)'] },
  ])
  assert.deepEqual(httpResponseDetails(status, '4xx'), [])
  assert.deepEqual(httpResponseDetails(null, '3xx'), [])
})
