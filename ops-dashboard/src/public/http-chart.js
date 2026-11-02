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
