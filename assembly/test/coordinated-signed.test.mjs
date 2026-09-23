import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { requiredJobs } from '../coordinated-evidence.mjs'
import { assertLatestForward, compareVersions, composeFinalReceipt, planDraftStaging, readReleaseReceipt,
  validateSignedRecord, validateStagedReceipt } from '../coordinated-signed.mjs'

const published = (tag, id = 1) => ({ id, tag_name: tag, draft: false, prerelease: false, published_at: '2026-09-22T06:38:55Z' })
const draft = (tag, id) => ({ id, tag_name: tag, draft: true, prerelease: false, published_at: null })

test('versions compare numerically', () => {
  assert.equal(compareVersions('v3.0.10', 'v3.0.9'), 1)
  assert.equal(compareVersions('3.0.14', 'v3.0.14'), 0)
  assert.equal(compareVersions('v3.0.14', 'v3.1.0'), -1)
  assert.throws(() => compareVersions('v3.0.14-beta.1', 'v3.0.14'))
})

test('an unpublished draft of the same version may be replaced by a new signing run', () => {
  const releases = [published('v3.0.14'), draft('v3.0.15', 7), draft('v3.0.15', 8), draft('v0.1.0-beta.2', 3)]
  assert.deepEqual(planDraftStaging({ tag: 'v3.0.15', releases, tagRefExists: false }),
    { replaceDraftIds: [7, 8], newestPublished: 'v3.0.14' })
  assert.deepEqual(planDraftStaging({ tag: 'v3.0.15', releases: [published('v3.0.14')], tagRefExists: false }).replaceDraftIds, [])
})

test('a published version is never replaced, even if it was later returned to draft', () => {
  assert.throws(() => planDraftStaging({ tag: 'v3.0.14', releases: [published('v3.0.14')], tagRefExists: true }), /requires a new version/)
  const unpublished = { ...published('v3.0.15'), draft: true }
  assert.throws(() => planDraftStaging({ tag: 'v3.0.15', releases: [published('v3.0.14'), unpublished], tagRefExists: false }), /requires a new version/)
  assert.throws(() => planDraftStaging({ tag: 'v3.0.15', releases: [published('v3.0.14'), draft('v3.0.15', 7)], tagRefExists: true }), /Tag v3\.0\.15 already exists/)
})

test('latest never moves backwards', () => {
  assert.throws(() => planDraftStaging({ tag: 'v3.0.13', releases: [published('v3.0.14')], tagRefExists: false }), /backwards/)
  assert.throws(() => assertLatestForward('v3.0.15', [published('v3.0.16'), draft('v3.0.15', 2)]), /backwards/)
  // Prereleases, drafts and historical community tags do not define latest.
  assertLatestForward('v3.0.15', [published('v3.0.14'), { ...published('v3.1.0'), prerelease: true }, draft('v3.2.0', 4),
    published('v1.2.3-preinstalled.9'), published('v3.0.15')])
})

const input = { productVersion: '3.0.15', plugin: { name: 'p', version: '1.0.0', sha256: 'a'.repeat(64) }, signing: { mode: 'self-signed' } }
const assets = [{ name: 'AgentRouter-3.0.15-x64-Setup.exe', bytes: 10, sha256: 'e'.repeat(64) }, { name: 'latest.yml', bytes: 1, sha256: 'f'.repeat(64) }]
const evidence = { releaseCommit: 'c'.repeat(40), jobs: requiredJobs.map((name, id) => ({ name, id })) }
const staged = () => ({ schemaVersion: 2, sourceCommit: 'c'.repeat(40), workflowRun: { workflow: '.github/workflows/release.yml', id: '55', attempt: '1' },
  input: structuredClone(input), patchSha256: 'd'.repeat(64), signed: true, testOnly: false, assets: structuredClone(assets),
  acceptanceEvidence: structuredClone(evidence) })
const context = { sourceCommit: 'c'.repeat(40), runId: '55' }

test('post-sign jobs accept only the draft staged from this commit by this run', () => {
  assert.ok(validateStagedReceipt(staged(), context))
  for (const change of [
    r => { r.sourceCommit = 'f'.repeat(40) },
    r => { r.workflowRun.id = '54' },
    r => { r.workflowRun.workflow = '.github/workflows/ci.yml' },
    r => { r.installedCandidate = { passed: true, nativeUpdaterExecuted: true, legacyInstallerExecuted: true } },
    r => { delete r.acceptanceEvidence },
    r => { r.acceptanceEvidence.releaseCommit = 'f'.repeat(40) },
    r => { r.acceptanceEvidence.jobs.pop() },
    r => { r.signed = false },
  ]) { const r = staged(); change(r); assert.throws(() => validateStagedReceipt(r, context)) }
  const fallback = staged(); delete fallback.acceptanceEvidence
  fallback.installedCandidate = { passed: true, nativeUpdaterExecuted: true, legacyInstallerExecuted: true }
  assert.ok(validateStagedReceipt(fallback, context))
  fallback.installedCandidate.legacyInstallerExecuted = false
  assert.throws(() => validateStagedReceipt(fallback, context))
})

