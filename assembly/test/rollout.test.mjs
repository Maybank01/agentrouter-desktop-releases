import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { root } from '../lib.mjs'
import { buildRolloutPayload, composeEnvelope, isOffered, loadPolicy, observeMirror, parseInputs, rolloutBucket, rolloutKind,
  verifyRolloutEnvelope } from '../rollout.mjs'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072 })
const policy = { schemaVersion: 1, mode: 'self-signed', publisher: 'AgentRouter', certificateSha256: 'c'.repeat(64),
  publicKey: publicKey.export({ type: 'spki', format: 'pem' }) }
const issuedAt = '2026-09-24T12:00:00.000Z'
const signed = (payload, key = privateKey) => JSON.parse(composeEnvelope(payload, sign('RSA-SHA256', payload, key), policy))

test('operator inputs are strict', () => {
  assert.deepEqual(parseInputs({ version: '3.0.22', percent: '10', paused: 'false' }), { version: '3.0.22', percent: 10, paused: false })
  assert.deepEqual(parseInputs({ version: '3.0.22' }), { version: '3.0.22', percent: 100, paused: false })
  assert.equal(parseInputs({ version: '3.0.22', percent: '0', paused: 'true' }).paused, true)
  for (const bad of [{ version: 'v3.0.22' }, { version: '3.0' }, { version: '3.0.22-rc.1' }, { version: '3.0.22', percent: '101' },
    { version: '3.0.22', percent: '-1' }, { version: '3.0.22', percent: '10.5' }, { version: '3.0.22', percent: '' }, { version: '3.0.22', paused: 'yes' }]) {
    assert.throws(() => parseInputs(bad), JSON.stringify(bad))
  }
})

test('the payload and envelope follow the published contract exactly', () => {
  const bytes = buildRolloutPayload({ version: '3.0.22', percent: 10, paused: false, issuedAt }, policy)
  assert.equal(bytes.toString('utf8'), JSON.stringify({ schemaVersion: 1, kind: rolloutKind, productVersion: '3.0.22', percent: 10,
    paused: false, issuedAt, certificateSha256: policy.certificateSha256 }))
  const envelope = signed(bytes)
  assert.deepEqual(Object.keys(envelope), ['schemaVersion', 'algorithm', 'payload', 'signature'])
  assert.equal(envelope.algorithm, 'RSA-SHA256')
  assert.equal(Buffer.from(envelope.payload, 'base64').toString('utf8'), bytes.toString('utf8'))
  assert.equal(verifyRolloutEnvelope(envelope, policy).percent, 10)
})

test('the verifier rejects another key, tampering and payloads outside the contract', () => {
  const bytes = buildRolloutPayload({ version: '3.0.22', percent: 50, paused: false, issuedAt }, policy)
  const other = generateKeyPairSync('rsa', { modulusLength: 3072 }).privateKey
  assert.throws(() => signed(bytes, other), /signature/)
  const envelope = signed(bytes)
  const tampered = Buffer.from(bytes.toString('utf8').replace('"percent":50', '"percent":100'))
  assert.throws(() => verifyRolloutEnvelope({ ...envelope, payload: tampered.toString('base64') }, policy), /signature/)
  assert.throws(() => verifyRolloutEnvelope({ ...envelope, extra: true }, policy), /unexpected fields/)
  assert.throws(() => verifyRolloutEnvelope({ ...envelope, algorithm: 'RSA-SHA1' }, policy))
  assert.throws(() => verifyRolloutEnvelope({ ...envelope, payload: envelope.payload + '\n' }, policy), /base64/)
  const payload = JSON.parse(bytes)
  const reSigned = changes => {
    const body = Buffer.from(JSON.stringify({ ...payload, ...changes }))
    return { schemaVersion: 1, algorithm: 'RSA-SHA256', payload: body.toString('base64'), signature: sign('RSA-SHA256', body, privateKey).toString('base64') }
  }
  for (const changes of [{ percent: 101 }, { percent: 1.5 }, { paused: 'false' }, { kind: 'other' }, { productVersion: '3.0' },
    { issuedAt: 'yesterday' }, { certificateSha256: 'd'.repeat(64) }, { schemaVersion: 2 }, { extra: 1 }]) {
    assert.throws(() => verifyRolloutEnvelope(reSigned(changes), policy), JSON.stringify(changes))
  }
  assert.throws(() => buildRolloutPayload({ version: '3.0.22', percent: 200, paused: false }, policy))
})

