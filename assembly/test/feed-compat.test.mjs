import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { root } from '../lib.mjs'
import { requiresInstalledAcceptance } from '../ci-scope.mjs'
import { compareVersions, resolveVerifierCommit, rowFailed, runFeedCompat, selectVerifierReleases } from '../feed-compat.mjs'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 })
const policy = { schemaVersion: 1, mode: 'self-signed', publisher: 'AgentRouter', certificateSha256: 'c'.repeat(64),
  publicKey: publicKey.export({ type: 'spki', format: 'pem' }) }
const adapter = join(root, 'assembly/coordinated')
const currentSignature = readFileSync(join(adapter, 'update-signature.mjs'), 'utf8')
const currentTransport = readFileSync(join(adapter, 'update-transport.mjs'), 'utf8')
// Dependency-free stand-in for update-routes.mjs (the real one imports semver).
const routesStub = `import { accept } from './routes-helper.mjs'
export function releaseHistory(items, ceiling) {
  if (!Array.isArray(items)) return []
  return items.filter(item => accept(item) && item.version <= ceiling).map(item => ({ version: item.version, changes: item.changes }))
}
`
const release = (tag, overrides = {}) => ({ tag_name: tag, draft: false, prerelease: false, published_at: '2026-09-24T00:00:00Z',
  assets: [{ name: 'agentrouter-update.json' }, { name: 'release-receipt.json' }], ...overrides })

test('verifier selection uses only published formal product releases older than the candidate', () => {
  assert.ok(compareVersions('3.0.10', '3.0.9') > 0)
  const releases = [release('v3.0.21'), release('v3.0.20'), release('v3.0.19'), release('v3.0.18', { draft: true, published_at: null }),
    release('v3.0.17', { prerelease: true }), release('v3.0.14'), release('v3.0.13', { assets: [{ name: 'latest.yml' }] }), release('v3.0.12'),
    release('v3.0.11'), release('v3.0.10'), release('v3.0.9'), release('v3.0.8'), release('v3.0.7'), release('v3.0.6'),
    release('v2.0.5-preinstalled.5'), release('rehearsal-7'), release('baseline-7')]
  assert.deepEqual(selectVerifierReleases(releases, '3.0.21').map(entry => entry.version), ['3.0.20', '3.0.19', '3.0.14', '3.0.12', '3.0.11', '3.0.10'])
  assert.deepEqual(selectVerifierReleases(releases, '3.0.9', 6).map(entry => entry.version), ['3.0.8', '3.0.7'])
  assert.deepEqual(selectVerifierReleases(releases, '3.0.21', 2).map(entry => entry.version), ['3.0.20', '3.0.19'])
})

test('the receipt source commit is preferred over the tag and disagreement is reported', () => {
  const a = 'a'.repeat(40), b = 'b'.repeat(40)
  assert.deepEqual(resolveVerifierCommit({ version: '3.0.19', tagCommit: a, receiptCommit: a }), { commit: a, source: 'receipt' })
  assert.deepEqual(resolveVerifierCommit({ version: '3.0.19', tagCommit: a }), { commit: a, source: 'tag' })
  const disagreement = resolveVerifierCommit({ version: '3.0.19', tagCommit: a, receiptCommit: b })
  assert.equal(disagreement.commit, b)
  assert.match(disagreement.note, /tag v3\.0\.19 points to aaaaaaaaaa, receipt to bbbbbbbbbb/)
  assert.throws(() => resolveVerifierCommit({ version: '3.0.19' }), /neither/)
})

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'feed-compat-test-'))
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false',
    '-c', 'core.autocrlf=false', ...args], { cwd: join(base, 'repo'), encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  mkdirSync(join(base, 'repo/assembly/coordinated'), { recursive: true })
  git('init', '-q')
  const commit = (files, tag) => {
    for (const [name, body] of Object.entries(files)) writeFileSync(join(base, 'repo/assembly/coordinated', name), body)
    git('add', '-A'); git('commit', '-q', '-m', tag); git('tag', tag)
    return git('rev-parse', 'HEAD').trim()
  }
  const commits = {}
  // v3.0.12: an old verifier without routes/transport and a narrower asset list.
  commits['3.0.12'] = commit({ 'update-signature.mjs': currentSignature.replace("'AgentRouter.exe', ", ''), 'windows-signing.json': JSON.stringify(policy) }, 'v3.0.12')
  commits['3.0.19'] = commit({ 'update-signature.mjs': currentSignature, 'update-routes.mjs': routesStub,
    'routes-helper.mjs': 'export const accept = item => Boolean(item && typeof item.version === "string" && Array.isArray(item.changes))\n' }, 'v3.0.19')
  commits['3.0.20'] = commit({ 'update-transport.mjs': currentTransport }, 'v3.0.20')
  return { base, git, commits }
}

