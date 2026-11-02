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
  const containers = overview.containers || []
  const running = containers.filter((item) => item.running)
  const stats = running.map((item) => item.stats).filter(Boolean)
  const memoryUsed = stats.reduce((sum, item) => sum + item.memoryUsedBytes, 0)
  const memoryLimit = stats.reduce((sum, item) => sum + item.memoryLimitBytes, 0)
  $('running-count').textContent = String(running.length)
  $('total-count').textContent = String(containers.length)
  $('alert-count').textContent = String(overview.alerts?.length || 0)
  $('cpu-total').textContent = `${stats.reduce((sum, item) => sum + item.cpuPercent, 0).toFixed(1)}%`
  $('memory-total').textContent = `${memoryLimit ? (memoryUsed / memoryLimit * 100).toFixed(1) : '0.0'}%`
  $('last-updated').textContent = new Date(overview.observedAt).toLocaleTimeString('ko-KR')
  $('connection-label').textContent = overview.dockerAvailable ? 'Docker 연결됨' : 'Docker 연결 오류'
  $('connection-label').previousElementSibling.style.background = overview.dockerAvailable ? '#67d49c' : '#f77e70'
  renderContainers(containers, overview.alerts || [])
  renderActions(overview.alerts || [])
  const banner = $('error-banner')
  if (overview.error) { banner.classList.remove('hidden'); banner.innerHTML = `<strong>OPS-DOCKER-001</strong> · ${escapeHtml(overview.error)}` } else banner.classList.add('hidden')
}

function renderContainers(containers, alerts) {
  const list = $('container-list')
  if (!containers.length) { list.innerHTML = '<div class="empty">감시 중인 컨테이너가 없습니다.</div>'; return }
  list.innerHTML = containers.map((container) => {
    const stats = container.stats || { cpuPercent: 0, memoryPercent: 0, memoryUsedBytes: 0, memoryLimitBytes: 0 }
    const ownAlerts = alerts.filter((alert) => alert.containerId === container.id)
    const selected = state.selectedId === container.id ? ' selected' : ''
    return `<button class="container-row${selected}" data-container-id="${escapeHtml(container.id)}" type="button">
      <div class="row-top"><span class="container-name" title="${escapeHtml(container.name)}">${escapeHtml(container.name)}</span><span class="status${container.running ? '' : ' stopped'}">${container.running ? 'running' : 'stopped'}</span></div>
      <div class="container-id">${escapeHtml(container.id.slice(0, 12))} · ${escapeHtml(container.image)}</div>
      <div class="metrics"><div><div class="metric-label"><span>CPU</span><span class="metric-value">${stats.cpuPercent.toFixed(1)}%</span></div><div class="bar"><i class="${stats.cpuPercent >= 80 ? 'warn' : ''}" style="width:${Math.min(stats.cpuPercent, 100)}%"></i></div></div><div><div class="metric-label"><span>MEM</span><span class="metric-value">${stats.memoryPercent.toFixed(1)}%</span></div><div class="bar"><i class="${stats.memoryPercent >= 80 ? 'warn' : ''}" style="width:${Math.min(stats.memoryPercent, 100)}%"></i></div></div></div>
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
  await refresh()
  setInterval(() => { void refresh().catch(() => {}) }, 5_000)
}

void init().catch((error) => { $('connection-label').textContent = '대시보드 초기화 오류'; $('error-banner').classList.remove('hidden'); $('error-banner').textContent = error.message })
