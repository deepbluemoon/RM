import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const defaultFile = path.resolve(root, '..', '.ops-data', 'action-audit.jsonl')
const maxFileBytes = 2 * 1024 * 1024
const maxEntries = 2_000
const cleanText = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max)

export function auditFilePath() {
  return path.resolve(process.env.OPS_ACTION_AUDIT_FILE || defaultFile)
}

export async function recordActionEvent(event) {
  const file = auditFilePath()
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const actorName = cleanText(event.actorName || process.env.OPS_OPERATOR_NAME || process.env.OPS_OPERATOR_ID || process.env.USER || 'local-user', 64)
  const actorId = cleanText(event.actorId || process.env.OPS_OPERATOR_ID, 64) || null
  const record = {
    at: new Date().toISOString(),
    actor: actorName,
    actorId,
    actorName,
    rationale: cleanText(event.rationale, 300),
    actionId: String(event.actionId || '').slice(0, 80),
    actionLabel: String(event.actionLabel || '').slice(0, 160),
    code: String(event.code || '').slice(0, 80),
    target: String(event.target || '').slice(0, 256),
    status: event.status === 'success' ? 'success' : 'failure',
    durationMs: Math.max(0, Number(event.durationMs) || 0),
    includeLogs: event.includeLogs === true,
    reportId: event.reportId || null,
    reason: event.reason ? cleanText(event.reason, 256) : null,
  }
  let previous = ''
  try { previous = await fs.readFile(file, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
  const lines = previous.split('\n').filter(Boolean)
  if (Buffer.byteLength(previous) > maxFileBytes || lines.length >= maxEntries) {
    previous = `${lines.slice(-Math.floor(maxEntries / 2)).join('\n')}\n`
    await fs.writeFile(file, previous, { mode: 0o600 })
  }
  const handle = await fs.open(file, 'a', 0o600)
  try { await handle.writeFile(`${JSON.stringify(record)}\n`) } finally { await handle.close() }
  await fs.chmod(file, 0o600)
  return record
}

export async function readActionHistory(limit = 50) {
  const file = auditFilePath()
  let contents
  try { contents = await fs.readFile(file, 'utf8') } catch (error) { if (error.code === 'ENOENT') return []; throw error }
  return contents.split('\n').filter(Boolean).slice(-Math.min(Math.max(Number(limit) || 50, 1), 100)).flatMap((line) => {
    try { return [JSON.parse(line)] } catch { return [] }
  }).reverse()
}
