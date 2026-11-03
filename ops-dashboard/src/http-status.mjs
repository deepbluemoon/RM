const STATUS_CODES = [
  [100, 'Continue'], [101, 'Switching Protocols'], [102, 'Processing'], [103, 'Early Hints'], [104, 'Upload Resumption Supported', 'temporary'],
  [200, 'OK'], [201, 'Created'], [202, 'Accepted'], [203, 'Non-Authoritative Information'], [204, 'No Content'], [205, 'Reset Content'], [206, 'Partial Content'], [207, 'Multi-Status'], [208, 'Already Reported'], [226, 'IM Used'],
  [300, 'Multiple Choices'], [301, 'Moved Permanently'], [302, 'Found'], [303, 'See Other'], [304, 'Not Modified'], [305, 'Use Proxy'], [306, '(Unused)', 'unused'], [307, 'Temporary Redirect'], [308, 'Permanent Redirect'],
  [400, 'Bad Request'], [401, 'Unauthorized'], [402, 'Payment Required'], [403, 'Forbidden'], [404, 'Not Found'], [405, 'Method Not Allowed'], [406, 'Not Acceptable'], [407, 'Proxy Authentication Required'], [408, 'Request Timeout'], [409, 'Conflict'], [410, 'Gone'], [411, 'Length Required'], [412, 'Precondition Failed'], [413, 'Content Too Large'], [414, 'URI Too Long'], [415, 'Unsupported Media Type'], [416, 'Range Not Satisfiable'], [417, 'Expectation Failed'], [418, '(Unused)', 'unused'], [421, 'Misdirected Request'], [422, 'Unprocessable Content'], [423, 'Locked'], [424, 'Failed Dependency'], [425, 'Too Early'], [426, 'Upgrade Required'], [428, 'Precondition Required'], [429, 'Too Many Requests'], [431, 'Request Header Fields Too Large'], [451, 'Unavailable For Legal Reasons'],
  [500, 'Internal Server Error'], [501, 'Not Implemented'], [502, 'Bad Gateway'], [503, 'Service Unavailable'], [504, 'Gateway Timeout'], [505, 'HTTP Version Not Supported'], [506, 'Variant Also Negotiates'], [507, 'Insufficient Storage'], [508, 'Loop Detected'], [510, 'Not Extended', 'obsoleted'], [511, 'Network Authentication Required'],
].map(([code, description, lifecycle = 'active']) => ({
  code,
  tag: `HTTP-${code}`,
  class: `${Math.floor(code / 100)}xx`,
  description,
  lifecycle,
}))

export const HTTP_STATUS_CODES = STATUS_CODES
export const HTTP_STATUS_CODE_MAP = new Map(HTTP_STATUS_CODES.map((item) => [item.code, item]))

export const HTTP_STATUS_ALERT_RULES = [
  { code: 'HTTP-404-RATE-001', title: 'HTTP 404 비율 급증', statusClass: '4xx', matchCodes: [404], thresholdRate: 20, minSamples: 10, actionIds: [] },
  { code: 'HTTP-429-RATE-001', title: 'HTTP 429 비율 급증', statusClass: '4xx', matchCodes: [429], thresholdRate: 10, minSamples: 10, actionIds: [] },
  { code: 'HTTP-5XX-RATE-001', title: 'HTTP 5xx 비율 급증', statusClass: '5xx', thresholdRate: 5, minSamples: 10, actionIds: ['collect-incident'] },
]

function toStatusCode(value) {
  const code = Number.parseInt(String(value), 10)
  return Number.isInteger(code) && code >= 100 && code <= 599 ? code : null
}

export function statusClassFor(code) {
  const parsed = toStatusCode(code)
  return parsed ? `${Math.floor(parsed / 100)}xx` : null
}

function safeField(value) {
  const text = String(value ?? '').trim()
  return /^[A-Za-z0-9._:-]{1,128}$/.test(text) ? text : ''
}

function safePath(value) {
  const text = String(value ?? '').split(/[?#]/, 1)[0]
  if (!text.startsWith('/') || text.length > 512 || /[\u0000-\u001f\u007f]/.test(text)) return ''
  return text
}

function jsonAdapter(text) {
  let data
  try { data = JSON.parse(text) } catch { return null }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const request = data.request && typeof data.request === 'object' ? data.request : {}
  const response = data.response && typeof data.response === 'object' ? data.response : {}
  const status = data.status ?? data.statusCode ?? data.httpStatus ?? data.responseStatus ?? response.status
  const method = data.method ?? request.method
  const route = data.route ?? data.routePattern ?? data.pathTemplate
  const path = route ?? data.path ?? data.url ?? request.path ?? request.url
  const requestId = data.requestId ?? data.request_id ?? request.id
  const traceId = data.traceId ?? data.trace_id ?? data['trace.id'] ?? data.trace?.id
  const deploymentVersion = data.deploymentVersion ?? data.release ?? data.version
  return { status, method, path, requestId, traceId, deploymentVersion }
}

function combinedAccessLogAdapter(text) {
  const match = text.match(/"([A-Z]{3,12})\s+(\S+)\s+HTTP\/\d(?:\.\d)?"\s+([1-5]\d{2})\s+(?:\d+|-)(?:\s|$)/)
  return match ? { method: match[1], path: match[2], status: match[3] } : null
}

function statusOnlyAdapter(text) {
  const patterns = [
    /["']?(?:status|statusCode|httpStatus|responseStatus)["']?\s*[:=]\s*["']?([1-5]\d{2})\b/i,
    /\bHTTP\/\d(?:\.\d)?\s+([1-5]\d{2})\b/i,
  ]
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match) return { status: match[1] }
  }
  return null
}

