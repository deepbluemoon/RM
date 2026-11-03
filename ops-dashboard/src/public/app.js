import { summarizeMetrics, formatPercent } from './metric-display.js'
import { httpChartData } from './http-chart.js'

const state = { overview: null, catalog: null, selectedId: null, logSource: null, alertPopoverOpen: false, highlightedAlertId: null, uiError: null, summaryOpen: null, metricHistory: [], pendingAction: null, pendingRecordOperation: null }
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
  $('close-action-dialog').addEventListener('click', () => $('action-confirm-dialog').close())
  $('cancel-action').addEventListener('click', () => $('action-confirm-dialog').close())
  $('confirm-action').addEventListener('click', () => { void runAction() })
  $('refresh-records').addEventListener('click', () => { void refreshOperatorRecords().catch((error) => showOperationToast(error.message, true)) })
  $('cleanup-old-reports').addEventListener('click', () => openRecordConfirmation('cleanup'))
  $('close-record-dialog').addEventListener('click', () => $('record-confirm-dialog').close())
  $('cancel-record-operation').addEventListener('click', () => $('record-confirm-dialog').close())
  $('confirm-record-operation').addEventListener('click', () => { void performRecordOperation() })
  $('activity-container-select').addEventListener('change', (event) => { if (event.target.value) selectContainer(event.target.value) })
  $('clear-logs').addEventListener('click', () => { $('log-output').innerHTML = '<div class="log-empty"><span>⌁</span><p>화면에 표시된 로그를 비웠습니다.</p></div>' })
  $('refresh-now').addEventListener('click', () => { void refresh().catch(() => {}) })
  $('brand-refresh').addEventListener('click', () => window.location.reload())
  await refresh()
  await refreshOperatorRecords().catch((error) => showOperationToast(error.message, true))
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
