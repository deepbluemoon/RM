import { beginActionProgress, endActionProgress } from './action-progress.js'
import { summarizeMetrics, formatPercent, topContainerMetrics } from './metric-display.js'
import { httpChartData, httpResponseDetails } from './http-chart.js'

const containerOrderKey = 'rm-ops-container-order-v1'
const state = { httpResponseCode: null, historyFilter: 'both', overview: null, catalog: null, httpCodes: [], responseAlertId: null, expandedContainerLogs: new Set(), containerLogSources: new Map(), containerLogLines: new Map(), containerOrder: readContainerOrder(), history: [], lastSample: null, highlightedAlertId: null, pendingAction: null, pendingRecordOperation: null, packages: null }
const $ = (id) => document.getElementById(id)
const viewNames = { overview: '운영 현황', containers: '컨테이너', 'status-codes': 'HTTP 응답', 'error-codes': '오류 확인', packages: '패키지 업데이트' }
const markupCache = new WeakMap()

function setMarkup(target, markup) {
  if (markupCache.get(target) === markup) return false
  const openDetails = [...target.querySelectorAll('details[open][data-detail-id]')].map((item) => item.dataset.detailId)
  const focusKey = target.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null
  target.innerHTML = markup
  markupCache.set(target, markup)
  for (const key of openDetails) target.querySelector(`[data-detail-id="${CSS.escape(key)}"]`)?.setAttribute('open', '')
  if (focusKey) target.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true })
  return true
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char])
}

