/**
 * Plan the "update from old published versions" matrix: which REAL published
 * installers update to the candidate, under which network conditions, and what
 * each cell is expected to do. Pure functions are unit-tested; the CLI writes
 * the job matrix for .github/workflows/update-matrix.yml.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const repository = 'Maybank01/agentrouter-desktop-releases'
/** Versions whose update path has field users; always kept while they are below the candidate. */
export const pinnedBaselines = Object.freeze(['3.0.14', '3.0.17', '3.0.19', '3.0.20'])
/** First release whose transport fetches mirror-first through Electron's network stack. */
export const mirrorTransportSince = '3.0.20'
export const networkModes = Object.freeze({
  normal: 'GitHub and the agentrouter.top mirror are both reachable directly.',
  'github-blocked': 'Direct connections to github.com and *.githubusercontent.com are reset; the mirror is reachable.',
  'system-proxy': 'GitHub is reachable only through the Windows system proxy (Chromium); direct connections to it, such as Node fetch, are reset.',
  faults: 'Normal network plus one dropped installer transfer and, when the baseline prepared the next runtime, a failed first activation.',
})
export const defaultModes = Object.freeze(['normal', 'github-blocked', 'system-proxy'])
const formalTag = /^v(\d+)\.(\d+)\.(\d+)$/
const versionPattern = /^\d+\.\d+\.\d+$/

export function compareVersions(a, b) {
  assert.match(a, versionPattern); assert.match(b, versionPattern)
  const left = a.split('.').map(Number), right = b.split('.').map(Number)
  for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return left[index] - right[index]
  return 0
}

/** Published formal product releases (vX.Y.Z, not draft, not prerelease), newest first. */
export function formalReleases(releases) {
  return releases.filter(release => formalTag.test(release.tag_name) && !release.draft && !release.prerelease && release.published_at)
    .map(release => release.tag_name.slice(1)).sort((a, b) => compareVersions(b, a))
}

/** The pinned field versions plus the latest two published formal versions below the candidate. */
export function defaultBaselines(candidate, releases) {
  const published = formalReleases(releases).filter(version => compareVersions(version, candidate) < 0)
  return [...new Set([...pinnedBaselines.filter(version => published.includes(version)), ...published.slice(0, 2)])]
    .sort((a, b) => compareVersions(a, b))
}

/**
 * <=3.0.19 verify the signed manifest with Node's global fetch straight from
 * GitHub (no mirror, no system proxy). Without direct GitHub access they fail at
 * the metadata step; that is a documented known failure, not a gate failure.
 */
export function expectationFor(baseline, mode) {
  assert.ok(Object.hasOwn(networkModes, mode), `Unknown network mode ${mode}`)
  if (mode === 'normal' || mode === 'faults' || compareVersions(baseline, mirrorTransportSince) >= 0) return { expected: 'pass', knownFailureSteps: [] }
  // Blocked GitHub: the feed itself (check) or the pinned manifest (download) is unreachable.
  // System proxy: the feed and installer download through Chromium; only the Node manifest fetch fails.
  return { expected: 'known-failure', knownFailureSteps: mode === 'github-blocked' ? ['check', 'download'] : ['download'] }
}

export function parseList(value) {
  return String(value ?? '').split(/[\s,]+/).map(entry => entry.trim()).filter(Boolean)
}

/** Every cell of the matrix. The extra fault cell runs only for the newest baseline. */
export function planMatrix({ candidate, baselines, modes = defaultModes, faults = true, releases }) {
  assert.match(candidate, versionPattern, 'The candidate must be a formal version')
  const published = new Set(formalReleases(releases))
  const selected = [...new Set(baselines)].sort((a, b) => compareVersions(a, b))
  assert.ok(selected.length > 0, 'No published baseline below the candidate')
  for (const baseline of selected) {
    assert.ok(published.has(baseline), `Baseline ${baseline} is not a published formal release`)
    assert.ok(compareVersions(baseline, candidate) < 0, `Baseline ${baseline} is not older than the candidate ${candidate}`)
  }
  for (const mode of modes) assert.ok(Object.hasOwn(networkModes, mode) && mode !== 'faults', `Unknown network mode ${mode}`)
  const cells = selected.flatMap(baseline => modes.map(mode => ({ baseline, mode })))
  if (faults) cells.push({ baseline: selected.at(-1), mode: 'faults' })
  return cells.map(cell => ({ ...cell, ...expectationFor(cell.baseline, cell.mode), id: `${cell.baseline}-${cell.mode}` }))
}

/** The version carried by the candidate release's own feed. */
export function feedVersion(latestYml) {
  const match = /^version:\s*['"]?(\d+\.\d+\.\d+)['"]?\s*$/m.exec(latestYml)
  assert.ok(match, 'The candidate latest.yml has no formal version')
  return match[1]
}

const gh = args => execFileSync('gh', args, { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] })

export function listReleases() {
  const all = []
  for (let page = 1; ; page++) {
    const batch = JSON.parse(gh(['api', `repos/${repository}/releases?per_page=100&page=${page}`]))
    all.push(...batch)
    if (batch.length < 100) return all
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const env = process.env
  const tag = env.CANDIDATE_TAG
  assert.match(tag ?? '', /^(v\d+\.\d+\.\d+|rehearsal-\d+)$/, 'CANDIDATE_TAG must be a version tag or a rehearsal draft')
  const candidate = feedVersion(gh(['release', 'download', tag, '--repo', repository, '--pattern', 'latest.yml', '--output', '-']))
  if (env.CANDIDATE_VERSION) assert.equal(candidate, env.CANDIDATE_VERSION, 'The candidate feed carries another version')
  if (env.EXPECT_RELEASE_JSON === 'true') {
    // Release runs: the staged draft must be this commit's reviewed product version.
    assert.equal(candidate, JSON.parse(readFileSync('assembly/coordinated/release.json', 'utf8')).productVersion)
  }
  const releases = listReleases()
  const baselines = parseList(env.BASELINES).length ? parseList(env.BASELINES) : defaultBaselines(candidate, releases)
  const modes = parseList(env.MODES).length ? parseList(env.MODES) : defaultModes
  const cells = planMatrix({ candidate, baselines, modes, faults: env.FAULTS !== 'false', releases })
  const plan = { schemaVersion: 1, candidate, candidateTag: tag, baselines: [...new Set(cells.map(cell => cell.baseline))], modes, cells }
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `candidate=${candidate}\ntag=${tag}\nmatrix=${JSON.stringify({ include: cells })}\nplan=${JSON.stringify(plan)}\n`)
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `## Update path matrix plan\n\nCandidate **${candidate}** (\`${tag}\`), ${cells.length} cells.\n\n`
    + '| Baseline | Mode | Expected |\n| --- | --- | --- |\n' + cells.map(cell => `| ${cell.baseline} | ${cell.mode} | ${cell.expected}${cell.knownFailureSteps.length ? ` (at ${cell.knownFailureSteps.join('/')})` : ''} |`).join('\n') + '\n')
  console.log(JSON.stringify(plan))
}
