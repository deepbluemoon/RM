import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const moduleRoot = path.dirname(fileURLToPath(import.meta.url))
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/
const MAX_LINE_BYTES = 256 * 1024

function boundedInt(value, fallback, min, max) {
  const number = Number(value)
  return Number.isInteger(number) ? Math.min(Math.max(number, min), max) : fallback
}

export function createLogArchive({
  root = process.env.OPS_LOG_ARCHIVE_DIR || path.resolve(moduleRoot, '..', '.ops-data', 'logs'),
  maxFileBytes = boundedInt(process.env.OPS_LOG_ARCHIVE_MAX_FILE_BYTES, 10 * 1024 * 1024, 64 * 1024, 100 * 1024 * 1024),
  maxFiles = boundedInt(process.env.OPS_LOG_ARCHIVE_MAX_FILES, 5, 1, 20),
  retentionDays = boundedInt(process.env.OPS_LOG_ARCHIVE_RETENTION_DAYS, 30, 1, 3650),
  spawnProcess = spawn,
  now = () => Date.now(),
} = {}) {
  const streams = new Map()
  let lastPruneAt = 0

  async function append(container, line) {
    if (!line || Buffer.byteLength(line) > MAX_LINE_BYTES) return
    const id = String(container.id || '')
    const name = String(container.name || '')
    if (!SAFE_ID.test(id) || !SAFE_ID.test(name)) return
    const directory = path.join(root, name)
    const file = path.join(directory, `${id}.log`)
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    await fs.chmod(directory, 0o700)
    let size = 0
    try { size = (await fs.stat(file)).size } catch (error) { if (error.code !== 'ENOENT') throw error }
    const bytes = Buffer.byteLength(line) + 1
    if (size + bytes > maxFileBytes) {
      if (maxFiles === 1) {
        await fs.rm(file, { force: true })
      } else {
        await fs.rm(path.join(directory, `${id}.${maxFiles - 1}.log`), { force: true })
        for (let index = maxFiles - 2; index >= 1; index -= 1) {
          await fs.rename(path.join(directory, `${id}.${index}.log`), path.join(directory, `${id}.${index + 1}.log`)).catch((error) => { if (error.code !== 'ENOENT') throw error })
        }
        await fs.rename(file, path.join(directory, `${id}.1.log`)).catch((error) => { if (error.code !== 'ENOENT') throw error })
      }
      size = 0
    }
    const handle = await fs.open(file, 'a', 0o600)
    try { await handle.writeFile(`${line}\n`); await handle.chmod(0o600) } finally { await handle.close() }
    await fs.chmod(directory, 0o700)
    const timestamp = line.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)\s/)
    if (timestamp) {
      const cursorFile = path.join(directory, `${id}.cursor`)
      const cursorHandle = await fs.open(cursorFile, 'w', 0o600)
      try { await cursorHandle.writeFile(JSON.stringify({ timestamp: timestamp[1], line })); await cursorHandle.chmod(0o600) } finally { await cursorHandle.close() }
    }
  }

  async function start(container) {
    const key = `${container.name}/${container.id}`
    if (streams.has(key) || !container.running || !SAFE_ID.test(String(container.id || '')) || !SAFE_ID.test(String(container.name || ''))) return
    const directory = path.join(root, container.name)
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    await fs.chmod(directory, 0o700)
    const cursorFile = path.join(directory, `${container.id}.cursor`)
    let cursor = null
    try { cursor = JSON.parse(await fs.readFile(cursorFile, 'utf8')) } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error }
    const args = ['logs', '--follow', '--timestamps']
    if (cursor?.timestamp) args.push('--since', cursor.timestamp)
    else args.push('--tail', '1000')
    args.push(container.id)
    const child = spawnProcess('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const entry = { child, lastLine: cursor?.line || '', buffer: '', chain: Promise.resolve() }
    streams.set(key, entry)
    const consume = (chunk) => {
      entry.buffer += chunk.toString('utf8')
      const lines = entry.buffer.split('\n')
      entry.buffer = lines.pop() || ''
      for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, '')
        if (!line || line === entry.lastLine) { entry.lastLine = ''; continue }
        entry.lastLine = ''
        entry.chain = entry.chain.then(() => append(container, line)).catch(() => {})
      }
    }
    child.stdout?.on('data', consume)
    child.stderr?.on('data', consume)
    child.on('error', () => streams.delete(key))
    child.on('close', () => {
      if (entry.buffer) entry.chain = entry.chain.then(() => append(container, entry.buffer)).catch(() => {})
      void entry.chain.finally(() => streams.delete(key))
    })
  }

  async function prune() {
    const cutoff = now() - retentionDays * 24 * 60 * 60 * 1000
    let names = []
    try { names = await fs.readdir(root) } catch (error) { if (error.code === 'ENOENT') return; throw error }
    for (const name of names) {
      if (!SAFE_ID.test(name)) continue
      const directory = path.join(root, name)
      let files = []
      try { files = await fs.readdir(directory, { withFileTypes: true }) } catch { continue }
      for (const item of files) {
        if (!item.isFile() || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}\.(?:log|cursor)$/.test(item.name)) continue
        const file = path.join(directory, item.name)
        try { if ((await fs.stat(file)).mtimeMs < cutoff) await fs.rm(file, { force: true }) } catch {}
      }
    }
  }

  async function sync(containers = []) {
    for (const container of containers) {
      if (container.running) void start(container).catch(() => {})
    }
    if (now() - lastPruneAt > 60 * 60 * 1000) {
      lastPruneAt = now()
      void prune().catch(() => {})
    }
  }

  function close() {
    for (const { child } of streams.values()) child.kill('SIGTERM')
    streams.clear()
  }

  return { sync, close, get activeStreams() { return streams.size } }
}
