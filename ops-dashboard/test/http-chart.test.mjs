import test from 'node:test'
import assert from 'node:assert/strict'
import { httpChartData } from '../src/public/http-chart.js'

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
