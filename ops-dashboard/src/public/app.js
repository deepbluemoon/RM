import { summarizeMetrics, formatPercent } from './metric-display.js'
import { httpChartData } from './http-chart.js'

const state = { overview: null, catalog: null, selectedId: null, logSource: null, alertPopoverOpen: false, highlightedAlertId: null, uiError: null, summaryOpen: null, metricHistory: [] }
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

function positionSummaryPopover(popover, trigger) {
  if (!trigger) return
  const gridRect = $('summary-grid').getBoundingClientRect()
  const triggerRect = trigger.getBoundingClientRect()
  const popoverWidth = popover.getBoundingClientRect().width
  const maxLeft = Math.max(0, gridRect.width - popoverWidth)
  const left = Math.min(Math.max(0, triggerRect.left - gridRect.left), maxLeft)
  const top = Math.max(0, triggerRect.bottom - gridRect.top + 8)
  popover.style.left = `${left}px`
  popover.style.top = `${top}px`
}

function renderOverview() {
  const overview = state.overview
  if (!overview) return
  const containers = overview.dockerAvailable ? (overview.containers || []) : []
  const metrics = summarizeMetrics(overview)
  $('running-count').textContent = metrics.running === null ? '-' : String(metrics.running)
  $('alert-count').textContent = String(overview.alerts?.length || 0)
  $('cpu-total').textContent = formatPercent(metrics.cpu, '-')
  $('memory-total').textContent = formatPercent(metrics.memory, '-')
  $('last-updated').textContent = new Date(overview.observedAt).toLocaleTimeString('ko-KR')
  $('sidebar-engine').textContent = overview.dockerAvailable ? 'Docker connected' : 'Docker unavailable'
  $('sidebar-engine-dot').className = `engine-dot ${overview.dockerAvailable ? 'is-online' : 'is-offline'}`
  $('scope-label').textContent = overview.scope ? `${String(overview.scope).toUpperCase()} SCOPE` : 'PROJECT SCOPE'
  renderAlerts(overview.alerts || [])
  renderStatusCodes(overview.statusCodes, overview.dockerAvailable)
  renderContainers(containers, overview.alerts || [], overview.dockerAvailable)
  renderSummaryDetail(containers, metrics, overview.dockerAvailable)
  renderActions(overview.alerts || [])
  renderAlertTarget(overview.alerts || [])
}

function recordMetricSample(overview) {
  const metrics = summarizeMetrics(overview)
  state.metricHistory.push({ at: Date.now(), cpu: metrics.cpu, memory: metrics.memory })
  if (state.metricHistory.length > 61) state.metricHistory.shift()
}

function renderMetricGraph(key, color, label) {
  const samples = state.metricHistory.filter((sample) => sample.at >= Date.now() - 5 * 60_000).slice(-61)
  const values = samples.map((sample) => sample[key])
  const finiteValues = values.filter(Number.isFinite)
  if (finiteValues.length < 2) return '<div class="metric-graph-empty">그래프 데이터를 모으는 중</div>'
  const max = Math.max(...finiteValues, 1)
  const segments = []
  let segment = []
  values.forEach((value, index) => {
    if (!Number.isFinite(value)) {
      if (segment.length > 1) segments.push(segment.join(' '))
      segment = []
      return
    }
    const x = 2 + index / Math.max(values.length - 1, 1) * 196
    const y = 43 - value / max * 37
    segment.push(`${x.toFixed(1)},${y.toFixed(1)}`)
  })
  if (segment.length > 1) segments.push(segment.join(' '))
  return `<svg class="metric-graph" viewBox="0 0 200 48" role="img" aria-label="최근 5분 ${label} 사용량 추이"><line x1="2" y1="43.5" x2="198" y2="43.5" />${segments.map((points) => `<polyline points="${points}" style="stroke:${color}" />`).join('')}</svg><div class="metric-graph-range"><span>5분 전</span><span>현재</span></div>`
}

