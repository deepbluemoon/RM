import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readSnapshot, readLogs, streamLogs, assertContainerId } from './docker.mjs'
import { createMonitor } from './monitor.mjs'
import { ACTIONS, canRunAction, runAction } from './actions.mjs'
import { ERROR_CODES } from './errors.mjs'
import { HTTP_STATUS_CODES, HTTP_STATUS_ALERT_RULES } from './http-status.mjs'
import { readActionHistory, recordActionEvent } from './action-audit.mjs'
import { deleteExpiredReports, deleteReport, listReports, readReport } from './reports.mjs'

const root = path.dirname(fileURLToPath(import.meta.url))
const publicDir = path.join(root, 'public')
const port = Number(process.env.OPS_DASHBOARD_PORT || 9760)
const host = process.env.OPS_DASHBOARD_HOST || '127.0.0.1'
const pollMs = Math.max(1_000, Number(process.env.OPS_DASHBOARD_POLL_MS || 5_000))
const statusLogTail = Math.min(Math.max(Number(process.env.OPS_HTTP_STATUS_LOG_TAIL || 200), 20), 1_000)

async function readStatusLogs(containers) {
  const logs = {}
  const errors = []
  await Promise.all(containers.filter((container) => container.running).map(async (container) => {
    try {
      const output = await readLogs(container.id, { tail: statusLogTail })
      logs[container.id] = output.split('\n').filter(Boolean)
    } catch (error) {
      errors.push(`${container.name}: ${error instanceof Error ? error.message : String(error)}`)
      logs[container.id] = []
    }
  }))
  return { logs, errors }
}

const monitor = createMonitor({
  readSnapshot,
  readStatusLogs,
  threshold: Number(process.env.OPS_RESOURCE_THRESHOLD || 80),
  httpStatusAlertDurationMs: Math.max(0, Number(process.env.OPS_HTTP_STATUS_ALERT_DURATION_MS || 30_000)),
  deploymentVersion: process.env.OPS_DEPLOYMENT_VERSION || '',
})

const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' }

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function routePath(req) {
  return new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).pathname
}

function activeCodeFor(state, code) {
  return state.alerts.find((alert) => alert.code === code) || null
}

async function serveStatic(req, res) {
  const requested = routePath(req) === '/' ? 'index.html' : routePath(req).slice(1)
  const target = path.resolve(publicDir, requested)
  if (target !== publicDir && !target.startsWith(`${publicDir}${path.sep}`)) return sendJson(res, 403, { error: 'forbidden' })
  const docFiles = new Set(['docs/error-codes.md', 'docs/http-status-codes.md', 'docs/response-scripts.md'])
  try {
    const isDoc = docFiles.has(requested)
    const body = await fs.readFile(isDoc ? path.join(root, '..', requested) : target)
    res.writeHead(200, { 'content-type': isDoc ? 'text/markdown; charset=utf-8' : (contentTypes[path.extname(target)] || 'application/octet-stream'), 'cache-control': 'no-store' })
    res.end(body)
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR' && error.code !== 'EISDIR') throw error
    if (requested.startsWith('api/')) return sendJson(res, 404, { error: 'not found' })
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end('<!doctype html><html lang="ko"><meta charset="utf-8"><title>404 찾을 수 없음</title><h1>404 페이지를 찾을 수 없습니다</h1><p><a href="/">대시보드로 돌아가기</a></p></html>')
  }
}

