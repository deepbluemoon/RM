import { summarizeMetrics, formatPercent } from './metric-display.js'
import { httpChartData } from './http-chart.js'

const state = { overview: null, catalog: null, selectedId: null, logSource: null, history: [], lastSample: null, highlightedAlertId: null }
const $ = (id) => document.getElementById(id)
const viewNames = { overview: '운영 현황', containers: '컨테이너', logs: '실시간 로그', 'status-codes': 'HTTP 응답', alerts: '활성 경고', playbooks: '오류 대응', 'error-codes': '오류 코드' }

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char])
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  if (total >= 3600) return Math.floor(total / 3600) + '시간 ' + Math.floor(total % 3600 / 60) + '분'
  if (total >= 60) return Math.floor(total / 60) + '분 ' + total % 60 + '초'
  return total + '초'
}

function showView() {
  const requested = window.location.hash.slice(1) || 'overview'
  const view = Object.hasOwn(viewNames, requested) ? requested : 'not-found'
  document.querySelectorAll('.view').forEach((section) => section.classList.toggle('hidden', section.id !== 'view-' + view))
  document.querySelectorAll('[data-view-link]').forEach((link) => {
    const active = link.dataset.viewLink === view
    link.classList.toggle('active', active)
    if (active) link.setAttribute('aria-current', 'page')
    else link.removeAttribute('aria-current')
  })
  $('page-title').textContent = viewNames[view] || '화면을 찾을 수 없음'
  $('main-content').scrollTop = 0
}

function recordSample(overview, metrics) {
  const observed = Number(overview.observedAt)
  if (!Number.isFinite(observed) || state.lastSample === observed) return
  state.lastSample = observed
  state.history.push({ at: observed, cpu: metrics.cpu, memory: metrics.memory })
  state.history = state.history.filter((sample) => sample.at >= observed - 300000).slice(-61)
}

function renderGauge(key, value) {
  $(key + '-gauge-value').textContent = formatPercent(value, '-')
  $(key + '-gauge').style.strokeDasharray = Number.isFinite(value) ? Math.max(0, Math.min(value, 100)) + ' 100' : '0 100'
}

function renderHistory() {
  const samples = state.history
  const target = $('resource-history')
  const available = samples.filter((sample) => Number.isFinite(sample.cpu) || Number.isFinite(sample.memory))
  if (available.length < 2) {
    target.innerHTML = '<div class="chart-empty">' + (available.length ? '추이 데이터를 모으는 중입니다.' : '수집된 지표가 없습니다.') + '</div>'
    return
  }
  const max = Math.max(100, ...available.flatMap((sample) => [sample.cpu, sample.memory].filter(Number.isFinite)))
  const last = samples[samples.length - 1].at
  const first = Math.max(last - 300000, samples[0].at)
  const span = Math.max(last - first, 1)
  const lines = (key, color) => {
    let segment = []
    const groups = []
    for (const sample of samples) {
      if (!Number.isFinite(sample[key])) {
        if (segment.length > 1) groups.push(segment.join(' '))
        segment = []
        continue
      }
      const x = 34 + (sample.at - first) / span * 552
      const y = 126 - sample[key] / max * 110
      segment.push(x.toFixed(1) + ',' + y.toFixed(1))
    }
    if (segment.length > 1) groups.push(segment.join(' '))
    return groups.map((points) => '<polyline class="history-line" stroke="' + color + '" points="' + points + '"/>').join('')
  }
  const grid = [0, 0.5, 1].map((ratio) => {
    const y = 126 - ratio * 110
    return '<line class="history-grid" x1="34" y1="' + y + '" x2="586" y2="' + y + '"/><text class="history-axis" x="0" y="' + (y + 3) + '">' + Math.round(max * ratio) + '%</text>'
  }).join('')
  target.innerHTML = '<svg viewBox="0 0 600 146" preserveAspectRatio="none" role="img" aria-label="페이지를 연 이후 수집한 CPU 및 메모리 사용 추이">' + grid + lines('cpu', '#39d9e5') + lines('memory', '#a27aff') + '</svg>'
}

