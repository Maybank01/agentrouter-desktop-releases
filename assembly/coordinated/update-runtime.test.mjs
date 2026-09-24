import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { prepareDownloadedRelease, runtimeChanged } from './update-runtime.mjs'

const current = { version: '0.1.5-rc.3', runtimeFingerprint: 'a'.repeat(64),
  managedPlugins: [{ name: '@agentrouter-top/dsh-codex', version: '0.16.1' }] }
const feed = (runtime, version = '3.0.20') => ({ version, agentrouter: { pluginVersion: '0.16.1', runtime } })

test('an identical runtime identity skips background preparation', () => {
  assert.equal(runtimeChanged(current, feed({ fingerprint: 'a'.repeat(64), dshVersion: '0.1.5-rc.3',
    managedPlugins: current.managedPlugins }), '3.0.20'), false)
})

test('a changed or unknown runtime identity is prepared', () => {
  assert.equal(runtimeChanged(current, feed({ fingerprint: 'b'.repeat(64), dshVersion: '0.1.5-rc.3',
    managedPlugins: current.managedPlugins }), '3.0.20'), true)
  assert.equal(runtimeChanged(current, feed({ fingerprint: 'a'.repeat(64), dshVersion: '0.1.5-rc.3',
    managedPlugins: [{ name: '@agentrouter-top/dsh-codex', version: '0.16.2' }] }), '3.0.20'), true)
  assert.equal(runtimeChanged(current, feed(undefined), '3.0.20'), true)
  // Metadata of another version never describes the selected download.
  assert.equal(runtimeChanged(current, feed({ fingerprint: 'a'.repeat(64), dshVersion: '0.1.5-rc.3',
    managedPlugins: current.managedPlugins }, '3.0.21'), '3.0.20'), true)
  assert.equal(runtimeChanged({ ...current, runtimeFingerprint: undefined }, feed({ fingerprint: undefined,
    dshVersion: '0.1.5-rc.3', managedPlugins: current.managedPlugins }), '3.0.20'), true)
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentrouter-update-runtime-'))
  const installer = join(root, 'AgentRouter-3.0.20-x64-Setup.exe')
  writeFileSync(installer, 'verified installer')
  return { root, installer, state: join(root, 'home', 'desktop') }
}

test('stages the verified installer, then lets the staged release prepare its own runtime', async () => {
  const { root, installer, state } = fixture()
  const calls = []
  try {
    const result = await prepareDownloadedRelease({ installer, version: '3.0.20', root: state, executableName: 'AgentRouter.exe',
      platform: 'win32', env: { PATH: 'x', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--require=evil' },
      run: async (file, args, { env }) => {
        calls.push({ file, args, env })
        if (file === installer) {
          const app = env.AGENTROUTER_STAGE_DIR
          mkdirSync(join(app, 'resources', 'seed'), { recursive: true })
          writeFileSync(join(app, 'resources', 'seed', 'desktop-release.json'), JSON.stringify({ version: '0.1.5-rc.3', productVersion: '3.0.20' }))
          return 0
        }
        writeFileSync(join(state, 'prepared-update.json'), JSON.stringify({ productVersion: '3.0.20', outcome: 'prepared' }))
        return 3 // Completed work with a teardown exit code still counts.
      } })
    assert.equal(result.outcome, 'prepared')
    assert.deepEqual(calls[0].args, ['/S', '--agentrouter-stage'])
    assert.equal(calls[0].env.AGENTROUTER_STAGE_DIR, join(state, 'update-stage', 'app'))
    assert.equal(calls[1].file, join(state, 'update-stage', 'app', 'AgentRouter.exe'))
    assert.equal(calls[1].args[0], '--agentrouter-prepare-update')
    assert.match(calls[1].args[1], /^--user-data-dir=/)
    for (const call of calls) {
      assert.equal(call.env.ELECTRON_RUN_AS_NODE, undefined)
      assert.equal(call.env.NODE_OPTIONS, undefined)
    }
    assert.equal(calls[1].env.AGENTROUTER_STAGE_DIR, undefined, 'Only the installer may see the stage request')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('rejects a staged application of another version before running it', async () => {
  const { root, installer, state } = fixture()
  let ran = 0
  try {
    await assert.rejects(prepareDownloadedRelease({ installer, version: '3.0.20', root: state, executableName: 'AgentRouter.exe',
      platform: 'win32', env: {}, run: async (file, args, { env }) => {
        ran++
        mkdirSync(join(env.AGENTROUTER_STAGE_DIR, 'resources', 'seed'), { recursive: true })
        writeFileSync(join(env.AGENTROUTER_STAGE_DIR, 'resources', 'seed', 'desktop-release.json'), JSON.stringify({ version: '0.1.5-rc.3', productVersion: '3.0.19' }))
        return 0
      } }), /does not match/)
    assert.equal(ran, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('reports a failed preparation without claiming a prepared runtime', async () => {
  const { root, installer, state } = fixture()
  try {
    await assert.rejects(prepareDownloadedRelease({ installer, version: '3.0.20', root: state, executableName: 'AgentRouter.exe',
      platform: 'win32', env: {}, run: async (file, args, { env }) => {
        if (file === installer) {
          mkdirSync(join(env.AGENTROUTER_STAGE_DIR, 'resources', 'seed'), { recursive: true })
          writeFileSync(join(env.AGENTROUTER_STAGE_DIR, 'resources', 'seed', 'desktop-release.json'), JSON.stringify({ version: '0.1.5-rc.3', productVersion: '3.0.20' }))
          return 0
        }
        writeFileSync(join(state, 'prepared-update.json'), JSON.stringify({ productVersion: '3.0.20', outcome: 'failed', message: 'another package transaction is active' }))
        return 1
      } }), /another package transaction is active/)
    await assert.rejects(prepareDownloadedRelease({ installer, version: '3.0.20', root: state, executableName: 'AgentRouter.exe',
      platform: 'win32', env: {}, run: async () => 2 }), /could not stage/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('other platforms and missing downloads never run anything', async () => {
  assert.deepEqual(await prepareDownloadedRelease({ installer: 'x', version: '3.0.20', root: tmpdir(), executableName: 'AgentRouter.exe',
    platform: 'darwin', run: async () => { throw new Error('must not run') } }), { outcome: 'unsupported' })
  await assert.rejects(prepareDownloadedRelease({ installer: join(tmpdir(), 'missing-agentrouter.exe'), version: '3.0.20', root: tmpdir(),
    executableName: 'AgentRouter.exe', platform: 'win32', run: async () => 0 }), /unavailable/)
  assert.equal(existsSync(join(tmpdir(), 'update-stage')), false)
})
