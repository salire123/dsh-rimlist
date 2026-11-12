import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, copyFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { findGameProcesses, stopGame } from '../src/host/process.js'

test('finds and stops a fake RimWorld process inside gameDir', { skip: process.platform !== 'linux' }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rl-game-'))
  const exe = path.join(dir, 'RimWorld')
  await copyFile('/bin/sleep', exe)
  const child = spawn(exe, ['30'], { stdio: 'ignore' })
  await new Promise((r) => child.once('spawn', r))
  try {
    const found = await findGameProcesses(dir)
    assert.ok(found.some((p) => p.pid === child.pid))
    assert.equal((await findGameProcesses(path.join(dir, 'other'))).length, 0)
    const r = await stopGame(dir, { waitMs: 3000 })
    assert.equal(r.stopped, true)
    assert.equal((await stopGame(dir)).running, false)
  } finally {
    child.kill('SIGKILL')
    await rm(dir, { recursive: true, force: true })
  }
})
