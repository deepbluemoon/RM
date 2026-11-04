export function httpChartData(status, dockerAvailable) {
  if (!dockerAvailable || !status) return { state: 'unavailable', bars: [] }
  const partial = Boolean(status.collectionErrors?.length)
  const counts = status.totals?.classCounts
  if (!counts) return { state: 'unavailable', bars: [] }
  const values = ['1xx', '2xx', '3xx', '4xx', '5xx'].map((label) => ({ label, count: counts[label] }))
  if (values.some(({ count }) => !Number.isSafeInteger(count) || count < 0)) return { state: 'unavailable', bars: [] }
  const total = values.reduce((sum, item) => sum + item.count, 0)
  if (!total) return { state: partial ? 'unavailable' : 'empty', bars: [] }
  return { state: partial ? 'partial' : 'ready', total, bars: values.filter(({ count }) => count > 0).map((item) => ({ ...item, percent: item.count / total * 100 })) }
}

export function selectHttpContainer(status, containerId = '') {
  if (!status || !containerId) return status
  const container = (status.containers || []).find((item) => item.id === containerId)
  if (!container) return { ...status, totals: null, containers: [], routes: [], correlations: [] }
  const names = (status.containers || []).map((item) => item.name).filter(Boolean)
  const collectionErrors = (status.collectionErrors || []).filter((error) => {
    const text = String(error)
    return text.startsWith(`${container.name}:`) || !names.some((name) => text.startsWith(`${name}:`))
  })
  return { ...status, totals: { total: container.total, counts: container.counts, classCounts: container.classCounts }, containers: [container], routes: [], correlations: (status.correlations || []).filter((item) => item.containerName === container.name), collectionErrors }
}

export function httpResponseDetails(status, statusClass, catalog = []) {
  const descriptions = new Map(catalog.map((item) => [Number(item.code), item.description]))
  return Object.entries(status?.totals?.counts || {})
    .filter(([code, count]) => `${Math.floor(Number(code) / 100)}xx` === statusClass && Number.isSafeInteger(count) && count > 0)
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([code, count]) => {
      const services = (status.containers || []).filter((item) => item.counts?.[code] > 0)
      const sources = services.map((item) => `${item.name || item.id} (${item.counts[code]}건)`)
      return { code: Number(code), count, description: descriptions.get(Number(code)) || 'HTTP 응답', sources }
    })
}
