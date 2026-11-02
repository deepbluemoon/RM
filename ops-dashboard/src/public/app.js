import { summarizeMetrics, formatPercent } from './metric-display.js'
import { httpChartData } from './http-chart.js'

const state = { overview: null, catalog: null, selectedId: null, logSource: null }
const $ = (id) => document.getElementById(id)

function formatBytes(bytes) {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** exponent).toFixed(exponent ? 1 : 0)} ${units[exponent]}`
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
  const banner = $('error-banner')
  if (overview.error) { banner.classList.remove('hidden'); banner.innerHTML = `<strong>OPS-DOCKER-001</strong> · ${escapeHtml(overview.error)}` } else banner.classList.add('hidden')
}

function renderAlerts(alerts) {
  const list = $('alerts-list')
  if (!alerts.length) {
    list.innerHTML = '<div class="alert-nominal">현재 활성 경고가 없습니다. 모든 감시 대상이 설정된 임계치 안에 있습니다.</div>'
    return
  }
  list.innerHTML = alerts.map((alert) => `<article class="alert-card">
    <div class="alert-card-top"><strong>${escapeHtml(alert.code)}</strong><span class="alert-resource">${escapeHtml(alert.resource)}</span></div>
    <p><b>${escapeHtml(alert.containerName || alert.containerId)}</b> · ${alert.kind === 'http' ? `${escapeHtml(String(alert.count))}/${escapeHtml(String(alert.total))}건 · ${escapeHtml(String(alert.value))}%` : `${escapeHtml(String(alert.value))}% 사용`} · ${formatDuration(alert.durationSec)} 지속</p>
  </article>`).join('')
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
  if (!dockerAvailable) { list.innerHTML = '<div class="empty">Docker 연결이 없어 컨테이너 상태를 확인할 수 없습니다.</div>'; return }
  if (!containers.length) { list.innerHTML = '<div class="empty">현재 프로젝트 스코프에 일치하는 컨테이너가 없습니다.<br />이미지·이름 prefix 설정을 확인하세요.</div>'; return }
  list.innerHTML = containers.map((container) => {
    const stats = container.stats
    const ownAlerts = alerts.filter((alert) => alert.containerId === container.id)
    const selected = state.selectedId === container.id ? ' selected' : ''
    return `<button class="container-row${selected}" data-container-id="${escapeHtml(container.id)}" type="button">
      <div class="row-top"><span class="container-name" title="${escapeHtml(container.name)}">${escapeHtml(container.name)}</span><span class="status${container.running ? '' : ' stopped'}">${container.running ? 'running' : 'stopped'}</span></div>
      <div class="container-id">${escapeHtml(container.id.slice(0, 12))} · ${escapeHtml(container.image)}</div>
      <div class="metrics"><div><div class="metric-label"><span>CPU</span><span class="metric-value">${formatPercent(stats?.cpuPercent)}</span></div>${stats && Number.isFinite(stats.cpuPercent) ? `<div class="bar"><i class="${stats.cpuPercent >= 80 ? 'warn' : ''}" style="width:${Math.min(Math.max(stats.cpuPercent, 0), 100)}%"></i></div>` : ''}</div><div><div class="metric-label"><span>MEM</span><span class="metric-value">${formatPercent(stats?.memoryPercent)}</span></div>${stats && Number.isFinite(stats.memoryPercent) ? `<div class="bar"><i class="${stats.memoryPercent >= 80 ? 'warn' : ''}" style="width:${Math.min(Math.max(stats.memoryPercent, 0), 100)}%"></i></div>` : ''}</div></div>
      ${ownAlerts.map((alert) => `<div class="row-alert"><b>${escapeHtml(alert.code)}</b> · ${escapeHtml(alert.resource)} ${alert.value}% 이상 · ${formatDuration(alert.durationSec)} 지속</div>`).join('')}
    </button>`
  }).join('')
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
  if (output.querySelector('.log-empty')) output.innerHTML = ''
  const item = document.createElement('div')
  item.className = 'log-line'
  item.textContent = line
  output.append(item)
  while (output.children.length > 500) output.firstElementChild.remove()
  output.scrollTop = output.scrollHeight
}

function selectContainer(containerId) {
  state.selectedId = containerId
  if (state.logSource) state.logSource.close()
  $('logs').classList.remove('hidden')
  $('container-workspace').classList.add('has-selection')
  $('logs-title').textContent = '로그 · ' + (state.overview.containers.find((item) => item.id === containerId)?.name || containerId)
  $('log-output').innerHTML = '<div class="log-empty"><span>⌁</span><p>로그 스트림에 연결하는 중…</p></div>'
  state.logSource = new EventSource(`/api/logs/stream?containerId=${encodeURIComponent(containerId)}&tail=200`)
  state.logSource.onmessage = (event) => appendLog(JSON.parse(event.data).line)
  state.logSource.addEventListener('error', () => appendLog('[stream] 로그 연결이 종료되었습니다.'))
  renderOverview()
}

async function refresh() {
  const response = await fetch('/api/overview', { cache: 'no-store' })
  state.overview = await response.json()
  renderOverview()
}

async function init() {
  state.catalog = await fetch('/api/error-codes').then((response) => response.json())
  $('codes-list').innerHTML = state.catalog.codes.map((item) => `<article class="code-item"><code>${escapeHtml(item.code)}</code><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.trigger)}<br />대응: ${escapeHtml(item.response)}</p></article>`).join('')
  $('clear-logs').addEventListener('click', () => { $('log-output').innerHTML = '<div class="log-empty"><span>⌁</span><p>로그를 선택하세요.</p></div>' })
  $('refresh-now').addEventListener('click', () => { void refresh().catch(() => {}) })
  await refresh()
  setInterval(() => { void refresh().catch(() => {}) }, 5_000)
}

void init().catch((error) => { $('connection-label').textContent = '대시보드 초기화 오류'; $('error-banner').classList.remove('hidden'); $('error-banner').textContent = error.message })