function renderOverview() {
  const overview = state.overview
  if (!overview) return
  const containers = overview.dockerAvailable ? (overview.containers || []) : []
  const metrics = summarizeMetrics(overview)
  $('running-count').textContent = metrics.running === null ? '-' : String(metrics.running)
  $('total-count').textContent = metrics.total === null ? '-' : String(metrics.total)
  $('alert-count').textContent = String(overview.alerts?.length || 0)
  $('nav-alert-count').textContent = String(overview.alerts?.length || 0)
  $('cpu-total').textContent = formatPercent(metrics.cpu, '-')
  $('memory-total').textContent = formatPercent(metrics.memory, '-')
  $('last-updated').textContent = new Date(overview.observedAt).toLocaleTimeString('ko-KR')
  $('connection-label').textContent = overview.dockerAvailable ? 'Docker 연결됨' : 'Docker 연결 오류'
  $('connection-label').previousElementSibling.style.background = overview.dockerAvailable ? 'var(--green)' : 'var(--red)'
  $('sidebar-engine').textContent = overview.dockerAvailable ? 'Docker connected' : 'Docker unavailable'
  $('sidebar-engine-dot').className = 'engine-dot ' + (overview.dockerAvailable ? 'is-online' : 'is-offline')
  $('scope-label').textContent = overview.scope ? String(overview.scope).toUpperCase() + ' SCOPE' : 'CONTAINER MONITOR'
  $('monitor-status').classList.toggle('is-offline', !overview.dockerAvailable)
  $('monitor-status-text').textContent = overview.dockerAvailable ? 'LIVE MONITORING' : '연결 확인 필요'
  $('error-banner').classList.add('hidden')
  recordSample(overview, metrics)
  renderGauge('cpu', metrics.cpu)
  renderGauge('memory', metrics.memory)
  renderHistory()
  renderAlerts(overview.alerts || [], overview.dockerAvailable)
  renderStatusCodes(overview.statusCodes, overview.dockerAvailable)
  renderContainers(containers, overview.alerts || [], overview.dockerAvailable)
  renderAlertTarget(overview.alerts || [])
  renderIo(containers, overview.dockerAvailable)
  renderActions(overview.alerts || [])
}

function renderAlerts(alerts, dockerAvailable) {
  const list = $('alerts-list')
  const preview = $('alert-preview')
  if (!alerts.length) {
    const message = dockerAvailable ? '현재 활성 경고가 없습니다.' : '경고 정보를 확인할 수 없습니다.'
    list.innerHTML = '<div class="alert-nominal">' + message + '</div>'
    preview.innerHTML = '<div class="alert-nominal">' + message + '</div>'
    return
  }
  list.innerHTML = alerts.map((alert) => {
    const details = alert.message || ((alert.containerName || alert.containerId || alert.resource) + ' · ' + formatDuration(alert.durationSec) + ' 지속')
    return '<button type="button" class="alert-card" data-alert-id="' + escapeHtml(alert.id) + '"><span class="alert-card-top"><strong>' + escapeHtml(alert.code) + '</strong><span class="alert-resource">' + escapeHtml(alert.resource) + '</span></span><p>' + escapeHtml(details) + '</p></button>'
  }).join('')
  list.querySelectorAll('[data-alert-id]').forEach((button) => button.addEventListener('click', () => focusAlert(button.dataset.alertId)))
  preview.innerHTML = alerts.slice(0, 3).map((alert) => '<div class="compact-alert"><strong>' + escapeHtml(alert.code) + '</strong><span>' + escapeHtml(alert.containerName || alert.resource) + '</span></div>').join('')
}

function renderAlertTarget(alerts) {
  const alert = alerts.find((item) => item.id === state.highlightedAlertId)
  if (!alert) state.highlightedAlertId = null
  const dockerTarget = Boolean(alert && alert.code === 'OPS-DOCKER-001')
  $('engine-card').classList.toggle('is-alert-target', dockerTarget)
  $('engine-warning').classList.toggle('hidden', !dockerTarget)
  $('http-warning').classList.toggle('hidden', !alert || alert.kind !== 'http')
  document.querySelectorAll('#container-list [data-container-id]').forEach((row) => {
    row.classList.toggle('is-alert-target', Boolean(alert && alert.kind !== 'http' && alert.containerId && row.dataset.containerId === alert.containerId))
  })
}

function focusAlert(alertId) {
  const alert = state.overview?.alerts?.find((item) => item.id === alertId)
  if (!alert) return
  state.highlightedAlertId = alert.id
  window.location.hash = alert.code === 'OPS-DOCKER-001' ? 'overview' : alert.kind === 'http' ? 'status-codes' : 'containers'
  renderOverview()
  showView()
  if (alert.containerId && alert.kind !== 'http') {
    const row = [...document.querySelectorAll('#container-list [data-container-id]')].find((item) => item.dataset.containerId === alert.containerId)
    row?.focus()
    row?.scrollIntoView({ block: 'nearest' })
  }
}

function renderStatusCodes(statusState, dockerAvailable) {
  const chart = httpChartData(statusState, dockerAvailable)
  const target = $('status-summary')
  if (chart.state === 'unavailable') { target.innerHTML = '<div class="empty">HTTP 응답을 수집할 수 없습니다.</div>'; return }
  if (chart.state === 'empty') { target.innerHTML = '<div class="empty">수집된 HTTP 응답이 없습니다.</div>'; return }
  target.innerHTML = (chart.state === 'partial' ? '<p class="status-chart-note">일부 로그를 수집하지 못해 확인된 응답만 표시합니다.</p>' : '') + '<p class="status-chart-note">최근 수집된 로그에서 확인된 응답 ' + chart.total + '건</p>' + chart.bars.map(({ label, count, percent }) => '<div class="status-chart-row status-' + label + '"><span>' + label.toUpperCase() + '</span><div class="status-chart-track" aria-hidden="true"><span style="width:' + percent + '%"></span></div><strong>' + count + '건</strong></div>').join('')
}