function renderSummaryDetail(containers, metrics, dockerAvailable) {
  const detail = $('summary-detail')
  const content = $('summary-detail-content')
  const title = $('summary-detail-title')
  document.querySelectorAll('[data-summary]').forEach((button) => {
    button.setAttribute('aria-expanded', String(button.dataset.summary === state.summaryOpen))
  })
  detail.classList.toggle('hidden', !state.summaryOpen)
  if (!state.summaryOpen) return
  detail.dataset.summary = state.summaryOpen
  const trigger = [...document.querySelectorAll('[data-summary]')].find((button) => button.dataset.summary === state.summaryOpen)
  positionSummaryPopover(detail, trigger)

  if (state.summaryOpen === 'running') {
    const running = containers.filter((container) => container.running)
    title.textContent = `실행 중인 컨테이너 ${metrics.running ?? '-'}개`
    content.innerHTML = !dockerAvailable
      ? '<div class="metric-graph-empty">Docker 상태를 확인할 수 없습니다.</div>'
      : running.length
        ? `<ul class="summary-container-list">${running.map((container) => { const indicator = getContainerIndicator(container, state.overview?.alerts || []); return `<li><span class="status-lamp ${indicator.className}" aria-hidden="true"></span><span>${escapeHtml(container.name)}</span><small>${indicator.label}</small></li>` }).join('')}</ul>`
        : '<div class="metric-graph-empty">실행 중인 컨테이너가 없습니다.</div>'
    return
  }

  const isCpu = state.summaryOpen === 'cpu'
  const metric = isCpu ? metrics.cpu : metrics.memory
  const label = isCpu ? 'CPU 사용량' : '메모리 사용률'
  const color = isCpu ? 'var(--blue)' : 'var(--pink)'
  title.textContent = label
  content.innerHTML = !dockerAvailable || !Number.isFinite(metric)
    ? '<div class="metric-graph-empty">수집된 사용량 데이터가 없습니다.</div>'
    : `<div class="metric-graph-current">현재 <strong>${formatPercent(metric, '-')}</strong></div>${renderMetricGraph(isCpu ? 'cpu' : 'memory', color, label)}`
}

function getContainerIndicator(container, alerts) {
  const ownAlerts = alerts.filter((alert) => alert.containerId === container.id)
  const dockerState = String(container.state || '').toLowerCase()
  const dockerStatus = String(container.status || '').toLowerCase()
  if (ownAlerts.length || dockerStatus.includes('unhealthy')) return { className: 'is-alert', label: '경고' }
  if (['created', 'restarting'].includes(dockerState) || dockerStatus.includes('health: starting')) {
    return { className: 'is-preparing', label: '준비 중' }
  }
  if (container.running) return { className: 'is-online', label: '실행 중' }
  if (dockerState === 'paused') return { className: 'is-unknown', label: '일시 정지' }
  return { className: 'is-unknown', label: '중지' }
}

function renderAlerts(alerts) {
  const list = $('alerts-list')
  const popover = $('alerts-popover')
  const toggle = $('alert-toggle')
  popover.classList.toggle('hidden', !state.alertPopoverOpen)
  toggle.setAttribute('aria-expanded', String(state.alertPopoverOpen))
  if (state.alertPopoverOpen) positionSummaryPopover(popover, toggle)
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
  const list = $('container-list')
  const selector = $('activity-container-select')
  if (!dockerAvailable) {
    list.innerHTML = '<div class="empty">Docker 연결을 확인해 주세요.</div>'
    selector.innerHTML = ''
    selector.disabled = true
    return
  }
  if (!containers.length) {
    list.innerHTML = '<div class="empty">표시할 컨테이너가 없습니다.</div>'
    selector.innerHTML = ''
    selector.disabled = true
    return
  }
  selector.disabled = false
  selector.innerHTML = containers.map((container) => `<option value="${escapeHtml(container.id)}" ${container.id === state.selectedId ? 'selected' : ''}>${escapeHtml(container.name)}</option>`).join('')
  const rows = containers.map((container) => {
    const stats = container.stats
    const ownAlerts = alerts.filter((alert) => alert.containerId === container.id)
    const indicator = getContainerIndicator(container, alerts)
    const selected = state.selectedId === container.id ? ' selected' : ''
    return `<button class="container-row${selected}" data-container-id="${escapeHtml(container.id)}" type="button" aria-pressed="${Boolean(selected)}">
      <span class="container-identity"><strong class="container-name" title="${escapeHtml(container.name)}">${escapeHtml(container.name)}</strong><small class="container-image" title="${escapeHtml(container.image)}">${escapeHtml(container.image)}</small></span>
      <span class="status ${indicator.className}"><span class="status-lamp" aria-hidden="true"></span>${indicator.label}</span>
      <span class="container-metric"><small>CPU</small><b>${formatPercent(stats?.cpuPercent, '-')}</b></span>
      <span class="container-metric"><small>MEM</small><b>${formatPercent(stats?.memoryPercent, '-')}</b></span>
      ${ownAlerts.length ? `<span class="row-alert">경고 ${ownAlerts.length}</span><span class="warning-lamp row-warning-lamp hidden" aria-label="선택한 경고 대상">!</span>` : ''}
    </button>`
  }).join('')
  list.innerHTML = rows
  list.querySelectorAll('[data-container-id]').forEach((row) => row.addEventListener('click', () => selectContainer(row.dataset.containerId)))
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
  recordMetricSample(state.overview)
  state.uiError = null
  renderOverview()
}

