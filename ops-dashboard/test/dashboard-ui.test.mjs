import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import vm from 'node:vm'
import { summarizeMetrics, formatPercent, topContainerMetrics } from '../src/public/metric-display.js'
import { httpChartData, httpResponseDetails, selectHttpContainer } from '../src/public/http-chart.js'

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
      this.markup = ''
      this.textContent = ''
      this.scrollHeight = 0
      this.scrollTop = 0
      this.clientHeight = 0
    }
    setAttribute(key, value) { this.attributes[key] = value }
    removeAttribute(key) { delete this.attributes[key] }
    get innerHTML() { return this.markup }
    set innerHTML(value) {
      this.markup = value
      this.children = []
      if (value === '<div class="container-column"></div><div class="container-column"></div>') {
        for (let index = 0; index < 2; index++) { const column = new Element(); column.className = 'container-column'; this.append(column) }
      }
    }
    contains(target) { return this === target || this.children.some((child) => child.contains(target)) }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
    querySelectorAll(selector) {
      const attribute = selector.match(/^\[data-([a-z-]+)(?:="([^"]*)")?\]$/)
      const key = attribute?.[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
      const matches = (child) => selector.startsWith('.') ? child.className?.split(' ').includes(selector.slice(1)) : attribute ? key in child.dataset && (attribute[2] === undefined || child.dataset[key] === attribute[2]) : false
      return this.children.flatMap((child) => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)])
    }
    append(child) { child.remove(); this.children.push(child); child.parent = this }
    insertBefore(child, reference) { child.remove(); const index = this.children.indexOf(reference); this.children.splice(index < 0 ? this.children.length : index, 0, child); child.parent = this }
    remove() { if (this.parent) { this.parent.children = this.parent.children.filter((child) => child !== this); this.parent = null } }
    insertAdjacentHTML(position, markup) {
      if (markup.startsWith('<section')) {
        const panel = new Element(); panel.className = 'inline-log-panel'
        const button = new Element(); button.dataset.collapseLog = 'collapse'; panel.append(button)
        const output = new Element(); output.dataset.inlineLogOutput = markup.match(/data-inline-log-output="([^"]*)"/)[1]; panel.append(output)
        this.append(panel)
      } else { const line = new Element(); line.markup = markup; this.append(line) }
    }
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
  const names = ['overview', 'containers', 'status-codes', 'playbooks', 'error-codes', 'packages', 'not-found']
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
    querySelector: (selector) => element('container-list').querySelector(selector),
    querySelectorAll: (selector) => selector === '.view' ? views : selector === '[data-view-link]' ? links : [],
  }
  let hash = ''
  const window = { scrollTo() {}, location: { replace(value) { this.hash = value }, get hash() { return hash }, set hash(value) { hash = value && !value.startsWith('#') ? '#' + value : value } } }
  const source = (await fs.readFile(new URL('../src/public/app.js', import.meta.url), 'utf8'))
    .replace(/^import [^\n]*\n/gm, '')
    .replace(/^void init\(\)\s*$/m, 'globalThis.ui = { state, renderHistory, containerKind, groupContainerKinds, showView, logLineMarkup, appendContainerLog, renderOverview, renderContainers, renderAlerts, renderActions, focusAlert, toggleContainerLogs, renderStatusCodes, openActionReview, renderActionHistory, renderReports, openRecordConfirmation }')
  const context = vm.createContext({ document, window, EventSource, CSS: { escape: (value) => value }, summarizeMetrics, formatPercent, topContainerMetrics, httpChartData, httpResponseDetails, selectHttpContainer })
  vm.runInContext(source, context)
  return { ui: context.ui, element, links, window, sources }
}

test('PC 추이 그래프는 기본 두 지표와 CPU·메모리 개별 선택을 제공한다', async () => {
  const { ui, element } = await makeUi()
  ui.state.history = [{ at: 1000, cpu: 20, memory: 30 }, { at: 6000, cpu: 25, memory: 35 }]
  for (const [filter, cpu, memory] of [['both', true, true], ['cpu', true, false], ['memory', false, true]]) {
    ui.state.historyFilter = filter
    ui.renderHistory()
    assert.equal(element('resource-history').innerHTML.includes('stroke="var(--accent)"'), cpu)
    assert.equal(element('resource-history').innerHTML.includes('stroke="var(--memory)"'), memory)
  }
  assert.equal(ui.containerKind({name:'rm-contract-risk-frontend'}).type, '프론트엔드')
  assert.equal(ui.containerKind({name:'rm-contract-risk-backend'}).type, '백엔드')
  assert.equal(ui.containerKind({name:'unknown'}).type, '미분류')
})

