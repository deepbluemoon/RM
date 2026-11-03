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
      this.textContent = ''
      this.innerHTML = ''
    }
    setAttribute(key, value) { this.attributes[key] = value }
    removeAttribute(key) { delete this.attributes[key] }
    addEventListener(type, callback) { this.listeners[type] = callback }
    querySelectorAll() {
      if (!['container-list', 'activity-container-list'].includes(this.id)) return []
      return [...this.innerHTML.matchAll(/data-container-id="([^"]+)"/g)].map((match) => {
        const row = new Element('row')
        row.dataset.containerId = match[1]
        this.rows ??= []
        this.rows.push(row)
        return row
      })
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
    alerts: [],
    statusCodes: { totals: { classCounts: { '1xx': 0, '2xx': 1, '3xx': 0, '4xx': 0, '5xx': 0 } }, collectionErrors: [] },
  }
  const source = (await fs.readFile(new URL('../src/public/app.js', import.meta.url), 'utf8')).replace(/^import [^\n]*\n/gm, '')
  const context = vm.createContext({
    document: { getElementById: element, querySelectorAll: () => links },
    window, EventSource, summarizeMetrics, formatPercent, httpChartData,
    fetch: async (url) => ({ json: async () => url === '/api/error-codes' ? { codes: [], actions: [] } : overview }),
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
  assert.match(element('activity-container-list').innerHTML, /worker/)

  element('container-list').rows[0].listeners.click()
  assert.equal(sources[0].url, '/api/logs/stream?containerId=abc&tail=200')
  assert.equal(window.location.hash, 'activity')
  window.location.hash = '#activity'
  events.hashchange()
  assert.equal(element('overview').classList.contains('hidden'), true)
  assert.equal(element('activity').classList.contains('hidden'), false)
  assert.equal(element('logs-title').textContent, '로그 · api')
  element('activity-container-list').rows.at(-1).listeners.click()
  assert.equal(sources[0].closed, true)
  assert.equal(sources[1].url, '/api/logs/stream?containerId=def&tail=200')
  window.location.hash = '#overview'
  events.hashchange()
  assert.equal(element('overview').classList.contains('hidden'), false)
  assert.equal(links[0].attributes['aria-current'], 'page')
})
