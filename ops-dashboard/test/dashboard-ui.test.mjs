import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import { summarizeMetrics, formatPercent } from '../src/public/metric-display.js'
import { httpChartData } from '../src/public/http-chart.js'

async function makeUi() {
  class Classes {
    constructor() { this.values = new Set() }
    add(name) { this.values.add(name) }
    remove(name) { this.values.delete(name) }
    contains(name) { return this.values.has(name) }
    toggle(name, force) {
      const next = force === undefined ? !this.values.has(name) : force
      if (next) this.values.add(name)
      else this.values.delete(name)
      return next
    }
  }
  class Element {
    constructor(id = '') {
      this.id = id
      this.dataset = {}
      this.classList = new Classes()
      this.style = {}
      this.attributes = {}
      this.previousElementSibling = { style: {} }
      this.children = []
      this.innerHTML = ''
      this.textContent = ''
      this.scrollHeight = 0
      this.scrollTop = 0
      this.clientHeight = 0
    }
    setAttribute(key, value) { this.attributes[key] = value }
    removeAttribute(key) { delete this.attributes[key] }
    querySelector() { return null }
    querySelectorAll() { return [] }
    append(child) { this.children.push(child); child.remove = () => this.children.shift() }
    get firstElementChild() { return this.children[0] }
    addEventListener() {}
    showModal() { this.open = true }
    close() { this.open = false }
    focus() {}
    scrollIntoView() {}
  }
  const elements = new Map()
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, new Element(id))
    return elements.get(id)
  }
  const names = ['overview', 'containers', 'logs', 'status-codes', 'alerts', 'playbooks', 'error-codes', 'not-found']
  const views = names.map((name) => element('view-' + name))
  const links = names.slice(0, -1).map((name) => { const link = new Element(); link.dataset.viewLink = name; return link })
  const sources = []
  class EventSource {
    constructor(url) { this.url = url; this.closed = false; sources.push(this) }
    addEventListener() {}
    close() { this.closed = true }
  }
  const document = {
    getElementById: element,
    createElement: () => new Element(),
    querySelectorAll: (selector) => selector === '.view' ? views : selector === '[data-view-link]' ? links : [],
  }
  let hash = ''
  const window = { location: { get hash() { return hash }, set hash(value) { hash = value && !value.startsWith('#') ? '#' + value : value } } }
  const source = (await fs.readFile(new URL('../src/public/app.js', import.meta.url), 'utf8'))
    .replace(/^import [^\n]*\n/gm, '')
    .replace(/^void init\(\)\s*$/m, 'globalThis.ui = { state, showView, appendLog, renderOverview, focusAlert, selectContainer, renderStatusCodes, openActionReview, renderActionHistory, renderReports, openRecordConfirmation }')
  const context = vm.createContext({ document, window, EventSource, summarizeMetrics, formatPercent, httpChartData })
  vm.runInContext(source, context)
  return { ui: context.ui, element, links, window, sources }
}

test('통합 화면은 HTTP 상세, 대응 확인과 운영 기록을 제공한다', async () => {
  const { ui, element } = await makeUi()
  ui.renderStatusCodes({ totals: { classCounts: { '1xx': 0, '2xx': 1, '3xx': 0, '4xx': 0, '5xx': 0 } }, services: [{ service: 'backend', total: 1, classCounts: { '5xx': 0 } }], routes: [{ service: 'backend', method: 'GET', route: '/api/health', total: 1 }], correlations: [{ service: 'backend', status: 503, traceId: 'trace-123', deploymentVersion: 'release-7' }] }, true)
  assert.match(element('status-summary').innerHTML, /backend/)
  assert.match(element('status-summary').innerHTML, /\/api\/health/)
  assert.match(element('status-summary').innerHTML, /trace-123/)
  ui.state.catalog = { actions: [{ id: 'diagnose', label: '진단', includeLogs: true }] }
  ui.openActionReview('diagnose', 'OPS-1', { containerName: 'api' }, null)
  assert.equal(element('action-confirm-target').textContent, 'api')
  assert.equal(element('action-confirm-dialog').open, true)
  assert.equal(element('include-logs-option').classList.contains('hidden'), false)
  ui.renderActionHistory([{ at: 0, actionId: 'diagnose', actor: 'operator', code: 'OPS-1', target: 'api', status: 'success' }])
  assert.match(element('action-history').innerHTML, /api/)
  ui.renderReports([{ id: 'report.txt', modifiedAt: 0, sizeBytes: 10 }])
  assert.match(element('report-list').innerHTML, /report.txt/)
  ui.openRecordConfirmation('delete', 'report.txt')
  assert.equal(element('record-confirm-dialog').open, true)
  assert.match(element('record-confirm-description').textContent, /report.txt/)
})

