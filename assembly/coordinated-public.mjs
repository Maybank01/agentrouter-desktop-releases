import assert from 'node:assert/strict'
// Node 24.15.0 can cache incomplete TLS exports when X509Certificate's legacy
// conversion initializes internal TLS first. Initialize the public module
// before inspecting signing policy so later anonymous HTTPS checks work.
import 'node:tls'
import { createHash } from 'node:crypto'
import { loadSigningPolicy } from './coordinated/windows-signing.mjs'
import { manifestName, verifyUpdateManifest } from './coordinated/update-signature.mjs'

const base = 'https://github.com/Maybank01/agentrouter-desktop-releases/releases'
const api = 'https://api.github.com/repos/Maybank01/agentrouter-desktop-releases/releases/latest'

async function publicBytes(url, limit, fetcher) {
  const response = await fetcher(url, { redirect: 'follow', signal: AbortSignal.timeout(180000), headers: { Accept: 'application/octet-stream' } })
  assert.equal(response.status, 200, 'Anonymous release download must succeed')
  assert.ok(response.body)
  const reader = response.body.getReader(), chunks = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) { await reader.cancel(); throw new Error('Public release asset exceeds its expected size') }
      chunks.push(value)
    }
    return Buffer.concat(chunks)
  } finally { reader.releaseLock() }
}

/** Check the public delivery surface after signed bytes are published. This
 * never changes assets, moves a tag, or turns unsigned tests into a release.
 */
export async function verifyCoordinatedPublicRelease(input, receipt, fetcher = fetch) {
  assert.equal(input.candidateOnly, false)
  assert.equal(receipt.signed, true)
  assert.equal(receipt.testOnly, false)
  assert.deepEqual(receipt.input, input)
  const policy = input.signing?.mode === 'self-signed' ? loadSigningPolicy() : undefined
  if (policy) {
    assert.deepEqual(receipt.signing, input.signing)
    assert.equal(receipt.installedSignedUpdate?.passed, true)
    assert.equal(receipt.installedSignedUpdate.nativeSignatureVerificationExecuted, true)
    assert.equal(receipt.assets.filter(file => file.name === manifestName).length, 1, 'A self-signed release must publish its signed update manifest')
  }
  assert.equal(input.updateUrl, `${base}/latest/download/`)
  const tag = `v${input.productVersion}`
  assert.match(tag, /^v\d+\.\d+\.\d+$/)
  const response = await fetcher(api, { redirect: 'error', headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) })
  assert.equal(response.status, 200)
  const text = await response.text()
  assert.ok(text.length <= 256 * 1024)
  const release = JSON.parse(text)
  assert.equal(release.tag_name, tag)
  assert.equal(release.draft, false); assert.equal(release.prerelease, false)
  for (const file of receipt.assets) {
    assert.match(file.name, /^(?:AgentRouter-\d+\.\d+\.\d+-x64-Setup\.exe(?:\.blockmap)?|latest\.yml|agentrouter-update\.json)$/)
    assert.ok(Number.isSafeInteger(file.bytes) && file.bytes > 0 && file.bytes <= 512 * 1024 * 1024)
    const assets = release.assets.filter(asset => asset.name === file.name)
    assert.equal(assets.length, 1)
    assert.equal(assets[0].size, file.bytes)
    assert.equal(assets[0].digest, `sha256:${file.sha256}`)
    const url = `${base}/download/${tag}/${file.name}`
    assert.equal(assets[0].browser_download_url, url)
    // latest.yml must also be the exact accepted public updater feed.
    for (const path of [url, ...(['latest.yml', manifestName].includes(file.name) ? [`${input.updateUrl}${file.name}`] : [])]) {
      const bytes = await publicBytes(path, file.bytes, fetcher)
      assert.equal(bytes.length, file.bytes)
      assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256)
      if (policy && file.name === manifestName) {
        const manifest = verifyUpdateManifest(JSON.parse(bytes.toString('utf8')), policy, input.productVersion)
        for (const asset of receipt.assets.filter(asset => asset.name !== manifestName)) {
          assert.deepEqual(manifest.assets.find(entry => entry.name === asset.name), asset)
        }
      }
    }
  }
  for (const name of ['release-receipt.json', 'signed-installed-acceptance.json']) {
    const assets = release.assets.filter(asset => asset.name === name)
    assert.equal(assets.length, 1)
    const bytes = await publicBytes(`${base}/download/${tag}/${name}`, 256 * 1024, fetcher)
    assert.equal(bytes.length, assets[0].size)
    assert.equal(`sha256:${createHash('sha256').update(bytes).digest('hex')}`, assets[0].digest)
    const evidence = JSON.parse(bytes.toString('utf8'))
    assert.deepEqual(evidence.input, input)
    if (name === 'release-receipt.json') assert.deepEqual(evidence, receipt)
    else {
      assert.equal(evidence.passed, true); assert.equal(evidence.installerExecuted, true)
      assert.equal(evidence.sourceCommit, receipt.sourceCommit)
      assert.equal(evidence.patchSha256, receipt.patchSha256)
      assert.equal(evidence.signedInstallerSha256, receipt.assets.find(file => file.name.endsWith('.exe')).sha256)
      if (policy) {
        assert.deepEqual(evidence.signing, input.signing)
        assert.deepEqual(evidence.installedSignedUpdate, receipt.installedSignedUpdate)
      }
    }
  }
  return { tag, anonymousDownloadsVerified: true, publicFeedBytesVerified: true }
}
