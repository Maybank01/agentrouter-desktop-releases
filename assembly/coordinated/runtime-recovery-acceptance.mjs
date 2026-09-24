import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const directory = dirname(fileURLToPath(import.meta.url))
const hash = path => existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null

/** Reproduce an interrupted installed executable, cancel repair, and restore the exact bytes. */
export async function assertRuntimeRecovery({ executablePath, state, home, electronHome, env }) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true')
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
  assert.ok(realpathSync(home).startsWith(realpathSync(state) + sep))
  const node = join(dirname(executablePath), 'resources/runtime/node/node.exe')
  const backup = join(state, 'runtime-node-before-interruption.exe')
  const originalHash = hash(node)
  copyFileSync(node, backup)
  // A broken executable must not start even interrupted-transaction recovery.
  // The following healthy launch will recover this journal under the real lock.
  const pending = join(home, 'desktop/pending.json')
  assert.equal(existsSync(pending), false)
  const id = randomUUID(), stagingProfile = join(home, 'desktop/staging', id, 'profile')
  mkdirSync(stagingProfile, { recursive: true })
  const stagedFile = join(stagingProfile, 'retained-until-runtime-is-healthy.txt')
  writeFileSync(stagedFile, 'synthetic interrupted transaction\n')
  writeFileSync(pending, JSON.stringify({ schemaVersion: 1, id, stagingProfile, step: 'prepared' }))
  const protectedFiles = [pending, stagedFile, join(home, '.credentials.yaml'), ...['package.json', 'desktop-release.json', 'pnpm-lock.yaml', 'cordis.patch.yml']
    .map(name => join(home, 'profiles/desktop', name))]
  const before = protectedFiles.map(hash)
  let child
  const started = Date.now()
  try {
    const header = readFileSync(node).subarray(0, 512)
    writeFileSync(node, header)
    child = spawn(executablePath, ['--lang=zh-CN', `--user-data-dir=${electronHome}`],
      { cwd: state, env, stdio: 'ignore', windowsHide: true, timeout: 60000 })
    const closed = once(child, 'exit')
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      join(directory, 'runtime-recovery-acceptance.ps1'), '-ClientProcessId', String(child.pid)],
    { env, encoding: 'utf8', windowsHide: true, timeout: 40000 })
    const dialog = JSON.parse(stdout.trim())
    assert.equal(dialog.explicitRuntimeFailure, true)
    assert.equal(dialog.cancelled, true)
    assert.ok(dialog.buttons.some(label => /自动修复|Repair automatically/.test(label)))
    const [exitCode] = await closed
    assert.equal(exitCode, 1)
    assert.deepEqual(protectedFiles.map(hash), before, 'A broken runtime must not prepare or change the active profile')
    const startup = JSON.parse(readFileSync(join(home, 'desktop/startup.json'), 'utf8'))
    assert.equal(startup.events.some(event => ['preparing', 'installing', 'validating'].includes(event.stage)), false)
    return { passed: true, realTruncatedExecutable: true, explicitRepairDialog: true, cancelRetainsProfile: true,
      failedBeforeMigration: true, pendingJournalPreserved: true, durationMs: Date.now() - started }
  } finally {
    if (child && child.exitCode === null) {
      child.kill()
      await once(child, 'exit').catch(() => {})
    }
    copyFileSync(backup, node)
    assert.equal(hash(node), originalHash, 'Restore the exact accepted executable after the fault-injection check')
  }
}