export const HTTP_LOG_ADAPTERS = [jsonAdapter, combinedAccessLogAdapter, statusOnlyAdapter]

export function parseHttpLogLine(line) {
  const text = String(line ?? '')
  if (!text) return null
  let parsed = null
  for (const adapter of HTTP_LOG_ADAPTERS) {
    parsed = adapter(text)
    if (parsed) break
  }
  if (!parsed) return null
  const code = toStatusCode(parsed.status)
  const status = code && HTTP_STATUS_CODE_MAP.get(code)
  if (!status) return null
  const routeValue = parsed.path
  return {
    status,
    method: /^[A-Z]{3,12}$/.test(String(parsed.method ?? '').toUpperCase()) ? String(parsed.method).toUpperCase() : '',
    path: safePath(routeValue),
    requestId: safeField(parsed.requestId),
    traceId: safeField(parsed.traceId),
    deploymentVersion: safeField(parsed.deploymentVersion),
  }
}

export function parseHttpStatusLine(line) {
  return parseHttpLogLine(line)?.status || null
}

function round(value) {
  return Math.round(value * 10) / 10
}

function emptyCounts() {
  return Object.fromEntries(HTTP_STATUS_CODES.map((item) => [item.code, 0]))
}

export function summarizeHttpStatusLines(lines = []) {
  const counts = emptyCounts()
  let parsedLines = 0
  for (const line of lines) {
    const status = parseHttpStatusLine(line)
    if (!status) continue
    counts[status.code] += 1
    parsedLines += 1
  }
  const classCounts = { '1xx': 0, '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 }
  for (const item of HTTP_STATUS_CODES) classCounts[item.class] += counts[item.code]
  return { total: parsedLines, counts, classCounts }
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(seconds))
  if (total >= 3_600) return `${Math.floor(total / 3_600)}시간 ${Math.floor(total % 3_600 / 60)}분`
  if (total >= 60) return `${Math.floor(total / 60)}분 ${total % 60}초`
  return `${total}초`
}

export function createHttpStatusAggregator({
  now = () => Date.now(),
  alertDurationMs = 30_000,
  rules = HTTP_STATUS_ALERT_RULES,
} = {}) {
  const startedAt = new Map()
  let latest = { observedAt: now(), containers: [], totals: summarizeHttpStatusLines([]), alerts: [], collectionErrors: [] }

  function observe(containers, logsByContainer = {}, observedAt = now(), collectionErrors = []) {
    const containerSummaries = containers.filter((container) => container.running).map((container) => ({
      id: container.id,
      name: container.name,
      image: container.image,
      ...summarizeHttpStatusLines(logsByContainer[container.id] || []),
    }))
    const totals = summarizeHttpStatusLines([])
    for (const summary of containerSummaries) {
      totals.total += summary.total
      for (const item of HTTP_STATUS_CODES) {
        totals.counts[item.code] += summary.counts[item.code]
        totals.classCounts[item.class] += summary.classCounts[item.class]
      }
    }

    const alerts = []
    const activeKeys = new Set()
    for (const container of containerSummaries) {
      for (const rule of rules) {
        const matched = rule.matchCodes?.length
          ? rule.matchCodes.reduce((sum, code) => sum + (container.counts[code] || 0), 0)
          : container.classCounts[rule.statusClass] || 0
        const rate = container.total ? matched / container.total * 100 : 0
        const key = `${container.id}:${rule.code}`
        if (container.total >= rule.minSamples && rate >= rule.thresholdRate) {
          activeKeys.add(key)
          const started = startedAt.get(key) ?? observedAt
          startedAt.set(key, started)
          const durationSec = Math.max(0, Math.floor((observedAt - started) / 1_000))
          if (observedAt - started >= alertDurationMs) {
            alerts.push({
              id: `${rule.code}:${container.id}`,
              code: rule.code,
              kind: 'http',
              severity: rule.statusClass === '5xx' ? 'critical' : 'warning',
              containerId: container.id,
              containerName: container.name,
              containerImage: container.image,
              resource: `HTTP ${rule.statusClass}`,
              statusClass: rule.statusClass,
              count: matched,
              total: container.total,
              value: round(rate),
              unit: '%',
              startedAt: new Date(started).toISOString(),
              durationSec,
              stateful: false,
              message: `${container.name} ${rule.title} — ${matched}/${container.total}건 (${round(rate)}%)이 ${formatDuration(durationSec)} 동안 지속`,
            })
          }
        }
      }
    }
    for (const key of startedAt.keys()) if (!activeKeys.has(key)) startedAt.delete(key)
    latest = { observedAt, containers: containerSummaries, totals, alerts, collectionErrors }
    return latest
  }

  return { observe, getState: () => latest }
}
