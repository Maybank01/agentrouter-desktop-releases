/**
 * Wait until npm serves the exact plugin bytes locked in release.json.
 *
 * A Desktop PR is opened as soon as the plugin candidate is accepted, with the
 * candidate's SHA-256 and integrity. Its installed checks (and the release) then
 * start the moment the protected publisher's bytes are public, instead of failing
 * with a 404 and waiting for a human rerun. Identity is never relaxed: the
 * version's integrity and the downloaded tarball's size and SHA-256 must equal
 * the locked input; a different published artifact fails immediately.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const registry = 'https://registry.npmjs.org'
const packagePath = name => name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name)

/** One observation: 'pending' while npm does not serve it yet, otherwise verified or thrown. */
export async function observePlugin(plugin, { requireNext = false, fetcher = fetch } = {}) {
  const response = await fetcher(`${registry}/${packagePath(plugin.name)}`, { signal: AbortSignal.timeout(30_000),
    headers: { accept: 'application/json' } })
  if (response.status === 404) return { state: 'pending', reason: 'package metadata not visible' }
  assert.equal(response.status, 200, `npm metadata returned ${response.status}`)
  const packument = await response.json()
  const version = packument.versions?.[plugin.version]
  if (!version) return { state: 'pending', reason: `version ${plugin.version} not visible` }
  assert.equal(version.dist?.integrity, plugin.integrity, `npm ${plugin.name}@${plugin.version} is a different artifact than the locked candidate`)
  const next = packument['dist-tags']?.next
  if (requireNext && next !== plugin.version) {
    // Waiting only helps while the locked version is newer than next; a newer
    // next needs a reviewed input change (or retain_plugin_reason), not time.
    assert.ok(!(packument.time?.[next] > packument.time?.[plugin.version]), `npm next ${next} is newer than the locked plugin ${plugin.version}`)
    return { state: 'pending', reason: `next is ${next}` }
  }
  const tarball = await fetcher(version.dist.tarball, { signal: AbortSignal.timeout(120_000) })
  if (tarball.status === 404) return { state: 'pending', reason: 'tarball not replicated' }
  assert.equal(tarball.status, 200, `npm tarball returned ${tarball.status}`)
  const bytes = Buffer.from(await tarball.arrayBuffer())
  assert.equal(bytes.length, plugin.size, 'npm tarball size differs from the locked candidate')
  assert.equal(createHash('sha256').update(bytes).digest('hex'), plugin.sha256, 'npm tarball SHA-256 differs from the locked candidate')
  return { state: 'verified', next: packument['dist-tags']?.next, published: packument.time?.[plugin.version] }
}

export async function waitForPlugin(plugin, { timeoutMs = 30 * 60_000, intervalMs = 15_000, requireNext = false,
  fetcher = fetch, sleep = ms => new Promise(done => setTimeout(done, ms)), now = Date.now, log = console.error } = {}) {
  const started = now()
  for (let attempt = 1; ; attempt++) {
    const observed = await observePlugin(plugin, { requireNext, fetcher })
    if (observed.state === 'verified') return { ...observed, waitedMs: now() - started, attempts: attempt }
    assert.ok(now() - started + intervalMs <= timeoutMs,
      `npm did not serve ${plugin.name}@${plugin.version} within ${Math.round(timeoutMs / 60_000)} minutes (${observed.reason}); publish its authorization first`)
    if (attempt === 1 || attempt % 4 === 0) log(`Waiting for npm ${plugin.name}@${plugin.version}: ${observed.reason}`)
    await sleep(intervalMs)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const input = JSON.parse(readFileSync('assembly/coordinated/release.json', 'utf8'))
  const minutes = Number(process.env.PLUGIN_WAIT_MINUTES ?? 30)
  assert.ok(Number.isFinite(minutes) && minutes > 0 && minutes <= 60)
  const result = await waitForPlugin(input.plugin, { timeoutMs: minutes * 60_000, requireNext: process.argv.includes('--require-next') })
  const line = { plugin: `${input.plugin.name}@${input.plugin.version}`, sha256: input.plugin.sha256, ...result }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `## Locked plugin bytes on npm\n\nVerified after ${Math.round(result.waitedMs / 1000)} s (${result.attempts} observations).\n\n\`\`\`json\n${JSON.stringify(line, null, 2)}\n\`\`\`\n`)
  console.log(JSON.stringify(line))
}
