import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { desktopDownloadPage, verifyCoordinatedWebsite, verifyWebsiteDownloadCard } from '../coordinated-website.mjs'

const base = 'https://github.com/Maybank01/agentrouter-desktop-releases/releases'
function card(version = '3.0.8') {
  return `<article><p>当前版本：V <!-- -->${version}</p>
    <a href="${base}/download/v${version}/AgentRouter-${version}-x64-Setup.exe" data-download-channel="github">立即下载</a>
    <a data-download-channel='mirror' href='/downloads/desktop/v${version}/AgentRouter-${version}-x64-Setup.exe'>备用镜像</a>
    <a href="${base}/tag/v${version}">版本说明</a></article>`
}
function fixture() {
  const bytes = Buffer.from('MZ exact accepted installer')
  const input = { productVersion: '3.0.8', candidateOnly: false }
  const receipt = { input, signed: true, testOnly: false, assets: [{ name: 'AgentRouter-3.0.8-x64-Setup.exe',
    bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] }
  let elapsed = 0
  const delays = []
  return { input, receipt, bytes, delays, options: { timeoutMs: 30_000, now: () => elapsed,
    wait: async ms => { delays.push(ms); elapsed += ms }, onRetry: () => {} } }
}

test('waits for stale website metadata to refresh before accepting the mirror bytes', async () => {
  const f = fixture(); let pageReads = 0
  const fetcher = async (url, options) => {
    assert.equal(options.headers.Authorization, undefined)
    return new Response(url === desktopDownloadPage ? card(++pageReads === 1 ? '3.0.7' : '3.0.8') : f.bytes)
  }
  const result = await verifyCoordinatedWebsite(f.input, f.receipt, fetcher, f.options)
  assert.equal(pageReads, 2); assert.deepEqual(f.delays, [15000])
  assert.equal(result.websiteVersionVerified, true); assert.equal(result.websiteMirrorBytesVerified, true)
})

test('a stale visible version cannot pass using a current link or hydration-script content', () => {
  const stale = card().replace('<!-- -->3.0.8', '<!-- -->3.0.7')
  assert.throws(() => verifyWebsiteDownloadCard(`${stale}<script>${card()}</script>`, '3.0.8'), /still displays 3.0.7/)
  for (const fragment of ['/download/v3.0.8/', '/desktop/v3.0.8/', '/tag/v3.0.8']) {
    assert.throws(() => verifyWebsiteDownloadCard(card().replace(fragment, fragment.replace('3.0.8', '3.0.7')), '3.0.8'))
  }
})

test('website failure has a bounded wait and preserves the observed stale-version reason', async () => {
  const f = fixture()
  await assert.rejects(verifyCoordinatedWebsite(f.input, f.receipt,
    async () => new Response(card('3.0.7')), f.options), /Website did not converge to 3.0.8:.*3.0.7/)
  assert.deepEqual(f.delays, [15000, 15000])
})

test('correct website labels cannot conceal unavailable, truncated or corrupted mirror bytes', async () => {
  for (const [bytes, status] of [[Buffer.from('unavailable'), 503], [Buffer.from('MZ short'), 200],
    [Buffer.from('MZ wrong accepted installer'), 200]]) {
    const f = fixture()
    const fetcher = async url => url === desktopDownloadPage ? new Response(card()) : new Response(bytes, { status })
    await assert.rejects(verifyCoordinatedWebsite(f.input, f.receipt, fetcher, f.options), /website mirror/)
  }
})
