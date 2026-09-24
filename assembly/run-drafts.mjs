/**
 * Never-published, run-scoped drafts of this public repository.
 *
 * - `baseline-<run>`: the signed loopback native-update baseline, produced on its
 *   own worker in parallel with product signing and consumed by the signed
 *   native update. Draft releases are visible only to repository writers; they
 *   are not public, not readable by fork workflows, never a product asset and
 *   never in a feed. The consumer re-verifies digests and Authenticode.
 * - `rehearsal-<run>`: the signed product staged by a rehearsal run. It is a
 *   prerelease draft under a non-version tag, so it can neither become latest nor
 *   be published by coordinated-release.mjs.
 * Both are deleted by the cleanup job of the same run.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const repository = 'Maybank01/agentrouter-desktop-releases'
export const runDraftTag = (kind, runId) => {
  assert.ok(['baseline', 'rehearsal'].includes(kind), `Unknown run draft ${kind}`)
  assert.match(String(runId ?? ''), /^[1-9][0-9]*$/)
  return `${kind}-${runId}`
}
export const isRunDraftTag = tag => /^(?:baseline|rehearsal)-[1-9][0-9]*$/.test(tag)

/** A run draft may be deleted only when it is this run's, still a draft and never published. */
export function assertDeletableRunDraft(release, tag) {
  assert.ok(isRunDraftTag(tag), `Refusing to delete ${tag}: not a run draft`)
  assert.equal(release.tag_name, tag)
  assert.equal(release.draft, true, `Refusing to delete ${tag}: it is not a draft`)
  assert.equal(release.published_at ?? null, null, `Refusing to delete ${tag}: it was published`)
  return release
}

/** Files of a prepared baseline directory, all named by its receipt. */
export function baselineFiles(directory, manifest) {
  assert.equal(manifest.kind, 'signed-loopback-native-update-baseline')
  assert.equal(manifest.testOnly, true)
  assert.match(manifest.feed, /^http:\/\/127\.0\.0\.1:\d+\/$/)
  const names = manifest.package.assets.map(file => file.name)
  assert.ok(names.includes(manifest.package.installer))
  const present = new Set(readdirSync(directory))
  for (const name of names) assert.ok(present.has(name), `Missing baseline file ${name}`)
  return ['signed-baseline.json', ...names].map(name => join(directory, name))
}

const gh = (args, options = {}) => execFileSync('gh', args, { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'inherit'], ...options })

function findRelease(tag) {
  // The tag endpoint resolves only published releases; list drafts explicitly.
  for (let page = 1; ; page++) {
    const batch = JSON.parse(gh(['api', `repos/${repository}/releases?per_page=100&page=${page}`]))
    const found = batch.find(release => release.tag_name === tag)
    if (found || batch.length < 100) return found
  }
}

function deleteRunDraft(tag) {
  const release = findRelease(tag)
  if (!release) return false
  assertDeletableRunDraft(release, tag)
  gh(['api', '--method', 'DELETE', `repos/${repository}/releases/${release.id}`])
  // A draft never creates its tag, but remove one if something else did.
  const refs = JSON.parse(gh(['api', `repos/${repository}/git/matching-refs/tags/${tag}`]))
  if (refs.some(ref => ref.ref === `refs/tags/${tag}`)) gh(['api', '--method', 'DELETE', `repos/${repository}/git/refs/tags/${tag}`])
  return true
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.env.GITHUB_REPOSITORY, repository)
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main')
  const runId = process.env.GITHUB_RUN_ID
  const [phase, directory] = process.argv.slice(2)
  const baselineTag = runDraftTag('baseline', runId)
  if (phase === 'stage-baseline') {
    const dir = resolve(directory)
    const files = baselineFiles(dir, JSON.parse(readFileSync(join(dir, 'signed-baseline.json'), 'utf8')))
    assert.equal(findRelease(baselineTag), undefined, `${baselineTag} already exists`)
    gh(['release', 'create', baselineTag, ...files, '--repo', repository, '--target', process.env.GITHUB_SHA, '--draft', '--prerelease',
      '--title', `Test-only signed baseline for run ${runId} (never published)`,
      '--notes', 'Loopback-feed native-update baseline for release acceptance. Deleted by the same run; never a product asset.'])
    console.log(JSON.stringify({ tag: baselineTag, staged: true, published: false }))
  } else if (phase === 'download-baseline') {
    const release = findRelease(baselineTag)
    assert.ok(release, `${baselineTag} was not staged`)
    assert.equal(release.draft, true); assert.equal(release.published_at ?? null, null)
    gh(['release', 'download', baselineTag, '--repo', repository, '--dir', resolve(directory)])
    const dir = resolve(directory)
    baselineFiles(dir, JSON.parse(readFileSync(join(dir, 'signed-baseline.json'), 'utf8')))
    console.log(JSON.stringify({ tag: baselineTag, downloaded: true }))
  } else if (phase === 'cleanup') {
    const tags = [baselineTag, ...(process.env.AGENTROUTER_REHEARSAL === '1' ? [runDraftTag('rehearsal', runId)] : [])]
    const deleted = tags.filter(deleteRunDraft)
    console.log(JSON.stringify({ deleted, examined: tags }))
  } else throw new Error('Expected stage-baseline, download-baseline or cleanup')
}