test('컨테이너 구성은 종류별로 전체 개수와 실행·중지 수를 빠짐없이 나눈다', async () => {
  const {ui} = await makeUi()
  const containers = [
    {id:'a',name:'rm-contract-risk-backend',running:true},
    {id:'b',name:'rm-contract-risk-backend-2',running:false},
    {id:'c',name:'rm-contract-risk-frontend',running:true},
    {id:'d',name:'unclassified',running:false},
  ]
  const groups = ui.groupContainerKinds(containers)
  assert.equal(groups.reduce((total,group)=>total+group.items.length,0),4)
  assert.equal(groups.find(group=>group.type==='백엔드').items.length,2)
  assert.equal(groups.find(group=>group.type==='백엔드').runningCount,1)
  assert.equal(groups.find(group=>group.type==='프론트엔드').items.length,1)
  assert.equal(groups.find(group=>group.type==='미분류').items[0].id,'d')
})

test('통합 화면은 HTTP 상세, 대응 확인과 운영 기록을 제공한다', async () => {
  const { ui, element } = await makeUi()
  ui.state.httpResponseCode = 503
  ui.renderStatusCodes({ totals: { classCounts: { '1xx': 0, '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 1 }, counts: {503:1} }, containers: [{ name: 'backend', counts: {503:1} }], routes: [{ service: 'backend', method: 'GET', route: '/api/health', counts: {503:1} }], correlations: [{ containerName: 'backend', status: 503, traceId: 'trace-123' }] }, true)
  assert.match(element('http-response-detail').innerHTML, /backend/)
  assert.match(element('http-response-detail').innerHTML, /\/api\/health/)
  assert.match(element('http-response-detail').innerHTML, /trace-123/)
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
  window.location.hash = '#status-codes'
  ui.showView()
  assert.equal(element('view-overview').classList.contains('hidden'), true)
  assert.equal(element('view-status-codes').classList.contains('hidden'), false)
  assert.equal(links[2].attributes['aria-current'], 'page')
  window.location.hash = '#alerts'
  ui.showView()
  assert.equal(window.location.hash, '#overview')
  ui.showView()
  assert.equal(element('view-overview').classList.contains('hidden'), false)
  window.location.hash = '#missing'
  ui.showView()
  assert.equal(element('view-not-found').classList.contains('hidden'), false)
})

test('로그 레벨과 원문 이스케이프를 유지하고 열린 스트림은 500줄로 제한한다', async () => {
  const { ui, element } = await makeUi()
  assert.match(ui.logLineMarkup('INFO <script>'), /level-info.*&lt;script&gt;/)
  assert.match(ui.logLineMarkup('WARNING retry'), /level-warning/)
  assert.match(ui.logLineMarkup('ERROR failed'), /level-error/)
  ui.state.overview = { dockerAvailable: true, containers: [{ id: 'abc', name: 'api', running: true }], alerts: [] }
  ui.toggleContainerLogs('abc')
  const output = element('container-list').querySelector('[data-inline-log-output="abc"]')
  for (let i = 0; i < 510; i++) ui.appendContainerLog('abc', 'INFO line')
  assert.equal(output.children.length, 500)
  assert.equal(ui.state.containerLogLines.get('abc').length, 500)
})

test('실측 데이터만 표시하고 수집 불가와 실제 0을 구분한다', async () => {
  const { ui, element } = await makeUi()
  ui.state.overview = { observedAt: 1000, dockerAvailable: false, containers: [], alerts: [], statusCodes: null }
  ui.renderOverview()
  assert.match(element('cpu-ranking').innerHTML, /확인할 수 없습니다/)
  assert.match(element('container-counts').textContent, /확인할 수 없습니다/)
  assert.equal(element('monitor-status-text').textContent, '연결 확인 필요')
  ui.state.overview = {
    observedAt: 2000, dockerAvailable: true, alerts: [],
    containers: [{ id: 'abc', name: 'demo', image: 'node', state: 'running', running: true, stats: { cpuPercent: 0, memoryPercent: 25, memoryUsedBytes: 25, memoryLimitBytes: 100, networkIo: '2kB / 1kB', blockIo: '0B / 0B' } }],
    statusCodes: { totals: { classCounts: { '1xx': 0, '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 } } },
  }
  ui.renderOverview()
  assert.match(element('cpu-ranking').innerHTML, /0.0%/)
  assert.match(element('memory-ranking').innerHTML, /25 B/)
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

test('좌우 컨테이너 로그는 독립적으로 열리고 갱신 시 로그 DOM과 스크롤을 보존한다', async () => {
  const { ui, element, window, sources } = await makeUi()
  ui.state.overview = {
    observedAt: 1000, dockerAvailable: true, alerts: [], statusCodes: null,
    containers: [
      { id: 'abc', name: 'api', image: 'demo', state: 'running', running: true, stats: null },
      { id: 'def', name: 'worker', image: 'demo', state: 'running', running: true, stats: null },
    ],
  }
  ui.toggleContainerLogs('abc')
  assert.match(sources[0].url, /containerId=abc/)
  const originalOutput = element('container-list').querySelector('[data-inline-log-output="abc"]')
  originalOutput.scrollTop = 37
  ui.toggleContainerLogs('def')
  assert.equal(sources[0].closed, false)
  assert.match(sources[1].url, /containerId=def/)
  assert.equal(window.location.hash, '')
  ui.renderOverview()
  assert.equal(element('container-list').querySelector('[data-inline-log-output="abc"]'), originalOutput)
  assert.equal(originalOutput.scrollTop, 37)
  const columns = element('container-list').querySelectorAll('.container-column')
  assert.equal(columns[0].children[0].dataset.containerEntry, 'abc')
  assert.equal(columns[1].children[0].dataset.containerEntry, 'def')
  ui.toggleContainerLogs('abc')
  assert.equal(sources[0].closed, true)
  assert.equal(sources[1].closed, false)
  assert.equal(ui.state.expandedContainerLogs.has('def'), true)
})

test('운영 현황에서 대응 스크립트는 관련 활성 경고에만 실행 버튼을 제공한다', async () => {
  const { ui, element } = await makeUi()
  ui.state.catalog = { codes: [], actions: [
    { id: 'collect-incident', label: '진단', codes: ['HTTP-5XX-RATE-001'] },
    { id: 'check-docker-access', label: 'Docker 점검', codes: ['OPS-DOCKER-001'] },
  ] }
  ui.renderActions([])
  assert.equal((element('overview-actions').innerHTML.match(/ disabled/g) || []).length, 2)
  const alerts = [{ id: 'http:1', code: 'HTTP-5XX-RATE-001', containerName: 'api' }]
  ui.renderAlerts(alerts, true)
  ui.renderActions(alerts)
  const markup = element('overview-actions').innerHTML
  assert.match(markup, /is-ready/)
  assert.match(markup, /data-action-id="collect-incident" data-alert-id="http:1"[^>]*>검토 후 실행/)
  assert.equal((markup.match(/ disabled/g) || []).length, 1)
  assert.match(element('alert-preview').innerHTML, /api/)
})

test('활성 경고 전용 메뉴와 페이지는 제거하고 운영 현황에 조치를 둔다', async () => {
  const html = await fs.readFile(new URL('../src/public/index.html', import.meta.url), 'utf8')
  assert.doesNotMatch(html, /href="#alerts"|id="view-alerts"|id="alerts-list"/)
  assert.match(html, /id="overview-actions"/)
  assert.match(html, /id="overview-action-result"/)
  assert.doesNotMatch(html, /id="http-container-filter"/)
  assert.match(html, /id="http-response-detail"/)
})

test('HTTP 막대 옆에 실제 코드 구성과 출처를 표시하고 HTML은 이스케이프한다', async () => {
  const { ui, element } = await makeUi()
  ui.state.httpCodes = [{ code: 302, description: 'Found' }, { code: 304, description: 'Not Modified' }]
  ui.state.httpResponseCode = 302
  ui.renderStatusCodes({ totals: { classCounts: { '1xx': 0, '2xx': 0, '3xx': 2, '4xx': 0, '5xx': 0 }, counts: { 302: 1, 304: 1 } }, containers: [{ name: '<script>api</script>', total: 2, counts: { 302: 1, 304: 1 }, classCounts: { '5xx': 0 } }] }, true)
  const markup = element('status-summary').innerHTML + element('http-response-detail').innerHTML
  assert.match(markup, /data-http-code="302"/)
  assert.match(markup, /data-http-code="304"/)
  assert.match(markup, /Found/)
  assert.match(markup, /&lt;script&gt;api&lt;\/script&gt;/)
  assert.doesNotMatch(markup, /<script>/)
  assert.doesNotMatch(element('status-summary').innerHTML, /api&lt;/)
})
