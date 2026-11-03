import { summarizeMetrics, formatPercent } from './metric-display.js'
import { httpChartData } from './http-chart.js'

const state = { overview: null, catalog: null, selectedId: null, logSource: null, history: [], lastSample: null, highlightedAlertId: null, pendingAction: null, pendingRecordOperation: null, packages: null }
const $ = (id) => document.getElementById(id)
const viewNames = { overview: '운영 현황', containers: '컨테이너', logs: '실시간 로그', 'status-codes': 'HTTP 응답', alerts: '활성 경고', playbooks: '오류 대응', 'error-codes': '오류 코드', packages: '패키지 업데이트' }

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char])
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  if (total >= 3600) return Math.floor(total / 3600) + '시간 ' + Math.floor(total % 3600 / 60) + '분'
  if (total >= 60) return Math.floor(total / 60) + '분 ' + total % 60 + '초'
  return total + '초'
}

function safeExternalLink(url) {
  try { return new URL(url).protocol === 'https:' ? url : null } catch { return null }
}

function packageLabels(item) {
  const services = { backend: '백엔드 API', frontend: '웹 프론트엔드', 'model-server': 'AI 모델 서버' }
  const scopes = { runtime: '직접 의존성', optional: '선택 의존성', dev: '개발 의존성', transitive: '하위 의존성' }
  const scope = scopes[item.scope] || item.scope || '종류 미확인'
  return '<span class="package-chip package-service-chip">' + escapeHtml(services[item.service] || item.service) + '</span><span class="package-chip">' + escapeHtml(item.ecosystem) + '</span><span class="package-chip package-scope-chip">' + scope + '</span>'
}

function renderPackages(data) {
  state.packages = data
  $('package-count').textContent = Number.isFinite(data.packageCount) ? data.packageCount : '-'
  $('package-vulnerability-count').textContent = data.advisories?.length ?? '-'
  $('package-release-count').textContent = data.releases?.length ?? '-'
  $('nav-package-alert-count').textContent = data.advisories?.length ?? '-'
  $('nav-package-alert-count').classList.toggle('is-critical', Boolean(data.advisories?.length))
  $('package-checked-at').textContent = data.checkedAt ? new Date(data.checkedAt).toLocaleString('ko-KR') : data.status === 'loading' ? '확인 중' : '미확인'
  const advisoryList = $('package-advisories')
  advisoryList.innerHTML = data.advisories?.length ? data.advisories.map((item) => {
    const link = safeExternalLink(item.url)
    return '<article class="package-item package-item-critical"><div class="package-item-heading"><span class="package-severity">' + escapeHtml(item.severity || '보안 권고') + '</span><code>' + escapeHtml(item.id) + '</code>' + packageLabels(item) + '</div><h3>' + escapeHtml(item.package) + ' · ' + escapeHtml(item.version) + '</h3><p>' + escapeHtml(item.summary) + '</p>' + (item.fixedVersions?.length ? '<p class="package-fixed">수정 버전: ' + escapeHtml(item.fixedVersions.join(', ')) + '</p>' : '') + '<div class="package-item-foot"><span>' + escapeHtml(item.aliases?.join(', ') || 'OSV 보안 데이터베이스') + '</span>' + (link ? '<a href="' + escapeHtml(link) + '" target="_blank" rel="noopener noreferrer">권고 원문 ↗</a>' : '') + '</div></article>'
  }).join('') : '<div class="empty">' + (data.status === 'loading' ? '취약점 정보를 조회 중입니다.' : data.status === 'unavailable' ? '취약점 정보를 확인할 수 없습니다. 연결 상태와 원본 lock 파일을 확인하세요.' : '현재 설치 버전과 일치하는 OSV 권고가 없습니다.') + '</div>'
  const releaseList = $('package-releases')
  releaseList.innerHTML = data.releases?.length ? data.releases.map((item) => {
    const link = safeExternalLink(item.release?.url) || safeExternalLink(item.source)
    const notes = item.release?.notes ? '<p class="package-release-notes">' + escapeHtml(item.release.notes) + (item.release.notes.length >= 1800 ? '…' : '') + '</p>' : '<p class="package-release-notes package-no-notes">공식 릴리즈 노트를 자동으로 찾지 못했습니다. 출처에서 변경 내용을 확인하세요.</p>'
    return '<article class="package-item"><div class="package-item-heading"><span class="package-update-badge">업데이트 후보</span>' + packageLabels(item) + '</div><h3>' + escapeHtml(item.package) + ' <span class="package-version">' + escapeHtml(item.installedVersion) + ' → ' + escapeHtml(item.latestVersion) + '</span></h3>' + (item.release?.title ? '<h4>' + escapeHtml(item.release.title) + '</h4>' : '') + notes + '<div class="package-item-foot"><span>' + escapeHtml(item.release?.publishedAt ? new Date(item.release.publishedAt).toLocaleDateString('ko-KR') : item.description) + '</span>' + (link ? '<a href="' + escapeHtml(link) + '" target="_blank" rel="noopener noreferrer">릴리즈 정보 ↗</a>' : '') + '</div></article>'
  }).join('') : '<div class="empty">' + (data.status === 'loading' ? '릴리즈 정보를 조회 중입니다.' : '최신 버전이거나 릴리즈 메타데이터를 가져오지 못했습니다.') + '</div>'
  if (data.errors?.length) {
    const warning = document.createElement('p')
    warning.className = 'package-source-warning'
    warning.textContent = '일부 데이터 원본 확인 실패: ' + data.errors.join(' · ')
    advisoryList.prepend(warning)
  }
}

