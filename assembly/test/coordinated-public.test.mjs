import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { verifyCoordinatedPublicRelease } from '../coordinated-public.mjs'
import { loadSigningPolicy } from '../coordinated/windows-signing.mjs'

test('a fresh publisher process can initialize TLS after reading the signing certificate', () => {
  // node:test may already initialize TLS. A fresh process reproduces the
  // certificate-first initialization order used by the release publisher.
  const script = `
    import ${JSON.stringify(new URL('../coordinated-public.mjs', import.meta.url).href)};
    import { loadSigningPolicy } from ${JSON.stringify(new URL('../coordinated/windows-signing.mjs', import.meta.url).href)};
    loadSigningPolicy();
    const { connect } = await import('node:tls');
    const { Socket } = await import('node:net');
    const socket = connect({ socket: new Socket(), servername: 'localhost' });
    socket.destroy();
  `
  // The unconnected socket exercises secure-context construction without
  // making any network request or changing certificate trust.
  execFileSync(process.execPath, ['--input-type=module'], {
    input: script, encoding: 'utf8', windowsHide: true, timeout: 15000,
  })
})

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
  const page = `<article><p>当前版本：V 3.0.5</p>
    <a data-download-channel="github" href="${base}/download/v3.0.5/AgentRouter-3.0.5-x64-Setup.exe">下载</a>
    <a data-download-channel="mirror" href="/downloads/desktop/v3.0.5/AgentRouter-3.0.5-x64-Setup.exe">镜像</a>
    <a href="${base}/tag/v3.0.5">版本说明</a></article>`
  const fetcher = async (url, options) => {
    urls.push(url)
    assert.equal(options.headers.Authorization, undefined, 'public validation must be anonymous')
    return new Response(url.endsWith('/for-dsh') ? page : url.includes('api.github.com') ? JSON.stringify(release) : bodies.get(url.split('/').at(-1)))
  }
  return { input, receipt, bodies, release, fetcher, urls }
}

test('published delivery verifies anonymous installer, receipts and actual updater feed bytes', async () => {
  const f = fixture()
  const result = await verifyCoordinatedPublicRelease(f.input, f.receipt, f.fetcher)
  assert.equal(result.publicFeedBytesVerified, true)
  assert.equal(result.websiteVersionVerified, true)
  assert.equal(result.websiteMirrorBytesVerified, true)
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