test('buckets are stable and the client decision fails open', () => {
  const expected = createHash('sha256').update('install-1:3.0.22').digest().readUInt32BE(0) % 100
  assert.equal(rolloutBucket('install-1', '3.0.22'), expected)
  const payload = JSON.parse(buildRolloutPayload({ version: '3.0.22', percent: 10, paused: false, issuedAt }, policy))
  const ids = Array.from({ length: 2000 }, (_, index) => `install-${index}`)
  const offered = ids.filter(installationId => isOffered(payload, { installationId, version: '3.0.22' })).length
  assert.ok(offered > 100 && offered < 300, `about 10% offered, got ${offered}`)
  assert.equal(isOffered({ ...payload, percent: 0 }, { installationId: 'install-1', version: '3.0.22' }), false)
  assert.equal(isOffered({ ...payload, percent: 100 }, { installationId: 'install-1', version: '3.0.22' }), true)
  assert.equal(isOffered({ ...payload, percent: 100, paused: true }, { installationId: 'install-1', version: '3.0.22' }), false)
  // Another version, or no valid file, is offered.
  assert.equal(isOffered({ ...payload, percent: 0, paused: true }, { installationId: 'install-1', version: '3.0.23' }), true)
  assert.equal(isOffered(undefined, { installationId: 'install-1', version: '3.0.22' }), true)
})

test('the committed signing policy loads and mirror observation only reports', async () => {
  assert.equal(loadPolicy().certificateSha256, JSON.parse(readFileSync(join(root, 'assembly/coordinated/windows-signing.json'), 'utf8')).certificateSha256)
  const body = Buffer.from('{"exact":true}\n')
  let clock = 0
  const quick = { now: () => clock, sleep: async ms => { clock += ms }, intervalMs: 15_000, timeoutMs: 60_000 }
  const serving = responses => async () => { const next = responses.length > 1 ? responses.shift() : responses[0]; return { status: next.status, arrayBuffer: async () => next.body } }
  assert.equal((await observeMirror(body, { ...quick, fetcher: serving([{ status: 404 }, { status: 200, body }]) })).identical, true)
  clock = 0
  const stale = await observeMirror(body, { ...quick, fetcher: serving([{ status: 200, body: Buffer.from('old') }]) })
  assert.equal(stale.identical, false)
  assert.match(stale.detail, /different bytes/)
  clock = 0
  assert.equal((await observeMirror(body, { ...quick, fetcher: async () => { throw new Error('offline') } })).detail, 'offline')
})

test('the rollout workflow signs on main in windows-signing and pushes only its branch', () => {
  const workflow = readFileSync(join(root, '.github/workflows/rollout.yml'), 'utf8')
  assert.match(workflow, /^on:\r?\n  workflow_dispatch:/m)
  assert.doesNotMatch(workflow, /pull_request|push:|schedule:|workflow_run:/)
  assert.match(workflow, /^permissions: \{\}/m)
  const jobs = Object.fromEntries(workflow.split('\njobs:')[1].split(/\n  (?=[a-z_]+:\r?\n)/).slice(1).map(body => [body.slice(0, body.indexOf(':')), body]))
  assert.deepEqual(Object.keys(jobs), ['sign', 'publish'])
  assert.match(jobs.sign, /environment: windows-signing/)
  assert.match(jobs.sign, /runs-on: windows-2025/)
  assert.match(jobs.sign, /contents: read/)
  assert.match(jobs.sign, /github\.ref == 'refs\/heads\/main'/)
  assert.match(jobs.sign, /import-signing-key\.ps1/)
  assert.match(jobs.sign, /sign-manifest\.ps1/)
  assert.match(jobs.sign, /if: always\(\)[\s\S]*-DeleteKey/)
  assert.match(jobs.sign, /node assembly\/rollout\.mjs envelope/)
  assert.doesNotMatch(jobs.publish, /environment:|secrets\./)
  assert.match(jobs.publish, /contents: write/)
  assert.match(jobs.publish, /!inputs\.dry_run/)
  assert.match(jobs.publish, /node assembly\/rollout\.mjs verify/)
  assert.match(jobs.publish, /git push origin HEAD:refs\/heads\/desktop-rollout/)
  assert.match(jobs.publish, /node assembly\/rollout\.mjs mirror/)
  // Operator text reaches scripts only through environment variables, never shell interpolation.
  for (const line of workflow.split('\n').filter(line => /\$\{\{ inputs\.(version|percent|paused) \}\}/.test(line))) {
    assert.match(line, /^\s+ROLLOUT_(VERSION|PERCENT|PAUSED): \$\{\{ inputs\.\w+ \}\}\r?$/, line)
  }
  for (const body of Object.values(jobs)) assert.match(body, /persist-credentials: false/)
})

test('rollout tooling does not change the installed-acceptance inputs', async () => {
  const { requiresInstalledAcceptance } = await import('../ci-scope.mjs')
  assert.equal(requiresInstalledAcceptance(['assembly/rollout.mjs', '.github/workflows/rollout.yml', 'assembly/test/rollout.test.mjs']), false)
  assert.equal(requiresInstalledAcceptance(['.github/workflows/release.yml']), true)
})
