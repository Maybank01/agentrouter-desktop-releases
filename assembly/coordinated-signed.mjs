/** Pure rules for staging, post-sign acceptance records and publication of signed bytes. */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { requiredJobs } from './coordinated-evidence.mjs'

// The sign job stages this receipt; publish adds the signed update/legacy results
// as release-receipt.json once every post-sign job has passed on its own worker.
export const stagedReceiptName = 'staged-release-receipt.json'
export const finalReceiptName = 'release-receipt.json'
export const signedRecords = {
  'native-updater': 'signed-native-update.json',
  'legacy-migration': 'signed-legacy-migration.json',
  'fresh-install': 'signed-fresh-install.json',
}

export function parseVersion(tag) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag)
  return match ? match.slice(1).map(Number) : undefined
}
export function compareVersions(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)]
  assert.ok(x && y, `Expected plain versions: ${a}, ${b}`)
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
  return 0
}

/** Newest formal (published, non-prerelease, plain vX.Y.Z) release other than `except`. */
export function newestPublished(releases, except) {
  return releases.filter(release => !release.draft && !release.prerelease && release.published_at
    && release.tag_name !== except && parseVersion(release.tag_name))
    .map(release => release.tag_name).sort(compareVersions).at(-1)
}

/** Owner decision 2026-09-23: an unpublished draft of the same version may be
 * replaced by a new signing run. A version that was ever published never is,
 * and latest never moves backwards. */
export function planDraftStaging({ tag, releases, tagRefExists }) {
  assert.ok(parseVersion(tag), `Invalid product tag ${tag}`)
  const same = releases.filter(release => release.tag_name === tag)
  for (const release of same) {
    assert.ok(release.draft === true && release.published_at == null,
      `${tag} was already published; a changed package or installer requires a new version`)
  }
  assert.equal(tagRefExists, false, `Tag ${tag} already exists; a published version is never re-signed`)
  const newest = newestPublished(releases, tag)
  if (newest) assert.equal(compareVersions(tag, newest), 1, `${tag} is not newer than published ${newest}; latest must never move backwards`)
  return { replaceDraftIds: same.map(release => release.id), newestPublished: newest }
}

export function assertLatestForward(tag, releases) {
  const newest = newestPublished(releases, tag)
  if (newest) assert.equal(compareVersions(tag, newest), 1, `${tag} is not newer than published ${newest}; latest must never move backwards`)
}

/** The draft receipt read by every post-sign job: this run, this commit, one acceptance source. */
export function validateStagedReceipt(receipt, { sourceCommit, runId }) {
  assert.equal(receipt.sourceCommit, sourceCommit, 'The draft was staged from another commit')
  assert.equal(receipt.signed, true); assert.equal(receipt.testOnly, false)
  if (receipt.schemaVersion === 1) return receipt // signed before post-sign jobs ran in parallel
  assert.equal(receipt.schemaVersion, 2)
  assert.equal(String(receipt.workflowRun?.id), String(runId), 'The draft was staged by another workflow run')
  assert.equal(receipt.workflowRun.workflow, '.github/workflows/release.yml')
  if (!receipt.installedCandidate && !receipt.acceptanceEvidence) {
    // Owner-approved hotfix profile: the unsigned pre-sign duplicate of the signed
    // installed scenarios is deferred to ci.yml, visibly, never silently absent.
    validateDeferredPreSign(receipt.releaseProfile)
    return receipt
  }
  assert.ok(Boolean(receipt.installedCandidate) !== Boolean(receipt.acceptanceEvidence), 'Exactly one pre-sign acceptance source')
  if (receipt.acceptanceEvidence) {
    assert.equal(receipt.acceptanceEvidence.releaseCommit, sourceCommit)
    assert.deepEqual(receipt.acceptanceEvidence.jobs.map(job => job.name), requiredJobs)
  } else {
    assert.equal(receipt.installedCandidate.passed, true)
    assert.equal(receipt.installedCandidate.nativeUpdaterExecuted, true)
    assert.equal(receipt.installedCandidate.legacyInstallerExecuted, true)
  }
  return receipt
}

