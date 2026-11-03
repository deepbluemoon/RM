import { summarizeMetrics, formatPercent } from './metric-display.js'
import { httpChartData } from './http-chart.js'

const state = { overview: null, catalog: null, selectedId: null, logSource: null, alertPopoverOpen: false, highlightedAlertId: null, uiError: null }
const $ = (id) => document.getElementById(id)

function showView() {
  const hash = window.location.hash.slice(1)
  const view = ['activity', 'logs', 'playbooks', 'error-codes'].includes(hash) ? 'activity' : 'overview'
  $('overview').classList.toggle('hidden', view !== 'overview')
  $('activity').classList.toggle('hidden', view !== 'activity')
  $('page-title').textContent = view === 'overview' ? '운영 현황' : '로그 · 대응'
  document.querySelectorAll('[data-view-link]').forEach((link) => {
    const active = link.dataset.viewLink === view
    link.classList.toggle('active', active)
    if (active) link.setAttribute('aria-current', 'page')
    else link.removeAttribute('aria-current')
  })
  if (hash === 'error-codes' && !$('error-codes').open) $('error-codes').showModal()
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(seconds))
  if (total >= 3600) return `${Math.floor(total / 3600)}시간 ${Math.floor(total % 3600 / 60)}분`
  if (total >= 60) return `${Math.floor(total / 60)}분 ${total % 60}초`
  return `${total}초`
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char])
}

function renderOverview() {
  const overview = state.overview
  if (!overview) return
  const containers = overview.dockerAvailable ? (overview.containers || []) : []
  const metrics = summarizeMetrics(overview)
  $('running-count').textContent = metrics.running === null ? '-' : String(metrics.running)
  $('total-count').textContent = metrics.total === null ? '-' : String(metrics.total)
  $('alert-count').textContent = String(overview.alerts?.length || 0)
  $('cpu-total').textContent = formatPercent(metrics.cpu, '-')
  $('memory-total').textContent = formatPercent(metrics.memory, '-')
  $('last-updated').textContent = new Date(overview.observedAt).toLocaleTimeString('ko-KR')
  $('connection-label').textContent = overview.dockerAvailable ? 'Docker 연결됨' : 'Docker 연결 오류'
  $('connection-label').previousElementSibling.style.background = overview.dockerAvailable ? '#29cccc' : '#ff6b78'
  $('sidebar-engine').textContent = overview.dockerAvailable ? 'Docker connected' : 'Docker unavailable'
  $('sidebar-engine-dot').className = `engine-dot ${overview.dockerAvailable ? 'is-online' : 'is-offline'}`
  $('scope-label').textContent = overview.scope ? `${String(overview.scope).toUpperCase()} SCOPE` : 'PROJECT SCOPE'
  renderAlerts(overview.alerts || [])
  renderStatusCodes(overview.statusCodes, overview.dockerAvailable)
  renderContainers(containers, overview.alerts || [], overview.dockerAvailable)
  renderActions(overview.alerts || [])
  renderAlertTarget(overview.alerts || [])
}

function renderAlerts(alerts) {
  const list = $('alerts-list')
  const popover = $('alerts-popover')
  const toggle = $('alert-toggle')
  popover.classList.toggle('hidden', !state.alertPopoverOpen)
  toggle.setAttribute('aria-expanded', String(state.alertPopoverOpen))
  if (state.uiError) {
    list.innerHTML = `<div class="empty">대시보드 데이터를 불러오지 못했습니다.<br />${escapeHtml(state.uiError)}</div>`
    return
  }
  if (!alerts.length) {
    list.innerHTML = '<div class="alert-nominal">활성 경고가 없습니다.</div>'
    return
  }
  list.innerHTML = alerts.map((alert) => `<button class="alert-card${state.highlightedAlertId === alert.id ? ' is-highlighted' : ''}" data-alert-id="${escapeHtml(alert.id)}" type="button">
    <span class="alert-card-top"><strong>${escapeHtml(alert.code)}</strong><span class="alert-resource">${escapeHtml(alert.resource)}</span></span>
    <span class="alert-message">${escapeHtml(alert.message || `${alert.containerName || alert.containerId} · ${formatDuration(alert.durationSec)} 지속`)}</span>
  </button>`).join('')
  list.querySelectorAll('[data-alert-id]').forEach((button) => button.addEventListener('click', () => focusAlert(button.dataset.alertId)))
}

