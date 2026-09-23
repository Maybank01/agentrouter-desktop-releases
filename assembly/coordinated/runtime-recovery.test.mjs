import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isRuntimeStartupFailure, repairInstallerUrl, runtimeRecoveryDialog, verifyRuntimeExecutables } from './runtime-recovery.mjs'

test('a real executable starts without consulting the system PATH or inherited Node preload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentrouter-runtime-'))
  const previous = process.env.NODE_OPTIONS
  try {
    const pnpm = join(root, 'pnpm.mjs')
    await writeFile(pnpm, '// packaged entry\n')
    process.env.NODE_OPTIONS = '--require=agentrouter-missing-preload'
    await verifyRuntimeExecutables({ node: process.execPath, pnpm })
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS
    else process.env.NODE_OPTIONS = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('an interrupted Windows executable is rejected before profile preparation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentrouter-runtime-'))
  try {
    const node = join(root, 'node.exe'), pnpm = join(root, 'pnpm.mjs')
    const bytes = Buffer.alloc(512); bytes.write('MZ')
    await writeFile(node, bytes, { mode: 0o755 })
    await writeFile(pnpm, '// packaged entry\n')
    await assert.rejects(verifyRuntimeExecutables({ node, pnpm }), error =>
      isRuntimeStartupFailure(error) && error.cause !== undefined)
    await assert.rejects(verifyRuntimeExecutables({ node: process.execPath, pnpm: join(root, 'absent.mjs') }),
      isRuntimeStartupFailure)
    assert.equal(isRuntimeStartupFailure(new Error('A model request failed')), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('runtime recovery keeps cancellation and uses the exact existing product release', () => {
  for (const chinese of [true, false]) {
    const dialog = runtimeRecoveryDialog(chinese)
    assert.equal(dialog.cancelId, 2)
    assert.equal(dialog.buttons.length, 3)
  }
  assert.equal(repairInstallerUrl('3.0.15'), 'https://github.com/Maybank01/agentrouter-desktop-releases/releases/download/v3.0.15/AgentRouter-3.0.15-x64-Setup.exe')
  assert.throws(() => repairInstallerUrl('3.0.15/../../latest'))
})