function candidate(directory, version, { extraAsset, feedChanges = {}, installer = Buffer.from(`installer ${version}`) } = {}) {
  mkdirSync(directory, { recursive: true })
  const name = `AgentRouter-${version}-x64-Setup.exe`
  const files = { [name]: installer, [`${name}.blockmap`]: Buffer.from('blockmap') }
  const sha512 = createHash('sha512').update(installer).digest('base64')
  // latest.yml written as JSON, which is valid YAML; the test parser is JSON.parse.
  files['latest.yml'] = Buffer.from(JSON.stringify({ version, files: [{ url: name, sha512, size: installer.length }], path: name, sha512,
    agentrouter: { pluginVersion: '0.16.2', releaseNotes: [{ version, changes: [{ kind: 'new', text: 'x' }] }] }, ...feedChanges }))
  const runtime = Buffer.from('runtime')
  const assets = Object.entries(files).map(([file, body]) => ({ name: file, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') }))
  assets.push({ name: 'AgentRouter.exe', bytes: runtime.length, sha256: createHash('sha256').update(runtime).digest('hex') })
  if (extraAsset) assets.push({ name: extraAsset, bytes: 1, sha256: 'e'.repeat(64) })
  const payload = Buffer.from(JSON.stringify({ schemaVersion: 1, productVersion: version, certificateSha256: policy.certificateSha256, assets }))
  files['agentrouter-update.json'] = Buffer.from(JSON.stringify({ schemaVersion: 1, algorithm: 'RSA-SHA256', payload: payload.toString('base64'),
    signature: sign('RSA-SHA256', payload, privateKey).toString('base64') }))
  for (const [file, body] of Object.entries(files)) writeFileSync(join(directory, file), body)
  return directory
}

const releases = [release('v3.0.20'), release('v3.0.19'), release('v3.0.12')]

test('a compatible candidate passes every published verifier snapshot', async t => {
  const { base, git, commits } = fixture()
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const directory = candidate(join(base, 'candidate'), '3.0.21')
  const result = await runFeedCompat({ directory, version: '3.0.21', releases, receiptCommit: async entry => commits[entry.version], git, parseYaml: JSON.parse })
  // v3.0.12's narrower verifier would already reject the runtime entry that every current manifest carries.
  assert.deepEqual(result.rows.map(row => [row.version, rowFailed(row)]), [['3.0.20', false], ['3.0.19', false], ['3.0.12', true]])
  const [latest, previous, old] = result.rows
  assert.equal(latest.source, 'receipt')
  assert.deepEqual(Object.fromEntries(Object.entries(latest.checks).map(([name, entry]) => [name, entry.status])),
    { manifest: 'pass', files: 'pass', feed: 'pass', routes: 'pass', transport: 'pass' })
  assert.match(latest.checks.files.detail, /3\/4 \(absent: AgentRouter\.exe\)/)
  assert.equal(previous.checks.transport.status, 'n/a')
  assert.match(previous.checks.routes.detail, /history 1/)
  assert.equal(old.checks.manifest.status, 'fail')
  assert.equal(old.checks.routes.status, 'n/a')
  assert.equal(result.passed, false)
  assert.match(result.table, /\| v3\.0\.12 \| [0-9a-f]{10} \(receipt\) \| FAIL: /)

  const compatible = await runFeedCompat({ directory, version: '3.0.21', releases: releases.slice(0, 2), receiptCommit: async entry => commits[entry.version], git, parseYaml: JSON.parse })
  assert.equal(compatible.passed, true, compatible.table)
})

test('non-additive or inconsistent candidates are rejected with the failing check named', async t => {
  const { base, git, commits } = fixture()
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const run = async (name, options) => runFeedCompat({ directory: candidate(join(base, name), '3.0.21', options), version: '3.0.21', releases: releases.slice(0, 2),
    receiptCommit: async entry => commits[entry.version], git, parseYaml: JSON.parse })
  // A new asset name in the signed manifest is rejected by every older client.
  const extra = await run('extra', { extraAsset: 'AgentRouter-3.0.21-x64-Setup.zip' })
  assert.equal(extra.passed, false)
  assert.ok(extra.rows.every(row => row.checks.manifest.status === 'fail' && row.checks.files.status === 'fail'))
  const wrongVersion = await run('version', { feedChanges: { version: '3.0.20' } })
  assert.ok(wrongVersion.rows.every(row => row.checks.feed.status === 'fail' && /version/.test(row.checks.feed.detail)))
  const brokenNotes = await run('notes', { feedChanges: { agentrouter: { releaseNotes: 'not a list' } } })
  assert.equal(brokenNotes.passed, true, 'releaseHistory tolerates malformed notes')
  // A tampered installer no longer matches the signed manifest or latest.yml.
  const directory = candidate(join(base, 'tampered'), '3.0.21')
  writeFileSync(join(directory, 'AgentRouter-3.0.21-x64-Setup.exe'), 'installer 3.0.2X')
  const tampered = await runFeedCompat({ directory, version: '3.0.21', releases: releases.slice(0, 1), receiptCommit: async entry => commits[entry.version], git, parseYaml: JSON.parse })
  assert.equal(tampered.rows[0].checks.files.status, 'fail')
  assert.equal(tampered.rows[0].checks.feed.status, 'fail')
  // A missing verifier commit fails the row instead of skipping it.
  const missing = await runFeedCompat({ directory, version: '3.0.21', releases: releases.slice(0, 1), receiptCommit: async () => 'f'.repeat(40), git, parseYaml: JSON.parse })
  assert.equal(missing.passed, false)
  assert.match(missing.rows[0].error, /lacks assembly\/coordinated\/update-signature\.mjs/)
})

test('the gate runs on the staged draft and publication requires it', () => {
  const workflow = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8')
  const lane = workflow.split('\n  # Coordinated lane:')[1]
  const jobs = Object.fromEntries(lane.split(/\n  (?=[a-z_]+:\r?\n)/).slice(1).map(body => [body.slice(0, body.indexOf(':')), body]))
  const gate = jobs.coordinated_feed_compat
  assert.match(gate, /needs: coordinated_sign\r?\n/)
  assert.match(gate, /runs-on: ubuntu-latest/)
  assert.match(gate, /git fetch --tags --force origin/)
  assert.match(gate, /gh release download "\$RELEASE_TAG"/)
  assert.match(gate, /node assembly\/feed-compat\.mjs \.local\/signed-release/)
  assert.doesNotMatch(gate, /environment:|secrets\./)
  assert.match(jobs.coordinated_publish, /needs: \[[^\]]*coordinated_feed_compat[^\]]*\]/)
  assert.match(jobs.coordinated_publish, /needs\.coordinated_feed_compat\.result == 'success'/)
  // A resumed publication (no new signing job) repeats the gate on the downloaded assets.
  assert.match(jobs.coordinated_publish, /if: inputs\.resume_signed_run != ''\r?\n[^\n]*\r?\n?[\s\S]*?node assembly\/feed-compat\.mjs \.local\/signed-release/)
  assert.equal(requiresInstalledAcceptance(['assembly/feed-compat.mjs']), false)
})
