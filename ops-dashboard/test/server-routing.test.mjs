import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'

test('대시보드의 정상 경로와 없는 경로를 구분한다', async (t) => {
  const reservation = createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const port = reservation.address().port
  await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()))

  const server = spawn(process.execPath, [fileURLToPath(new URL('../src/server.mjs', import.meta.url))], {
    env: { ...process.env, OPS_DASHBOARD_PORT: String(port), OPS_ACTION_AUDIT_FILE: path.join(os.tmpdir(), `rm-ops-test-${process.pid}.jsonl`), OPS_DIAGNOSTICS_DIR: path.join(os.tmpdir(), `rm-ops-test-reports-${process.pid}`), PATH: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => server.kill())
  const started = await Promise.race([
    once(server.stdout, 'data').then(([data]) => data.toString()),
    once(server, 'exit').then(([code]) => { throw new Error(`server exited: ${code}`) }),
  ])
  assert.match(started, /listening/)
  const base = `http://127.0.0.1:${port}`

  for (let index = 0; index < 30; index += 1) {
    const response = await fetch(`${base}/`, { redirect: 'manual' })
    assert.equal(response.status, 200)
    assert.match(await response.text(), /RM Ops/)
  }
  assert.equal((await fetch(`${base}/app.js`)).status, 200)
  assert.equal((await fetch(`${base}/docs/error-codes.md`)).status, 200)
  assert.equal((await fetch(`${base}/docs/response-scripts.md`)).status, 200)
  assert.equal((await fetch(`${base}/api/health`)).status, 200)
  assert.deepEqual(await (await fetch(`${base}/api/actions/history`)).json(), { events: [] })
  assert.deepEqual(await (await fetch(`${base}/api/reports`)).json(), { reports: [] })

  for (const pathname of ['/missing-route-for-test', '/missing.js', '/api/missing']) {
    const response = await fetch(`${base}${pathname}`, { redirect: 'manual' })
    assert.equal(response.status, 404, pathname)
    if (pathname.startsWith('/api/')) assert.deepEqual(await response.json(), { error: 'not found' })
    else assert.match(await response.text(), /404/)
  }
})
