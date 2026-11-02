export function summarizeMetrics(overview) {
  if (!overview?.dockerAvailable) return { running: null, total: null, cpu: null, memory: null }
  const containers = overview.containers || []
  const running = containers.filter((container) => container.running)
  const stats = running.map((container) => container.stats)
  if (!running.length) return { running: 0, total: containers.length, cpu: null, memory: null }
  const complete = stats.every((item) => item && Number.isFinite(item.cpuPercent) && Number.isFinite(item.memoryUsedBytes) && Number.isFinite(item.memoryLimitBytes) && item.memoryLimitBytes > 0)
  if (!complete) return { running: running.length, total: containers.length, cpu: null, memory: null }
  const used = stats.reduce((sum, item) => sum + item.memoryUsedBytes, 0)
  const limit = stats.reduce((sum, item) => sum + item.memoryLimitBytes, 0)
  return {
    running: running.length,
    total: containers.length,
    cpu: stats.reduce((sum, item) => sum + item.cpuPercent, 0),
    memory: limit ? used / limit * 100 : null,
  }
}

export function formatPercent(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : '수집 불가'
}
