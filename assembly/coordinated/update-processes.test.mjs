import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { once } from 'node:events'
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

test('Windows close ignores same-directory helpers and a same-name sibling installation', { skip: process.platform !== 'win32', timeout: 45000 }, async t => {
  const work = await mkdtemp(join(tmpdir(), 'agentrouter-process-test-'))
  const children = []
  t.after(async () => {
    for (const child of children) if (child.exitCode === null) {
      const exited = once(child, 'exit'); child.kill(); await exited
    }
    assert.ok(resolve(work).startsWith(resolve(tmpdir()) + sep))
    await rm(work, { recursive: true, force: true })
  })
  const install = join(work, "AgentRouter ' test")
  const sibling = install + '-other'
  for (const path of [install, sibling]) await mkdir(path)
  async function launch(path) {
    await copyFile(process.execPath, path)
    const child = spawn(path, ['-e', 'process.stdout.write("ready\\n");setInterval(()=>{},1000)'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    children.push(child)
    await once(child.stdout, 'data')
    return child
  }
  const exact = join(install, 'AgentRouter.exe')
  const target = await launch(exact)
  const helper = await launch(join(install, 'helper.exe'))
  const other = await launch(join(sibling, 'AgentRouter.exe'))
  const run = promisify(execFile)
  const script = fileURLToPath(new URL('./update-processes.ps1', import.meta.url))
  const close = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-ExecutablePath', exact, '-Action', 'close'], { windowsHide: true, timeout: 30000 })
  assert.equal(close.stderr, '')
  assert.notEqual(target.exitCode, null)
  assert.equal(helper.exitCode, null)
  assert.equal(other.exitCode, null)
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-ExecutablePath', exact, '-Action', 'probe'], { windowsHide: true, timeout: 10000 })
})