async function refreshPackages(force = false) {
  const button = $('refresh-packages')
  button.disabled = true
  button.textContent = '확인 중…'
  try {
    const response = await fetch(force ? '/api/packages/refresh' : '/api/packages', { method: force ? 'POST' : 'GET', cache: 'no-store' })
    if (!response.ok) throw new Error('HTTP ' + response.status)
    renderPackages(await response.json())
  } catch (error) {
    renderPackages({ status: 'unavailable', packageCount: 0, advisories: [], releases: [], errors: [error.message] })
  } finally {
    button.disabled = false
    button.textContent = '지금 확인'
  }
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
  const services = [...(statusState.services || [])].sort((a, b) => b.total - a.total).slice(0, 4)
  const routes = [...(statusState.routes || [])].sort((a, b) => b.total - a.total).slice(0, 4)
  const correlations = (statusState.correlations || []).slice(0, 3)
  const serviceRows = services.map((item) => `<li><span>${escapeHtml(item.service)}</span><small>${item.total}건 · 5xx ${item.classCounts['5xx']}</small></li>`).join('')
  const routeRows = routes.map((item) => `<li><span><b>${escapeHtml(item.method || '—')}</b> ${escapeHtml(item.route)}</span><small>${escapeHtml(item.service)} · ${item.total}건</small></li>`).join('')
  const correlationRows = correlations.map((item) => `<li><span>${escapeHtml(item.service)} · HTTP ${escapeHtml(item.status)}${item.method ? ` · ${escapeHtml(item.method)}` : ''}${item.route ? ` ${escapeHtml(item.route)}` : ''}</span><small>${item.deploymentVersion ? `배포 ${escapeHtml(item.deploymentVersion)} · ` : ''}${item.traceId ? `trace ${escapeHtml(item.traceId)}` : item.requestId ? `request ${escapeHtml(item.requestId)}` : '요청 ID 없음'}</small></li>`).join('')
  target.innerHTML = `${chart.state === 'partial' ? '<p class="status-chart-note">일부 로그를 수집하지 못했습니다. 아래 수치는 확인된 응답만 포함합니다.</p>' : ''}<p class="status-chart-note">최근 수집된 로그에서 확인된 응답 ${chart.total}건</p>${chart.bars.map(({ label, count, percent }) => `<div class="status-chart-row status-${label}"><span>${label.toUpperCase()}</span><div class="status-chart-track" aria-hidden="true"><span style="width:${percent}%"></span></div><strong>${count}건</strong></div>`).join('')}<div class="status-breakdowns"><section><h3>서비스별</h3><ul>${serviceRows || '<li class="status-breakdown-empty">집계할 서비스가 없습니다.</li>'}</ul></section><section><h3>라우트별</h3><ul>${routeRows || '<li class="status-breakdown-empty">route template 로그가 없습니다.</li>'}</ul></section></div><section class="request-correlations"><h3>배포 · 요청 상관관계</h3><ul>${correlationRows || '<li class="status-breakdown-empty">배포 버전 또는 trace/request ID 로그가 없습니다.</li>'}</ul></section>`
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
  const activeCodes = new Set(alerts.map((alert) => alert.code))
  $('actions-list').innerHTML = (state.catalog?.actions || []).map((action) => {
    const alert = alerts.find((item) => activeCodes.has(item.code) && action.codes.includes(item.code))
    const code = alert?.code
    const blockedReason = action.id === 'scale-service' && alert ? scaleBlockReason(action, alert) : ''
    const enabled = Boolean(code) && !blockedReason
    const note = blockedReason || (enabled ? '활성 경고에 대응할 수 있습니다.' : '대응 가능한 활성 오류가 없습니다.')
    const targetHint = action.id === 'scale-service' && action.targetService ? `${action.targetService} · 목표 ${action.targetReplicas}개` : ''
    return `<div class="action-card${enabled ? ' is-enabled' : ''}"><div><strong>${escapeHtml(action.label)}</strong><small>${escapeHtml(action.description || note)}</small>${targetHint ? `<small class="action-availability">${escapeHtml(targetHint)}</small>` : ''}<small class="action-availability">${escapeHtml(note)}</small>${code ? `<div class="action-code">${escapeHtml(code)}</div>` : ''}<a class="action-manual-link" href="${escapeHtml(action.manualPath || '/docs/response-scripts.md')}" target="_blank" rel="noreferrer">실행 매뉴얼 ↗</a></div><button type="button" data-action-id="${escapeHtml(action.id)}" data-code="${escapeHtml(code || '')}" ${enabled ? '' : 'disabled'}>${enabled ? '검토' : blockedReason ? '차단됨' : '대기 중'}</button></div>`
  }).join('')
  $('actions-list').querySelectorAll('button:not([disabled])').forEach((button) => button.addEventListener('click', () => openActionReview(button.dataset.actionId, button.dataset.code, alerts.find((alert) => alert.code === button.dataset.code), button)))
}

