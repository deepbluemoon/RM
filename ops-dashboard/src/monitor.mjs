import { createHttpStatusAggregator } from './http-status.mjs'

const METRICS = [
  { key: 'cpuPercent', label: 'CPU', code: 'OPS-CPU-80-001', unit: '%' },
  { key: 'memoryPercent', label: '메모리', code: 'OPS-MEM-80-001', unit: '%' },
]

function round(value) {
  return Math.round(value * 10) / 10
}

export function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(total / 3_600)
  const minutes = Math.floor((total % 3_600) / 60)
  const secs = total % 60
  if (hours) return `${hours}시간 ${minutes}분`
  if (minutes) return `${minutes}분 ${secs}초`
  return `${secs}초`
}

export function createMonitor({
  readSnapshot,
  readStatusLogs = async () => ({ logs: {}, errors: [] }),
  threshold = 80,
  clearThreshold = Math.max(0, threshold - 5),
  alertForMs = 15_000,
  recoveryForMs = 30_000,
  now = () => Date.now(),
  httpStatusAlertDurationMs = 30_000,
  deploymentVersion = '',
} = {}) {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) throw new RangeError('자원 경고 임계치는 0~100 사이여야 합니다')
  if (!Number.isFinite(clearThreshold) || clearThreshold < 0 || clearThreshold >= threshold) throw new RangeError('자원 경고 해제 임계치는 경고 임계치보다 낮아야 합니다')
  if (!Number.isFinite(alertForMs) || alertForMs < 0) throw new RangeError('자원 경고 시작 지속시간은 0 이상이어야 합니다')
  if (!Number.isFinite(recoveryForMs) || recoveryForMs < 0) throw new RangeError('자원 경고 해제 지속시간은 0 이상이어야 합니다')
  const resourceStates = new Map()
  const httpStatusMonitor = createHttpStatusAggregator({ now, alertDurationMs: httpStatusAlertDurationMs, deploymentVersion })
  let latest = { observedAt: now(), containers: [], alerts: [], dockerAvailable: true, statusCodes: httpStatusMonitor.getState() }

  function makeAlerts(containers, observedAt) {
    const alerts = []
    const observedKeys = new Set()
    for (const container of containers) {
      for (const metric of METRICS) {
        const value = container.stats?.[metric.key]
        if (typeof value !== 'number') continue
        const key = `${container.id}:${metric.key}`
        observedKeys.add(key)
        let state = resourceStates.get(key)
        if (value >= threshold) {
          if (!state) {
            state = { startedAt: observedAt, active: false, recoveryStartedAt: null }
            resourceStates.set(key, state)
          }
          state.recoveryStartedAt = null
          if (!state.active && observedAt - state.startedAt >= alertForMs) state.active = true
        } else if (state && !state.active) {
          // A brief spike that did not last long enough never becomes an alert.
          resourceStates.delete(key)
          state = null
        } else if (state && value < clearThreshold) {
          state.recoveryStartedAt ??= observedAt
          if (observedAt - state.recoveryStartedAt >= recoveryForMs) {
            resourceStates.delete(key)
            state = null
          }
        } else if (state) {
          // Between the clear and trigger thresholds, retain the active alert.
          state.recoveryStartedAt = null
        }

        if (!state?.active) continue
        const durationSec = Math.max(0, Math.floor((observedAt - state.startedAt) / 1_000))
        const recovering = state.recoveryStartedAt !== null
        const recoveryDurationSec = recovering ? Math.max(0, Math.floor((observedAt - state.recoveryStartedAt) / 1_000)) : 0
        alerts.push({
          id: `${metric.code}:${container.id}`,
          code: metric.code,
          severity: 'warning',
          phase: recovering ? 'recovering' : 'active',
          containerId: container.id,
          containerName: container.name,
          containerImage: container.image,
          composeService: container.composeService || '',
          stateful: /(?:mariadb|mysql)(?::|$|\/)/i.test(`${container.image || ''}:${container.name || ''}`),
          resource: metric.label,
          value: round(value),
          unit: metric.unit,
          startedAt: new Date(state.startedAt).toISOString(),
          durationSec,
          recoveryDurationSec,
          message: recovering
            ? `${container.name} ${metric.label} ${round(value)}% — ${clearThreshold}% 미만 회복 중 ${recoveryDurationSec}/${Math.ceil(recoveryForMs / 1_000)}초`
            : `${container.name} ${metric.label} ${round(value)}% — 경고 ${formatDuration(durationSec)} 유지 중 (해제 기준 ${clearThreshold}% 미만)`,
        })
      }
    }
    for (const key of resourceStates.keys()) if (!observedKeys.has(key)) resourceStates.delete(key)
    return alerts
  }

  async function tick() {
    const observedAt = now()
    try {
      const containers = await readSnapshot()
      let statusCollection = { logs: {}, errors: [] }
      try {
        statusCollection = await readStatusLogs(containers)
      } catch (error) {
        statusCollection = { logs: {}, errors: [error instanceof Error ? error.message : String(error)] }
      }
      const statusCodes = httpStatusMonitor.observe(containers, statusCollection.logs || statusCollection, observedAt, statusCollection.errors || [])
      latest = {
        observedAt,
        containers,
        alerts: [...makeAlerts(containers, observedAt), ...statusCodes.alerts],
        statusCodes,
        dockerAvailable: true,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const startedAt = latest.error ? latest.alerts.find((alert) => alert.code === 'OPS-DOCKER-001')?.startedAt : new Date(observedAt).toISOString()
      latest = {
        ...latest,
        observedAt,
        dockerAvailable: false,
        error: message,
        alerts: [{
          id: 'OPS-DOCKER-001',
          code: 'OPS-DOCKER-001',
          severity: 'critical',
          containerId: '',
          containerName: 'Docker Engine',
          resource: 'Docker 연결',
          value: 0,
          unit: '',
          startedAt: startedAt || new Date(observedAt).toISOString(),
          durationSec: 0,
          message: `Docker 엔진 연결 실패 — ${message}`,
        }],
      }
    }
    return latest
  }

  return { tick, getState: () => latest }
}

export const monitoredMetrics = METRICS
