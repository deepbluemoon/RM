export function summarizeMetrics(overview) {
  if (!overview?.dockerAvailable) return { running: null, total: null, cpu: null, memory: null }
  const containers = overview.containers || []
  const running = containers.filter((container) => container.running)
  const stats = running.map((container) => container.stats)
  if (!running.length) return { running: 0, total: containers.length, cpu: null, memory: null }
  const cpuComplete = stats.every((item) => Number.isFinite(item?.cpuPercent))
  const memoryComplete = stats.every((item) => Number.isFinite(item?.memoryUsedBytes) && Number.isFinite(item?.memoryLimitBytes) && item.memoryLimitBytes > 0)
  return {
    running: running.length,
    total: containers.length,
    cpu: cpuComplete ? stats.reduce((sum, item) => sum + item.cpuPercent, 0) : null,
    memory: memoryComplete ? stats.reduce((sum, item) => sum + item.memoryUsedBytes, 0) / stats.reduce((sum, item) => sum + item.memoryLimitBytes, 0) * 100 : null,
  }
}

export function formatPercent(value, unavailable = '수집 불가') {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : unavailable
}

export function topContainerMetrics(overview, metric) {
  const running = overview?.dockerAvailable ? (overview.containers || []).filter((item) => item.running) : []
  const field = metric === 'cpu' ? 'cpuPercent' : 'memoryUsedBytes'
  const measured = running.filter((item) => Number.isFinite(item.stats?.[field]) && item.stats[field] >= 0)
  const items = measured.map((item) => ({ id: item.id, name: item.name || item.id, value: item.stats[field] }))
    .sort((left, right) => right.value - left.value || left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
    .slice(0, 5)
  return { items, measuredCount: measured.length, runningCount: running.length }
}