async function handle(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  if (req.method === 'GET' && url.pathname === '/api/health') return sendJson(res, 200, { ok: true, service: 'rm-ops-dashboard' })
  if (req.method === 'GET' && url.pathname === '/api/overview') return sendJson(res, 200, monitor.getState())
  if (req.method === 'GET' && url.pathname === '/api/error-codes') return sendJson(res, 200, { codes: ERROR_CODES, actions: ACTIONS })
  if (req.method === 'GET' && url.pathname === '/api/status-codes') return sendJson(res, 200, { codes: HTTP_STATUS_CODES, rules: HTTP_STATUS_ALERT_RULES })
  if (req.method === 'GET' && url.pathname === '/api/actions/history') {
    try { return sendJson(res, 200, { events: await readActionHistory(url.searchParams.get('limit') || 30) }) }
    catch { return sendJson(res, 500, { error: '실행 이력을 읽지 못했습니다' }) }
  }
  if (req.method === 'GET' && url.pathname === '/api/reports') {
    try { return sendJson(res, 200, { reports: await listReports() }) }
    catch { return sendJson(res, 500, { error: '진단 보고서를 읽지 못했습니다' }) }
  }
  const reportMatch = url.pathname.match(/^\/api\/reports\/(incident\.[a-zA-Z0-9]{8})$/)
  if (reportMatch && req.method === 'GET') {
    try {
      const report = await readReport(reportMatch[1])
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': `attachment; filename="${reportMatch[1]}.txt"`, 'cache-control': 'no-store' })
      return res.end(report.body)
    } catch (error) { return sendJson(res, error.code === 'ENOENT' ? 404 : 400, { error: error.message }) }
  }
  if (reportMatch && req.method === 'DELETE') {
    try { await deleteReport(reportMatch[1]); return sendJson(res, 200, { ok: true, deleted: reportMatch[1] }) }
    catch (error) { return sendJson(res, error.code === 'ENOENT' ? 404 : 400, { error: error.message }) }
  }
  if (req.method === 'DELETE' && url.pathname === '/api/reports') {
    try {
      const deleted = await deleteExpiredReports(url.searchParams.get('olderThanDays'))
      return sendJson(res, 200, { ok: true, deleted })
    } catch (error) { return sendJson(res, 400, { error: error.message }) }
  }
  if (req.method === 'GET' && url.pathname === '/api/logs') {
    try {
      const containerId = assertContainerId(url.searchParams.get('containerId') || '')
      const output = await readLogs(containerId, { tail: url.searchParams.get('tail') || 200 })
      return sendJson(res, 200, { containerId, lines: output.split('\n').filter(Boolean) })
    } catch (error) {
      return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/logs/stream') {
    try {
      const containerId = assertContainerId(url.searchParams.get('containerId') || '')
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' })
      res.write(`event: ready\ndata: ${JSON.stringify({ containerId })}\n\n`)
      const stop = streamLogs(containerId, {
        tail: url.searchParams.get('tail') || 200,
        onData: (line) => res.write(`data: ${JSON.stringify({ line })}\n\n`),
        onError: (error) => res.write(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`),
        onClose: () => res.end(),
      })
      req.on('close', stop)
      return
    } catch (error) {
      return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/actions/run') {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', async () => {
      try {
        const input = JSON.parse(body || '{}')
        const alert = activeCodeFor(monitor.getState(), input.code)
        if (!alert) {
          try { await recordActionEvent({ actionId: input.actionId, code: input.code, status: 'failure', reason: '현재 활성화된 오류코드가 아닙니다' }) } catch {}
          return sendJson(res, 409, { error: '현재 활성화된 오류코드가 아닙니다' })
        }
        const permission = canRunAction(input.actionId, alert)
        const action = ACTIONS.find((item) => item.id === input.actionId)
        if (!permission.allowed) {
          try { await recordActionEvent({ actionId: input.actionId, actionLabel: action?.label, code: input.code, target: alert.containerName, status: 'failure', reason: permission.reason }) } catch {}
          return sendJson(res, 409, { error: permission.reason })
        }
        const startedAt = Date.now()
        try {
          const result = await runAction(input.actionId, { code: input.code, containerId: alert.containerId, includeLogs: input.includeLogs === true })
          const reportId = result.output.match(/^report=.*\/(incident\.[a-zA-Z0-9]{8})\/incident\.txt$/m)?.[1] || null
          let auditRecorded = true
          try { await recordActionEvent({ actionId: input.actionId, actionLabel: action?.label, code: input.code, target: alert.containerName, status: 'success', durationMs: Date.now() - startedAt, includeLogs: input.includeLogs === true, reportId }) } catch { auditRecorded = false }
          return sendJson(res, 200, { ok: true, ...result, reportId, auditRecorded })
        } catch (error) {
          let auditRecorded = true
          try { await recordActionEvent({ actionId: input.actionId, actionLabel: action?.label, code: input.code, target: alert.containerName, status: 'failure', durationMs: Date.now() - startedAt, includeLogs: input.includeLogs === true, reason: error instanceof Error ? error.message : String(error) }) } catch { auditRecorded = false }
          return sendJson(res, 500, { error: error instanceof Error ? error.message : String(error), auditRecorded })
        }
      } catch (error) {
        return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
    })
    return
  }
  return serveStatic(req, res)
}

const server = http.createServer((req, res) => {
  void handle(req, res).catch(() => {
    if (!res.headersSent) return sendJson(res, 500, { error: 'internal server error' })
    res.destroy()
  })
})
await monitor.tick()
setInterval(() => { void monitor.tick() }, pollMs).unref()
server.listen(port, host, () => process.stdout.write(`RM ops dashboard listening on http://${host}:${port}\n`))
