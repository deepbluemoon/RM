import fs from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const SAFE_REPORT_ID = /^(?:incident|action)\.[a-zA-Z0-9]{8}$/
const REVIEW_STATUSES = new Set(['pending_review', 'reviewed', 'runbook_update_proposed', 'runbook_updated'])
const root = path.dirname(fileURLToPath(import.meta.url))
const reviewWrites = new Map()

export function diagnosticsRoot() {
  return path.resolve(process.env.OPS_DIAGNOSTICS_DIR || path.join(root, '..', '.ops-data', 'reports'))
}

function reportDirectory(reportId) {
  if (!SAFE_REPORT_ID.test(String(reportId))) throw new Error('유효하지 않은 진단 보고서 ID입니다')
  return path.join(diagnosticsRoot(), reportId)
}

function reportFileName(reportId) {
  return String(reportId).startsWith('action.') ? 'action-report.txt' : 'incident.txt'
}

function reportValue(value, max = 2_000) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').slice(0, max)
}

function defaultReview(reportId) {
  return { reportId, status: 'pending_review', reviewer: null, reviewedAt: null, notes: '', runbookPath: null, proposal: '', changeReference: null, history: [] }
}

function normalizeReviewInput(input = {}) {
  const status = String(input.status || '')
  const reviewer = String(input.reviewer || '').trim()
  const notes = String(input.notes || '').trim()
  const runbookPath = String(input.runbookPath || '').trim()
  const proposal = String(input.proposal || '').trim()
  const changeReference = String(input.changeReference || '').trim()
  if (!REVIEW_STATUSES.has(status)) throw new Error('지원하지 않는 검토 상태입니다')
  if (!reviewer || reviewer.length > 64 || /[\u0000-\u001f\u007f]/.test(reviewer)) throw new Error('검토자 이름은 1~64자여야 합니다')
  if (!notes || notes.length > 2_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(notes)) throw new Error('검토 메모는 1~2000자여야 합니다')
  if (runbookPath && (runbookPath.length > 200 || !/^(?:ops-dashboard\/)?docs\/[A-Za-z0-9._/-]+\.md$/.test(runbookPath) || runbookPath.split('/').includes('..'))) throw new Error('런북 경로는 저장소 docs 아래의 Markdown 경로여야 합니다')
  if (proposal.length > 4_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(proposal)) throw new Error('런북 제안은 4000자 이하여야 합니다')
  if (changeReference.length > 256 || /[\u0000-\u001f\u007f]/.test(changeReference)) throw new Error('반영 참조는 256자 이하여야 합니다')
  if (status === 'runbook_update_proposed' && (!runbookPath || !proposal)) throw new Error('런북 수정 제안 상태에는 대상 경로와 제안 내용이 필요합니다')
  if (status === 'runbook_updated' && (!runbookPath || !changeReference)) throw new Error('런북 반영 완료 상태에는 대상 경로와 PR·커밋 등 참조가 필요합니다')
  return { status, reviewer, notes, runbookPath: runbookPath || null, proposal, changeReference: changeReference || null }
}

async function readReviewFile(reportId) {
  const file = path.join(reportDirectory(reportId), 'review.json')
  try {
    const review = JSON.parse(await fs.readFile(file, 'utf8'))
    if (review.reportId !== reportId || !REVIEW_STATUSES.has(review.status) || !Array.isArray(review.history)) throw new Error('보고서 검토 기록 형식이 올바르지 않습니다')
    return review
  } catch (error) {
    if (error.code === 'ENOENT') return defaultReview(reportId)
    throw error
  }
}