function renderIo(containers, dockerAvailable) {
  const target = $('io-summary')
  const rows = containers.filter((container) => container.stats)
  if (!rows.length) { target.innerHTML = '<div class="empty">' + (dockerAvailable ? '수집된 I/O 데이터가 없습니다.' : 'Docker 연결을 확인해 주세요.') + '</div>'; return }
  target.innerHTML = rows.map((container) => '<div class="io-row"><strong>' + escapeHtml(container.name) + '</strong><span class="io-values"><span>NET RX/TX <b>' + escapeHtml(container.stats.networkIo || '-') + '</b></span><span>DISK R/W <b>' + escapeHtml(container.stats.blockIo || '-') + '</b></span></span></div>').join('')
}

function renderContainers(containers, alerts, dockerAvailable) {
  const list = $('container-list')
  const selector = $('log-container-select')
  selector.innerHTML = '<option value="">컨테이너 선택</option>' + containers.map((container) => '<option value="' + escapeHtml(container.id) + '"' + (container.id === state.selectedId ? ' selected' : '') + '>' + escapeHtml(container.name) + '</option>').join('')
  selector.disabled = !containers.length
  if (!dockerAvailable) { list.innerHTML = '<div class="empty">Docker 연결이 없어 컨테이너 상태를 확인할 수 없습니다.</div>'; return }
  if (!containers.length) { list.innerHTML = '<div class="empty">표시할 컨테이너가 없습니다.</div>'; return }
  list.innerHTML = containers.map((container) => {
    const stats = container.stats
    const ownAlerts = alerts.filter((alert) => alert.containerId === container.id)
    const selected = state.selectedId === container.id ? ' selected' : ''
    const stateName = String(container.state || '').toLowerCase()
    const statusName = String(container.status || '').toLowerCase()
    const danger = ownAlerts.length || statusName.includes('unhealthy')
    const preparing = ['created', 'restarting'].includes(stateName) || statusName.includes('health: starting')
    const status = danger ? '경고' : preparing ? '준비 중' : container.running ? '실행 중' : '중지'
    const statusClass = danger ? ' danger' : preparing ? ' warning' : container.running ? '' : ' stopped'
    const metric = (label, value) => '<div><div class="metric-label"><span>' + label + '</span><span class="metric-value">' + formatPercent(value, '-') + '</span></div>' + (Number.isFinite(value) ? '<div class="bar"><i class="' + (value >= 80 ? 'warn' : '') + '" style="width:' + Math.min(Math.max(value, 0), 100) + '%"></i></div>' : '') + '</div>'
    return '<button class="container-row' + selected + '" data-container-id="' + escapeHtml(container.id) + '" type="button"><div class="row-top"><strong class="container-name">' + escapeHtml(container.name) + '</strong><span class="status' + statusClass + '">' + status + '</span></div><div class="container-id">' + escapeHtml(container.id.slice(0, 12)) + ' · ' + escapeHtml(container.image) + '</div><div class="metrics">' + metric('CPU', stats?.cpuPercent) + metric('MEM', stats?.memoryPercent) + '</div>' + ownAlerts.map((alert) => '<div class="row-alert">' + escapeHtml(alert.message || alert.code) + '</div>').join('') + '</button>'
  }).join('')
  list.querySelectorAll('[data-container-id]').forEach((row) => row.addEventListener('click', () => selectContainer(row.dataset.containerId)))
}

function renderActions(alerts) {
  if (!state.catalog) return
  $('actions-list').innerHTML = (state.catalog?.actions || []).map((action) => {
    const alert = alerts.find((item) => action.codes.includes(item.code))
    const code = alert?.code
    const blocked = action.id === 'scale-service' && alert?.stateful
    const enabled = Boolean(code) && !blocked
    const note = blocked ? 'MariaDB는 데이터 일관성을 위해 자동 수평 확장을 차단했습니다.' : enabled ? '활성 경고에 대응할 수 있습니다.' : '대응 가능한 활성 오류가 없습니다.'
    return '<div class="action-card' + (enabled ? ' is-enabled' : '') + '"><div><strong>' + escapeHtml(action.label) + '</strong><small>' + escapeHtml(note) + '</small>' + (code ? '<div class="action-code">' + escapeHtml(code) + '</div>' : '') + '</div><button type="button" data-action-id="' + escapeHtml(action.id) + '" data-code="' + escapeHtml(code || '') + '"' + (enabled ? '' : ' disabled') + '>' + (enabled ? '실행' : blocked ? '차단됨' : '대기 중') + '</button></div>'
  }).join('')
  $('actions-list').querySelectorAll('button:not([disabled])').forEach((button) => button.addEventListener('click', () => runAction(button.dataset.actionId, button.dataset.code, alerts.find((alert) => alert.code === button.dataset.code))))
}

