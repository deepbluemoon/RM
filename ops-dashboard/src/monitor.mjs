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

export function createMonitor({ readSnapshot, readStatusLogs = async () => ({ logs: {}, errors: [] }), threshold = 80, now = () => Date.now(), httpStatusAlertDurationMs = 30_000 } = {}) {
  const thresholdStartedAt = new Map()
  const httpStatusMonitor = createHttpStatusAggregator({ now, alertDurationMs: httpStatusAlertDurationMs })
  let latest = { observedAt: now(), containers: [], alerts: [], dockerAvailable: true, statusCodes: httpStatusMonitor.getState() }

  function makeAlerts(containers, observedAt) {
    const alerts = []
    const activeKeys = new Set()
    for (const container of containers) {
      for (const metric of METRICS) {
        const value = container.stats?.[metric.key]
        if (typeof value !== 'number') continue
        const key = `${container.id}:${metric.key}`
        if (value >= threshold) {
          activeKeys.add(key)
          const startedAt = thresholdStartedAt.get(key) ?? observedAt
          thresholdStartedAt.set(key, startedAt)
          alerts.push({
            id: `${metric.code}:${container.id}`,
            code: metric.code,
            severity: 'warning',
            containerId: container.id,
            containerName: container.name,
            containerImage: container.image,
            composeService: container.composeService || '',
            stateful: /(?:mariadb|mysql)(?::|$|\/)/i.test(`${container.image || ''}:${container.name || ''}`),
            resource: metric.label,
            value: round(value),
            unit: metric.unit,
            startedAt: new Date(startedAt).toISOString(),
            durationSec: Math.max(0, Math.floor((observedAt - startedAt) / 1_000)),
            message: `${container.name} ${metric.label} 사용률 ${round(value)}% — ${formatDuration((observedAt - startedAt) / 1_000)} 동안 ${threshold}% 이상`,
          })
        }
      }
    }
    for (const key of thresholdStartedAt.keys()) if (!activeKeys.has(key)) thresholdStartedAt.delete(key)
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
