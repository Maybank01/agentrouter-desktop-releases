/**
 * Warm and verify the website download mirror after GitHub publication.
 *
 * The mirror (agentrouter.top/downloads/desktop/) is a verified pull-through
 * cache of the GitHub release. Order matters: the versioned installer and its
 * blockmap and per-version agentrouter-update.json are requested first; the
 * mirror advertises a version in latest.yml only once all three are cached. This check
 * then requires the feed to be byte-identical to GitHub's and the installer and
 * blockmap bytes to match the release digests (sha256 and latest.yml sha512).
 *
 * MIRROR_REQUIRED=true makes a mismatch or timeout fail publication; otherwise
 * the result is reported (summary/receipt) while the mirror route is rolled out.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const mirrorBase = 'https://agentrouter.top/downloads/desktop'
const github = 'https://github.com/Maybank01/agentrouter-desktop-releases/releases/download'

const sha = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding)

async function bytesOf(url, fetcher, timeoutMs = 600_000) {
  // One bounded retry for a dropped connection ("terminated") on the 300 MB installer.
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetcher(url, { redirect: 'follow', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) })
      return { status: response.status, headers: response.headers, bytes: response.status === 200 ? Buffer.from(await response.arrayBuffer()) : undefined }
    } catch (error) {
      if (attempt >= 2) throw error
    }
  }
}

/** Expected files of one version from its GitHub release (the source of truth). */
export function mirrorPlan(version, assets) {
  const installer = `AgentRouter-${version}-x64-Setup.exe`
  const pick = name => {
    const asset = assets.find(entry => entry.name === name)
    assert.ok(asset, `GitHub release lacks ${name}`)
    assert.match(asset.digest ?? '', /^sha256:[a-f0-9]{64}$/, `${name} has no GitHub digest`)
    return { name, size: asset.size, sha256: asset.digest.slice('sha256:'.length) }
  }
  return {
    // Client contract: per-version installer, blockmap and signed manifest; one moving latest.yml.
    versioned: [pick(installer), pick(`${installer}.blockmap`), pick('agentrouter-update.json')].map(file => ({ ...file, url: `${mirrorBase}/v${version}/${file.name}` })),
    feed: [pick('latest.yml')].map(file => ({ ...file, url: `${mirrorBase}/${file.name}`, origin: `${github}/v${version}/${file.name}` })),
  }
}

export async function verifyMirror({ version, assets, fetcher = fetch, sleep = ms => new Promise(done => setTimeout(done, ms)),
  now = Date.now, timeoutMs = 10 * 60_000, intervalMs = 15_000, feed = true }) {
  const plan = mirrorPlan(version, assets)
  const result = { version, versioned: [], feed: [] }
  // 1. Versioned bytes first (this also warms the mirror before its feed moves).
  for (const file of plan.versioned) {
    const started = now()
    let fetched
    for (;;) {
      fetched = await bytesOf(file.url, fetcher)
      if (fetched.status === 200 || now() - started + intervalMs > timeoutMs) break
      await sleep(intervalMs)
    }
    assert.equal(fetched.status, 200, `Mirror ${file.url} returned ${fetched.status}`)
    assert.equal(fetched.bytes.length, file.size, `Mirror ${file.name} size differs from GitHub`)
    assert.equal(sha(fetched.bytes), file.sha256, `Mirror ${file.name} bytes differ from GitHub`)
    result.versioned.push({ name: file.name, sha256: file.sha256, cache: fetched.headers.get('cf-cache-status'), cacheControl: fetched.headers.get('cache-control'),
      ...(file.name.endsWith('.exe') ? { sha512: sha(fetched.bytes, 'sha512', 'base64') } : {}) })
  }
  if (!feed) return { ...result, verified: true, feed: 'not checked (older version)' }
  // 2. The feed must then converge to GitHub's exact bytes for this version.
  const started = now()
  for (const file of plan.feed) {
    let fetched
    for (;;) {
      fetched = await bytesOf(file.url, fetcher, 60_000)
      if (fetched.status === 200 && sha(fetched.bytes) === file.sha256) break
      assert.ok(now() - started + intervalMs <= timeoutMs, `Mirror ${file.name} did not converge to ${version} (HTTP ${fetched.status})`)
      await sleep(intervalMs)
    }
    result.feed.push({ name: file.name, sha256: file.sha256, cacheControl: fetched.headers.get('cache-control') })
  }
  const latest = plan.feed.find(file => file.name === 'latest.yml')
  const feedText = (await bytesOf(latest.url, fetcher, 60_000)).bytes.toString('utf8')
  const installer = result.versioned.find(file => file.sha512)
  assert.ok(feedText.includes(`sha512: >-\n    ${installer.sha512}`) || feedText.includes(installer.sha512), 'Mirror installer sha512 differs from latest.yml')
  return { ...result, verified: true }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const version = process.argv[2] ?? JSON.parse(readFileSync('assembly/coordinated/release.json', 'utf8')).productVersion
  assert.match(version ?? '', /^\d+\.\d+\.\d+$/)
  const required = process.env.MIRROR_REQUIRED === 'true'
  let outcome
  try {
    const release = await (await fetch(`https://api.github.com/repos/Maybank01/agentrouter-desktop-releases/releases/tags/v${version}`,
      { headers: { accept: 'application/vnd.github+json', ...(process.env.GH_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN}` } : {}) } })).json()
    outcome = await verifyMirror({ version, assets: release.assets, feed: !process.argv.includes('--versioned-only') })
  } catch (error) {
    outcome = { version, verified: false, error: String(error?.message ?? error).slice(0, 300) }
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `## Website download mirror\n\n${outcome.verified ? 'Verified byte-identical to GitHub.' : `**Not verified** (${required ? 'required: publication fails' : 'report-only while the mirror route rolls out'}).`}\n\n\`\`\`json\n${JSON.stringify(outcome, null, 2)}\n\`\`\`\n`)
  console.log(JSON.stringify(outcome))
  if (!outcome.verified && required) process.exitCode = 1
}