async function runAction(actionId, code, alert) {
  if (!window.confirm(code + ' 대응 스크립트를 실행할까요?\n대상: ' + (alert?.containerName || '운영 환경'))) return
  try {
    const response = await fetch('/api/actions/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actionId, code }) })
    const result = await response.json()
    window.alert(response.ok ? '실행 완료\n' + (result.output || '') : '실행하지 못했습니다\n' + (result.error || '알 수 없는 오류'))
    await refresh()
  } catch (error) { window.alert('대응 요청 실패: ' + error.message) }
}

function appendLog(line) {
  const output = $('log-output')
  const follow = output.scrollHeight - output.scrollTop - output.clientHeight < 40
  if (output.querySelector('.log-empty')) output.innerHTML = ''
  const item = document.createElement('div')
  const match = String(line).match(/\b(ERROR|FATAL|CRITICAL|WARN(?:ING)?|INFO)\b/i)
  const level = match ? match[1].toUpperCase() : ''
  item.className = 'log-line' + (level === 'INFO' ? ' level-info' : level.startsWith('WARN') ? ' level-warning' : level ? ' level-error' : '')
  item.textContent = line
  output.append(item)
  while (output.children.length > 500) output.firstElementChild.remove()
  if (follow) output.scrollTop = output.scrollHeight
}

function selectContainer(containerId) {
  const container = state.overview?.containers?.find((item) => item.id === containerId)
  if (!container) return
  state.selectedId = containerId
  if (state.logSource) state.logSource.close()
  $('logs-title').textContent = '로그 · ' + container.name
  $('log-output').innerHTML = '<div class="log-empty">로그 스트림에 연결하는 중…</div>'
  state.logSource = new EventSource('/api/logs/stream?containerId=' + encodeURIComponent(containerId) + '&tail=200')
  state.logSource.onmessage = (event) => { try { appendLog(JSON.parse(event.data).line) } catch { appendLog('[stream] 로그 형식을 읽을 수 없습니다.') } }
  state.logSource.addEventListener('error', () => appendLog('[stream] 로그 연결이 종료되었습니다.'))
  renderOverview()
  window.location.hash = 'logs'
}

async function refresh() {
  try {
    const response = await fetch('/api/overview', { cache: 'no-store' })
    if (!response.ok) throw new Error('HTTP ' + response.status)
    state.overview = await response.json()
    renderOverview()
  } catch (error) {
    $('error-banner').classList.remove('hidden')
    $('error-banner').textContent = '대시보드 데이터를 불러오지 못했습니다. ' + error.message
    $('connection-label').textContent = '대시보드 연결 오류'
    $('monitor-status').classList.add('is-offline')
    $('monitor-status-text').textContent = '연결 확인 필요'
    $('sidebar-engine').textContent = 'Dashboard unavailable'
    $('sidebar-engine-dot').className = 'engine-dot is-offline'
    for (const id of ['running-count', 'total-count', 'alert-count', 'nav-alert-count', 'cpu-total', 'memory-total']) $(id).textContent = '-'
    renderGauge('cpu', null)
    renderGauge('memory', null)
  }
}

async function init() {
  showView()
  window.addEventListener('hashchange', showView)
  $('refresh-now').addEventListener('click', () => { void refresh() })
  $('brand-refresh').addEventListener('click', () => window.location.reload())
  $('log-container-select').addEventListener('change', (event) => { if (event.target.value) selectContainer(event.target.value) })
  $('clear-logs').addEventListener('click', () => { $('log-output').innerHTML = '<div class="log-empty">화면에 표시된 로그를 비웠습니다.</div>' })
  try {
    const response = await fetch('/api/error-codes')
    if (!response.ok) throw new Error('HTTP ' + response.status)
    state.catalog = await response.json()
    $('codes-list').innerHTML = state.catalog.codes.map((item) => '<article class="code-item"><code>' + escapeHtml(item.code) + '</code><strong>' + escapeHtml(item.title) + '</strong><p>' + escapeHtml(item.trigger) + '<br />대응: ' + escapeHtml(item.response) + '</p></article>').join('')
  } catch (error) {
    $('codes-list').innerHTML = '<div class="empty">오류 코드 목록을 불러오지 못했습니다.</div>'
    $('actions-list').innerHTML = '<div class="empty">대응 스크립트 목록을 불러오지 못했습니다.</div>'
  }
  await refresh()
  setInterval(() => { void refresh() }, 5000)
}

void init()
