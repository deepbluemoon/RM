import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createLogArchive } from '../src/log-archive.mjs'

test('삭제한 컨테이너의 보관 로그만 정리한다', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rm-ops-logs-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const directory = path.join(root, 'demo')
  await fs.mkdir(directory)
  for (const file of ['abc.log', 'abc.1.log', 'abc.cursor', 'abcd.log']) await fs.writeFile(path.join(directory, file), 'test')
  await createLogArchive({ root }).remove({ id: 'abc', name: 'demo' })
  assert.deepEqual(await fs.readdir(directory), ['abcd.log'])
})
