/**
 * Backward-compatible feed gate: update schemas are additive only.
 *
 * A candidate release (latest.yml, agentrouter-update.json, installer, blockmap
 * and, when present, the runtime AgentRouter.exe) must be accepted by the
 * verifier code of the last N published product versions, because those are
 * the clients that will read it. For every published formal release vX.Y.Z
 * (>= 3.0.7, with agentrouter-update.json) the exported adapter files at the
 * commit that built it (release-receipt.json sourceCommit, else the tag) are
 * loaded from git into a temporary directory and exercised:
 *   manifest  old verifyUpdateManifest(envelope, oldPolicy, candidate) accepts
 *   files     old verifyUpdateFile accepts every named asset present locally
 *   feed      latest.yml parses with js-yaml (electron-updater's parser) and
 *             names the candidate installer's version, url, sha512 and size
 *   routes    old releaseHistory / update routes read the agentrouter section
 *   transport old downloadSources maps the candidate's GitHub asset URLs to
 *             https://agentrouter.top/downloads/desktop/v<ver>/...
 * Checks an old version does not export are reported as n/a.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, posix, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const repo = 'Maybank01/agentrouter-desktop-releases'
export const minimumVersion = '3.0.7'
export const defaultDepth = 6
export const checkNames = ['manifest', 'files', 'feed', 'routes', 'transport']
const root = resolve(import.meta.dirname, '..')
const adapterPath = 'assembly/coordinated'
const verifierFiles = ['update-signature.mjs', 'windows-signing.json', 'update-routes.mjs', 'update-transport.mjs']
const requiredFiles = ['update-signature.mjs', 'windows-signing.json']
const versionPattern = /^\d+\.\d+\.\d+$/
const github = `https://github.com/${repo}/releases/`
const mirror = 'https://agentrouter.top/downloads/desktop/'

export function compareVersions(a, b) {
  const left = a.split('.').map(Number), right = b.split('.').map(Number)
  for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return left[index] - right[index]
  return 0
}

/** Published formal releases older than the candidate, newest first, at most `depth`. */
export function selectVerifierReleases(releases, candidate, depth = defaultDepth) {
  assert.match(candidate, versionPattern)
  const seen = new Set()
  return releases.flatMap(release => {
    const version = /^v(\d+\.\d+\.\d+)$/.exec(release.tag_name ?? '')?.[1]
    if (!version || release.draft || release.prerelease || !release.published_at) return []
    if (compareVersions(version, minimumVersion) < 0 || compareVersions(version, candidate) >= 0) return []
    if (!release.assets?.some(asset => asset.name === 'agentrouter-update.json') || seen.has(version)) return []
    seen.add(version)
    return [{ version, tag: release.tag_name, receipt: release.assets.some(asset => asset.name === 'release-receipt.json') }]
  }).sort((a, b) => compareVersions(b.version, a.version)).slice(0, depth)
}

/** Prefer the commit recorded by the release receipt; the tag must agree or is reported. */
export function resolveVerifierCommit({ version, tagCommit, receiptCommit }) {
  const valid = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
  assert.ok(valid(receiptCommit) || valid(tagCommit), `v${version}: neither a release receipt nor a tag names its source commit`)
  const commit = valid(receiptCommit) ? receiptCommit : tagCommit
  const source = valid(receiptCommit) ? 'receipt' : 'tag'
  const note = valid(receiptCommit) && valid(tagCommit) && receiptCommit !== tagCommit ? `tag v${version} points to ${tagCommit.slice(0, 10)}, receipt to ${receiptCommit.slice(0, 10)}` : undefined
  return { commit, source, ...(note ? { note } : {}) }
}

function relativeImports(source) {
  return [...source.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s*['"](\.{1,2}\/[^'"]+)['"]/g)].map(match => match[1])
}

/**
 * Write one verifier snapshot from git into `directory` (plus any relative
 * modules it imports) and link the adapter's node_modules for bare imports.
 */
