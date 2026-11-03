import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import { summarizeMetrics, formatPercent } from '../src/public/metric-display.js'
import { httpChartData } from '../src/public/http-chart.js'

test('화면 전환과 컨테이너 선택은 기존 로그 연결을 유지한다', async () => {
  class Classes {
    constructor(initial = []) { this.values = new Set(initial) }
    add(value) { this.values.add(value) }
    remove(value) { this.values.delete(value) }
    toggle(value, force) { if (force) this.add(value); else this.remove(value) }
    contains(value) { return this.values.has(value) }
  }
  class Element {
    constructor(id) {
      this.id = id
      this.classList = new Classes(id === 'activity' ? ['hidden'] : [])
      this.dataset = {}
      this.previousElementSibling = { style: {} }
      this.listeners = {}
      this.attributes = {}
      this.open = false
      this.clientHeight = 0
      this.scrollTop = 0
      this.textContent = ''
      this.innerHTML = ''
    }
    showModal() { this.open = true }
    close() { this.open = false }
    focus() {}
    getBoundingClientRect() { return { top: 0 } }
    setAttribute(key, value) { this.attributes[key] = value }
    removeAttribute(key) { delete this.attributes[key] }
    addEventListener(type, callback) { this.listeners[type] = callback }
    querySelectorAll(selector) {
      if (this.id === 'container-list') {
        this.rows = [...this.innerHTML.matchAll(/data-container-id="([^"]+)"/g)].map((match) => {
          const row = new Element('row')
          row.dataset.containerId = match[1]
          row.parent = this
          row.getBoundingClientRect = () => ({ top: 0 })
          row.closest = () => this
          return row
        })
        return this.rows
      }
      if (this.id === 'alerts-list') {
        this.alertRows = [...this.innerHTML.matchAll(/data-alert-id="([^"]+)"/g)].map((match) => {
          const button = new Element('alert')
          button.dataset.alertId = match[1]
          return button
        })
        return this.alertRows
      }
      return []
    }
    querySelector() { return null }
  }
  const elements = new Map()
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, new Element(id))
    return elements.get(id)
  }
  const links = ['overview', 'activity'].map((view) => {
    const link = new Element(view)
    link.dataset.viewLink = view
    return link
  })
  const events = {}
  const sources = []
  class EventSource {
    constructor(url) { this.url = url; this.closed = false; sources.push(this) }
    close() { this.closed = true }
    addEventListener() {}
  }
  const window = { location: { hash: '' }, addEventListener: (type, callback) => { events[type] = callback } }
  const overview = {
    dockerAvailable: true,
    observedAt: 0,
    containers: [
      { id: 'abc', name: 'api', image: 'api:test', running: true, stats: { cpuPercent: 0, memoryPercent: 0, memoryUsedBytes: 0, memoryLimitBytes: 100 } },
      { id: 'def', name: 'worker', image: 'worker:test', running: false, stats: null },
    ],
    alerts: [
      { id: 'OPS-DOCKER-001', code: 'OPS-DOCKER-001', severity: 'critical', containerId: '', containerName: 'Docker Engine', resource: 'Docker 연결', message: 'Docker 엔진 연결 실패 — spawn docker ENOENT' },
      { id: 'HTTP-5XX-RATE-001:abc', code: 'HTTP-5XX-RATE-001', kind: 'http', severity: 'critical', containerId: 'abc', containerName: 'api', resource: 'HTTP 5xx', message: 'api HTTP 5xx 비율 경고' },
      { id: 'OPS-CPU-80-001:abc', code: 'OPS-CPU-80-001', severity: 'warning', containerId: 'abc', containerName: 'api', resource: 'CPU', message: 'api CPU 사용률 경고' },
    ],
    statusCodes: { totals: { classCounts: { '1xx': 0, '2xx': 1, '3xx': 0, '4xx': 0, '5xx': 0 } }, collectionErrors: [] },
  }
  const source = (await fs.readFile(new URL('../src/public/app.js', import.meta.url), 'utf8')).replace(/^import [^\n]*\n/gm, '')
  const context = vm.createContext({
    document: { getElementById: element, querySelectorAll: (selector) => selector === '.container-row' ? (element('container-list').rows || []) : links },
    window, EventSource, summarizeMetrics, formatPercent, httpChartData,
    fetch: async (url) => ({ ok: true, json: async () => url === '/api/error-codes' ? { codes: [], actions: [] } : overview }),
    setInterval: () => 0,
    console,
  })
  vm.runInContext(source, context)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(element('overview').classList.contains('hidden'), false)
  assert.equal(element('activity').classList.contains('hidden'), true)
  assert.equal(element('running-count').textContent, '1')
  assert.match(element('status-summary').innerHTML, /2XX/)
  assert.match(element('container-list').innerHTML, /api/)
  assert.match(element('activity-container-select').innerHTML, /worker/)
  assert.equal(element('alert-count').textContent, '3')
  assert.equal(element('alerts-popover').classList.contains('hidden'), true)
  element('alert-toggle').listeners.click()
  assert.equal(element('alerts-popover').classList.contains('hidden'), false)
  element('alerts-list').alertRows.find((row) => row.dataset.alertId === 'HTTP-5XX-RATE-001:abc').listeners.click()
  assert.equal(element('alerts-popover').classList.contains('hidden'), true)
  assert.equal(element('http-warning-lamp').classList.contains('hidden'), false)
  assert.equal(element('engine-warning-lamp').classList.contains('hidden'), true)
  element('alert-toggle').listeners.click()
  element('alerts-list').alertRows.find((row) => row.dataset.alertId === 'OPS-CPU-80-001:abc').listeners.click()
  assert.equal(element('container-list').rows.some((row) => row.classList.contains('is-alert-target')), true, JSON.stringify(element('container-list').rows.map((row) => [row.dataset.containerId, [...row.classList.values]])))
  assert.equal(element('http-warning-lamp').classList.contains('hidden'), true)
  assert.equal(element('engine-warning-lamp').classList.contains('hidden'), true)
  element('alert-toggle').listeners.click()
  element('alerts-list').alertRows.find((row) => row.dataset.alertId === 'OPS-DOCKER-001').listeners.click()
  assert.equal(element('engine-warning-lamp').classList.contains('hidden'), false)
  assert.equal(element('http-warning-lamp').classList.contains('hidden'), true)

  element('container-list').rows[0].listeners.click()
  assert.equal(sources[0].url, '/api/logs/stream?containerId=abc&tail=200')
  assert.equal(window.location.hash, 'activity')
  window.location.hash = '#activity'
  events.hashchange()
  assert.equal(element('overview').classList.contains('hidden'), true)
  assert.equal(element('activity').classList.contains('hidden'), false)
  assert.equal(element('logs-title').textContent, '로그 · api')
  element('activity-container-select').listeners.change({ target: { value: 'def' } })
  assert.equal(sources[0].closed, true)
  assert.equal(sources[1].url, '/api/logs/stream?containerId=def&tail=200')
  window.location.hash = '#overview'
  events.hashchange()
  assert.equal(element('overview').classList.contains('hidden'), false)
  assert.equal(links[0].attributes['aria-current'], 'page')
})

test('화면에서 상단 오류 배너를 제거하고 오류코드 안내는 dialog로 제공한다', async () => {
  const html = await fs.readFile(new URL('../src/public/index.html', import.meta.url), 'utf8')
  assert.doesNotMatch(html, /id="error-banner"/)
  assert.match(html, /<dialog id="error-codes"/)
  assert.match(html, /id="alert-toggle"[^>]+aria-expanded="false"/)
})