function readContainerOrder() {
  try {
    const saved = JSON.parse(localStorage.getItem(containerOrderKey) || '{}')
    return Object.fromEntries(['running', 'waiting', 'stopped'].map(key => [key, Array.isArray(saved[key]) ? saved[key].filter(id => typeof id === 'string') : []]))
  } catch { return { running: [], waiting: [], stopped: [] } }
}
function saveContainerOrder() {
  try { localStorage.setItem(containerOrderKey, JSON.stringify(state.containerOrder)) } catch {}
}
function containerGroupKey(container) {
  const stateName = String(container.state || '').toLowerCase()
  const statusName = String(container.status || '').toLowerCase()
  return ['created', 'restarting', 'paused'].includes(stateName) || statusName.includes('health: starting') ? 'waiting' : container.running ? 'running' : 'stopped'
}
function orderedGroupContainers(containers, key) {
  const positions = new Map((state.containerOrder[key] || []).map((id, index) => [id, index]))
  return containers.filter(container => containerGroupKey(container) === key).sort((a, b) =>
    (positions.get(a.id) ?? Infinity) - (positions.get(b.id) ?? Infinity))
}
function moveContainerInGroup(sourceId, targetId, before) {
  const containers = state.overview?.containers || []
  const source = containers.find(container => container.id === sourceId)
  const target = containers.find(container => container.id === targetId)
  if (!source || !target || sourceId === targetId || containerGroupKey(source) !== containerGroupKey(target)) return false
  const key = containerGroupKey(source)
  const ids = orderedGroupContainers(containers, key).map(container => container.id)
  const previous = ids.join('\u0000')
  ids.splice(ids.indexOf(sourceId), 1)
  ids.splice(ids.indexOf(targetId) + (before ? 0 : 1), 0, sourceId)
  if (ids.join('\u0000') === previous) return false
  state.containerOrder[key] = ids
  saveContainerOrder()
  return true
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
  $('package-security-count').textContent = data.advisories?.length ?? '-'
  $('package-release-count').textContent = data.releases?.length ?? '-'
  $('nav-package-alert-count').textContent = data.advisories?.length ?? '-'
  $('package-checked-at').textContent = data.checkedAt ? new Date(data.checkedAt).toLocaleString('ko-KR') : data.status === 'loading' ? '확인 중' : '미확인'
  const advisoryList = $('package-advisories')
  advisoryList.innerHTML = data.advisories?.length ? data.advisories.map((item) => {
    const link = safeExternalLink(item.url)
    return '<article class="package-item package-item-critical"><div class="package-item-heading"><span class="package-severity">' + escapeHtml(item.severity || '보안 권고') + '</span><code>' + escapeHtml(item.id) + '</code>' + packageLabels(item) + '</div><h3>' + escapeHtml(item.package) + ' · ' + escapeHtml(item.version) + '</h3><p>' + escapeHtml(item.summary) + '</p>' + (item.fixedVersions?.length ? '<p class="package-fixed">수정 버전: ' + escapeHtml(item.fixedVersions.join(', ')) + '</p>' : '') + '<div class="package-item-foot"><span>' + escapeHtml(item.aliases?.join(', ') || 'OSV 보안 데이터베이스') + '</span>' + (link ? '<a href="' + escapeHtml(link) + '" target="_blank" rel="noopener noreferrer">권고 원문 ↗</a>' : '') + '</div></article>'
  }).join('') : '<div class="empty">' + (data.status === 'loading' ? '취약점 정보를 조회 중입니다.' : data.status === 'unavailable' ? '취약점 정보를 확인할 수 없습니다. 연결 상태와 원본 lock 파일을 확인하세요.' : '현재 설치 버전과 일치하는 OSV 권고가 없습니다.') + '</div>'
  const releaseList = $('package-releases')
  const query = $('package-search').value.trim().toLowerCase()
  const service = $('package-service-filter').value
  const scope = $('package-scope-filter').value
  const groups = new Map()
  const releases = (data.releases || []).flatMap((item) => item.version ? [item] : item.latestVersion ? [{
    ...item,
    version: item.latestVersion,
    publishedAt: item.release?.publishedAt || null,
    title: item.release?.title || `v${item.latestVersion}`,
    notes: item.release?.notes || '',
    url: item.release?.url || item.source,
  }] : [])
  for (const item of releases) {
    if (service !== 'all' && item.service !== service) continue
    if (scope !== 'all' && item.scope !== scope) continue
    if (query && !`${item.package} ${item.version}`.toLowerCase().includes(query)) continue
    const key = `${item.service}:${item.ecosystem}:${item.package}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(item)
  }
  const groupRows = [...groups.values()].sort((a, b) => a[0].package.localeCompare(b[0].package))
  setMarkup(releaseList, groupRows.length ? groupRows.map((items) => {
    const first = items[0]
    const versions = items.map((item) => item.version)
    const releaseRows = items.map((item) => {
      const link = safeExternalLink(item.url) || safeExternalLink(item.source)
      const notes = item.notes ? '<p class="package-release-notes">' + escapeHtml(item.notes) + (item.notes.length >= 1800 ? '…' : '') + '</p>' : '<p class="package-release-notes package-no-notes">이 버전의 릴리즈 노트가 없습니다. 버전 이력에서 변경 사항을 확인하세요.</p>'
      return '<article class="package-release-row"><div class="package-release-row-head"><strong>' + escapeHtml(item.version) + '</strong><time>' + escapeHtml(item.publishedAt ? new Date(item.publishedAt).toLocaleDateString('ko-KR') : '날짜 미제공') + '</time>' + (link ? '<a href="' + escapeHtml(link) + '" target="_blank" rel="noopener noreferrer">원문 ↗</a>' : '') + '</div><p class="package-release-title">' + escapeHtml(item.title) + '</p>' + notes + '</article>'
    }).join('')
    return '<details class="package-group" data-detail-id="' + escapeHtml(`${first.service}:${first.package}`) + '"><summary><span class="package-group-name">' + escapeHtml(first.package) + '</span>' + packageLabels(first) + '<span class="package-group-range">' + escapeHtml(first.installedVersion) + ' 이후 ' + items.length + '개 · 최신 ' + escapeHtml(versions[0]) + '</span></summary><div class="package-group-releases">' + releaseRows + '</div></details>'
  }).join('') : '<div class="empty">' + (data.status === 'loading' ? '릴리즈 이력을 조회 중입니다.' : query || service !== 'all' || scope !== 'all' ? '필터 조건에 맞는 릴리즈가 없습니다.' : '설치 버전 이후 새 릴리즈가 없습니다.') + '</div>')
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
  if (requested === 'alerts' || requested === 'playbooks') { window.location.replace('#overview'); return }
  const view = Object.hasOwn(viewNames, requested) ? requested : 'not-found'
  document.querySelectorAll('.view').forEach((section) => section.classList.toggle('hidden', section.id !== 'view-' + view))
  document.querySelectorAll('[data-view-link]').forEach((link) => {
    const active = link.dataset.viewLink === view
    link.classList.toggle('active', active)
    if (active) link.setAttribute('aria-current', 'page')
    else link.removeAttribute('aria-current')
  })
  $('page-title').textContent = viewNames[view] || '화면을 찾을 수 없음'
  window.scrollTo({ top: 0, behavior: 'instant' })
  if (view === 'overview' && state.overview) {
    renderResourceRanking('cpu', state.overview, true)
    renderResourceRanking('memory', state.overview, true)
  }
}

function recordSample(overview, metrics) {
  const observed = Number(overview.observedAt)
  if (!Number.isFinite(observed) || state.lastSample === observed) return
  state.lastSample = observed
  state.history.push({ at: observed, cpu: metrics.cpu, memory: metrics.memory })
  state.history = state.history.filter((sample) => sample.at >= observed - 300000).slice(-61)
}

function renderResourceRanking(key, overview, entrance = false) {
  const target = $(key + '-ranking')
  const {items, measuredCount, runningCount} = topContainerMetrics(overview, key)
  const previous = new Map([...target.querySelectorAll('[data-resource-id]')].map((row) => {
    const track = row.querySelector('.resource-rank-track')
    return [row.dataset.resourceId, {top:row.getBoundingClientRect().top, width:track.clientWidth ? row.querySelector('.resource-rank-fill').getBoundingClientRect().width / track.clientWidth * 100 : 0}]
  }))
  const max = Math.max(0, ...items.map(item => item.value)) || 1
  const display = (value) => key === 'cpu' ? formatPercent(value) : value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GiB` : value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MiB` : value >= 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${value} B`
  const markup = items.map((item,index) => `<div class="resource-rank-row" data-resource-id="${escapeHtml(item.id)}" title="${escapeHtml(item.name)} · ${display(item.value)}"><span class="resource-rank-position">${index+1}</span><span class="resource-rank-name">${escapeHtml(item.name)}</span><strong>${display(item.value)}</strong><div class="resource-rank-track"><span class="resource-rank-fill ${key}" style="width:${(item.value / max * 100).toFixed(2)}%"></span></div></div>`).join('') || `<div class="ranking-empty">${overview?.dockerAvailable ? '측정된 사용량이 없습니다.' : '사용량을 확인할 수 없습니다.'}</div>`
  const changed = setMarkup(target, markup)
  const retained = overview?.containers?.some(container => container.statsRetained)
  $(key + '-ranking-note').textContent = !overview?.dockerAvailable ? 'Docker 연결 확인 필요' : `측정 ${measuredCount}/${runningCount}개 · ${retained ? '일부 최근 측정값' : '1위 기준'}`
  if ((!changed && !entrance) || !window.matchMedia || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  target.querySelectorAll('[data-resource-id]').forEach((row,index) => {
    const old = previous.get(row.dataset.resourceId)
    const fresh = entrance || !old
    const fill = row.querySelector('.resource-rank-fill')
    fill.animate([{width:fresh ? '0%' : `${old.width}%`}, {width:fill.style.width}], {duration:fresh ? 480 : 300, delay:fresh ? index*65 : 0, easing:'cubic-bezier(.22,1,.36,1)', fill:'backwards'})
    if (fresh) row.animate([{transform:'translateX(-6px)'},{transform:'translateX(0)'}], {duration:250,easing:'ease-out'})
    else if (Math.abs(old.top-row.getBoundingClientRect().top)>1) row.animate([{transform:`translateY(${old.top-row.getBoundingClientRect().top}px)`},{transform:'translateY(0)'}],{duration:300,easing:'cubic-bezier(.22,1,.36,1)'})
  })
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
  target.innerHTML = '<svg viewBox="0 0 600 146" preserveAspectRatio="none" role="img" aria-label="페이지를 연 이후 수집한 CPU 및 메모리 사용 추이">' + grid + (state.historyFilter !== 'memory' ? lines('cpu', 'var(--accent)') : '') + (state.historyFilter !== 'cpu' ? lines('memory', 'var(--memory)') : '') + '</svg>'
}

function renderOverview() {
  const overview = state.overview
  if (!overview) return
  const containers = overview.dockerAvailable ? (overview.containers || []) : []
  const metrics = summarizeMetrics(overview)
  $('alert-count').textContent = String(overview.alerts?.length || 0)
  $('nav-alert-count').textContent = String(overview.alerts?.length || 0)
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
  renderResourceRanking('cpu', overview)
  renderResourceRanking('memory', overview)
  renderHistory()
  renderAlerts(overview.alerts || [], overview.dockerAvailable)
  renderStatusCodes(overview.statusCodes, overview.dockerAvailable)
  renderContainers(containers, overview.alerts || [], overview.dockerAvailable)
  renderAlertTarget(overview.alerts || [])
  renderIo(containers, overview.dockerAvailable)
  renderContainerDirectory(containers, overview.dockerAvailable)
  renderActions(overview.alerts || [])
}

function renderAlerts(alerts, dockerAvailable) {
  const preview = $('alert-preview')
  const status = $('response-status')
  status.textContent = !dockerAvailable ? '연결 확인 필요' : alerts.length ? `${alerts.length}건 확인 필요` : '모두 정상'
  status.className = 'response-status ' + (!dockerAvailable ? 'is-offline' : alerts.length ? 'has-alerts' : 'is-healthy')
  if (!alerts.some((alert) => alert.id === state.responseAlertId)) state.responseAlertId = alerts.find((alert) => alert.severity === 'critical')?.id || alerts[0]?.id || null
  if (!alerts.length) {
    setMarkup(preview, `<div class="response-empty${dockerAvailable ? '' : ' is-unavailable'}"><span class="response-empty-symbol" aria-hidden="true">${dockerAvailable ? '✓' : '!'}</span><strong>${dockerAvailable ? '현재 활성 경고가 없습니다' : '경고 상태를 확인할 수 없습니다'}</strong><p>${dockerAvailable ? '컨테이너와 응답 상태를 계속 지켜보고 있습니다.' : 'Docker 연결 상태와 마지막 갱신 시간을 확인하세요.'}</p></div>`)
    return
  }
  const changed = setMarkup(preview, alerts.map((alert) => {
    const codeInfo = state.catalog?.codes?.find((item) => item.code === alert.code)
    const details = alert.message || alert.containerName || alert.resource
    const selected = alert.id === state.responseAlertId
    const critical = (alert.severity || codeInfo?.severity) === 'critical'
    return `<article class="response-incident${selected ? ' is-selected' : ''}${critical ? ' is-critical' : ''}"><button type="button" class="response-incident-select" data-select-alert="${escapeHtml(alert.id)}" data-focus-key="alert:${escapeHtml(alert.id)}" aria-pressed="${selected}"><span class="incident-heading"><span class="incident-severity">${critical ? '긴급' : '주의'}</span><code>${escapeHtml(alert.code)}</code><span class="incident-duration">${formatDuration(alert.durationSec)}</span></span><strong>${escapeHtml(codeInfo?.title || alert.resource || alert.code)}</strong><span class="incident-target">${escapeHtml(alert.containerName || alert.containerId || alert.resource)}</span></button><details class="incident-details" data-detail-id="${escapeHtml(alert.id)}"><summary>상태와 권장 조치</summary><p>${escapeHtml(details)}</p>${codeInfo?.response ? `<p>${escapeHtml(codeInfo.response)}</p>` : ''}<button type="button" class="text-button" data-alert-target="${escapeHtml(alert.id)}">관련 ${alert.kind === 'http' ? 'HTTP 응답' : '대상'} 확인 ↗</button></details></article>`
  }).join(''))
  if (!changed) return
  preview.querySelectorAll('[data-select-alert]').forEach((button) => button.addEventListener('click', () => {
    state.responseAlertId = button.dataset.selectAlert
    renderAlerts(alerts, dockerAvailable)
    renderActions(alerts)
  }))
  preview.querySelectorAll('[data-alert-target]').forEach((button) => button.addEventListener('click', () => focusAlert(button.dataset.alertTarget)))
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
  if (chart.state === 'unavailable' || chart.state === 'empty') {
    setMarkup(target, `<div class="empty">${chart.state === 'empty' ? '수집된 HTTP 응답이 없습니다.' : 'HTTP 응답을 확인할 수 없습니다.'}</div>`)
    renderHttpDetail(null)
    return
  }
  const previousWidths = new Map([...target.querySelectorAll('[data-status-class]')].map((row) => {
    const track = row.querySelector('.status-chart-track')
    const width = track.getBoundingClientRect().width
    return [row.dataset.statusClass, width ? `${row.querySelector('.status-chart-track span').getBoundingClientRect().width / width * 100}%` : '0%']
  }))
  const bars = chart.bars.map(({ label, count, percent }) => {
    const codes = httpResponseDetails(statusState, label, state.httpCodes)
    const chips = codes.map((item) => `<button type="button" class="http-code-chip" data-http-code="${item.code}" data-focus-key="response:${item.code}" aria-pressed="false" aria-controls="http-response-detail" title="${escapeHtml(item.description)} · 출처와 설명 보기"><b>${item.code}</b><span>${item.count}건</span><i aria-hidden="true">↗</i></button>`).join('')
    return `<div class="http-compact-row status-${label}" data-status-class="${label}"><span class="http-class-label">${label.toUpperCase()}</span><div class="status-chart-track" aria-hidden="true"><span style="width:${percent}%"></span></div><strong>${count}건<small>${percent.toFixed(1)}%</small></strong><div class="http-code-chips">${chips || '<span class="http-no-code">상세 코드 미수집</span>'}</div></div>`
  }).join('')
  const changed = setMarkup(target, `<div class="http-chart-caption"><span>전체 응답 <b>${chart.total}건</b></span><small>같은 응답 코드를 다시 누르면 상세 정보가 닫힙니다</small></div>${chart.state === 'partial' ? '<p class="status-chart-note">일부 로그 수집 실패 · 확인된 응답만 표시합니다.</p>' : ''}${bars}`)
  if (changed) target.querySelectorAll('[data-http-code]').forEach((button) => button.addEventListener('click', () => {
    const code = Number(button.dataset.httpCode)
    state.httpResponseCode = state.httpResponseCode === code ? null : code
    target.querySelectorAll('[data-http-code]').forEach((item) => item.setAttribute('aria-pressed', String(Number(item.dataset.httpCode) === state.httpResponseCode)))
    renderHttpDetail(state.overview?.statusCodes, true)
  }))
  target.querySelectorAll('[data-http-code]').forEach((button) => button.setAttribute('aria-pressed', String(Number(button.dataset.httpCode) === state.httpResponseCode)))
  if (changed && window.matchMedia && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) target.querySelectorAll('[data-status-class]').forEach((row) => {
    const bar = row.querySelector('.status-chart-track span')
    bar.animate([{width:previousWidths.get(row.dataset.statusClass) || '0%'}, {width:bar.style.width}], {duration:380, easing:'cubic-bezier(.22,1,.36,1)'})
  })
  renderHttpDetail(statusState)
}

function renderHttpDetail(statusState, animate = false) {
  const target = $('http-response-detail')
  const scrollTop = target.querySelector('.http-detail-scroll')?.scrollTop || 0
  const code = state.httpResponseCode
  if (!code || !statusState) {
    target.getAnimations?.().forEach(animation => animation.cancel())
    const changed = setMarkup(target, '<div class="http-detail-placeholder"><span aria-hidden="true">↗</span><strong>어떤 응답인지 확인해 보세요</strong><p>그래프 옆의 응답 코드를 누르면<br />발생 컨테이너와 설명이 여기에 표시됩니다.</p></div>')
    return
  }
  const info = state.httpCodes.find((item) => Number(item.code) === code)
  const total = statusState.totals?.counts?.[code] || 0
  const meanings = {100:'요청을 계속 보내도 된다는 중간 응답입니다.',101:'연결을 WebSocket 등 다른 프로토콜로 전환한 응답입니다.',200:'요청이 정상적으로 처리되었습니다.',201:'요청한 리소스가 새로 생성되었습니다.',202:'요청을 접수했으며 처리는 아직 진행 중일 수 있습니다.',204:'요청을 처리했으며 응답 본문은 없습니다.',301:'리소스가 다른 주소로 영구 이동했습니다.',302:'다른 주소로 임시 이동하도록 안내한 응답입니다.',304:'리소스가 변경되지 않아 기존 캐시를 사용할 수 있습니다.',400:'요청 형식이나 입력값을 확인해야 합니다.',401:'인증이 필요하거나 인증 정보가 유효하지 않습니다.',403:'해당 리소스에 접근할 권한이 없습니다.',404:'요청한 경로나 리소스를 찾을 수 없습니다.',422:'요청 형식은 이해했지만 입력 내용의 검증을 통과하지 못했습니다.',429:'허용된 요청 횟수를 초과했습니다.',500:'서버 내부 처리 중 오류가 발생했습니다.',502:'중간 서버가 상위 서버에서 유효한 응답을 받지 못했습니다.',503:'서버가 과부하 또는 점검 등으로 요청을 처리할 수 없습니다.',504:'상위 서버의 응답을 기다리다 시간이 초과되었습니다.'}
  const explanation = meanings[code] || ({1:'요청 처리 도중 전달된 정보성 응답입니다.',2:'요청이 성공적으로 처리된 응답입니다.',3:'리디렉션 또는 캐시 관련 응답입니다.',4:'클라이언트 요청에 대한 확인이 필요한 응답입니다.',5:'서버 측 처리 오류를 나타내는 응답입니다.'})[Math.floor(code / 100)]
  const sources = (statusState.containers || []).filter((item) => item.counts?.[code] > 0).sort((a,b) => b.counts[code] - a.counts[code])
  const sourceMarkup = sources.map((item) => `<li><span>${escapeHtml(item.name || item.id)}</span><strong>${item.counts[code]}건 <small>${total ? (item.counts[code] / total * 100).toFixed(1) : 0}%</small></strong></li>`).join('')
  const routes = (statusState.routes || []).filter((item) => item.counts?.[code] > 0)
  const correlations = (statusState.correlations || []).filter((item) => Number(item.status) === code)
  const requests = [...routes.slice(0,5).map((item) => `<li>${escapeHtml(item.method || '—')} ${escapeHtml(item.route)} <small>${item.counts[code]}건</small></li>`), ...correlations.slice(0,3).map((item) => `<li>${escapeHtml(item.containerName || '')} <small>${escapeHtml(item.traceId || item.requestId || item.deploymentVersion || '')}</small></li>`)].join('')
  const changed = setMarkup(target, `<div class="http-detail-heading"><div><small>RESPONSE DETAIL</small><h3>HTTP ${code}</h3></div><button type="button" id="http-detail-close" class="text-button" aria-label="응답 상세 닫기">닫기 ×</button></div><p class="http-detail-name">${escapeHtml(info?.description || 'HTTP 응답')}</p><p class="http-detail-explanation">${escapeHtml(explanation)}</p><div class="http-source-heading"><strong>발생 컨테이너</strong><span>${total}건</span></div><div class="http-detail-scroll"><ul class="http-source-list">${sourceMarkup || '<li>현재 수집 범위에 이 응답이 없습니다.</li>'}</ul>${requests ? `<details class="http-request-extra" data-detail-id="http-requests:${code}"><summary>요청 정보</summary><ul>${requests}</ul></details>` : ''}</div>`)
  if (changed) $('http-detail-close').addEventListener('click', () => {
    state.httpResponseCode = null
    $('status-summary').querySelectorAll('[data-http-code]').forEach((button) => button.setAttribute('aria-pressed','false'))
    renderHttpDetail(statusState)
    $('status-summary').querySelector(`[data-http-code="${code}"]`)?.focus({preventScroll:true})
  })
  if (changed && !animate) {
    const scroll = target.querySelector('.http-detail-scroll')
    if (scroll) scroll.scrollTop = scrollTop
  }
  if (animate && target.animate && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    target.getAnimations().forEach((animation) => animation.cancel())
    target.animate([{opacity:.15,transform:'translateX(24px)'},{opacity:1,transform:'translateX(0)'}], {duration:320,easing:'cubic-bezier(.22,1,.36,1)'})
  }
}


function renderIo(containers, dockerAvailable) {
  const target = $('io-summary')
  const running = dockerAvailable ? containers.filter((container) => container.running).length : null
  $('container-counts').textContent = dockerAvailable ? `컨테이너 ${containers.length}개 · 실행 중 ${running}개` : '컨테이너 수를 확인할 수 없습니다.'
  const rows = containers.filter((container) => container.stats)
  if (!rows.length) { target.innerHTML = '<div class="empty">' + (dockerAvailable ? '수집된 I/O 데이터가 없습니다.' : 'Docker 연결을 확인해 주세요.') + '</div>'; return }
  target.innerHTML = '<div class="io-table-head" aria-hidden="true"><span>컨테이너</span><span class="io-network-label">↕ 네트워크 <small>수신 / 송신</small></span><span class="io-disk-label">▤ 디스크 <small>읽기 / 쓰기</small></span></div>' + rows.map((container) => '<div class="io-row"><strong title="' + escapeHtml(container.name) + '">' + escapeHtml(container.name) + '</strong><span class="io-values"><span class="io-cell io-network" aria-label="네트워크 수신 / 송신"><b>' + escapeHtml(container.stats.networkIo || '-') + '</b></span><span class="io-cell io-disk" aria-label="디스크 읽기 / 쓰기"><b>' + escapeHtml(container.stats.blockIo || '-') + '</b></span></span></div>').join('')
}

function logLineMarkup(line) {
  const match = String(line).match(/\b(ERROR|FATAL|CRITICAL|WARN(?:ING)?|INFO)\b/i)
  const level = match ? match[1].toUpperCase() : ''
  const className = level === 'INFO' ? ' level-info' : level.startsWith('WARN') ? ' level-warning' : level ? ' level-error' : ''
  return `<div class="log-line${className}">${escapeHtml(line)}</div>`
}

function appendContainerLog(containerId, line) {
  const lines = state.containerLogLines.get(containerId) || []
  lines.push(line)
  if (lines.length > 500) lines.shift()
  state.containerLogLines.set(containerId, lines)
  const output = document.querySelector(`[data-inline-log-output="${CSS.escape(containerId)}"]`)
  if (!output) return
  const follow = output.scrollHeight - output.scrollTop - output.clientHeight < 40
  if (output.querySelector('.log-empty')) output.innerHTML = ''
  output.insertAdjacentHTML('beforeend', logLineMarkup(line))
  if (output.children.length > 500) output.firstElementChild.remove()
  if (follow) output.scrollTop = output.scrollHeight
}

function toggleContainerLogs(containerId) {
  if (state.closingLogs?.has(containerId)) return
  if (state.expandedContainerLogs.has(containerId)) {
    state.containerLogSources.get(containerId)?.close()
    state.containerLogSources.delete(containerId)
    const output = document.querySelector(`[data-inline-log-output="${CSS.escape(containerId)}"]`)
    const panel = output?.closest?.('.inline-log-panel')
    const finish = () => {
      state.expandedContainerLogs.delete(containerId)
      state.closingLogs?.delete(containerId)
      renderContainers(state.overview?.containers || [], state.overview?.alerts || [], state.overview?.dockerAvailable)
      document.querySelector(`[data-container-id="${CSS.escape(containerId)}"]`)?.focus({ preventScroll: true })
    }
    if (panel?.animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      state.closingLogs ||= new Set()
      state.closingLogs.add(containerId)
      panel.animate([{ height: `${panel.offsetHeight}px`, opacity: 1 }, { height: '0px', opacity: 0, paddingTop: '0px', paddingBottom: '0px', marginTop: '0px' }], { duration: 170, easing: 'ease-out', fill: 'forwards' }).finished.then(finish, finish)
    } else finish()
    return
  }
  state.expandedContainerLogs.add(containerId)
  state.containerLogLines.set(containerId, [])
  renderContainers(state.overview?.containers || [], state.overview?.alerts || [], state.overview?.dockerAvailable)
  const output = document.querySelector(`[data-inline-log-output="${CSS.escape(containerId)}"]`)
  if (output) output.innerHTML = '<div class="log-empty">로그 스트림에 연결하는 중…</div>'
  const source = new EventSource('/api/logs/stream?containerId=' + encodeURIComponent(containerId) + '&tail=200')
  source.onmessage = (event) => { try { appendContainerLog(containerId, JSON.parse(event.data).line) } catch { appendContainerLog(containerId, '[stream] 로그 형식을 읽을 수 없습니다.') } }
  source.addEventListener('end', () => {
    source.close()
    state.containerLogSources.delete(containerId)
    appendContainerLog(containerId, '[stream] 로그 스트림이 종료되었습니다.')
  })
  source.addEventListener('error', () => {
    if (source.readyState === EventSource.CLOSED) appendContainerLog(containerId, '[stream] 로그 연결이 종료되었습니다.')
  })
  state.containerLogSources.set(containerId, source)
}

const stoppingContainers = new Set()

async function stopContainer(container, button) {
  if (stoppingContainers.has(container.id) || !window.confirm(container.name + ' 컨테이너를 중지할까요?')) return
  stoppingContainers.add(container.id)
  button.disabled = true
  button.textContent = '…'
  try {
    const response = await fetch('/api/containers/stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ops-intent': 'stop-container' },
      body: JSON.stringify({ containerId: container.id }),
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || '컨테이너를 중지하지 못했습니다')
    await refresh()
    showOperationToast(container.name + ' 중지 완료')
  } catch (error) {
    showOperationToast(error.message, true)
  } finally {
    stoppingContainers.delete(container.id)
    button.textContent = '×'
    const current = state.overview?.containers.find(item => item.id === container.id)
    button.disabled = !current || (!current.running && containerGroupKey(current) !== 'stopped')
  }
}

async function removeContainer(container, button) {
  if (stoppingContainers.has(container.id) || !window.confirm(container.name + ' 컨테이너를 삭제할까요?\n컨테이너와 저장된 로그가 삭제됩니다.')) return
  stoppingContainers.add(container.id)
  button.disabled = true
  button.textContent = '…'
  try {
    const response = await fetch('/api/containers/remove', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ops-intent': 'remove-container' },
      body: JSON.stringify({ containerId: container.id }),
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || '컨테이너를 삭제하지 못했습니다')
    await refresh()
    showOperationToast(result.warning || container.name + ' 삭제 완료', Boolean(result.warning))
  } catch (error) {
    showOperationToast(error.message, true)
  } finally {
    stoppingContainers.delete(container.id)
    button.textContent = '×'
    button.disabled = false
  }
}

function renderContainers(containers, alerts, dockerAvailable) {
  const list = $('container-list')
  if (!dockerAvailable) { setMarkup(list, '<div class="empty">Docker 연결이 없어 컨테이너 상태를 확인할 수 없습니다.</div>'); return }
  if (!containers.length) { setMarkup(list, '<div class="empty">표시할 컨테이너가 없습니다.</div>'); return }
  if (!list.querySelector('.container-column')) {
    markupCache.delete(list)
    list.innerHTML = [['running', '실행'], ['waiting', '대기'], ['stopped', '중지']].map(([key, label]) =>
      '<section class="container-group" data-container-group="' + key + '"><h3>' + label + ' <span></span></h3><div class="container-group-grid"><div class="container-column"></div><div class="container-column"></div></div><p class="container-group-empty">해당 상태의 컨테이너가 없습니다.</p></section>'
    ).join('')
  }
  const groups = new Map([...list.querySelectorAll('[data-container-group]')].map(group => [group.dataset.containerGroup, { group, columns: group.querySelectorAll('.container-column'), count: 0 }]))
  const entries = new Map([...list.querySelectorAll('[data-container-entry]')].map((entry) => [entry.dataset.containerEntry, entry]))
  const orderedContainers = [...groups.keys()].flatMap(key => orderedGroupContainers(containers, key))
  orderedContainers.forEach((container) => {
    const stats = container.stats
    const ownAlerts = alerts.filter((alert) => alert.containerId === container.id)
    const statusName = String(container.status || '').toLowerCase()
    const danger = ownAlerts.length || statusName.includes('unhealthy')
    const preparing = containerGroupKey(container) === 'waiting'
    const group = groups.get(containerGroupKey(container))
    const index = group.count++
    const status = preparing ? '대기' : container.running ? '실행 중' : '중지'
    const statusClass = danger ? ' danger' : preparing ? ' warning' : container.running ? '' : ' stopped'
    const metric = (label, value) => '<div><div class="metric-label"><span>' + label + '</span><span class="metric-value">' + formatPercent(value, '-') + '</span></div>' + (Number.isFinite(value) ? '<div class="bar"><i class="' + (value >= 80 ? 'warn' : '') + '" style="width:' + Math.min(Math.max(value, 0), 100) + '%"></i></div>' : '') + '</div>'
    const expanded = state.expandedContainerLogs.has(container.id)
    let entry = entries.get(container.id)
    if (!entry) {
      entry = document.createElement('div')
      entry.className = 'container-entry'
      entry.dataset.containerEntry = container.id
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'container-row'
      button.dataset.containerId = container.id
      button.addEventListener('click', () => toggleContainerLogs(container.id))
      entry.append(button)
      const moveButton = document.createElement('button')
      moveButton.type = 'button'
      moveButton.className = 'container-move'
      entry.append(moveButton)
    }
    entries.delete(container.id)
    const column = group.columns[index % 2]
    if (column.children[Math.floor(index / 2)] !== entry) column.insertBefore(entry, column.children[Math.floor(index / 2)] || null)
    const row = entry.querySelector('.container-row')
    row.setAttribute('aria-expanded', String(expanded))
    const moveButton = entry.querySelector('.container-move')
    moveButton.setAttribute('aria-label', container.name + ' 순서 이동')
    moveButton.title = '드래그: 원하는 위치 · 더블클릭: 다음 자리 · 방향키: 한 자리 이동'
    setMarkup(row, '<div class="row-top"><strong class="container-name">' + escapeHtml(container.name) + '</strong><span class="status' + statusClass + '">' + status + '</span></div><div class="container-id">' + escapeHtml(container.id.slice(0, 12)) + ' · ' + escapeHtml(container.image) + '</div><div class="metrics">' + metric('CPU', stats?.cpuPercent) + metric('MEM', stats?.memoryPercent) + '</div>' + ownAlerts.map((alert) => '<div class="row-alert">' + escapeHtml(alert.message || alert.code) + '</div>').join('') + '<span class="container-log-hint">' + (expanded ? '로그 열림 · 클릭해 접기' : '클릭해 실시간 로그 펼치기') + '</span>')
    let stopButton = entry.querySelector('.container-stop')
    if (!stopButton) {
      stopButton = document.createElement('button')
      stopButton.type = 'button'
      stopButton.className = 'container-stop'
      stopButton.textContent = '×'
      row.after(stopButton)
    }
    const removable = !container.running && !preparing
    stopButton.disabled = (!container.running && !removable) || stoppingContainers.has(container.id)
    stopButton.classList.toggle('is-delete', removable)
    stopButton.setAttribute('aria-label', container.name + (removable ? ' 삭제' : container.running ? ' 중지' : ' 대기 중'))
    stopButton.title = removable ? container.name + ' 삭제' : container.running ? container.name + ' 중지' : '대기 중인 컨테이너'
    stopButton.onclick = () => void (removable ? removeContainer(container, stopButton) : stopContainer(container, stopButton))
    entry.classList.add('has-stop')
    const panel = entry.querySelector('.inline-log-panel')
    if (!expanded) panel?.remove()
    else if (!panel) {
      const lines = state.containerLogLines.get(container.id) || []
      entry.insertAdjacentHTML('beforeend', `<section class="inline-log-panel"><div class="panel-head"><div><p class="eyebrow">LIVE LOGS</p><h3>로그 · ${escapeHtml(container.name)}</h3></div><button class="text-button" type="button" data-collapse-log="${escapeHtml(container.id)}">접기</button></div><div class="log-legend" aria-label="로그 수준 색상 안내"><span class="info"><i aria-hidden="true"></i>INFO</span><span class="warning"><i aria-hidden="true"></i>WARN</span><span class="error"><i aria-hidden="true"></i>ERROR</span></div><div class="log-output" data-inline-log-output="${escapeHtml(container.id)}" role="log" aria-live="polite">${lines.length ? lines.map(logLineMarkup).join('') : '<div class="log-empty">로그를 불러오는 중…</div>'}</div></section>`)
      entry.querySelector('[data-collapse-log]').addEventListener('click', () => toggleContainerLogs(container.id))
      const output = entry.querySelector('[data-inline-log-output]')
      output.scrollTop = output.scrollHeight
    }
  })
  for (const { group, count } of groups.values()) {
    group.querySelector('h3 span').textContent = String(count)
    group.querySelector('.container-group-empty').hidden = count > 0
    group.querySelector('.container-group-grid').hidden = count === 0
  }
  for (const [id, entry] of entries) {
    entry.remove()
    state.containerLogSources.get(id)?.close()
    state.containerLogSources.delete(id)
    state.expandedContainerLogs.delete(id)
    state.containerLogLines.delete(id)
  }
}

function renderActions(alerts) {
  const actions = state.catalog?.actions || []
  const labels = { 'collect-incident': ['진단 정보 수집', '컨테이너 상태와 선택한 로그를 보고서로 저장합니다.', '≡'], 'check-docker-access': ['Docker 연결 점검', '엔진 연결과 실행 환경을 확인합니다.', '⌁'], 'scale-service': ['서비스 확장', '설정된 범위 안에서 서비스 실행 수를 늘립니다.', '↗'] }
  for (const [targetId, compact] of [['overview-actions', true]]) {
    const target = $(targetId)
    const markup = actions.map((action) => {
      const matches = alerts.filter((alert) => action.codes.includes(alert.code))
      const reasonFor = (alert) => action.id === 'scale-service' ? scaleBlockReason(action, alert) : ''
      const alert = matches.find((item) => item.id === state.responseAlertId) || matches.find((item) => !reasonFor(item)) || matches[0]
      const blockedReason = alert ? reasonFor(alert) : ''
      const enabled = Boolean(alert) && !blockedReason
      const [label, description, icon] = labels[action.id] || [action.label, action.description || '', '→']
      const note = blockedReason || (alert ? `${alert.containerName || alert.resource} · ${alert.code}` : '대응할 경고가 발생하면 활성화됩니다.')
      return `<article class="response-action-card${enabled ? ' is-ready' : ''}${blockedReason ? ' is-blocked' : ''}"><span class="response-action-icon" aria-hidden="true">${icon}</span><div class="response-action-content"><div class="response-action-heading"><h4>${escapeHtml(compact ? label : action.label)}</h4><span class="response-action-state">${enabled ? '실행 가능' : blockedReason ? '조건 확인' : '대기'}</span></div><p>${escapeHtml(compact ? description : action.description || description)}</p><small>${escapeHtml(note)}</small>${compact ? '' : `<a class="action-manual-link" href="${escapeHtml(action.manualPath || '/docs/response-scripts.md')}" target="_blank" rel="noreferrer">실행 매뉴얼 ↗</a>`}</div><button class="response-run-button" type="button" data-action-id="${escapeHtml(action.id)}" data-alert-id="${escapeHtml(alert?.id || '')}" data-focus-key="${targetId}:${escapeHtml(action.id)}" ${enabled && !state.actionRunning ? '' : 'disabled'}>${enabled ? '검토 후 실행' : blockedReason ? '실행 제한' : '경고 대기'}<span aria-hidden="true"> ↗</span></button></article>`
    }).join('') || '<p class="response-catalog-unavailable">대응 스크립트 정보를 불러오지 못했습니다. 새로고침해 다시 확인하세요.</p>'
    if (!setMarkup(target, markup)) continue
    target.querySelectorAll('[data-action-id]:not([disabled])').forEach((button) => button.addEventListener('click', () => {
      const alert = state.overview?.alerts?.find((item) => item.id === button.dataset.alertId)
      if (alert) openActionReview(button.dataset.actionId, alert.code, alert, button)
    }))
  }
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
  if (state.actionRunning) return
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
  $('action-operator-name').value = ''
  try { $('action-operator-name').value = localStorage.getItem('ops-operator-name') || '' } catch {}
  $('action-rationale').value = ''
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
  target.innerHTML = events.map((event) => `<div class="record-row"><div><strong>${escapeHtml(event.actionLabel || event.actionId)}</strong><small>${escapeHtml(new Date(event.at).toLocaleString('ko-KR'))} · ${escapeHtml(event.actorName || event.actor)} · ${escapeHtml(event.code)} · ${escapeHtml(event.target || '대상 없음')}</small>${event.rationale ? `<small>선택 근거: ${escapeHtml(event.rationale)}</small>` : ''}<small class="record-status-${event.status === 'success' ? 'success' : 'failure'}">${event.status === 'success' ? '실행 완료' : '실행 실패'}${event.includeLogs ? ' · 로그 포함' : ''}</small></div>${event.reportId ? `<a href="/api/reports/${encodeURIComponent(event.reportId)}">보고서</a>` : ''}</div>`).join('')
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
  const operatorName = $('action-operator-name').value.trim()
  const rationale = $('action-rationale').value.trim()
  if (!operatorName || !rationale) {
    showOperationToast('운영자 이름과 선택 근거를 입력하세요.', true)
    return
  }
  if (state.actionRunning) return
  state.actionRunning = true
  beginActionProgress($('confirm-action'))
  renderActions(state.overview?.alerts || [])
  $('confirm-action').disabled = true
  $('close-action-dialog').disabled = true
  $('cancel-action').disabled = true
  $('confirm-action').textContent = '실행 중…'
  renderActionResult(`${action.label} 실행 중 · ${alert.containerName || 'Docker Engine'}`)
  try {
    const response = await fetch('/api/actions/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actionId: action.id, code, alertId: alert.id, operatorName, rationale, includeLogs: $('include-recent-logs').checked }),
    })
    const result = await response.json()
    try { localStorage.setItem('ops-operator-name', operatorName) } catch {}
    if (!response.ok) {
      const failure = new Error(result.error || '알 수 없는 오류')
      failure.reportId = result.reportId || ''
      throw failure
    }
    await endActionProgress(true)
    const output = result.output || ''
    const degraded = output.includes('engine=unreachable') || output.includes('docker_cli=missing')
    const summary = output.replace(/^report=.*\n?/m, '').trim()
    const auditWarning = result.auditRecorded === false ? '\n경고: 실행 이력을 저장하지 못했습니다.' : ''
    renderActionResult(`${action.label} ${degraded ? '점검 완료 · 추가 확인 필요' : '완료'}${summary ? `\n${summary}` : ''}${auditWarning}`, result.reportId)
    showOperationToast(result.auditRecorded === false ? '작업은 실행됐지만 실행 이력을 저장하지 못했습니다.' : degraded ? `${action.label}: 연결 상태가 정상인지 확인하세요.` : `${action.label} 작업이 끝났습니다.`, result.auditRecorded === false || degraded)
    $('action-confirm-dialog').close()
    await refreshOperatorRecords().catch(() => {})
    await refresh().catch(() => {})
  } catch (error) {
    await endActionProgress(false)
    renderActionResult(`${action.label} 실패\n${error instanceof Error ? error.message : String(error)}`, error.reportId || '')
    showOperationToast(`${action.label} 실행에 실패했습니다. 대응 영역의 상세 결과를 확인하세요.`, true)
    $('action-confirm-dialog').close()
  } finally {
    state.actionRunning = false
    renderActions(state.overview?.alerts || [])
    $('confirm-action').disabled = false
    $('close-action-dialog').disabled = false
    $('cancel-action').disabled = false
    $('confirm-action').textContent = action.confirmation === 'change' ? '확인 후 변경 실행' : '검토 후 실행'
    const focusKey = pending.trigger?.dataset.focusKey
    const trigger = focusKey ? document.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`) : pending.trigger
    trigger?.focus({ preventScroll: true })
    state.pendingAction = null
  }
}

function renderActionResult(message, reportId = '') {
  for (const target of [$('overview-action-result')]) {
    target.classList.remove('hidden')
    target.textContent = message
    if (!reportId) continue
    const link = document.createElement('a')
    link.href = `/api/reports/${encodeURIComponent(reportId)}`
    link.textContent = '진단 보고서 다운로드'
    link.className = 'report-download-link'
    target.append(document.createElement('br'), link)
  }
}

let refreshSequence = 0
async function refresh() {
  const request = ++refreshSequence
  try {
    const response = await fetch('/api/overview', { cache: 'no-store', signal: AbortSignal.timeout(4500) })
    if (!response.ok) throw new Error('HTTP ' + response.status)
    const overview = await response.json()
    if (request !== refreshSequence) return
    state.overview = overview
    try { sessionStorage.setItem('rm-overview-cache', JSON.stringify(state.overview)) } catch {}
    renderOverview()
  } catch (error) {
    if (request !== refreshSequence) return
    $('error-banner').classList.remove('hidden')
    $('error-banner').textContent = '대시보드 데이터를 불러오지 못했습니다. ' + error.message
    $('connection-label').textContent = '대시보드 연결 오류'
    $('monitor-status').classList.add('is-offline')
    $('monitor-status-text').textContent = '연결 확인 필요'
    $('sidebar-engine').textContent = 'Dashboard unavailable'
    $('sidebar-engine-dot').className = 'engine-dot is-offline'
    for (const id of ['alert-count', 'nav-alert-count']) $(id).textContent = '-'
    renderResourceRanking('cpu', null)
    renderResourceRanking('memory', null)
  }
}

async function init() {
  try { const cached=JSON.parse(sessionStorage.getItem('rm-overview-cache')||'null'); if(cached&&Date.now()-cached.observedAt<20000){state.overview=cached;renderOverview()} } catch {}

  document.querySelectorAll('[data-history-filter]').forEach((button) => button.addEventListener('click', () => {
    state.historyFilter = state.historyFilter === button.dataset.historyFilter ? 'both' : button.dataset.historyFilter
    document.querySelectorAll('[data-history-filter]').forEach((item) => item.setAttribute('aria-pressed', String(state.historyFilter === 'both' || state.historyFilter === item.dataset.historyFilter)))
    renderHistory()
  }))
  const containerList = $('container-list')
  const commitContainerMove = (sourceId, targetId, before) => {
    const entries = [...containerList.querySelectorAll('[data-container-entry]')]
    const positions = new Map(entries.map(entry => [entry.dataset.containerEntry, entry.getBoundingClientRect()]))
    if (!moveContainerInGroup(sourceId, targetId, before)) return
    renderContainers(state.overview.containers, state.overview.alerts || [], state.overview.dockerAvailable)
    if (!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      for (const entry of entries) {
        const previous = positions.get(entry.dataset.containerEntry)
        const current = entry.getBoundingClientRect()
        const x = previous.left - current.left
        const y = previous.top - current.top
        if (x || y) entry.animate([{ transform: `translate(${x}px, ${y}px)` }, { transform: 'translate(0, 0)' }], { duration: 320, easing: 'cubic-bezier(.2,.75,.25,1)' })
      }
    }
    containerList.querySelectorAll('.container-move').forEach(handle => {
      if (handle.closest('[data-container-entry]')?.dataset.containerEntry === sourceId) handle.focus({ preventScroll: true })
    })
  }
  let draggedContainer = null
  let dropTarget = null
  let lastDragEndedAt = 0
  const clearDropTarget = () => {
    dropTarget?.entry.classList.remove('is-drop-before', 'is-drop-after')
    dropTarget = null
  }
  containerList.addEventListener('pointerdown', (event) => {
    const handle = event.target.closest('.container-move')
    if (!handle || (event.pointerType === 'mouse' && event.button !== 0)) return
    const entry = handle.closest('[data-container-entry]')
    const bounds = entry.querySelector('.container-row').getBoundingClientRect()
    draggedContainer = { id: entry.dataset.containerEntry, group: entry.closest('[data-container-group]').dataset.containerGroup, entry, handle, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, offsetX: event.clientX - bounds.left, offsetY: event.clientY - bounds.top, width: bounds.width, started: false, preview: null }
  })
  window.addEventListener('pointermove', (event) => {
    if (!draggedContainer || event.pointerId !== draggedContainer.pointerId) return
    if (!draggedContainer.started && Math.hypot(event.clientX - draggedContainer.startX, event.clientY - draggedContainer.startY) < 5) return
    if (!draggedContainer.started) {
      draggedContainer.started = true
      draggedContainer.entry.classList.add('is-reordering')
      draggedContainer.handle.setPointerCapture(event.pointerId)
      const preview = draggedContainer.entry.querySelector('.container-row').cloneNode(true)
      preview.classList.add('container-drag-preview')
      preview.style.width = draggedContainer.width + 'px'
      document.body.append(preview)
      draggedContainer.preview = preview
    }
    event.preventDefault()
    draggedContainer.preview.style.transform = `translate3d(${event.clientX - draggedContainer.offsetX}px, ${event.clientY - draggedContainer.offsetY}px, 0)`
    const entry = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-container-entry]')
    if (!entry || entry === draggedContainer.entry || entry.closest('[data-container-group]')?.dataset.containerGroup !== draggedContainer.group) {
      clearDropTarget()
      return
    }
    const sourceRow = draggedContainer.entry.querySelector('.container-row').getBoundingClientRect()
    const targetRow = entry.querySelector('.container-row').getBoundingClientRect()
    const sameRow = Math.abs(sourceRow.top - targetRow.top) < 8
    const before = sameRow
      ? sourceRow.left > targetRow.left
      : event.clientY < targetRow.top + targetRow.height / 2
    if (dropTarget?.entry === entry && dropTarget.before === before) return
    clearDropTarget()
    dropTarget = { entry, before }
    entry.classList.add(before ? 'is-drop-before' : 'is-drop-after')
  })
  const finishContainerDrag = (event) => {
    if (!draggedContainer || (event.pointerId !== undefined && event.pointerId !== draggedContainer.pointerId)) return
    if (draggedContainer.started) lastDragEndedAt = performance.now()
    const sourceId = draggedContainer.id
    const targetId = dropTarget?.entry.dataset.containerEntry
    const before = dropTarget?.before
    draggedContainer.entry.classList.remove('is-reordering')
    draggedContainer.preview?.remove()
    clearDropTarget()
    draggedContainer = null
    if (event.type === 'pointerup' && targetId) commitContainerMove(sourceId, targetId, before)
  }
  window.addEventListener('pointerup', finishContainerDrag)
  window.addEventListener('pointercancel', finishContainerDrag)
  window.addEventListener('blur', finishContainerDrag)
  containerList.addEventListener('dblclick', (event) => {
    const handle = event.target.closest('.container-move')
    if (!handle || performance.now() - lastDragEndedAt < 400) return
    event.preventDefault()
    const entry = handle.closest('[data-container-entry]')
    const key = entry.closest('[data-container-group]').dataset.containerGroup
    const items = orderedGroupContainers(state.overview?.containers || [], key)
    if (items.length < 2) return
    const index = items.findIndex(item => item.id === entry.dataset.containerEntry)
    const next = items[(index + 1) % items.length]
    commitContainerMove(entry.dataset.containerEntry, next.id, index === items.length - 1)
  })
  containerList.addEventListener('keydown', (event) => {
    const handle = event.target.closest('.container-move')
    if (!handle || !['ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    const entry = handle.closest('[data-container-entry]')
    const key = entry.closest('[data-container-group]').dataset.containerGroup
    const items = orderedGroupContainers(state.overview?.containers || [], key)
    const index = items.findIndex(item => item.id === entry.dataset.containerEntry)
    const target = items[index + (event.key === 'ArrowUp' ? -1 : 1)]
    if (target) commitContainerMove(entry.dataset.containerEntry, target.id, event.key === 'ArrowUp')
  })
  let logDrag = null
  let suppressDraggedClick = false
  containerList.addEventListener('pointerdown', (event) => {
    if (!event.target.closest('.inline-log-panel') || (event.pointerType === 'mouse' && event.button !== 0)) return
    logDrag = { pointerId: event.pointerId, startX: event.clientX, scrollLeft: containerList.scrollLeft, moved: false }
  })
  containerList.addEventListener('pointermove', (event) => {
    if (!logDrag || logDrag.pointerId !== event.pointerId) return
    const delta = event.clientX - logDrag.startX
    if (!logDrag.moved && Math.abs(delta) < 6) return
    if (!logDrag.moved) { logDrag.moved = true; containerList.setPointerCapture(event.pointerId) }
    containerList.scrollLeft = logDrag.scrollLeft - delta
    containerList.classList.add('is-log-dragging')
  })
  const finishLogDrag = (event) => {
    if (!logDrag || logDrag.pointerId !== event.pointerId) return
    if (logDrag.moved) suppressDraggedClick = true
    logDrag = null
    containerList.classList.remove('is-log-dragging')
  }
  containerList.addEventListener('pointerup', finishLogDrag)
  containerList.addEventListener('pointercancel', finishLogDrag)
  containerList.addEventListener('click', (event) => {
    if (!suppressDraggedClick) return
    event.preventDefault()
    event.stopPropagation()
    suppressDraggedClick = false
  }, true)
  showView()
  window.addEventListener('hashchange', showView)
  document.querySelectorAll('[data-nav-card]').forEach((card) => {
    const navigate = () => { window.location.hash = card.dataset.navCard }
    card.addEventListener('click', (event) => { if (!event.target.closest('a, button, summary, input, select, details')) navigate() })
    card.addEventListener('keydown', (event) => { if (event.target.closest('a, button, summary, input, select, details')) return; if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); navigate() } })
  })
  $('refresh-now').addEventListener('click', () => { void refresh() })
  $('refresh-packages').addEventListener('click', () => { void refreshPackages(true) })
  $('toggle-package-security').addEventListener('click', () => {
    const content = $('package-advisories')
    const isExpanded = $('toggle-package-security').getAttribute('aria-expanded') === 'true'
    content.classList.toggle('hidden', isExpanded)
    $('toggle-package-security').setAttribute('aria-expanded', String(!isExpanded))
    $('toggle-package-security').textContent = isExpanded ? '목록 펼치기' : '목록 접기'
  })
  $('package-search').addEventListener('input', () => { if (state.packages) renderPackages(state.packages) })
  $('package-service-filter').addEventListener('change', () => { if (state.packages) renderPackages(state.packages) })
  $('package-scope-filter').addEventListener('change', () => { if (state.packages) renderPackages(state.packages) })
  $('package-expand-all').addEventListener('click', () => {
    const groups = [...document.querySelectorAll('.package-group')]
    const shouldOpen = groups.some((group) => !group.open)
    groups.forEach((group) => { group.open = shouldOpen })
    $('package-expand-all').textContent = shouldOpen ? '모두 접기' : '모두 펼치기'
  })
  $('brand-refresh').addEventListener('click', () => window.location.reload())
  $('close-action-dialog').addEventListener('click', () => $('action-confirm-dialog').close())
  $('cancel-action').addEventListener('click', () => $('action-confirm-dialog').close())
  $('confirm-action').addEventListener('click', () => { void runAction() })
  $('refresh-records').addEventListener('click', () => { void refreshOperatorRecords().catch((error) => showOperationToast(error.message, true)) })
  $('cleanup-old-reports').addEventListener('click', () => openRecordConfirmation('cleanup'))
  $('close-record-dialog').addEventListener('click', () => $('record-confirm-dialog').close())
  $('cancel-record-operation').addEventListener('click', () => $('record-confirm-dialog').close())
  $('confirm-record-operation').addEventListener('click', () => { void performRecordOperation() })
  try {
    const response = await fetch('/api/error-codes')
    if (!response.ok) throw new Error('HTTP ' + response.status)
    state.catalog = await response.json()
    $('codes-list').innerHTML = state.catalog.codes.map((item) => '<article class="code-item"><code>' + escapeHtml(item.code) + '</code><strong>' + escapeHtml(item.title) + '</strong><p>' + escapeHtml(item.trigger) + '<br />대응: ' + escapeHtml(item.response) + '</p></article>').join('')
  } catch (error) {
    $('codes-list').innerHTML = '<div class="empty">오류 코드 목록을 불러오지 못했습니다.</div>'
    $('overview-actions').innerHTML = '<div class="empty">대응 스크립트 목록을 불러오지 못했습니다.</div>'
  }
  try {
    const response = await fetch('/api/status-codes')
    if (response.ok) state.httpCodes = (await response.json()).codes || []
  } catch { /* Counts remain available when the code reference cannot be loaded. */ }
  await refresh()
  await refreshPackages()
  await refreshOperatorRecords().catch((error) => showOperationToast(error.message, true))
  setInterval(() => { void refresh() }, 5000)
  setInterval(() => { if (window.location.hash === '#packages') void refreshPackages() }, 60_000)
}

void init()

function containerKind(container) {
  const name = `${container.composeService || ''} ${container.name || ''}`.trim().toLowerCase()
  const rules = [
    [/model[-_]server|ml[-_]service[-_]api/, '모델 API', '모델 추론과 API 요청 처리'],
    [/frontend|front[-_]end|(?:^|[-_])web(?:[-_]|$)/, '프론트엔드', '웹 화면 제공 및 API 프록시'],
    [/backend|back[-_]end/, '백엔드', '인증·문서 처리·서비스 API'],
    [/mariadb|mysql|postgres|database|(?:^|[-_])db(?:[-_]|$)/, '데이터베이스', '서비스 데이터 저장'],
    [/ollama|embedding/, '임베딩', '검색용 벡터 생성'],
    [/grafana|prometheus|metrics|dashboard/, '모니터링', '지표 수집·시각화·운영 관측'],
    [/(?:^|[-_\s])api(?:[-_\s]|$)/, 'API', 'API 요청 처리'],
    [/nginx|proxy|traefik/, '프록시', '서비스 요청 전달 및 라우팅'],
    [/worker|celery/, '작업 워커', '백그라운드 작업 처리'],
    [/redis|cache/, '캐시', '캐시·임시 데이터 처리'],
  ]
  const match = rules.find(([pattern]) => pattern.test(name))
  return match ? {type:match[1], description:match[2]} : {type:'미분류', description:'이름만으로 역할을 확인할 수 없습니다.'}
}

function renderContainerDirectory(containers, available) {
  const target = $('container-directory')
  if (!available || !containers.length) { setMarkup(target, '<p class="empty">컨테이너 정보를 확인할 수 없습니다.</p>'); return }
  const groups = groupContainerKinds(containers)
  const scrollTop = target.scrollTop
  const changed = setMarkup(target, `<div class="directory-total"><strong>전체 ${containers.length}개</strong><span>${groups.length}개 종류 · 이름 규약 기준</span></div>` + groups.map(group => {
    const members = group.items.map(container => `<details class="directory-item directory-member" data-detail-id="directory:${escapeHtml(container.id)}"><summary><strong title="${escapeHtml(container.name)}">${escapeHtml(container.name)}</strong><span class="directory-state ${container.running ? 'is-running' : 'is-stopped'}">${container.running ? '실행 중' : '중지'}</span></summary><dl><dt>이미지</dt><dd>${escapeHtml(container.image)}</dd><dt>서비스</dt><dd>${escapeHtml(container.composeService || '정보 없음')}</dd><dt>컨테이너 ID</dt><dd>${escapeHtml(container.id)}</dd></dl></details>`).join('')
    return `<details class="directory-group" name="container-role" data-detail-id="role:${escapeHtml(group.type)}"><summary><span class="directory-group-arrow" aria-hidden="true">›</span><strong>${escapeHtml(group.type)}</strong><b>${group.items.length}</b><span class="directory-group-counts"><span class="running-count">실행 ${group.runningCount}</span><span>중지 ${group.items.length-group.runningCount}</span></span></summary><div class="directory-members"><p>${escapeHtml(group.description)}</p>${members}</div></details>`
  }).join(''))
  if (changed) target.scrollTop = scrollTop
}

function groupContainerKinds(containers) {
  const groups = new Map()
  for (const container of containers) {
    const kind = containerKind(container)
    if (!groups.has(kind.type)) groups.set(kind.type, {...kind, items:[], runningCount:0})
    const group = groups.get(kind.type)
    group.items.push(container)
    if (container.running) group.runningCount++
  }
  return [...groups.values()].sort((a,b) => b.items.length-a.items.length || a.type.localeCompare(b.type))
}
