/**
 * Staged rollout / kill switch for AgentRouter Desktop (clients >= 3.0.21).
 *
 * The canonical file is rollout.json on the desktop-rollout branch of this
 * repository, mirrored at https://agentrouter.top/downloads/desktop/rollout.json.
 * It is a signed envelope with the same pinned key as agentrouter-update.json:
 *   { schemaVersion: 1, algorithm: 'RSA-SHA256', payload: base64(UTF-8 JSON), signature: base64(PKCS#1 v1.5) }
 * Payload: { schemaVersion: 1, kind, productVersion, percent, paused, issuedAt, certificateSha256 }.
 *
 * Client semantics: a version is offered iff the verified payload names exactly
 * that version, is not paused and bucket < percent, where bucket =
 * uint32BE(sha256(`${installationId}:${version}`)[0..4]) % 100. Any other
 * version, or a missing, invalid or unreachable file, fails open (offered).
 * Clients <= 3.0.20 never read it and always follow latest.yml.
 */
import assert from 'node:assert/strict'
import { createHash, verify } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { validateSigningPolicy } from './coordinated/update-signature.mjs'

export const rolloutKind = 'agentrouter-desktop-rollout'
export const rolloutBranch = 'desktop-rollout'
export const rolloutRawUrl = `https://raw.githubusercontent.com/Maybank01/agentrouter-desktop-releases/${rolloutBranch}/rollout.json`
export const rolloutMirrorUrl = 'https://agentrouter.top/downloads/desktop/rollout.json'
const payloadKeys = ['schemaVersion', 'kind', 'productVersion', 'percent', 'paused', 'issuedAt', 'certificateSha256']
const envelopeKeys = ['schemaVersion', 'algorithm', 'payload', 'signature']
const versionPattern = /^\d+\.\d+\.\d+$/
const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/
const maxEnvelope = 16 * 1024

export function loadPolicy(path = join(import.meta.dirname, 'coordinated/windows-signing.json')) {
  const policy = JSON.parse(readFileSync(path, 'utf8'))
  validateSigningPolicy(policy)
  return policy
}

/** Operator input as strings (workflow_dispatch) or typed values. */
export function parseInputs({ version, percent = 100, paused = false }) {
  assert.match(String(version ?? ''), versionPattern, 'version must be X.Y.Z')
  const percentText = String(percent).trim()
  assert.match(percentText, /^\d{1,3}$/, 'percent must be an integer 0..100')
  const value = Number(percentText)
  assert.ok(value >= 0 && value <= 100, 'percent must be an integer 0..100')
  assert.ok([true, false, 'true', 'false'].includes(paused), 'paused must be true or false')
  return { version: String(version), percent: value, paused: paused === true || paused === 'true' }
}

export function validateRolloutPayload(payload, policy) {
  assert.ok(payload && typeof payload === 'object' && !Array.isArray(payload), 'Rollout payload must be an object')
  assert.deepEqual(Object.keys(payload).sort(), [...payloadKeys].sort(), 'Rollout payload has unexpected fields')
  assert.equal(payload.schemaVersion, 1)
  assert.equal(payload.kind, rolloutKind)
  assert.match(payload.productVersion, versionPattern)
  assert.ok(Number.isInteger(payload.percent) && payload.percent >= 0 && payload.percent <= 100, 'percent must be an integer 0..100')
  assert.equal(typeof payload.paused, 'boolean')
  assert.ok(typeof payload.issuedAt === 'string' && isoPattern.test(payload.issuedAt) && Number.isFinite(Date.parse(payload.issuedAt)), 'issuedAt must be an ISO UTC time')
  assert.equal(payload.certificateSha256, policy.certificateSha256, 'Rollout names another signing certificate')
  return payload
}

/** Exact bytes to sign: UTF-8 JSON in the contract's key order. */
export function buildRolloutPayload({ version, percent, paused, issuedAt = new Date().toISOString() }, policy) {
  const payload = { schemaVersion: 1, kind: rolloutKind, productVersion: version, percent, paused, issuedAt, certificateSha256: policy.certificateSha256 }
  validateRolloutPayload(payload, policy)
  return Buffer.from(JSON.stringify(payload), 'utf8')
}

function strictBase64(value, label) {
  assert.ok(typeof value === 'string' && value.length > 0 && value.length <= maxEnvelope, `${label} must be base64`)
  const bytes = Buffer.from(value, 'base64')
  assert.equal(bytes.toString('base64'), value, `${label} must be canonical base64`)
  return bytes
}

export function verifyRolloutEnvelope(envelope, policy) {
  const key = validateSigningPolicy(policy)
  assert.ok(envelope && typeof envelope === 'object' && !Array.isArray(envelope), 'Rollout envelope must be an object')
  assert.deepEqual(Object.keys(envelope).sort(), [...envelopeKeys].sort(), 'Rollout envelope has unexpected fields')
  assert.equal(envelope.schemaVersion, 1)
  assert.equal(envelope.algorithm, 'RSA-SHA256')
  const payload = strictBase64(envelope.payload, 'payload')
  assert.ok(verify('RSA-SHA256', payload, key, strictBase64(envelope.signature, 'signature')), 'Rollout signature does not match the pinned key')
  return validateRolloutPayload(JSON.parse(payload.toString('utf8')), policy)
}

