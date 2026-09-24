/** Verification shared by the native electron-updater hook and release acceptance.
 * The installed app pins the update key. No Windows trust-store changes are used.
 */
import assert from 'node:assert/strict'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { createReadStream } from 'node:fs'

export const manifestName = 'agentrouter-update.json'
const maxManifest = 64 * 1024
const maxAsset = 1024 * 1024 * 1024
const versionPattern = /^\d+\.\d+\.\d+$/

export function validateSigningPolicy(policy) {
  assert.equal(policy?.schemaVersion, 1)
  assert.equal(policy.mode, 'self-signed')
  assert.match(policy.certificateSha256, /^[a-f0-9]{64}$/)
  assert.equal(typeof policy.publisher, 'string')
  assert.ok(policy.publisher.length > 0)
  assert.equal(typeof policy.publicKey, 'string')
  const key = createPublicKey(policy.publicKey)
  assert.equal(key.asymmetricKeyType, 'rsa')
  assert.ok(key.asymmetricKeyDetails.modulusLength >= 3072)
  return key
}

function base64(value) {
  assert.equal(typeof value, 'string')
  assert.ok(value.length > 0 && value.length <= maxManifest)
  const bytes = Buffer.from(value, 'base64')
  assert.equal(bytes.toString('base64'), value)
  return bytes
}

export function verifyUpdateManifest(envelope, policy, version) {
  const key = validateSigningPolicy(policy)
  assert.match(version, versionPattern)
  assert.equal(envelope?.schemaVersion, 1)
  assert.equal(envelope.algorithm, 'RSA-SHA256')
  const payload = base64(envelope.payload)
  assert.ok(verify('RSA-SHA256', payload, key, base64(envelope.signature)), 'Update manifest signature does not match the installed key')
  const manifest = JSON.parse(payload.toString('utf8'))
  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.productVersion, version, 'The signed update version differs from the selected update')
  assert.equal(manifest.certificateSha256, policy.certificateSha256)
  assert.ok(Array.isArray(manifest.assets) && manifest.assets.length >= 1 && manifest.assets.length <= 8)
  const names = new Set()
  for (const file of manifest.assets) {
    assert.equal(typeof file.name, 'string')
    assert.ok(['AgentRouter.exe', 'latest.yml', `AgentRouter-${version}-x64-Setup.exe`, `AgentRouter-${version}-x64-Setup.exe.blockmap`].includes(file.name))
    assert.ok(!names.has(file.name)); names.add(file.name)
    assert.ok(Number.isSafeInteger(file.bytes) && file.bytes > 0 && file.bytes <= maxAsset)
    assert.match(file.sha256, /^[a-f0-9]{64}$/)
  }
  return manifest
}

export async function verifyUpdateFile(manifest, path, name) {
  const entry = manifest.assets.find(file => file.name === name)
  assert.ok(entry, 'File is absent from the signed update manifest')
  const hash = createHash('sha256')
  let size = 0
  for await (const bytes of createReadStream(path)) {
    size += bytes.length
    assert.ok(size <= entry.bytes, 'Update file exceeds the signed size')
    hash.update(bytes)
  }
  assert.equal(size, entry.bytes, 'Update file size differs from the signature')
  assert.equal(hash.digest('hex'), entry.sha256, 'Update file content differs from the signature')
  return entry
}

export function validateUpdateFeed(value, testOnly = false) {
  const url = new URL(value)
  const localTest = testOnly === true && url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port
  assert.ok(url.protocol === 'https:' || localTest, 'Signed updates require HTTPS')
  assert.equal(url.username + url.password + url.search + url.hash, '')
  assert.ok(url.pathname.endsWith('/'))
  return url
}

