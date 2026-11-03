import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { auditFilePath, readActionHistory, recordActionEvent } from '../src/action-audit.mjs'
import { deleteExpiredReports, deleteReport, diagnosticsRoot, listReports, readReport } from '../src/reports.mjs'

test('실행 이력에는 제한된 항목만 저장하고 최근 기록을 읽는다', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rm-ops-audit-'))
  const previous = process.env.OPS_ACTION_AUDIT_FILE
  process.env.OPS_ACTION_AUDIT_FILE = path.join(directory, 'audit.jsonl')
  try {
    await recordActionEvent({ actionId: 'check-docker-access', actionLabel: 'Docker 점검', code: 'OPS-DOCKER-001', target: 'Docker Engine', status: 'success', durationMs: 12, rawOutput: 'secret-output' })
    const history = await readActionHistory(10)
    assert.equal(history.length, 1)
    assert.equal(history[0].status, 'success')
    assert.equal(history[0].durationMs, 12)
    assert.equal('rawOutput' in history[0], false)
    assert.equal((await fs.stat(auditFilePath())).mode & 0o777, 0o600)
    await fs.appendFile(auditFilePath(), 'not-json\n')
    assert.equal((await readActionHistory(10)).length, 1)
    await fs.writeFile(auditFilePath(), `${Array.from({ length: 2_000 }, (_, index) => JSON.stringify({ actionId: `old-${index}` })).join('\n')}\n`)
    await recordActionEvent({ actionId: 'last-entry', code: 'OPS-CPU-80-001', target: 'worker', status: 'failure', reason: 'sanitized reason' })
    assert.equal((await readActionHistory(1))[0].actionId, 'last-entry')
  } finally {
    if (previous === undefined) delete process.env.OPS_ACTION_AUDIT_FILE
    else process.env.OPS_ACTION_AUDIT_FILE = previous
  }
})

test('보고서 디렉터리가 아직 없으면 빈 목록을 반환하고 없는 파일은 거부한다', async () => {
  const directory = path.join(os.tmpdir(), `rm-ops-reports-missing-${process.pid}-${Date.now()}`)
  const previous = process.env.OPS_DIAGNOSTICS_DIR
  process.env.OPS_DIAGNOSTICS_DIR = directory
  try {
    assert.deepEqual(await listReports(), [])
    await assert.rejects(readReport('incident.ABC12345'))
    await assert.rejects(deleteReport('incident.ABC12345'))
  } finally {
    if (previous === undefined) delete process.env.OPS_DIAGNOSTICS_DIR
    else process.env.OPS_DIAGNOSTICS_DIR = previous
  }
})

test('진단 보고서를 열거·읽기·개별 삭제하고 오래된 것만 보관 기준으로 정리한다', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rm-ops-reports-'))
  const previous = process.env.OPS_DIAGNOSTICS_DIR
  process.env.OPS_DIAGNOSTICS_DIR = directory
  const now = Date.now()
  try {
    const oldId = 'incident.OLD12345'
    const newId = 'incident.NEW12345'
    for (const id of [oldId, newId]) {
      const target = path.join(diagnosticsRoot(), id)
      await fs.mkdir(target)
      await fs.writeFile(path.join(target, 'incident.txt'), `${id}\n`)
    }
    const oldFile = path.join(diagnosticsRoot(), oldId, 'incident.txt')
    await fs.utimes(oldFile, new Date(now - 40 * 86_400_000), new Date(now - 40 * 86_400_000))
    assert.equal((await listReports()).length, 2)
    assert.match((await readReport(newId)).body.toString(), /incident\.NEW12345/)
    await assert.rejects(readReport('../outside'), /유효하지 않은 진단 보고서 ID/)
    assert.deepEqual(await deleteExpiredReports(30, now), [oldId])
    assert.equal((await listReports()).length, 1)
    await deleteReport(newId)
    assert.deepEqual(await listReports(), [])
    await assert.rejects(deleteExpiredReports(1, now), /7일 이상/)
  } finally {
    if (previous === undefined) delete process.env.OPS_DIAGNOSTICS_DIR
    else process.env.OPS_DIAGNOSTICS_DIR = previous
  }
})