function renderAlertTarget(alerts) {
  const activeAlert = alerts.find((alert) => alert.id === state.highlightedAlertId)
  if (!activeAlert) state.highlightedAlertId = null
  $('engine-warning-lamp').classList.toggle('hidden', !activeAlert || activeAlert.code !== 'OPS-DOCKER-001')
  $('http-warning-lamp').classList.toggle('hidden', !activeAlert || activeAlert.kind !== 'http')
  document.querySelectorAll('.container-row').forEach((row) => {
    const targeted = Boolean(activeAlert && activeAlert.kind !== 'http' && activeAlert.code !== 'OPS-DOCKER-001' && row.dataset.containerId === activeAlert.containerId)
    row.classList.toggle('is-alert-target', targeted)
    const lamp = row.querySelector('.row-warning-lamp')
    if (lamp) lamp.classList.toggle('hidden', !targeted)
  })
}

function focusAlert(alertId) {
  const alert = state.overview?.alerts?.find((item) => item.id === alertId)
  if (!alert) return
  state.highlightedAlertId = alert.id
  state.alertPopoverOpen = false
  renderOverview()
  $('alert-toggle').focus()
  if (alert.containerId && alert.kind !== 'http') {
    const row = [...document.querySelectorAll('.container-row')].find((item) => item.dataset.containerId === alert.containerId)
    const list = row?.closest('.container-list')
    if (row && list) {
      const rowTop = row.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop
      list.scrollTop = Math.max(0, rowTop - (list.clientHeight - row.clientHeight) / 2)
    }
  }
}

function renderStatusCodes(statusState, dockerAvailable) {
  const chart = httpChartData(statusState, dockerAvailable)
  const target = $('status-summary')
  if (chart.state === 'unavailable') { target.innerHTML = '<div class="empty">HTTP 응답을 수집할 수 없습니다.</div>'; return }
  if (chart.state === 'empty') { target.innerHTML = '<div class="empty">수집된 HTTP 응답이 없습니다.</div>'; return }
  target.innerHTML = `${chart.state === 'partial' ? '<p class="status-chart-note">일부 로그를 수집하지 못했습니다. 아래 수치는 확인된 응답만 포함합니다.</p>' : ''}<p class="status-chart-note">최근 수집된 로그에서 확인된 응답 ${chart.total}건</p>${chart.bars.map(({ label, count, percent }) => `<div class="status-chart-row status-${label}"><span>${label.toUpperCase()}</span><div class="status-chart-track" aria-hidden="true"><span style="width:${percent}%"></span></div><strong>${count}건</strong></div>`).join('')}`
}

function renderContainers(containers, alerts, dockerAvailable) {
  const lists = [$('container-list'), $('activity-container-list')]
  if (!dockerAvailable) { lists.forEach((list) => { list.innerHTML = '<div class="empty">Docker 연결을 확인해 주세요.</div>' }); return }
  if (!containers.length) { lists.forEach((list) => { list.innerHTML = '<div class="empty">표시할 컨테이너가 없습니다.</div>' }); return }
  const rows = containers.map((container) => {
    const stats = container.stats
    const ownAlerts = alerts.filter((alert) => alert.containerId === container.id)
    const selected = state.selectedId === container.id ? ' selected' : ''
    return `<button class="container-row${selected}" data-container-id="${escapeHtml(container.id)}" type="button" aria-pressed="${Boolean(selected)}">
      <span class="container-identity"><strong class="container-name" title="${escapeHtml(container.name)}">${escapeHtml(container.name)}</strong><small class="container-image" title="${escapeHtml(container.image)}">${escapeHtml(container.image)}</small></span>
      <span class="status${container.running ? '' : ' stopped'}">${container.running ? '실행 중' : '중지'}</span>
      <span class="container-metric"><small>CPU</small><b>${formatPercent(stats?.cpuPercent, '-')}</b></span>
      <span class="container-metric"><small>MEM</small><b>${formatPercent(stats?.memoryPercent, '-')}</b></span>
      ${ownAlerts.length ? `<span class="row-alert">경고 ${ownAlerts.length}</span><span class="warning-lamp row-warning-lamp hidden" aria-label="선택한 경고 대상">!</span>` : ''}
    </button>`
  }).join('')
  lists.forEach((list) => {
    list.innerHTML = rows
    list.querySelectorAll('[data-container-id]').forEach((row) => row.addEventListener('click', () => selectContainer(row.dataset.containerId)))
  })
}