async function readManifest(url, fetcher) {
  const response = await fetcher(url, { redirect: 'follow', signal: AbortSignal.timeout(30000) })
  assert.equal(response.status, 200, 'Signed update metadata is unavailable')
  if (response.url) {
    const actual = new URL(response.url)
    assert.ok(actual.protocol === 'https:' || (url.protocol === 'http:' && actual.origin === url.origin))
  }
  assert.ok(response.body)
  const chunks = []; let size = 0
  for await (const bytes of response.body) {
    size += bytes.length
    assert.ok(size <= maxManifest, 'Signed update metadata exceeds its limit')
    chunks.push(bytes)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** electron-updater's supported verifyUpdateCodeSignature callback. Errors
 * always reject installation; absence of Windows root trust is not a bypass.
 */
function verificationError(code, cause) {
  return Object.assign(new Error(code, { cause }), { code })
}

function pinnedUpdateVerification(config, getVersion, fetcher) {
  validateSigningPolicy(config.policy)
  const feed = validateUpdateFeed(config.feed, config.testOnly)
  // Node's global fetch ignores the Windows system proxy and PAC. <=3.0.19 used it
  // here and could not verify updates where GitHub is reachable only via a proxy.
  assert.equal(typeof fetcher, 'function', 'Signed update metadata requires an explicit (Electron session) fetcher')
  let selectedVersion, manifestPromise
  const prepare = async () => {
    const version = getVersion()
    assert.match(version, versionPattern)
    if (selectedVersion !== version || !manifestPromise) {
      selectedVersion = version
      // A downloaded release remains valid when a newer release becomes latest.
      // Pin GitHub metadata to the same immutable tag as the selected installer.
      const base = new URL(feed)
      if (base.origin === 'https://github.com' && /\/releases\/latest\/download\/$/.test(base.pathname)) {
        base.pathname = base.pathname.replace(/\/releases\/latest\/download\/$/, `/releases/download/v${version}/`)
      }
      const operation = (async () => {
        let envelope
        try { envelope = await readManifest(new URL(manifestName, base), fetcher) }
        catch (cause) { throw verificationError('UPDATE_METADATA_UNAVAILABLE', cause) }
        try { return verifyUpdateManifest(envelope, config.policy, version) }
        catch (cause) { throw verificationError('UPDATE_METADATA_INVALID', cause) }
      })()
      manifestPromise = operation
      // A temporary transport failure must not poison all subsequent retries.
      void operation.catch(() => { if (manifestPromise === operation) manifestPromise = undefined })
    }
    return { version, manifest: await manifestPromise }
  }
  const verifyFile = async path => {
    const { version, manifest } = await prepare()
    try { await verifyUpdateFile(manifest, path, `AgentRouter-${version}-x64-Setup.exe`) }
    catch (cause) {
      throw verificationError(['EACCES', 'EPERM', 'EBUSY'].includes(cause?.code)
        ? 'UPDATE_CACHE_UNAVAILABLE' : 'UPDATE_FILE_INVALID', cause)
    }
  }
  const hook = async (publishers, path) => {
    try {
      assert.ok(publishers.includes(config.policy.publisher))
      await verifyFile(path)
      return null
    } catch {
      return 'AgentRouter update signature verification failed. Check for updates and retry.'
    }
  }
  return { prepare, verifyFile, hook }
}

export function createPinnedUpdateVerifier(config, getVersion, fetcher) {
  return pinnedUpdateVerification(config, getVersion, fetcher).hook
}

/** Guard both the updater's normal path and its existing-download cache path. */
export function configurePinnedUpdater(updater, config, getVersion, fetcher) {
  assert.equal(typeof updater.verifyUpdateCodeSignature, 'function', 'The installed updater lacks its signature-verifier interface')
  const verification = pinnedUpdateVerification(config, getVersion, fetcher)
  const verifier = verification.hook
  updater.verifyUpdateCodeSignature = verifier
  return {
    beforeDownload: async () => {
      assert.equal(updater.verifyUpdateCodeSignature, verifier)
      const settings = await updater.configOnDisk.value
      const publishers = Array.isArray(settings.publisherName) ? settings.publisherName : [settings.publisherName]
      assert.deepEqual(publishers, [config.policy.publisher], 'The installed updater must require its pinned publisher')
      // Verify metadata before downloading. Later checks rehash the file against
      // this authenticated manifest without requiring another network request.
      await verification.prepare()
    },
    afterDownload: async paths => {
      assert.ok(Array.isArray(paths) && paths.length === 1)
      await verification.verifyFile(paths[0])
    },
  }
}
