import { execFile, spawn } from 'node:child_process'

const DOCKER_TIMEOUT_MS = 10_000
const SAFE_CONTAINER_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/

export function assertContainerId(containerId) {
  if (!SAFE_CONTAINER_ID.test(containerId)) throw new Error('유효하지 않은 컨테이너 ID입니다')
  return containerId
}

function runDocker(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('docker', args, {
      encoding: 'utf8',
      timeout: options.timeout ?? DOCKER_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        const message = String(stderr || error.message).trim() || 'Docker 명령을 실행하지 못했습니다'
        reject(new Error(message))
        return
      }
      resolve(String(stdout))
    })
    options.signal?.addEventListener('abort', () => child.kill('SIGTERM'), { once: true })
  })
}

function parseJsonLines(output) {
  return output.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line))
}

export async function listContainers() {
  const output = await runDocker(['ps', '-a', '--format', '{{json .}}'])
  return parseJsonLines(output).map((item) => ({
    id: item.ID,
    name: item.Names,
    image: item.Image,
    state: item.State,
    status: item.Status,
    ports: item.Ports || '',
    createdAt: item.CreatedAt || '',
  }))
}

function parsePercent(value) {
  const parsed = Number.parseFloat(String(value).replace('%', ''))
  return Number.isFinite(parsed) ? parsed : 0
}

function parseBytes(value) {
  const match = String(value).trim().match(/^([\d.]+)\s*([KMGTPE]?i?B)?$/i)
  if (!match) return 0
  const amount = Number.parseFloat(match[1])
  const unit = (match[2] || 'B').toUpperCase()
  const units = { B: 0, KB: 1, KIB: 1, MB: 2, MIB: 2, GB: 3, GIB: 3, TB: 4, TIB: 4, PB: 5, PIB: 5, EB: 6, EIB: 6 }
  return Math.round(amount * (1024 ** (units[unit] ?? 0)))
}

function parseMemoryUsage(value) {
  const [used, limit] = String(value).split('/').map((part) => parseBytes(part))
  return { usedBytes: used || 0, limitBytes: limit || 0 }
}

export async function listStats() {
  const output = await runDocker(['stats', '--no-stream', '--format', '{{json .}}'])
  return parseJsonLines(output).map((item) => {
    const memory = parseMemoryUsage(item.MemUsage)
    return {
      id: item.Container,
      name: item.Name,
      cpuPercent: parsePercent(item.CPUPerc),
      memoryPercent: parsePercent(item.MemPerc),
      memoryUsedBytes: memory.usedBytes,
      memoryLimitBytes: memory.limitBytes,
      networkIo: item.NetIO || '',
      blockIo: item.BlockIO || '',
      pids: Number.parseInt(item.PIDs, 10) || 0,
    }
  })
}

export function filterContainers(containers, {
  scope = process.env.OPS_CONTAINER_SCOPE || 'all',
  imagePrefixes = String(process.env.OPS_IMAGE_PREFIXES || '').split(',').map((value) => value.trim()).filter(Boolean),
  namePrefixes = String(process.env.OPS_NAME_PREFIXES || '').split(',').map((value) => value.trim()).filter(Boolean),
} = {}) {
  if (scope === 'all') return containers
  if (scope === 'image') return containers.filter((item) => imagePrefixes.some((prefix) => item.image.startsWith(prefix)))
  if (scope === 'name') return containers.filter((item) => namePrefixes.some((prefix) => item.name.startsWith(prefix)))
  if (scope === 'image-or-name') return containers.filter((item) => imagePrefixes.some((prefix) => item.image.startsWith(prefix)) || namePrefixes.some((prefix) => item.name.startsWith(prefix)))
  throw new Error(`지원하지 않는 OPS_CONTAINER_SCOPE: ${scope}`)
}

export async function readSnapshot() {
  const [containers, stats] = await Promise.all([listContainers(), listStats()])
  return filterContainers(containers).map((container) => ({
    ...container,
    running: container.state === 'running',
    // `docker ps` 는 기본적으로 짧은 ID, `docker stats` 는 전체 ID를 반환한다.
    stats: stats.find((item) => item.id === container.id || item.id.startsWith(container.id) || container.id.startsWith(item.id)) || null,
  }))
}

export async function readLogs(containerId, { tail = 200, since } = {}) {
  assertContainerId(containerId)
  const args = ['logs', '--timestamps', '--tail', String(Math.min(Math.max(Number(tail) || 200, 1), 1_000))]
  if (since) args.push('--since', String(since))
  args.push(containerId)
  return runDocker(args, { timeout: 20_000 })
}

export function streamLogs(containerId, { tail = 200, onData, onError, onClose } = {}) {
  assertContainerId(containerId)
  const args = ['logs', '--follow', '--timestamps', '--tail', String(Math.min(Math.max(Number(tail) || 200, 1), 1_000)), containerId]
  const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let buffer = ''
  const flush = (chunk) => {
    buffer += chunk.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) if (line) onData?.(line)
  }
  child.stdout.on('data', flush)
  child.stderr.on('data', flush)
  child.on('error', (error) => onError?.(error))
  child.on('close', (code) => {
    if (buffer) onData?.(buffer)
    onClose?.(code)
  })
  return () => child.kill('SIGTERM')
}

export { runDocker }
