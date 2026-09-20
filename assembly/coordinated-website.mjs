import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { setTimeout as pause } from 'node:timers/promises'

export const desktopDownloadPage = 'https://agentrouter.top/for-dsh'
const releaseBase = 'https://github.com/Maybank01/agentrouter-desktop-releases/releases'

async function pageText(response) {
  assert.equal(response.status, 200, 'The website download page must be available')
  assert.ok(response.body)
  const chunks = []; let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    assert.ok(size <= 2 * 1024 * 1024, 'The download page exceeds its size limit')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function attributes(tag) {
  return Object.fromEntries([...tag.matchAll(/\s([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)]
    .map(match => [match[1], match[2] ?? match[3]]))
}

/** Inspect server-rendered content, excluding metadata and hydration scripts. */
export function verifyWebsiteDownloadCard(html, version) {
  assert.match(version, /^\d+\.\d+\.\d+$/)
  const visible = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '').replace(/<!--[\s\S]*?-->/g, '')
  const cards = [...visible.matchAll(/<article\b[^>]*>[\s\S]*?<\/article\s*>/gi)]
    .map(match => match[0]).filter(card => [...card.matchAll(/<a\b[^>]*>/gi)]
      .some(match => attributes(match[0])['data-download-channel'] === 'github'))
  assert.equal(cards.length, 1, 'The website must expose one Windows download card')
  const text = cards[0].replace(/<[^>]*>/g, ' ')
  const current = /当前版本[：:]\s*V?\s*(\d+\.\d+\.\d+(?:-[\w.]+)?)/.exec(text)?.[1]
  assert.equal(current, version, `Website still displays ${current ?? 'no version'}; waiting for ${version}`)
  const links = [...cards[0].matchAll(/<a\b[^>]*>/gi)].map(match => attributes(match[0]))
  const filename = `AgentRouter-${version}-x64-Setup.exe`
  const downloadUrl = `${releaseBase}/download/v${version}/${filename}`
  const mirrorPath = `/downloads/desktop/v${version}/${filename}`
  for (const [channel, expected] of [['github', downloadUrl], ['mirror', mirrorPath]]) {
    const selected = links.filter(link => link['data-download-channel'] === channel)
    assert.equal(selected.length, 1, `The website must expose one ${channel} download`)
    assert.equal(new URL(selected[0].href, desktopDownloadPage).href, new URL(expected, desktopDownloadPage).href,
      `The website ${channel} link differs from the accepted installer`)
  }
  assert.ok(links.some(link => link.href === `${releaseBase}/tag/v${version}`), 'The website release notes must match the version')
  return { version, downloadUrl, mirrorUrl: new URL(mirrorPath, desktopDownloadPage).href }
}

/** The website caches latest metadata for 300 seconds. A release is complete
 * only once the visible card and both download channels agree with its bytes. */
export async function verifyCoordinatedWebsite(input, receipt, fetcher = fetch, options = {}) {
  assert.equal(input.candidateOnly, false)
  assert.equal(receipt.signed, true); assert.equal(receipt.testOnly, false)
  assert.deepEqual(receipt.input, input)
  const filename = `AgentRouter-${input.productVersion}-x64-Setup.exe`
  const installers = receipt.assets.filter(asset => asset.name === filename)
  assert.equal(installers.length, 1)
  const installer = installers[0]
  assert.ok(Number.isSafeInteger(installer.bytes) && installer.bytes > 0 && installer.bytes <= 512 * 1024 * 1024)
  assert.match(installer.sha256, /^[a-f0-9]{64}$/)
  const { timeoutMs = 360_000, now = Date.now, wait = pause,
    onRetry = message => console.error(message) } = options
  const deadline = now() + timeoutMs
  let card, lastError
  do {
    try {
      const response = await fetcher(desktopDownloadPage, { redirect: 'error', cache: 'no-store',
        headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(Math.max(1, Math.min(15000, deadline - now()))) })
      card = verifyWebsiteDownloadCard(await pageText(response), input.productVersion)
      break
    } catch (error) {
      lastError = error
      const remaining = deadline - now()
      if (remaining <= 0) break
      onRetry(`Waiting for website version ${input.productVersion}: ${error.message}`)
      await wait(Math.min(15000, remaining))
    }
  } while (now() < deadline)
  if (!card) throw new Error(`Website did not converge to ${input.productVersion}: ${lastError?.message}`, { cause: lastError })

  const response = await fetcher(card.mirrorUrl, { redirect: 'error', cache: 'no-store',
    headers: { Accept: 'application/octet-stream' }, signal: AbortSignal.timeout(180000) })
  assert.equal(response.status, 200, 'The website mirror must serve the accepted installer')
  assert.ok(response.body)
  const hash = createHash('sha256'); let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    assert.ok(size <= installer.bytes, 'The website mirror exceeds the accepted installer size')
    hash.update(chunk)
  }
  assert.equal(size, installer.bytes, 'The website mirror returned an incomplete installer')
  assert.equal(hash.digest('hex'), installer.sha256, 'The website mirror bytes differ from the accepted installer')
  return { websiteVersionVerified: true, websiteDownloadLinksVerified: true, websiteMirrorBytesVerified: true,
    website: { page: desktopDownloadPage, ...card, installerSha256: installer.sha256 } }
}
