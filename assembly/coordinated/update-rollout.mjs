/**
 * Staged rollout and remote pause for product updates (clients from 3.0.21 on).
 *
 * A small `rollout.json`, signed with the same pinned update key as
 * agentrouter-update.json, names one product version, a percentage and a pause
 * flag. The client offers that version only when it is not paused and the
 * installation's stable bucket is below the percentage. Everything else fails
 * open: a missing, unreachable, invalid or other-version rollout file never
 * blocks an update, so the kill switch can only hold a release back, never
 * select bytes. Older clients ignore the file and simply follow latest.yml.
 *
 * Main-process network access must use Electron's session fetch (system proxy
 * and PAC aware); callers always pass the fetcher explicitly.
 */
import assert from 'node:assert/strict'
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const ROLLOUT_KIND = 'agentrouter-desktop-rollout'
export const ROLLOUT_SOURCES = Object.freeze([
  'https://agentrouter.top/downloads/desktop/rollout.json',
  'https://raw.githubusercontent.com/Maybank01/agentrouter-desktop-releases/desktop-rollout/rollout.json',
])
const maxRollout = 16 * 1024
const versionPattern = /^\d+\.\d+\.\d+$/
const idPattern = /^[a-f0-9-]{36}$/

function base64(value) {
  assert.equal(typeof value, 'string')
  assert.ok(value.length > 0 && value.length <= maxRollout)
  const bytes = Buffer.from(value, 'base64')
  assert.equal(bytes.toString('base64'), value)
  return bytes
}

// Self-contained (the app bundles each adapter module under another name); the
// same pinned-policy rules as update-signature.mjs validateSigningPolicy.
function pinnedKey(policy) {
  assert.equal(policy?.schemaVersion, 1)
  assert.equal(policy.mode, 'self-signed')
  assert.match(policy.certificateSha256, /^[a-f0-9]{64}$/)
  const key = createPublicKey(policy.publicKey)
  assert.equal(key.asymmetricKeyType, 'rsa')
  assert.ok(key.asymmetricKeyDetails.modulusLength >= 3072)
  return key
}

/** Verify one signed rollout envelope with the installed pinned key. */
export function verifyRollout(envelope, policy) {
  const key = pinnedKey(policy)
  assert.equal(envelope?.schemaVersion, 1)
  assert.equal(envelope.algorithm, 'RSA-SHA256')
  const payload = base64(envelope.payload)
  assert.ok(verify('RSA-SHA256', payload, key, base64(envelope.signature)), 'Rollout signature does not match the installed key')
  const rollout = JSON.parse(payload.toString('utf8'))
  assert.equal(rollout.schemaVersion, 1)
  assert.equal(rollout.kind, ROLLOUT_KIND)
  assert.equal(rollout.certificateSha256, policy.certificateSha256)
  assert.match(rollout.productVersion, versionPattern)
  assert.ok(Number.isInteger(rollout.percent) && rollout.percent >= 0 && rollout.percent <= 100)
  assert.equal(typeof rollout.paused, 'boolean')
  assert.ok(typeof rollout.issuedAt === 'string' && Number.isFinite(Date.parse(rollout.issuedAt)))
  return rollout
}

/** Stable 0..99 bucket of one installation for one version. */
export function rolloutBucket(installationId, version) {
  return createHash('sha256').update(`${installationId}:${version}`).digest().readUInt32BE(0) % 100
}

/** Decide whether `version` is offered to this installation. */
export function rolloutDecision(rollout, installationId, version) {
  if (!rollout || rollout.productVersion !== version) return { offer: true, reason: 'open' }
  if (rollout.paused) return { offer: false, reason: 'paused', percent: rollout.percent }
  const bucket = rolloutBucket(installationId, version)
  return bucket < rollout.percent
    ? { offer: true, reason: 'staged', percent: rollout.percent }
    : { offer: false, reason: 'staged', percent: rollout.percent }
}

/** A random identifier kept beside the updater state; recreated when unreadable. */
export function installationId(path) {
  try {
    const value = readFileSync(path, 'utf8').trim()
    if (idPattern.test(value)) return value
  } catch { /* first use */ }
  const value = randomUUID()
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(`${path}.tmp`, value + '\n')
    renameSync(`${path}.tmp`, path)
  } catch { /* An unwritable profile still gets a stable bucket for this run. */ }
  return value
}

async function readRollout(url, fetcher) {
  const response = await fetcher(url, { redirect: 'follow', cache: 'no-store', signal: AbortSignal.timeout(10000) })
  if (response.status !== 200) throw new Error(`HTTP ${response.status}`)
  const text = await response.text()
  assert.ok(text.length <= maxRollout, 'Rollout metadata exceeds its limit')
  return JSON.parse(text)
}

/**
 * Fetch, verify and apply the rollout for `version`. Never throws.
 * @param options.fetcher - Electron's session fetch (required; no Node global fetch).
 */
export async function checkRollout({ version, installationId: id, policy, fetcher, sources = ROLLOUT_SOURCES }) {
  assert.equal(typeof fetcher, 'function', 'Rollout checks require an explicit (Electron session) fetcher')
  for (const url of sources) {
    let rollout
    try { rollout = verifyRollout(await readRollout(url, fetcher), policy) }
    catch { continue }
    return rolloutDecision(rollout, id, version)
  }
  return { offer: true, reason: 'unavailable' }
}