async function init() {
  showView()
  window.addEventListener('hashchange', showView)
  state.catalog = await fetch('/api/error-codes').then((response) => response.json())
  $('codes-list').innerHTML = state.catalog.codes.map((item) => `<article class="code-item"><code>${escapeHtml(item.code)}</code><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.trigger)}<br />대응: ${escapeHtml(item.response)}</p></article>`).join('')
  $('alert-toggle').addEventListener('click', () => { state.alertPopoverOpen = !state.alertPopoverOpen; state.summaryOpen = null; renderOverview() })
  $('close-alerts').addEventListener('click', () => { state.alertPopoverOpen = false; renderAlerts(state.overview?.alerts || []); $('alert-toggle').focus() })
  document.querySelectorAll('[data-summary]').forEach((button) => {
    button.addEventListener('click', () => {
      state.summaryOpen = state.summaryOpen === button.dataset.summary ? null : button.dataset.summary
      state.alertPopoverOpen = false
      renderOverview()
    })
  })
  $('close-summary-detail').addEventListener('click', () => {
    const trigger = document.querySelector(`[data-summary="${state.summaryOpen}"]`)
    state.summaryOpen = null
    renderOverview()
    trigger?.focus()
  })
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    if (state.alertPopoverOpen) { state.alertPopoverOpen = false; renderAlerts(state.overview?.alerts || []); $('alert-toggle').focus() }
    else if (state.summaryOpen) {
      const trigger = document.querySelector(`[data-summary="${state.summaryOpen}"]`)
      state.summaryOpen = null
      renderOverview()
      trigger?.focus()
    }
  })
  $('open-error-codes').addEventListener('click', () => $('error-codes').showModal())
  $('close-error-codes').addEventListener('click', () => $('error-codes').close())
  $('error-codes').addEventListener('click', (event) => { if (event.target === $('error-codes')) $('error-codes').close() })
  $('activity-container-select').addEventListener('change', (event) => { if (event.target.value) selectContainer(event.target.value) })
  $('clear-logs').addEventListener('click', () => { $('log-output').innerHTML = '<div class="log-empty"><span>⌁</span><p>화면에 표시된 로그를 비웠습니다.</p></div>' })
  $('refresh-now').addEventListener('click', () => { void refresh().catch(() => {}) })
  $('brand-refresh').addEventListener('click', () => window.location.reload())
  await refresh()
  setInterval(() => { void refresh().catch(() => {}) }, 5_000)
}

void init().catch((error) => {
  state.uiError = error instanceof Error ? error.message : String(error)
  $('sidebar-engine').textContent = 'Dashboard unavailable'
  $('sidebar-engine-dot').className = 'engine-dot is-offline'
  $('alert-count').textContent = '-'
  $('alert-toggle').setAttribute('aria-label', '대시보드 오류 상세 보기')
  renderAlerts([])
})
