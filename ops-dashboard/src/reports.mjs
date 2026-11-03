import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const SAFE_REPORT_ID = /^incident\.[a-zA-Z0-9]{8}$/

export function diagnosticsRoot() {
  return path.resolve(process.env.OPS_DIAGNOSTICS_DIR || path.join(os.tmpdir(), 'rm-ops-diagnostics'))
}

function reportDirectory(reportId) {
  if (!SAFE_REPORT_ID.test(String(reportId))) throw new Error('유효하지 않은 진단 보고서 ID입니다')
  return path.join(diagnosticsRoot(), reportId)
}

export async function listReports() {
  let entries
  try { entries = await fs.readdir(diagnosticsRoot(), { withFileTypes: true }) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
  const reports = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !SAFE_REPORT_ID.test(entry.name)) continue
    try {
      const directory = reportDirectory(entry.name)
      const file = path.join(directory, 'incident.txt')
      const [dirInfo, fileInfo] = await Promise.all([fs.lstat(directory), fs.lstat(file)])
      if (!dirInfo.isDirectory() || !fileInfo.isFile()) continue
      reports.push({ id: entry.name, sizeBytes: fileInfo.size, createdAt: fileInfo.birthtime.toISOString(), modifiedAt: fileInfo.mtime.toISOString() })
    } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error }
  }
  return reports.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt))
}

export async function readReport(reportId) {
  const directory = reportDirectory(reportId)
  const dirInfo = await fs.lstat(directory)
  const file = path.join(directory, 'incident.txt')
  const fileInfo = await fs.lstat(file)
  if (!dirInfo.isDirectory() || !fileInfo.isFile()) throw new Error('진단 보고서를 찾을 수 없습니다')
  return { file, body: await fs.readFile(file) }
}

export async function deleteReport(reportId) {
  const directory = reportDirectory(reportId)
  const dirInfo = await fs.lstat(directory)
  const file = path.join(directory, 'incident.txt')
  const fileInfo = await fs.lstat(file)
  if (!dirInfo.isDirectory() || !fileInfo.isFile()) throw new Error('진단 보고서를 찾을 수 없습니다')
  await fs.unlink(file)
  await fs.rmdir(directory)
  return reportId
}

export async function deleteExpiredReports(olderThanDays, now = Date.now()) {
  const days = Number(olderThanDays)
  if (!Number.isInteger(days) || days < 7 || days > 3_650) throw new Error('보관 기간은 7일 이상 3650일 이하의 정수여야 합니다')
  const cutoff = now - days * 24 * 60 * 60 * 1_000
  const reports = await listReports()
  const deleted = []
  for (const report of reports) {
    if (Date.parse(report.modifiedAt) < cutoff) deleted.push(await deleteReport(report.id))
  }
  return deleted
}
