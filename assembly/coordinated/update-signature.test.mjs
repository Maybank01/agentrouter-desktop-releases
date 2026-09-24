import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createPinnedUpdateVerifier, configurePinnedUpdater, verifyUpdateManifest, verifyUpdateFile } from './update-signature.mjs'

const keys = generateKeyPairSync('rsa', { modulusLength: 3072 })
const wrongKeys = generateKeyPairSync('rsa', { modulusLength: 3072 })
const policy = { schemaVersion: 1, mode: 'self-signed', publisher: 'AgentRouter', certificateSha256: 'a'.repeat(64),
  publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }) }
const bytes = Buffer.from('signed installer bytes for a disposable cryptographic test')
const file = { name: 'AgentRouter-3.0.7-x64-Setup.exe', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
const payload = Buffer.from(JSON.stringify({ schemaVersion: 1, productVersion: '3.0.7', certificateSha256: policy.certificateSha256, assets: [file] }))
const envelope = { schemaVersion: 1, algorithm: 'RSA-SHA256', payload: payload.toString('base64'), signature: sign('RSA-SHA256', payload, keys.privateKey).toString('base64') }
const config = { policy, feed: 'https://example.test/releases/' }
const work = mkdtempSync(join(tmpdir(), 'agentrouter-signature-'))
const path = join(work, file.name)
writeFileSync(path, bytes)
const fetcher = async () => new Response(JSON.stringify(envelope))

test('pinned signed metadata validates the exact installer without Windows root trust', async () => {
  const manifest = verifyUpdateManifest(envelope, policy, '3.0.7')
  await verifyUpdateFile(manifest, path, file.name)
  assert.equal(await createPinnedUpdateVerifier(config, () => '3.0.7', fetcher)(['AgentRouter'], path), null)
})

test('tampered manifest, wrong signing key, wrong publisher and wrong release are rejected', async () => {
  const modified = { ...envelope, payload: Buffer.from(payload.toString().replace('3.0.7', '9.0.0')).toString('base64') }
  assert.throws(() => verifyUpdateManifest(modified, policy, '9.0.0'))
  assert.throws(() => verifyUpdateManifest({ ...envelope, signature: sign('RSA-SHA256', payload, wrongKeys.privateKey).toString('base64') }, policy, '3.0.7'))
  assert.throws(() => verifyUpdateManifest(envelope, policy, '3.0.8'))
  assert.notEqual(await createPinnedUpdateVerifier(config, () => '3.0.7', fetcher)(['Unrelated publisher'], path), null)
})

test('installer modifications, missing signatures and unavailable metadata fail closed', async () => {
  const modified = join(work, 'modified.exe')
  const changed = Buffer.from(bytes); changed[0] ^= 1; writeFileSync(modified, changed)
  const verify = createPinnedUpdateVerifier(config, () => '3.0.7', fetcher)
  assert.notEqual(await verify(['AgentRouter'], modified), null)
  assert.notEqual(await createPinnedUpdateVerifier(config, () => '3.0.7', async () => new Response('{}'))(['AgentRouter'], path), null)
  assert.notEqual(await createPinnedUpdateVerifier(config, () => '3.0.7', async () => new Response('', { status: 404 }))(['AgentRouter'], path), null)
})

test('existing download cache is verified again and cannot bypass a missing publisher check', async () => {
  const updater = { verifyUpdateCodeSignature: async () => null, configOnDisk: { value: Promise.resolve({ publisherName: 'AgentRouter' }) } }
  const check = configurePinnedUpdater(updater, config, () => '3.0.7', fetcher)
  await check.beforeDownload()
  await check.afterDownload([path])
  await assert.rejects(check.afterDownload([join(work, 'modified.exe')]))
  updater.configOnDisk.value = Promise.resolve({})
  await assert.rejects(check.beforeDownload())
  updater.verifyUpdateCodeSignature = async () => null
  await assert.rejects(check.beforeDownload())
})

test('HTTP is restricted to an explicit packaged loopback test feed', () => {
  assert.throws(() => createPinnedUpdateVerifier({ ...config, feed: 'http://example.test/' }, () => '3.0.7', fetcher))
  assert.throws(() => createPinnedUpdateVerifier({ ...config, feed: 'http://127.0.0.1:4567/' }, () => '3.0.7', fetcher))
  assert.doesNotThrow(() => createPinnedUpdateVerifier({ ...config, feed: 'http://127.0.0.1:4567/', testOnly: true }, () => '3.0.7', fetcher))
  // No implicit Node global fetch: it ignores the system proxy.
  assert.throws(() => createPinnedUpdateVerifier(config, () => '3.0.7'), /explicit/)
})

test('one authenticated manifest serves the signature hook, cache check and restart even when latest moves or goes offline', async () => {
  const urls = []
  const updater = { verifyUpdateCodeSignature: async () => null, configOnDisk: { value: Promise.resolve({ publisherName: 'AgentRouter' }) } }
  const check = configurePinnedUpdater(updater, { ...config, feed: 'https://github.com/owner/product/releases/latest/download/' }, () => '3.0.7', async url => {
    urls.push(url.href)
    assert.equal(urls.length, 1, 'Later checks must not depend on a new network request')
    return fetcher()
  })
  await check.beforeDownload()
  assert.equal(await updater.verifyUpdateCodeSignature(['AgentRouter'], path), null)
  await check.afterDownload([path])
  await check.afterDownload([path])
  assert.deepEqual(urls, ['https://github.com/owner/product/releases/download/v3.0.7/agentrouter-update.json'])
  await assert.rejects(check.afterDownload([join(work, 'modified.exe')]), { code: 'UPDATE_FILE_INVALID' })
})

test('a failed metadata request can retry, while selecting a different release requires its own signed manifest', async () => {
  let version = '3.0.7', requests = 0
  const updater = { verifyUpdateCodeSignature: async () => null, configOnDisk: { value: Promise.resolve({ publisherName: 'AgentRouter' }) } }
  const check = configurePinnedUpdater(updater, config, () => version, async () => {
    if (++requests === 1) throw new Error('temporary offline state')
    return fetcher()
  })
  await assert.rejects(check.beforeDownload(), { code: 'UPDATE_METADATA_UNAVAILABLE' })
  await check.beforeDownload()
  await check.afterDownload([path])
  assert.equal(requests, 2)
  version = '3.0.8'
  await assert.rejects(check.beforeDownload(), { code: 'UPDATE_METADATA_INVALID' })
  assert.equal(requests, 3)
})