test('메뉴는 해시와 뒤로 가기에 맞춰 화면을 구분한다', async () => {
  const { ui, element, links, window } = await makeUi()
  ui.showView()
  assert.equal(element('view-overview').classList.contains('hidden'), false)
  window.location.hash = '#logs'
  ui.showView()
  assert.equal(element('view-overview').classList.contains('hidden'), true)
  assert.equal(element('view-logs').classList.contains('hidden'), false)
  assert.equal(links[2].attributes['aria-current'], 'page')
  window.location.hash = '#missing'
  ui.showView()
  assert.equal(element('view-not-found').classList.contains('hidden'), false)
})

test('로그 레벨을 구분하고 원문을 안전한 텍스트로 표시하며 500줄을 유지한다', async () => {
  const { ui, element } = await makeUi()
  const output = element('log-output')
  ui.appendLog('INFO [demo] <script>alert(1)</script>')
  ui.appendLog('WARNING [demo] retry')
  ui.appendLog('ERROR [demo] failed')
  assert.equal(output.children[0].className, 'log-line level-info')
  assert.equal(output.children[0].textContent, 'INFO [demo] <script>alert(1)</script>')
  assert.equal(output.children[1].className, 'log-line level-warning')
  assert.equal(output.children[2].className, 'log-line level-error')
  for (let i = 0; i < 510; i++) ui.appendLog('INFO line')
  assert.equal(output.children.length, 500)
})

test('실측 데이터만 표시하고 수집 불가와 실제 0을 구분한다', async () => {
  const { ui, element } = await makeUi()
  ui.state.overview = { observedAt: 1000, dockerAvailable: false, containers: [], alerts: [], statusCodes: null }
  ui.renderOverview()
  assert.equal(element('cpu-total').textContent, '-')
  assert.equal(element('running-count').textContent, '-')
  assert.equal(element('monitor-status-text').textContent, '연결 확인 필요')
  ui.state.overview = {
    observedAt: 2000, dockerAvailable: true, alerts: [],
    containers: [{ id: 'abc', name: 'demo', image: 'node', state: 'running', running: true, stats: { cpuPercent: 0, memoryPercent: 25, memoryUsedBytes: 25, memoryLimitBytes: 100, networkIo: '2kB / 1kB', blockIo: '0B / 0B' } }],
    statusCodes: { totals: { classCounts: { '1xx': 0, '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 } } },
  }
  ui.renderOverview()
  assert.equal(element('cpu-total').textContent, '0.0%')
  assert.equal(element('memory-total').textContent, '25.0%')
  assert.match(element('io-summary').innerHTML, /2kB/)
  ui.state.overview.observedAt = 7000
  ui.state.overview.containers[0].stats.cpuPercent = 5
  ui.renderOverview()
  assert.match(element('resource-history').innerHTML, /polyline/)
})

test('경고 선택은 관련 화면으로 이동하고 대상 표시를 유지한다', async () => {
  const { ui, element, window } = await makeUi()
  ui.state.overview = {
    observedAt: 1000, dockerAvailable: false, containers: [],
    alerts: [{ id: 'OPS-DOCKER-001', code: 'OPS-DOCKER-001', resource: 'Docker 연결', message: '연결 실패' }],
  }
  ui.renderOverview()
  ui.focusAlert('OPS-DOCKER-001')
  assert.equal(window.location.hash, '#overview')
  assert.equal(element('engine-warning').classList.contains('hidden'), false)
  ui.state.overview = {
    observedAt: 2000, dockerAvailable: true, containers: [], statusCodes: null,
    alerts: [{ id: 'http:1', code: 'HTTP-5XX-RATE-001', kind: 'http', resource: 'HTTP' }],
  }
  ui.renderOverview()
  ui.focusAlert('http:1')
  assert.equal(window.location.hash, '#status-codes')
  assert.equal(element('http-warning').classList.contains('hidden'), false)
  assert.equal(element('engine-warning').classList.contains('hidden'), true)
})

test('컨테이너를 바꾸면 이전 로그 스트림을 닫고 선택한 로그로 이동한다', async () => {
  const { ui, element, window, sources } = await makeUi()
  ui.state.overview = {
    observedAt: 1000, dockerAvailable: true, alerts: [], statusCodes: null,
    containers: [
      { id: 'abc', name: 'api', image: 'demo', state: 'running', running: true, stats: null },
      { id: 'def', name: 'worker', image: 'demo', state: 'running', running: true, stats: null },
    ],
  }
  ui.selectContainer('abc')
  assert.match(sources[0].url, /containerId=abc/)
  assert.equal(window.location.hash, '#logs')
  assert.equal(element('logs-title').textContent, '로그 · api')
  ui.selectContainer('def')
  assert.equal(sources[0].closed, true)
  assert.match(sources[1].url, /containerId=def/)
})