export function composeEnvelope(payloadBytes, signatureBytes, policy) {
  const envelope = { schemaVersion: 1, algorithm: 'RSA-SHA256', payload: Buffer.from(payloadBytes).toString('base64'), signature: Buffer.from(signatureBytes).toString('base64') }
  verifyRolloutEnvelope(envelope, policy)
  return Buffer.from(JSON.stringify(envelope, null, 2) + '\n', 'utf8')
}

export function rolloutBucket(installationId, version) {
  return createHash('sha256').update(`${installationId}:${version}`, 'utf8').digest().readUInt32BE(0) % 100
}

/** Reference client decision. `rollout` is the verified payload, or undefined when missing/invalid/unreachable. */
export function isOffered(rollout, { installationId, version }) {
  if (!rollout || rollout.productVersion !== version) return true
  if (rollout.paused) return false
  return rolloutBucket(installationId, version) < rollout.percent
}

function expectMatches(payload, expected) {
  if (!expected) return payload
  assert.equal(payload.productVersion, expected.version)
  assert.equal(payload.percent, expected.percent)
  assert.equal(payload.paused, expected.paused)
  return payload
}

/** Poll the website mirror; report, never throw. */
export async function observeMirror(expected, { url = rolloutMirrorUrl, fetcher = fetch, timeoutMs = 300_000, intervalMs = 15_000,
  now = Date.now, sleep = ms => new Promise(done => setTimeout(done, ms)) } = {}) {
  const started = now(); let last = 'not requested'
  for (;;) {
    try {
      const response = await fetcher(url, { cache: 'no-store', redirect: 'follow', signal: AbortSignal.timeout(30_000) })
      if (response.status === 200) {
        const body = Buffer.from(await response.arrayBuffer())
        if (body.equals(expected)) return { identical: true, waitedMs: now() - started, detail: 'identical bytes' }
        last = `HTTP 200 with different bytes (${body.length} bytes)`
      } else last = `HTTP ${response.status}`
    } catch (error) { last = error?.message ?? String(error) }
    if (now() - started + intervalMs > timeoutMs) return { identical: false, waitedMs: now() - started, detail: last }
    await sleep(intervalMs)
  }
}

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index > 0 ? process.argv[index + 1] : fallback
}
const summary = text => { if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text) }
const expectedFromEnv = () => parseInputs({ version: process.env.ROLLOUT_VERSION, percent: process.env.ROLLOUT_PERCENT, paused: process.env.ROLLOUT_PAUSED })

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const command = process.argv[2]
  const policy = loadPolicy()
  if (command === 'payload') {
    // Inputs come from ROLLOUT_VERSION / ROLLOUT_PERCENT / ROLLOUT_PAUSED (never interpolated into shell).
    const out = resolve(argument('out'))
    mkdirSync(dirname(out), { recursive: true })
    const bytes = buildRolloutPayload(expectedFromEnv(), policy)
    writeFileSync(out, bytes)
    console.log(bytes.toString('utf8'))
  } else if (command === 'envelope') {
    const out = resolve(argument('out'))
    const body = composeEnvelope(readFileSync(resolve(argument('payload'))), readFileSync(resolve(argument('signature'))), policy)
    const payload = expectMatches(verifyRolloutEnvelope(JSON.parse(body), policy), expectedFromEnv())
    writeFileSync(out, body)
    console.log(JSON.stringify({ verified: true, sha256: createHash('sha256').update(body).digest('hex'), payload }))
  } else if (command === 'verify') {
    const body = readFileSync(resolve(process.argv[3]))
    assert.ok(body.length <= maxEnvelope)
    const payload = expectMatches(verifyRolloutEnvelope(JSON.parse(body.toString('utf8')), policy), process.env.ROLLOUT_VERSION ? expectedFromEnv() : undefined)
    const line = `Verified rollout.json: ${payload.productVersion} at ${payload.percent}%${payload.paused ? ' (paused)' : ''}, issued ${payload.issuedAt}, sha256 ${createHash('sha256').update(body).digest('hex')}.`
    console.log(line); summary(`## Desktop rollout\n\n${line}\n`)
  } else if (command === 'mirror') {
    const body = readFileSync(resolve(process.argv[3]))
    const result = await observeMirror(body, { timeoutMs: Number(argument('timeout-seconds', '300')) * 1000 })
    const line = result.identical ? `Mirror ${rolloutMirrorUrl} serves identical bytes after ${Math.round(result.waitedMs / 1000)} s.`
      : `Mirror ${rolloutMirrorUrl} did not serve identical bytes within ${Math.round(result.waitedMs / 1000)} s (last: ${result.detail}). The canonical file is ${rolloutRawUrl}; a client that cannot read a valid file fails open.`
    console.log(line); summary(`\n${line}\n`)
    if (!result.identical) console.log(`::warning::${line}`)
  } else throw new Error('Usage: rollout.mjs payload|envelope|verify|mirror')
}
