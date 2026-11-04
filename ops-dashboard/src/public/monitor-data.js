export function wallSummary(data, now = Date.now()) {
  const containers = data?.containers || []
  const running = containers.filter(item => item.running)
  const stale = !Number.isFinite(data?.observedAt) || now - data.observedAt > 20000
  const available = data?.dockerAvailable === true && !stale
  const total = field => available && running.length && running.every(item => Number.isFinite(item.stats?.[field]) && item.stats[field] >= 0)
    ? running.reduce((sum, item) => sum + item.stats[field], 0) : null
  return { available, stale, running: available ? running.length : null, total: available ? containers.length : null, cpu: total('cpuPercent'), memory: total('memoryUsedBytes') }
}
export function chartSegments(samples, field, end, max) {
  const segments = []
  let points = []
  for (const item of samples) {
    if (!Number.isFinite(item[field])) { if (points.length) segments.push(points.join(' ')); points = []; continue }
    const x = Math.max(0, Math.min(600, (item.at - (end - 300000)) / 300000 * 600))
    points.push(`${x.toFixed(1)},${(145 - Math.min(item[field] / max, 1) * 135).toFixed(1)}`)
  }
  if (points.length) segments.push(points.join(' '))
  return segments
}