function scaleBlockReason(action, alert) {
  if (alert.stateful) return '데이터베이스 컨테이너는 수평 확장 대상이 아닙니다.'
  if (!action.targetService) return '확장 대상 Compose 서비스를 설정하지 않았습니다.'
  if ((action.blockedServices || []).includes(action.targetService)) return `현재 안전 정책상 ${action.targetService} 확장을 차단했습니다.`
  if (!(action.allowedServices || []).includes(action.targetService)) return 'OPS_SCALE_ALLOWED_SERVICES에 검토된 서비스만 명시적으로 추가할 수 있습니다.'
  if (!alert.composeService || alert.composeService !== action.targetService) return '경고 컨테이너의 Compose 서비스와 설정된 확장 대상이 다릅니다.'
  if (!Number.isInteger(action.maxReplicas) || action.maxReplicas > action.hardMaxReplicas) return `OPS_SCALE_MAX는 ${action.hardMaxReplicas} 이하여야 합니다.`
  if (!Number.isInteger(action.targetReplicas) || action.targetReplicas < 1 || action.targetReplicas > action.maxReplicas) return '목표 replica 수가 허용 범위를 벗어났습니다.'
  return ''
}

function openActionReview(actionId, code, alert, trigger) {
  const action = state.catalog.actions.find((item) => item.id === actionId)
  if (!action || !alert) return
  state.pendingAction = { action, code, alert, trigger }
  $('action-confirm-title').textContent = action.label
  $('action-confirm-description').textContent = action.description || '실행 전 대상과 영향을 확인하세요.'
  $('action-confirm-code').textContent = code
  if (action.id === 'scale-service') {
    const replicas = state.overview?.containers?.filter((container) => container.running && container.composeService === action.targetService).length || 0
    $('action-confirm-target').textContent = `${action.targetService} 서비스 · 실행 중 ${replicas}개 → 목표 ${action.targetReplicas}개 (최대 ${action.maxReplicas}개)`
  } else {
    $('action-confirm-target').textContent = alert.containerName || alert.containerId || 'Docker Engine'
  }
  $('include-logs-option').classList.toggle('hidden', !action.includeLogs)
  $('include-recent-logs').checked = false
  $('confirm-action').textContent = action.confirmation === 'change' ? '확인 후 변경 실행' : '검토 후 실행'
  $('action-confirm-dialog').showModal()
}

