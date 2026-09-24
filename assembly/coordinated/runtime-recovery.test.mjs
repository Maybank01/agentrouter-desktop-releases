import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isRuntimeStartupFailure, prepareRepairInstaller, repairInstallerUrl, runtimeRecoveryDialog, verifyRuntimeExecutables } from './runtime-recovery.mjs'

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
    assert.equal(dialog.noLink, true)
  }
  assert.equal(repairInstallerUrl('3.0.15'), 'https://agentrouter.top/downloads/desktop/v3.0.15/AgentRouter-3.0.15-x64-Setup.exe')
  assert.equal(runtimeRecoveryDialog(true).buttons[0], '自动修复')
  assert.throws(() => repairInstallerUrl('3.0.15/../../latest'))
})

test('repair downloads the exact signed release, falls back per source and rejects tampered bytes', async () => {
  const { createHash, generateKeyPairSync, sign } = await import('node:crypto')
  const { createServer } = await import('node:http')
  const { readFile } = await import('node:fs/promises')
  const { verifyUpdateManifest, verifyUpdateFile } = await import('./update-signature.mjs')
  const { resumableDownload } = await import('./update-transport.mjs')
  const keys = generateKeyPairSync('rsa', { modulusLength: 3072 })
  const policy = { schemaVersion: 1, mode: 'self-signed', publisher: 'AgentRouter', certificateSha256: 'a'.repeat(64),
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }) }
  const bytes = Buffer.from('repair installer bytes '.repeat(4096))
  const name = 'AgentRouter-3.0.21-x64-Setup.exe'
  const payload = Buffer.from(JSON.stringify({ schemaVersion: 1, productVersion: '3.0.21', certificateSha256: policy.certificateSha256,
    assets: [{ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] }))
  const envelope = JSON.stringify({ schemaVersion: 1, algorithm: 'RSA-SHA256', payload: payload.toString('base64'),
    signature: sign('RSA-SHA256', payload, keys.privateKey).toString('base64') })
  let served = bytes
  const requests = []
  const server = createServer((req, res) => {
    requests.push(req.url)
    if (req.url.startsWith('/mirror/')) { res.writeHead(503); res.end(); return }
    if (req.url.endsWith('/agentrouter-update.json')) { res.end(envelope); return }
    if (req.url.endsWith(`/${name}`)) { res.writeHead(200, { 'content-length': served.length }); res.end(served); return }
    res.writeHead(404); res.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const root = await mkdtemp(join(tmpdir(), 'agentrouter-repair-'))
  const options = { version: '3.0.21', policy, fetcher: fetch, verifyManifest: verifyUpdateManifest, verifyFile: verifyUpdateFile,
    download: (value) => resumableDownload({ ...value, wait: async () => {}, delays: [0] }), bases: [`${origin}/mirror/`, `${origin}/github/`] }
  try {
    const path = await prepareRepairInstaller({ ...options, directory: join(root, 'a') })
    assert.deepEqual(await readFile(path), bytes)
    assert.ok(requests.includes('/mirror/v3.0.21/agentrouter-update.json') && requests.includes(`/github/v3.0.21/${name}`))
    served = Buffer.from(bytes); served[0] ^= 1
    await assert.rejects(prepareRepairInstaller({ ...options, directory: join(root, 'b') }))
    await assert.rejects(prepareRepairInstaller({ ...options, directory: join(root, 'c'), version: '3.0.22' }))
    await assert.rejects(prepareRepairInstaller({ ...options, directory: join(root, 'd'), fetcher: undefined }), /explicit/)
  } finally { server.close(); await rm(root, { recursive: true, force: true }) }
})