const scenario = (kind, extra) => ({ schemaVersion: 1, kind, sourceCommit: 'c'.repeat(40), workflowRun: { id: '55' },
  verifierRun: { id: '55', attempt: '1' }, signedInstallerSha256: 'e'.repeat(64),
  acceptance: { passed: true, signed: true, scenario: kind, rootTrustInstalled: false, productVersion: '3.0.15',
    patchSha256: 'd'.repeat(64), plugin: structuredClone(input.plugin), targetInstaller: { testOnly: false, assets: structuredClone(assets) }, ...extra } })
const update = () => scenario('native-updater', { nativeUpdaterExecuted: true, nativeSignatureVerificationExecuted: true,
  installerRestartedApp: true, update: { installerUpgrade: true } })
const legacy = () => scenario('legacy-migration', { legacyInstallerExecuted: true, migration: { legacyProfileMigration: true } })
const fresh = () => ({ kind: 'fresh-install', passed: true, installerExecuted: true, sourceCommit: 'c'.repeat(40), workflowRun: { id: '55' },
  signedInstallerSha256: 'e'.repeat(64), input: structuredClone(input), patchSha256: 'd'.repeat(64), signing: structuredClone(input.signing) })

test('each signed installed record must come from this run and these exact signed bytes', () => {
  const options = { receipt: staged(), runId: '55' }
  for (const [kind, make] of [['native-updater', update], ['legacy-migration', legacy], ['fresh-install', fresh]]) {
    assert.ok(validateSignedRecord(kind, make(), options))
    for (const change of [r => { r.sourceCommit = 'f'.repeat(40) }, r => { r.workflowRun.id = '54' },
      r => { r.signedInstallerSha256 = 'f'.repeat(64) }, r => { r.kind = 'other' }]) {
      const record = make(); change(record); assert.throws(() => validateSignedRecord(kind, record, options), kind)
    }
  }
  for (const change of [a => { a.nativeSignatureVerificationExecuted = false }, a => { a.installerRestartedApp = false },
    a => { a.rootTrustInstalled = true }, a => { a.signed = false }, a => { a.scenario = 'legacy-migration' },
    a => { a.targetInstaller.assets[0].sha256 = 'f'.repeat(64) }, a => { a.targetInstaller.testOnly = true }]) {
    const record = update(); change(record.acceptance); assert.throws(() => validateSignedRecord('native-updater', record, options))
  }
  const migration = legacy(); migration.acceptance.migration.legacyProfileMigration = false
  assert.throws(() => validateSignedRecord('legacy-migration', migration, options))
  const install = fresh(); install.passed = false
  assert.throws(() => validateSignedRecord('fresh-install', install, options))
  assert.throws(() => validateSignedRecord('unsigned', update(), options))
})

test('the published receipt adds both signed installed checks to the staged receipt', () => {
  const final = composeFinalReceipt(staged(), update(), legacy())
  assert.deepEqual({ ...final, installedSignedUpdate: undefined, installedSignedLegacyMigration: undefined },
    { ...staged(), installedSignedUpdate: undefined, installedSignedLegacyMigration: undefined })
  assert.equal(final.installedSignedUpdate.passed, true)
  assert.equal(final.installedSignedUpdate.installerRestartedApp, true)
  assert.equal(final.installedSignedUpdate.rootTrustInstalled, false)
  assert.equal(final.installedSignedUpdate.signedInstallerSha256, 'e'.repeat(64))
  assert.equal(final.installedSignedLegacyMigration.legacyProfileMigration, true)
  assert.throws(() => composeFinalReceipt(final, update(), legacy()))
})

test('the final receipt takes precedence over the staged receipt in a downloaded draft', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentrouter-receipt-'))
  assert.throws(() => readReleaseReceipt(directory))
  writeFileSync(join(directory, 'staged-release-receipt.json'), JSON.stringify({ stage: 'staged' }))
  assert.equal(readReleaseReceipt(directory).name, 'staged-release-receipt.json')
  writeFileSync(join(directory, 'release-receipt.json'), JSON.stringify({ stage: 'final' }))
  assert.deepEqual(readReleaseReceipt(directory), { name: 'release-receipt.json', receipt: { stage: 'final' } })
})