function showOperationToast(message, isError = false) {
  const toast = $('operation-toast')
  toast.textContent = message
  toast.classList.toggle('is-error', isError)
  toast.classList.remove('hidden')
  window.setTimeout(() => toast.classList.add('hidden'), 6000)
}

function renderActionHistory(events) {
  const target = $('action-history')
  if (!events.length) { target.innerHTML = '<p class="record-empty">기록된 실행이 없습니다.</p>'; return }
  target.innerHTML = events.map((event) => `<div class="record-row"><div><strong>${escapeHtml(event.actionLabel || event.actionId)}</strong><small>${escapeHtml(new Date(event.at).toLocaleString('ko-KR'))} · ${escapeHtml(event.actor)} · ${escapeHtml(event.code)} · ${escapeHtml(event.target || '대상 없음')}</small><small class="record-status-${event.status === 'success' ? 'success' : 'failure'}">${event.status === 'success' ? '실행 완료' : '실행 실패'}${event.includeLogs ? ' · 로그 포함' : ''}</small></div>${event.reportId ? `<a href="/api/reports/${encodeURIComponent(event.reportId)}">보고서</a>` : ''}</div>`).join('')
}

function renderReports(reports) {
  const target = $('report-list')
  if (!reports.length) { target.innerHTML = '<p class="record-empty">저장된 진단 보고서가 없습니다.</p>'; return }
  target.innerHTML = reports.map((report) => `<div class="record-row"><div><strong>${escapeHtml(report.id)}</strong><small>${escapeHtml(new Date(report.modifiedAt).toLocaleString('ko-KR'))} · ${formatBytes(report.sizeBytes)}</small></div><span><a href="/api/reports/${encodeURIComponent(report.id)}">다운로드</a> <button type="button" data-delete-report="${escapeHtml(report.id)}">삭제</button></span></div>`).join('')
  target.querySelectorAll('[data-delete-report]').forEach((button) => button.addEventListener('click', () => openRecordConfirmation('delete', button.dataset.deleteReport)))
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
}

async function refreshOperatorRecords() {
  const [historyResponse, reportsResponse] = await Promise.all([fetch('/api/actions/history?limit=30'), fetch('/api/reports')])
  if (!historyResponse.ok || !reportsResponse.ok) throw new Error('운영 기록을 불러오지 못했습니다')
  const [history, reports] = await Promise.all([historyResponse.json(), reportsResponse.json()])
  renderActionHistory(history.events || [])
  renderReports(reports.reports || [])
}

function openRecordConfirmation(operation, reportId = '') {
  state.pendingRecordOperation = { operation, reportId }
  const cleanup = operation === 'cleanup'
  $('record-confirm-title').textContent = cleanup ? '오래된 보고서 정리' : '진단 보고서 삭제'
  $('record-confirm-description').textContent = cleanup
    ? '수정된 지 30일이 지난 진단 보고서를 삭제합니다. 이 작업은 되돌릴 수 없습니다.'
    : `${reportId} 보고서를 삭제합니다. 다운로드가 필요하면 먼저 파일을 저장하세요.`
  $('confirm-record-operation').textContent = cleanup ? '30일 지난 보고서 삭제' : '보고서 삭제'
  $('record-confirm-dialog').showModal()
}

async function performRecordOperation() {
  const pending = state.pendingRecordOperation
  if (!pending) return
  $('confirm-record-operation').disabled = true
  try {
    const url = pending.operation === 'cleanup'
      ? '/api/reports?olderThanDays=30'
      : `/api/reports/${encodeURIComponent(pending.reportId)}`
    const response = await fetch(url, { method: 'DELETE' })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || '보고서 작업에 실패했습니다')
    const count = pending.operation === 'cleanup' ? result.deleted.length : 1
    $('record-confirm-dialog').close()
    showOperationToast(`${count}개 진단 보고서를 정리했습니다.`)
    await refreshOperatorRecords()
  } catch (error) {
    $('record-confirm-dialog').close()
    showOperationToast(error instanceof Error ? error.message : String(error), true)
  } finally {
    $('confirm-record-operation').disabled = false
    state.pendingRecordOperation = null
  }
}