function renderActions(alerts) {
  const activeCodes = new Set(alerts.map((alert) => alert.code))
  $('actions-list').innerHTML = (state.catalog?.actions || []).map((action) => {
    const alert = alerts.find((item) => activeCodes.has(item.code) && action.codes.includes(item.code))
    const code = alert?.code
    const blocked = action.id === 'scale-service' && alert?.stateful
    const enabled = Boolean(code) && !blocked
    const note = blocked ? 'MariaDB는 데이터 일관성을 위해 자동 수평 확장을 차단했습니다.' : enabled ? '활성 경고에 대응할 수 있습니다.' : '대응 가능한 활성 오류가 없습니다.'
    return `<div class="action-card${enabled ? ' is-enabled' : ''}"><div><strong>${escapeHtml(action.label)}</strong><small>${escapeHtml(note)}</small>${code ? `<div class="action-code">${escapeHtml(code)}</div>` : ''}</div><button type="button" data-action-id="${escapeHtml(action.id)}" data-code="${escapeHtml(code || '')}" ${enabled ? '' : 'disabled'}>${enabled ? '실행' : blocked ? '차단됨' : '대기 중'}</button></div>`
  }).join('')
  $('actions-list').querySelectorAll('button:not([disabled])').forEach((button) => button.addEventListener('click', () => runAction(button.dataset.actionId, button.dataset.code, alerts.find((alert) => alert.code === button.dataset.code))))
}

async function runAction(actionId, code, alert) {
  if (!window.confirm(`${code} 대응 스크립트를 실행할까요?\n대상: ${alert?.containerName || '운영 환경'}`)) return
  const response = await fetch('/api/actions/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actionId, code }) })
  const result = await response.json()
  window.alert(response.ok ? `실행 완료\n${result.output || ''}` : `실행하지 못했습니다\n${result.error || '알 수 없는 오류'}`)
  await refresh()
}

function appendLog(line) {
  const output = $('log-output')
  const follow = output.scrollHeight - output.scrollTop - output.clientHeight < 40
  if (output.querySelector('.log-empty')) output.innerHTML = ''
  const item = document.createElement('div')
  item.className = 'log-line'
  item.textContent = line
  output.append(item)
  while (output.children.length > 500) output.firstElementChild.remove()
  if (follow) output.scrollTop = output.scrollHeight
}

function selectContainer(containerId) {
  state.selectedId = containerId
  if (state.logSource) state.logSource.close()
  $('logs-title').textContent = '로그 · ' + (state.overview.containers.find((item) => item.id === containerId)?.name || containerId)
  $('log-output').innerHTML = '<div class="log-empty"><span>⌁</span><p>로그 스트림에 연결하는 중…</p></div>'
  state.logSource = new EventSource(`/api/logs/stream?containerId=${encodeURIComponent(containerId)}&tail=200`)
  state.logSource.onmessage = (event) => appendLog(JSON.parse(event.data).line)
  state.logSource.addEventListener('error', () => appendLog('[stream] 로그 연결이 종료되었습니다.'))
  renderOverview()
  if (window.location.hash !== '#activity') window.location.hash = 'activity'
}

async function refresh() {
  const response = await fetch('/api/overview', { cache: 'no-store' })
  if (!response.ok) throw new Error(`요약 정보를 불러오지 못했습니다 (${response.status})`)
  state.overview = await response.json()
  state.uiError = null
  renderOverview()
}

async function init() {
  showView()
  window.addEventListener('hashchange', showView)
  state.catalog = await fetch('/api/error-codes').then((response) => response.json())
  $('codes-list').innerHTML = state.catalog.codes.map((item) => `<article class="code-item"><code>${escapeHtml(item.code)}</code><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.trigger)}<br />대응: ${escapeHtml(item.response)}</p></article>`).join('')
  $('alert-toggle').addEventListener('click', () => { state.alertPopoverOpen = !state.alertPopoverOpen; renderAlerts(state.overview?.alerts || []) })
  $('close-alerts').addEventListener('click', () => { state.alertPopoverOpen = false; renderAlerts(state.overview?.alerts || []); $('alert-toggle').focus() })
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.alertPopoverOpen) { state.alertPopoverOpen = false; renderAlerts(state.overview?.alerts || []); $('alert-toggle').focus() }
  })
  $('open-error-codes').addEventListener('click', () => $('error-codes').showModal())
  $('close-error-codes').addEventListener('click', () => $('error-codes').close())
  $('error-codes').addEventListener('click', (event) => { if (event.target === $('error-codes')) $('error-codes').close() })
  $('clear-logs').addEventListener('click', () => { $('log-output').innerHTML = '<div class="log-empty"><span>⌁</span><p>로그를 선택하세요.</p></div>' })
  $('refresh-now').addEventListener('click', () => { void refresh().catch(() => {}) })
  await refresh()
  setInterval(() => { void refresh().catch(() => {}) }, 5_000)
}

void init().catch((error) => {
  state.uiError = error instanceof Error ? error.message : String(error)
  $('connection-label').textContent = '대시보드 연결 오류'
  $('alert-count').textContent = '확인 필요'
  $('alert-toggle').setAttribute('aria-label', '대시보드 오류 상세 보기')
  renderAlerts([])
})