export const hotfixDeferral = Object.freeze({
  name: 'hotfix',
  preSignInstalledAcceptance: 'deferred',
  deferredTo: 'ci.yml installed scenarios on the export PR and the main push (asynchronous; a failure opens an incident)',
  retained: ['Authenticode and signed update manifest', 'signed native update and restart', 'signed legacy Profile migration',
    'signed clean-worker installation', 'publication, website, download and feed verification', 'plugin bytes equal the authorized npm candidate'],
  policy: 'owner-approved hotfix profile 2026-09-24',
})

export function validateDeferredPreSign(profile) {
  assert.ok(profile, 'Exactly one pre-sign acceptance source')
  assert.deepEqual(profile, hotfixDeferral, 'Only the recorded hotfix profile may defer pre-sign installed acceptance')
  return profile
}

/** Release profile recorded in every staged receipt. */
export function releaseProfileRecord(name, hasPreSignSource) {
  assert.ok(['standard', 'hotfix'].includes(name), `Unknown release profile ${name}`)
  if (hasPreSignSource) return { name, preSignInstalledAcceptance: 'executed-or-reused' }
  assert.equal(name, 'hotfix', 'Expected exactly one installed acceptance source')
  return { ...hotfixDeferral }
}

export function readReleaseReceipt(directory) {
  for (const name of [finalReceiptName, stagedReceiptName]) {
    const path = join(directory, name)
    if (existsSync(path)) return { name, receipt: JSON.parse(readFileSync(path, 'utf8')) }
  }
  throw new Error('The draft has no release receipt')
}

const installerSha = receipt => {
  const installers = receipt.assets.filter(file => file.name.endsWith('.exe'))
  assert.equal(installers.length, 1)
  return installers[0].sha256
}

/** Validate one post-sign record against the staged receipt of this run. */
export function validateSignedRecord(kind, record, { receipt, runId }) {
  assert.ok(Object.hasOwn(signedRecords, kind), `Unknown signed record ${kind}`)
  const sha = installerSha(receipt)
  assert.equal(record.kind, kind)
  assert.equal(record.sourceCommit, receipt.sourceCommit)
  assert.equal(String(record.workflowRun?.id), String(runId))
  assert.equal(record.signedInstallerSha256, sha)
  if (kind === 'fresh-install') {
    assert.equal(record.passed, true); assert.equal(record.installerExecuted, true)
    assert.deepEqual(record.input, receipt.input)
    assert.equal(record.patchSha256, receipt.patchSha256)
    assert.deepEqual(record.signing, receipt.input.signing)
    return record
  }
  const run = record.acceptance
  assert.equal(run.passed, true); assert.equal(run.signed, true)
  assert.equal(run.scenario, kind)
  assert.equal(run.rootTrustInstalled, false)
  assert.equal(run.productVersion, receipt.input.productVersion)
  assert.equal(run.patchSha256, receipt.patchSha256)
  assert.deepEqual(run.plugin, receipt.input.plugin)
  assert.equal(run.targetInstaller.testOnly, false)
  assert.deepEqual(run.targetInstaller.assets, receipt.assets)
  if (kind === 'native-updater') {
    assert.equal(run.nativeUpdaterExecuted, true)
    assert.equal(run.nativeSignatureVerificationExecuted, true)
    assert.equal(run.installerRestartedApp, true)
    assert.equal(run.update?.installerUpgrade, true)
  } else {
    assert.equal(run.legacyInstallerExecuted, true)
    assert.equal(run.migration?.legacyProfileMigration, true)
  }
  return record
}

/** release-receipt.json: the staged receipt plus the summaries of both signed installed checks. */
export function composeFinalReceipt(staged, update, legacy) {
  assert.equal(staged.installedSignedUpdate, undefined)
  const signedInstallerSha256 = installerSha(staged)
  return { ...staged,
    installedSignedUpdate: { passed: true, nativeUpdaterExecuted: true, nativeSignatureVerificationExecuted: true,
      installerRestartedApp: update.acceptance.installerRestartedApp, rootTrustInstalled: false, signedInstallerSha256,
      verifierRun: update.verifierRun },
    installedSignedLegacyMigration: { passed: true, legacyInstallerExecuted: true, legacyProfileMigration: true,
      rootTrustInstalled: false, signedInstallerSha256, verifierRun: legacy.verifierRun } }
}
