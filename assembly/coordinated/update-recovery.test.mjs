import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import { gzipSync } from 'node:zlib'
import test from 'node:test'
import { configurePinnedUpdater } from './update-signature.mjs'
import { configureUpdateRecovery, updateFailureMessage } from './update-recovery.mjs'

const require = createRequire(import.meta.url)
const { NsisUpdater } = require('electron-updater/out/NsisUpdater.js')
const bytes = Buffer.from('installer fixture bytes retained across a cancelled install')
const hash = (data, kind, format = 'hex') => createHash(kind).update(data).digest(format)
const version = '3.0.15'
const name = `AgentRouter-${version}-x64-Setup.exe`
const keys = generateKeyPairSync('rsa', { modulusLength: 3072 })
const policy = { schemaVersion: 1, mode: 'self-signed', publisher: 'AgentRouter', certificateSha256: 'b'.repeat(64),
  publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }) }
const payload = Buffer.from(JSON.stringify({ schemaVersion: 1, productVersion: version, certificateSha256: policy.certificateSha256,
  assets: [{ name, bytes: bytes.length, sha256: hash(bytes, 'sha256') }] }))
const envelope = { schemaVersion: 1, algorithm: 'RSA-SHA256', payload: payload.toString('base64'),
  signature: sign('RSA-SHA256', payload, keys.privateKey).toString('base64') }
async function fixture(t) {
  const work = await mkdtemp(join(tmpdir(), 'agentrouter-updater-test-'))
  t.after(async () => {
    assert.ok(resolve(work).startsWith(resolve(tmpdir()) + sep))
    await rm(work, { recursive: true, force: true })
  })
  let downloads = 0
  function create() {
    const updater = new NsisUpdater(undefined, { version: '3.0.14', name: 'AgentRouter', baseCachePath: work, isPackaged: true })
    updater.logger = null
    updater.on('error', () => {})
    updater.autoInstallOnAppQuit = false
    updater.disableWebInstaller = true
    updater.disableDifferentialDownload = true
    updater.configOnDisk = { value: Promise.resolve({ publisherName: 'AgentRouter', updaterCacheDirName: 'cache' }) }
    const info = { version, files: [{ url: name, sha512: hash(bytes, 'sha512', 'base64'), size: bytes.length }] }
    updater.updateInfoAndProvider = { info, provider: {
      resolveFiles: () => [{ url: new URL(name, 'https://example.test/'), info: info.files[0] }],
    } }
    updater.httpExecutor = { download: async (_url, destination) => { downloads++; await writeFile(destination, bytes) } }
    const verification = configurePinnedUpdater(updater, { policy, feed: 'https://example.test/' }, () => version,
      async () => new Response(JSON.stringify(envelope)))
    return { updater, verification, recovery: configureUpdateRecovery(updater) }
  }
  return { work, create, downloads: () => downloads }
}

test('the real updater reuses a valid cancelled download after relaunch without transferring it again', async t => {
  const fixtureData = await fixture(t)
  let client = fixtureData.create()
  await client.verification.beforeDownload()
  const first = await client.updater.downloadUpdate()
  await client.verification.afterDownload(first)
  client = fixtureData.create() // Installer cancelled; the original app was reopened.
  await client.verification.beforeDownload()
  const second = await client.updater.downloadUpdate()
  await client.verification.afterDownload(second)
  assert.deepEqual(second, first)
  assert.equal(fixtureData.downloads(), 1)
})

test('integrity rejection clears the upstream in-memory shortcut, then retry obtains fresh verified bytes', async t => {
  const f = await fixture(t)
  const client = f.create()
  await client.verification.beforeDownload()
  const [path] = await client.updater.downloadUpdate()
  const helper = client.updater.downloadedUpdateHelper
  const baseline = join(helper.cacheDir, 'installer.exe')
  await writeFile(baseline, 'preserve the previous installed version')
  await writeFile(path, Buffer.alloc(bytes.length, 42))
  // Exercise the real dependency's same-process existence-only shortcut.
  assert.deepEqual(await client.updater.downloadUpdate(), [path])
  await assert.rejects(client.verification.afterDownload([path]), { code: 'UPDATE_FILE_INVALID' })
  await client.recovery.discardInvalidDownload()
  assert.equal(await readFile(baseline, 'utf8'), 'preserve the previous installed version')
  const retried = await client.updater.downloadUpdate()
  await client.verification.afterDownload(retried)
  assert.equal(f.downloads(), 2)
})

test('a cancelled target blockmap cannot displace the installed baseline during the next differential download', async t => {
  const f = await fixture(t)
  const client = f.create()
  client.updater.disableDifferentialDownload = false
  client.updater._testOnlyOptions = { isUseDifferentialDownload: true }
  client.updater.previousBlockmapBaseUrlOverride = 'https://example.test/v3.0.14/'
  const helper = await client.updater.getOrCreateDownloadHelper()
  await mkdir(helper.cacheDir, { recursive: true })
  await writeFile(join(helper.cacheDir, 'installer.exe'), bytes)
  await writeFile(join(helper.cacheDir, 'current.blockmap'), 'map left by a cancelled target')
  const map = { version: '2', files: [{ name: 'file', offset: 0, checksums: ['same-block'], sizes: [bytes.length] }] }
  const urls = []
  client.updater.httpExecutor.downloadToBuffer = async url => { urls.push(url.href); return gzipSync(JSON.stringify(map)) }
  client.updater.updateInfoAndProvider.provider.getBlockMapFiles = async (_url, old, next, base) =>
    [new URL(`AgentRouter-${old}-x64-Setup.exe.blockmap`, base), new URL(`https://example.test/${next}.blockmap`)]
  await client.verification.beforeDownload()
  await client.recovery.beforeDownload()
  const files = await client.updater.downloadUpdate()
  await client.verification.afterDownload(files)
  assert.ok(urls.includes('https://example.test/v3.0.14/AgentRouter-3.0.14-x64-Setup.exe.blockmap'))
  assert.equal(f.downloads(), 0, 'The native differential downloader copied all unchanged bytes')
  assert.deepEqual(await readFile(join(helper.cacheDir, 'installer.exe')), bytes)
})

test('cleanup refuses a pending-directory junction and never touches its target', async t => {
  const f = await fixture(t)
  const { updater, recovery } = f.create()
  const helper = await updater.getOrCreateDownloadHelper()
  await mkdir(helper.cacheDir, { recursive: true })
  const unrelated = join(f.work, 'unrelated')
  await mkdir(unrelated)
  await writeFile(join(unrelated, 'keep'), 'untouched')
  await symlink(unrelated, helper.cacheDirForPendingUpdate, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(recovery.discardInvalidDownload())
  assert.equal(await readFile(join(unrelated, 'keep'), 'utf8'), 'untouched')
})

test('failure messages distinguish metadata, locked files and integrity without exposing details', () => {
  assert.match(updateFailureMessage({ code: 'UPDATE_METADATA_UNAVAILABLE' }), /网络.*保留/)
  assert.match(updateFailureMessage({ code: 'UPDATE_CACHE_UNAVAILABLE' }), /占用/)
  assert.match(updateFailureMessage({ code: 'UPDATE_FILE_INVALID' }), /校验失败/)
  assert.match(updateFailureMessage({ code: 'UPDATE_DOWNLOAD_INTERRUPTED', transferred: 52428800 }), /50.0 MB 已保留.*继续下载/)
  assert.ok(!updateFailureMessage(new Error('private account/path')).includes('private'))
})