async function writeReviewFile(reportId, review) {
  const directory = reportDirectory(reportId)
  const target = path.join(directory, 'review.json')
  const temporary = path.join(directory, `.review-${randomBytes(6).toString('hex')}.tmp`)
  await fs.writeFile(temporary, `${JSON.stringify(review, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  await fs.chmod(temporary, 0o600)
  await fs.rename(temporary, target)
  await fs.chmod(target, 0o600)
}

export async function readReportReview(reportId) {
  await readReport(reportId)
  return readReviewFile(reportId)
}

export async function updateReportReview(reportId, input) {
  const prior = reviewWrites.get(reportId) || Promise.resolve()
  const update = prior.then(async () => {
    await readReport(reportId)
    const previous = await readReviewFile(reportId)
    const next = normalizeReviewInput(input)
    const transitions = {
      pending_review: new Set(['reviewed', 'runbook_update_proposed']),
      reviewed: new Set(['reviewed', 'runbook_update_proposed']),
      runbook_update_proposed: new Set(['reviewed', 'runbook_update_proposed', 'runbook_updated']),
      runbook_updated: new Set(['reviewed', 'runbook_update_proposed']),
    }
    if (!transitions[previous.status]?.has(next.status)) throw new Error(`검토 상태를 ${previous.status}에서 ${next.status}(으)로 변경할 수 없습니다`)
    const at = new Date().toISOString()
    const entry = { at, status: next.status, reviewer: next.reviewer, notes: next.notes, runbookPath: next.runbookPath, proposal: next.proposal, changeReference: next.changeReference }
    const review = { reportId, ...next, reviewedAt: at, history: [...previous.history, entry].slice(-100) }
    await writeReviewFile(reportId, review)
    return review
  })
  const queued = update.catch(() => {})
  reviewWrites.set(reportId, queued)
  try { return await update } finally { if (reviewWrites.get(reportId) === queued) reviewWrites.delete(reportId) }
}

export async function createActionReport(event) {
  const root = diagnosticsRoot()
  await fs.mkdir(root, { recursive: true, mode: 0o700 })
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const reportId = `action.${randomBytes(4).toString('hex')}`
    const directory = reportDirectory(reportId)
    try {
      await fs.mkdir(directory, { mode: 0o700 })
      const body = [
        'RM 운영 작업 보고서',
        `보고서 ID: ${reportId}`,
        `실행 시각: ${reportValue(event.at, 64)}`,
        `운영자 이름: ${reportValue(event.actorName, 64) || '미입력'}`,
        `운영자 계정 ID: ${reportValue(event.actorId, 64) || '미등록'}`,
        `선택 근거: ${reportValue(event.rationale, 300) || '미입력'}`,
        `작업: ${reportValue(event.actionLabel, 160)}`,
        `오류 코드: ${reportValue(event.code, 80)}`,
        `대상: ${reportValue(event.target, 256)}`,
        `결과: ${event.status === 'success' ? '성공' : '실패'}`,
        `소요 시간(ms): ${Math.max(0, Number(event.durationMs) || 0)}`,
        event.diagnosticReportId ? `진단 보고서: ${reportValue(event.diagnosticReportId, 64)}` : '',
        event.failureReason ? `실패 사유: ${reportValue(event.failureReason, 1_000)}` : '',
        '',
        '작업 출력 요약:',
        reportValue(event.output, 12_000) || '(출력 없음)',
        '',
      ].filter((line) => line !== '').join('\n')
      const file = path.join(directory, 'action-report.txt')
      await fs.writeFile(file, body, { flag: 'wx', mode: 0o600 })
      await fs.chmod(directory, 0o700)
      await fs.chmod(file, 0o600)
      return reportId
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }
  throw new Error('고유한 작업 보고서 ID를 만들지 못했습니다')
}

export async function listReports() {
  let entries
  try { entries = await fs.readdir(diagnosticsRoot(), { withFileTypes: true }) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
  const reports = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !SAFE_REPORT_ID.test(entry.name)) continue
    try {
      const directory = reportDirectory(entry.name)
      const file = path.join(directory, reportFileName(entry.name))
      const [dirInfo, fileInfo] = await Promise.all([fs.lstat(directory), fs.lstat(file)])
      if (!dirInfo.isDirectory() || !fileInfo.isFile()) continue
      const review = await readReviewFile(entry.name)
      reports.push({ id: entry.name, sizeBytes: fileInfo.size, createdAt: fileInfo.birthtime.toISOString(), modifiedAt: fileInfo.mtime.toISOString(), reviewStatus: review.status, reviewedAt: review.reviewedAt })
    } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error }
  }
  return reports.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt))
}

export async function readReport(reportId) {
  const directory = reportDirectory(reportId)
  const dirInfo = await fs.lstat(directory)
  const file = path.join(directory, reportFileName(reportId))
  const fileInfo = await fs.lstat(file)
  if (!dirInfo.isDirectory() || !fileInfo.isFile()) throw new Error('진단 보고서를 찾을 수 없습니다')
  const body = await fs.readFile(file)
  const review = await readReviewFile(reportId)
  const reviewBlock = Buffer.from(`\n\n--- 운영 검토 및 런북 반영 이력 ---\n${JSON.stringify(review, null, 2)}\n`, 'utf8')
  return { file, body: Buffer.concat([body, reviewBlock]) }
}

export async function deleteReport(reportId) {
  const directory = reportDirectory(reportId)
  const dirInfo = await fs.lstat(directory)
  const file = path.join(directory, reportFileName(reportId))
  const fileInfo = await fs.lstat(file)
  if (!dirInfo.isDirectory() || !fileInfo.isFile()) throw new Error('진단 보고서를 찾을 수 없습니다')
  await fs.unlink(file)
  for (const name of await fs.readdir(directory)) {
    if (name === 'review.json' || /^\.review-[a-f0-9]{12}\.tmp$/.test(name)) await fs.rm(path.join(directory, name), { force: true })
  }
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
