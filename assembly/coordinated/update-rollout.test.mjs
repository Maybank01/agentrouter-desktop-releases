import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { checkRollout, installationId, rolloutBucket, rolloutDecision, verifyRollout, ROLLOUT_KIND, ROLLOUT_SOURCES } from './update-rollout.mjs'

const keys = generateKeyPairSync('rsa', { modulusLength: 3072 })
const other = generateKeyPairSync('rsa', { modulusLength: 3072 })
const policy = { schemaVersion: 1, mode: 'self-signed', publisher: 'AgentRouter', certificateSha256: 'a'.repeat(64),
  publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }) }
const envelope = (fields, key = keys.privateKey) => {
  const payload = Buffer.from(JSON.stringify({ schemaVersion: 1, kind: ROLLOUT_KIND, productVersion: '3.0.21', percent: 25,
    paused: false, issuedAt: '2026-09-24T00:00:00Z', certificateSha256: policy.certificateSha256, ...fields }))
  return { schemaVersion: 1, algorithm: 'RSA-SHA256', payload: payload.toString('base64'), signature: sign('RSA-SHA256', payload, key).toString('base64') }
}
const ids = Array.from({ length: 2000 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`)

test('verifies the pinned signature and exact rollout fields', () => {
  assert.equal(verifyRollout(envelope({}), policy).percent, 25)
  assert.throws(() => verifyRollout(envelope({}, other.privateKey), policy))
  assert.throws(() => verifyRollout(envelope({ kind: 'other' }), policy))
  assert.throws(() => verifyRollout(envelope({ percent: 101 }), policy))
  assert.throws(() => verifyRollout(envelope({ percent: 2.5 }), policy))
  assert.throws(() => verifyRollout(envelope({ paused: 'yes' }), policy))
  assert.throws(() => verifyRollout(envelope({ certificateSha256: 'b'.repeat(64) }), policy))
  // A signed update manifest is not a rollout.
  assert.throws(() => verifyRollout(envelope({ kind: undefined, assets: [] }), policy))
})

test('buckets are stable, uniform and independent per version', () => {
  assert.equal(rolloutBucket(ids[0], '3.0.21'), rolloutBucket(ids[0], '3.0.21'))
  const offered = ids.filter(id => rolloutBucket(id, '3.0.21') < 25).length / ids.length
  assert.ok(offered > 0.2 && offered < 0.3, `offered share ${offered}`)
  const moved = ids.filter(id => rolloutBucket(id, '3.0.21') !== rolloutBucket(id, '3.0.22')).length
  assert.ok(moved > ids.length * 0.9)
  // Raising the percentage only adds installations.
  const at10 = ids.filter(id => rolloutDecision({ productVersion: '3.0.21', percent: 10, paused: false }, id, '3.0.21').offer)
  assert.ok(at10.every(id => rolloutDecision({ productVersion: '3.0.21', percent: 50, paused: false }, id, '3.0.21').offer))
})

test('pause holds everyone back; other versions and 100% are open', () => {
  assert.deepEqual(rolloutDecision({ productVersion: '3.0.21', percent: 100, paused: true }, ids[0], '3.0.21'), { offer: false, reason: 'paused', percent: 100 })
  assert.equal(rolloutDecision({ productVersion: '3.0.21', percent: 100, paused: false }, ids[0], '3.0.21').offer, true)
  assert.equal(rolloutDecision({ productVersion: '3.0.21', percent: 0, paused: false }, ids[0], '3.0.21').offer, false)
  assert.equal(rolloutDecision({ productVersion: '3.0.20', percent: 0, paused: true }, ids[0], '3.0.21').offer, true)
  assert.equal(rolloutDecision(undefined, ids[0], '3.0.21').offer, true)
})

test('fetches mirror first, falls back per source and fails open', async () => {
  const seen = []
  const paused = envelope({ paused: true })
  const decision = await checkRollout({ version: '3.0.21', installationId: ids[0], policy, fetcher: async url => {
    seen.push(url)
    return url === ROLLOUT_SOURCES[0] ? new Response('down', { status: 502 }) : new Response(JSON.stringify(paused))
  } })
  assert.deepEqual(seen, ROLLOUT_SOURCES)
  assert.equal(decision.reason, 'paused')
  assert.deepEqual(await checkRollout({ version: '3.0.21', installationId: ids[0], policy, fetcher: async () => { throw new Error('offline') } }),
    { offer: true, reason: 'unavailable' })
  const forged = envelope({ paused: true }, other.privateKey)
  assert.equal((await checkRollout({ version: '3.0.21', installationId: ids[0], policy, fetcher: async () => new Response(JSON.stringify(forged)) })).offer, true)
  await assert.rejects(checkRollout({ version: '3.0.21', installationId: ids[0], policy }), /explicit/)
})

test('installation id persists and is recreated when unreadable', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'agentrouter-rollout-')), 'nested', 'id')
  const first = installationId(path)
  assert.equal(installationId(path), first)
  writeFileSync(path, 'garbage')
  const second = installationId(path)
  assert.notEqual(second, first)
  assert.equal(readFileSync(path, 'utf8').trim(), second)
})
