import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readSnapshot, readLogs, streamLogs, assertContainerId } from './docker.mjs'
import { createMonitor } from './monitor.mjs'
import { ACTIONS, canRunAction, runAction } from './actions.mjs'
import { ERROR_CODES } from './errors.mjs'

const root = path.dirname(fileURLToPath(import.meta.url))
const publicDir = path.join(root, 'public')
const port = Number(process.env.OPS_DASHBOARD_PORT || 9760)
const pollMs = Math.max(1_000, Number(process.env.OPS_DASHBOARD_POLL_MS || 5_000))
const monitor = createMonitor({ readSnapshot, threshold: Number(process.env.OPS_RESOURCE_THRESHOLD || 80) })

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
  if (requested === 'docs/error-codes.md') {
    const markdown = await fs.readFile(path.join(root, '..', 'docs', 'error-codes.md'))
    res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store' })
    res.end(markdown)
    return
  }
  try {
    const body = await fs.readFile(target)
    res.writeHead(200, { 'content-type': contentTypes[path.extname(target)] || 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(body)
  } catch {
    const body = await fs.readFile(path.join(publicDir, 'index.html'))
    res.writeHead(200, { 'content-type': contentTypes['.html'], 'cache-control': 'no-store' })
    res.end(body)
  }
}

async function handle(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  if (req.method === 'GET' && url.pathname === '/api/health') return sendJson(res, 200, { ok: true, service: 'rm-ops-dashboard' })
  if (req.method === 'GET' && url.pathname === '/api/overview') return sendJson(res, 200, monitor.getState())
  if (req.method === 'GET' && url.pathname === '/api/error-codes') return sendJson(res, 200, { codes: ERROR_CODES, actions: ACTIONS })
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
        if (!alert) return sendJson(res, 409, { error: '현재 활성화된 오류코드가 아닙니다' })
        const permission = canRunAction(input.actionId, alert)
        if (!permission.allowed) return sendJson(res, 409, { error: permission.reason })
        const result = await runAction(input.actionId, { code: input.code, containerId: alert.containerId })
        return sendJson(res, 200, { ok: true, ...result })
      } catch (error) {
        return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
      }
    })
    return
  }
  return serveStatic(req, res)
}

const server = http.createServer((req, res) => { void handle(req, res) })
await monitor.tick()
setInterval(() => { void monitor.tick() }, pollMs).unref()
server.listen(port, '0.0.0.0', () => process.stdout.write(`RM ops dashboard listening on http://127.0.0.1:${port}\n`))
