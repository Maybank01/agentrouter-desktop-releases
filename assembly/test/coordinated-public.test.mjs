import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { verifyCoordinatedPublicRelease } from '../coordinated-public.mjs'
import { loadSigningPolicy } from '../coordinated/windows-signing.mjs'

function fixture() {
  const base = 'https://github.com/Maybank01/agentrouter-desktop-releases/releases'
  const input = { candidateOnly: false, productVersion: '3.0.5', updateUrl: `${base}/latest/download/` }
  const bodies = new Map([['AgentRouter-3.0.5-x64-Setup.exe', Buffer.from('MZ signed fixture')], ['latest.yml', Buffer.from('version: 3.0.5')]])
  const digest = bytes => createHash('sha256').update(bytes).digest('hex')
  const receipt = { input, signed: true, testOnly: false, sourceCommit: 'a'.repeat(40), patchSha256: 'b'.repeat(64),
    assets: [...bodies].map(([name, bytes]) => ({ name, bytes: bytes.length, sha256: digest(bytes) })) }
  bodies.set('release-receipt.json', Buffer.from(JSON.stringify(receipt)))
  bodies.set('signed-installed-acceptance.json', Buffer.from(JSON.stringify({ input, passed: true, installerExecuted: true,
    sourceCommit: receipt.sourceCommit, patchSha256: receipt.patchSha256, signedInstallerSha256: receipt.assets[0].sha256 })))
  const release = { draft: false, prerelease: false, tag_name: 'v3.0.5', assets: [...bodies].map(([name, bytes]) => ({
    name, size: bytes.length, digest: `sha256:${digest(bytes)}`, browser_download_url: `${base}/download/v3.0.5/${name}`,
  })) }
  const urls = []
  const fetcher = async (url, options) => {
    urls.push(url)
    assert.equal(options.headers.Authorization, undefined, 'public validation must be anonymous')
    return new Response(url.includes('api.github.com') ? JSON.stringify(release) : bodies.get(url.split('/').at(-1)))
  }
  return { input, receipt, bodies, release, fetcher, urls }
}

test('published delivery verifies anonymous installer, receipts and actual updater feed bytes', async () => {
  const f = fixture()
  const result = await verifyCoordinatedPublicRelease(f.input, f.receipt, f.fetcher)
  assert.equal(result.publicFeedBytesVerified, true)
  assert.ok(f.urls.includes(`${f.input.updateUrl}latest.yml`))
})

test('test-only installers, a stale public latest and changed public bytes cannot pass delivery', async () => {
  const f = fixture()
  await assert.rejects(verifyCoordinatedPublicRelease(f.input, { ...f.receipt, testOnly: true }, f.fetcher))
  f.release.tag_name = 'v3.0.4'
  await assert.rejects(verifyCoordinatedPublicRelease(f.input, f.receipt, f.fetcher))
  f.release.tag_name = 'v3.0.5'
  f.bodies.set('latest.yml', Buffer.from('version: 9.9.9'))
  await assert.rejects(verifyCoordinatedPublicRelease(f.input, f.receipt, f.fetcher))
})

test('a self-signed claim without the public signed manifest or native signature acceptance is rejected', async () => {
  const f = fixture(), policy = loadSigningPolicy()
  f.input.signing = { mode: policy.mode, certificateSha256: policy.certificateSha256 }
  f.receipt.signing = f.input.signing
  await assert.rejects(verifyCoordinatedPublicRelease(f.input, f.receipt, f.fetcher))
  f.receipt.installedSignedUpdate = { passed: true, nativeSignatureVerificationExecuted: true }
  await assert.rejects(verifyCoordinatedPublicRelease(f.input, f.receipt, f.fetcher), /signed update manifest/)
})