export function snapshotVerifier({ commit, git, directory, nodeModules }) {
  mkdirSync(directory, { recursive: true })
  const present = []
  const exists = path => { try { git('cat-file', '-e', `${commit}:${path}`); return true } catch { return false } }
  const queue = verifierFiles.map(name => ({ name, required: requiredFiles.includes(name) }))
  const written = new Set()
  while (queue.length) {
    const { name, required } = queue.shift()
    if (written.has(name)) continue
    const path = posix.join(adapterPath, name)
    if (!exists(path)) {
      assert.ok(!required, `${commit.slice(0, 10)} lacks ${path}`)
      continue
    }
    const body = git('show', `${commit}:${path}`)
    const target = join(directory, ...name.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, body)
    written.add(name); present.push(name)
    if (name.endsWith('.mjs')) for (const specifier of relativeImports(body)) queue.push({ name: posix.normalize(posix.join(posix.dirname(name), specifier)), required: true })
  }
  if (nodeModules && existsSync(nodeModules) && !existsSync(join(directory, 'node_modules'))) {
    symlinkSync(nodeModules, join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  }
  return present
}

export async function loadVerifier(directory, present) {
  const load = async name => present.includes(name) ? import(pathToFileURL(join(directory, name)).href) : undefined
  return {
    signature: await load('update-signature.mjs'),
    policy: JSON.parse(readFileSync(join(directory, 'windows-signing.json'), 'utf8')),
    routes: await load('update-routes.mjs'),
    transport: await load('update-transport.mjs'),
  }
}

const sha = (bytes, algorithm, encoding) => createHash(algorithm).update(bytes).digest(encoding)
const message = error => String(error?.message ?? error).split('\n')[0].slice(0, 160)

/** Candidate-level facts shared by every verifier row. */
export function readCandidate(directory, version, parseYaml) {
  assert.match(version, versionPattern)
  const installer = `AgentRouter-${version}-x64-Setup.exe`
  const file = name => join(directory, name)
  for (const name of ['latest.yml', 'agentrouter-update.json', installer]) assert.ok(existsSync(file(name)), `Candidate directory lacks ${name}`)
  return { version, directory, installer, envelope: JSON.parse(readFileSync(file('agentrouter-update.json'), 'utf8')),
    feedText: readFileSync(file('latest.yml'), 'utf8'), parseYaml, installerBytes: readFileSync(file(installer)) }
}

export function checkFeed(candidate) {
  const feed = candidate.parseYaml(candidate.feedText)
  const sha512 = sha(candidate.installerBytes, 'sha512', 'base64')
  assert.equal(feed?.version, candidate.version, 'latest.yml version differs from the candidate')
  assert.ok(Array.isArray(feed.files) && feed.files.length >= 1, 'latest.yml has no files')
  assert.equal(feed.files[0].url, candidate.installer, 'latest.yml files[0].url differs')
  assert.equal(feed.files[0].sha512, sha512, 'latest.yml files[0].sha512 differs from the installer')
  assert.equal(feed.files[0].size, candidate.installerBytes.length, 'latest.yml files[0].size differs from the installer')
  assert.equal(feed.path, candidate.installer, 'latest.yml path differs')
  assert.equal(feed.sha512, sha512, 'latest.yml sha512 differs from the installer')
  return feed
}

async function checkRoutes(routes, feed, candidate) {
  if (!routes || (typeof routes.releaseHistory !== 'function' && typeof routes.createProductUpdateRoutes !== 'function')) return { status: 'n/a' }
  const notes = feed.agentrouter?.releaseNotes
  const details = []
  if (typeof routes.releaseHistory === 'function') {
    const history = routes.releaseHistory(notes, candidate.version)
    assert.ok(Array.isArray(history), 'releaseHistory did not return a list')
    if (Array.isArray(notes) && notes.some(item => item?.version === candidate.version)) {
      assert.ok(history.some(item => item.version === candidate.version), 'releaseHistory dropped the candidate notes')
    }
    details.push(`history ${history.length}`)
  }
  if (typeof routes.createProductUpdateRoutes === 'function') {
    // Drive the status route as the old client would after electron-updater read latest.yml.
    const coordinator = { status: () => ({ enabled: true, phase: 'available', version: candidate.version, releaseInfo: feed, canDownload: true, canInstall: false }),
      check: async () => {}, download: async () => {}, restart: async () => {} }
    const handler = routes.createProductUpdateRoutes({ coordinator, productVersion: '0.0.1', fetchHost: async () => { throw new Error('offline') }, history: [] })
    const response = await handler.handle(new Request('dsh-app://app/api/agentrouter/v1/updates/status'))
    assert.equal(response.status, 200, 'status route failed')
    const body = await response.json()
    assert.equal(body.product?.latestVersion, candidate.version, 'status route lost the candidate version')
    const plugin = feed.agentrouter?.pluginVersion
    if (typeof plugin === 'string' && versionPattern.test(plugin)) assert.equal(body.product.latestPluginVersion, plugin, 'status route lost the plugin version')
    details.push('status ok')
  }
  return { status: 'pass', detail: details.join(', ') }
}

function checkTransport(transport, candidate) {
  if (typeof transport?.downloadSources !== 'function') return { status: 'n/a' }
  const names = [candidate.installer, `${candidate.installer}.blockmap`, 'agentrouter-update.json']
  for (const name of names) {
    const url = `${github}download/v${candidate.version}/${name}`
    assert.deepEqual(transport.downloadSources(url), [`${mirror}v${candidate.version}/${name}`, url], `${name} is not mirror-first`)
  }
  const feedUrl = `${github}latest/download/latest.yml`
  assert.equal(transport.downloadSources(feedUrl)[0], `${mirror}latest.yml`, 'latest.yml is not mirror-first')
  return { status: 'pass', detail: `${names.length + 1} URLs` }
}

/** Run every check of one verifier against the candidate; never throws. */
export async function checkWithVerifier(verifier, candidate) {
  const result = {}
  const run = async (name, operation) => {
    try { result[name] = await operation() } catch (error) { result[name] = { status: 'fail', detail: message(error) } }
  }
  let manifest, feed
  await run('manifest', () => {
    manifest = verifier.signature.verifyUpdateManifest(candidate.envelope, verifier.policy, candidate.version)
    return { status: 'pass', detail: `${manifest.assets.length} assets` }
  })
  await run('files', async () => {
    assert.ok(manifest, 'manifest rejected')
    let verified = 0; const absent = []
    for (const entry of manifest.assets) {
      const path = join(candidate.directory, entry.name)
      if (!existsSync(path)) { absent.push(entry.name); continue }
      await verifier.signature.verifyUpdateFile(manifest, path, entry.name)
      verified++
    }
    assert.ok(!absent.includes(candidate.installer), 'installer absent')
    return { status: 'pass', detail: `${verified}/${manifest.assets.length}${absent.length ? ` (absent: ${absent.join(', ')})` : ''}` }
  })
  await run('feed', () => { feed = checkFeed(candidate); return { status: 'pass' } })
  await run('routes', () => { assert.ok(feed, 'latest.yml unreadable'); return checkRoutes(verifier.routes, feed, candidate) })
  await run('transport', () => checkTransport(verifier.transport, candidate))
  return result
}

export function renderTable(candidateVersion, rows) {
  const cell = entry => !entry ? '-' : entry.status === 'pass' ? `pass${entry.detail ? ` (${entry.detail})` : ''}` : entry.status === 'n/a' ? 'n/a' : `${entry.status.toUpperCase()}${entry.detail ? `: ${entry.detail}` : ''}`
  return [`## Feed compatibility of ${candidateVersion} with published verifiers`, '',
    `| Verifier | Commit | ${checkNames.join(' | ')} |`, `| --- | --- | ${checkNames.map(() => '---').join(' | ')} |`,
    ...rows.map(row => `| v${row.version} | ${row.commit ? `${row.commit.slice(0, 10)} (${row.source})` : '-'} | ${row.error ? `FAIL: ${row.error}` : checkNames.map(name => cell(row.checks[name])).join(' | ')} |`),
    '', ...rows.filter(row => row.note).map(row => `Note: ${row.note}`), ''].join('\n')
}

export const rowFailed = row => Boolean(row.error) || checkNames.some(name => row.checks?.[name]?.status === 'fail')

/** The full gate: select verifiers, snapshot each from git, check, report. */
export async function runFeedCompat({ directory, version, depth = defaultDepth, releases, receiptCommit, git, parseYaml, nodeModules, workDirectory }) {
  const candidate = readCandidate(directory, version, parseYaml)
  const selected = selectVerifierReleases(releases, version, depth)
  assert.ok(selected.length > 0, `No published verifier release older than ${version}`)
  const rows = []
  const work = workDirectory ?? mkdtempSync(join(tmpdir(), 'feed-compat-'))
  try {
    for (const release of selected) {
      const row = { version: release.version }
      try {
        let tagCommit
        try { tagCommit = git('rev-list', '-n', '1', `refs/tags/${release.tag}`).trim() } catch { /* missing tag: receipt only */ }
        Object.assign(row, resolveVerifierCommit({ version: release.version, tagCommit, receiptCommit: release.receipt ? await receiptCommit(release) : undefined }))
        const snapshot = join(work, `v${release.version}`)
        const present = snapshotVerifier({ commit: row.commit, git, directory: snapshot, nodeModules })
        row.checks = await checkWithVerifier(await loadVerifier(snapshot, present), candidate)
      } catch (error) { row.error = message(error) }
      rows.push(row)
    }
  } finally { if (!workDirectory) rmSync(work, { recursive: true, force: true }) }
  return { candidate: version, rows, passed: !rows.some(rowFailed), table: renderTable(version, rows) }
}

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index > 0 ? process.argv[index + 1] : fallback
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = resolve(process.argv[2] ?? '')
  assert.ok(process.argv[2] && existsSync(directory), 'Usage: feed-compat.mjs <candidate-directory> [--version X.Y.Z] [--depth 6]')
  const adapter = join(root, adapterPath)
  const version = argument('version') ?? JSON.parse(readFileSync(join(adapter, 'release.json'), 'utf8')).productVersion
  const depth = Number(argument('depth', String(defaultDepth)))
  assert.ok(Number.isInteger(depth) && depth >= 1)
  const { load } = createRequire(join(adapter, 'package.json'))('js-yaml')
  const ghBin = process.env.GH_BIN || 'gh'
  const gh = (args, options = {}) => execFileSync(ghBin, args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'], ...options })
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  const releases = []
  for (let page = 1; ; page++) {
    const batch = JSON.parse(gh(['api', `repos/${repo}/releases?per_page=100&page=${page}`]))
    releases.push(...batch)
    if (batch.length < 100) break
  }
  const receiptCommit = async release => {
    const body = gh(['release', 'download', release.tag, '--repo', repo, '--pattern', 'release-receipt.json', '--output', '-'])
    return JSON.parse(body).sourceCommit
  }
  const result = await runFeedCompat({ directory, version, depth, releases, receiptCommit, git, parseYaml: load, nodeModules: join(adapter, 'node_modules') })
  console.log(result.table)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, result.table)
  if (!result.passed) {
    console.error(`::error::An already published client verifier would reject ${version}. Update schemas are additive only; fix the candidate, not the old clients.`)
    process.exit(1)
  }
}