async function runAction() {
  const pending = state.pendingAction
  if (!pending) return
  const { action, code, alert } = pending
  $('confirm-action').disabled = true
  $('close-action-dialog').disabled = true
  $('cancel-action').disabled = true
  $('confirm-action').textContent = '실행 중…'
  $('action-result').classList.remove('hidden')
  $('action-result').textContent = `${action.label} 실행 중 · ${alert.containerName || 'Docker Engine'}`
  try {
    const response = await fetch('/api/actions/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actionId: action.id, code, includeLogs: $('include-recent-logs').checked }),
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || '알 수 없는 오류')
    const output = result.output || ''
    const degraded = output.includes('engine=unreachable') || output.includes('docker_cli=missing')
    const summary = output.replace(/^report=.*\n?/m, '').trim()
    const auditWarning = result.auditRecorded === false ? '\n경고: 실행 이력을 저장하지 못했습니다.' : ''
    $('action-result').textContent = `${action.label} ${degraded ? '점검 완료 · 추가 확인 필요' : '완료'}${summary ? `\n${summary}` : ''}${auditWarning}`
    if (result.reportId) {
      const link = document.createElement('a')
      link.href = `/api/reports/${encodeURIComponent(result.reportId)}`
      link.textContent = '진단 보고서 다운로드'
      link.className = 'report-download-link'
      $('action-result').append(document.createElement('br'), link)
    }
    showOperationToast(result.auditRecorded === false ? '작업은 실행됐지만 실행 이력을 저장하지 못했습니다.' : degraded ? `${action.label}: 연결 상태가 정상인지 확인하세요.` : `${action.label} 작업이 끝났습니다.`, result.auditRecorded === false || degraded)
    $('action-confirm-dialog').close()
    await refreshOperatorRecords().catch(() => {})
    await refresh().catch(() => {})
  } catch (error) {
    $('action-result').textContent = `${action.label} 실패\n${error instanceof Error ? error.message : String(error)}`
    showOperationToast(`${action.label} 실행에 실패했습니다. 대응 영역의 상세 결과를 확인하세요.`, true)
    $('action-confirm-dialog').close()
  } finally {
    $('confirm-action').disabled = false
    $('close-action-dialog').disabled = false
    $('cancel-action').disabled = false
    $('confirm-action').textContent = action.confirmation === 'change' ? '확인 후 변경 실행' : '검토 후 실행'
    pending.trigger?.focus()
    state.pendingAction = null
  }
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
  $('refresh-packages').addEventListener('click', () => { void refreshPackages(true) })
  $('brand-refresh').addEventListener('click', () => window.location.reload())
  $('log-container-select').addEventListener('change', (event) => { if (event.target.value) selectContainer(event.target.value) })
  $('close-action-dialog').addEventListener('click', () => $('action-confirm-dialog').close())
  $('cancel-action').addEventListener('click', () => $('action-confirm-dialog').close())
  $('confirm-action').addEventListener('click', () => { void runAction() })
  $('refresh-records').addEventListener('click', () => { void refreshOperatorRecords().catch((error) => showOperationToast(error.message, true)) })
  $('cleanup-old-reports').addEventListener('click', () => openRecordConfirmation('cleanup'))
  $('close-record-dialog').addEventListener('click', () => $('record-confirm-dialog').close())
  $('cancel-record-operation').addEventListener('click', () => $('record-confirm-dialog').close())
  $('confirm-record-operation').addEventListener('click', () => { void performRecordOperation() })
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
  await refreshPackages()
  await refreshOperatorRecords().catch((error) => showOperationToast(error.message, true))
  setInterval(() => { void refresh() }, 5000)
  setInterval(() => { if (window.location.hash === '#packages') void refreshPackages() }, 60_000)
}

void init()
