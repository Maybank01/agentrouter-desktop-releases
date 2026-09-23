import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { observeInstalledProcessExit } from './installed-process.mjs'

test('observes the original process exiting while a descendant keeps its output pipe open', { skip: process.platform !== 'win32' }, async () => {
  const child = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
      { windowsHide: true, detached: true, stdio: ['ignore', process.stdout, 'ignore'] });
    descendant.unref();
    process.on('message', () => process.exit(0));
    process.send({ pid: descendant.pid });
  `], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore', 'ipc'] })
  let descendant, observer
  let pipesClosed = false
  child.once('close', () => { pipesClosed = true })
  try {
    const [message] = await once(child, 'message')
    descendant = message.pid
    observer = await observeInstalledProcessExit(child.pid, process.execPath, 5000)
    const originalExited = once(child, 'exit')
    child.send('exit')
    assert.equal((await originalExited)[0], 0)
    assert.deepEqual(await observer.exited, { pid: child.pid, exitCode: 0 })
    await delay(100)
    assert.equal(pipesClosed, false, 'The prior close-event observer would still be waiting')
    process.kill(descendant, 0)
  } finally {
    observer?.cancel()
    if (descendant) {
      try { process.kill(descendant) } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
    if (child.exitCode === null) child.kill()
  }
})

test('rejects the wrong executable and a process that remains alive without terminating it', { skip: process.platform !== 'win32' }, async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' })
  try {
    await assert.rejects(observeInstalledProcessExit(child.pid, process.execPath + '.different'), /does not own/)
    const observer = await observeInstalledProcessExit(child.pid, process.execPath, 200)
    await assert.rejects(observer.exited, /did not exit/)
    assert.equal(child.exitCode, null)
    process.kill(child.pid, 0)
  } finally { child.kill() }
})
