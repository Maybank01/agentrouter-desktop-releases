import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { root } from '../lib.mjs'
import { releaseJobs, requiredRecoveryJobs, validateSignedRecovery } from '../coordinated-recovery.mjs'

function fixture() {
  const input = { candidateOnly: false, productVersion: '3.0.7', signing: { mode: 'self-signed', certificateSha256: 'b'.repeat(64) } }
  const adapterSource = { commit: 'c'.repeat(40), files: [{ path: 'release.json', sha256: 'd'.repeat(64) }] }
  const run = { id: 77, repository: { full_name: 'Maybank01/agentrouter-desktop-releases' }, path: '.github/workflows/release.yml',
    event: 'workflow_dispatch', head_branch: 'main', head_sha: 'a'.repeat(40), status: 'completed', conclusion: 'failure' }
  const jobs = ['Accept coordinated installers before signing', 'Sign and stage the exact product release']
    .map(name => ({ name, conclusion: 'success' }))
  const receipt = { schemaVersion: 1, sourceCommit: run.head_sha, input: structuredClone(input), adapterSource: structuredClone(adapterSource),
    signed: true, testOnly: false, signing: structuredClone(input.signing), assets: [{ name: 'AgentRouter-3.0.7-x64-Setup.exe', sha256: 'e'.repeat(64) }],
    installedSignedUpdate: { passed: true, nativeUpdaterExecuted: true, nativeSignatureVerificationExecuted: true,
      installerRestartedApp: true, rootTrustInstalled: false, signedInstallerSha256: 'e'.repeat(64) } }
  return { run, jobs, receipt, input, adapterSource }
}

// A draft staged by the parallel post-sign pipeline, before or after publish finalized its receipt.
function staged({ evidence = true, final = false } = {}) {
  const f = fixture()
  delete f.receipt.installedSignedUpdate
  Object.assign(f.receipt, { schemaVersion: 2, workflowRun: { workflow: '.github/workflows/release.yml', id: '77', attempt: '1' } },
    evidence ? { acceptanceEvidence: { runId: 101 } } : { installedCandidate: { passed: true } })
  if (final) f.receipt.installedSignedUpdate = fixture().receipt.installedSignedUpdate
  f.jobs = [evidence ? releaseJobs.evidence : releaseJobs.candidate, releaseJobs.sign, releaseJobs.signedUpdate,
    releaseJobs.signedLegacy, releaseJobs.signedInstall].map(name => ({ name, conclusion: 'success' }))
  if (evidence) f.jobs.push({ name: releaseJobs.candidate, conclusion: 'skipped' })
  f.jobs.push({ name: 'Publish the accepted signed release and verify delivery', conclusion: 'failure' })
  return f
}

test('a failed publication can retain the original accepted signing source', () => {
  const f = fixture()
  assert.deepEqual(validateSignedRecovery(f), { sourceCommit: f.run.head_sha, runId: '77' })
  for (const options of [{}, { evidence: false }, { final: true }]) {
    const s = staged(options)
    assert.deepEqual(validateSignedRecovery(s), { sourceCommit: s.run.head_sha, runId: '77' })
  }
})

test('recovery requires the release job names that exist in release.yml', () => {
  const workflow = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8')
  for (const name of Object.values(releaseJobs)) assert.match(workflow, new RegExp(`\\n    name: ${name}\\r?\\n`), name)
  assert.deepEqual(requiredRecoveryJobs(staged().receipt), [releaseJobs.evidence, releaseJobs.sign, releaseJobs.signedUpdate, releaseJobs.signedLegacy])
  assert.deepEqual(requiredRecoveryJobs(staged({ evidence: false }).receipt), [releaseJobs.candidate, releaseJobs.sign, releaseJobs.signedUpdate, releaseJobs.signedLegacy])
})

test('recovery rejects another source, workflow, repository or unfinished signing', () => {
  for (const change of [
    f => { f.run.head_sha = 'f'.repeat(40) },
    f => { f.run.event = 'pull_request' },
    f => { f.run.head_branch = 'feature' },
    f => { f.run.path = '.github/workflows/ci.yml' },
    f => { f.run.repository.full_name = 'other/repository' },
    f => { f.run.status = 'in_progress' },
    f => { f.jobs[1].conclusion = 'failure' },
    f => { f.jobs.push(f.jobs[1]) },
  ]) { const f = fixture(); change(f); assert.throws(() => validateSignedRecovery(f)) }
})

test('parallel signed checks must all have passed in the original run that staged the draft', () => {
  for (const change of [
    f => { f.jobs.find(job => job.name === releaseJobs.signedUpdate).conclusion = 'failure' },
    f => { f.jobs.find(job => job.name === releaseJobs.signedLegacy).conclusion = 'skipped' },
    f => { f.jobs = f.jobs.filter(job => job.name !== releaseJobs.evidence) },
    f => { f.receipt.workflowRun.id = '76' },
    f => { f.receipt.installedCandidate = { passed: true } },
    f => { f.receipt.schemaVersion = 3 },
  ]) { const f = staged(); change(f); assert.throws(() => validateSignedRecovery(f)) }
  const fallback = staged({ evidence: false })
  fallback.jobs.find(job => job.name === releaseJobs.candidate).conclusion = 'failure'
  assert.throws(() => validateSignedRecovery(fallback))
})

test('recovery cannot substitute a different product recipe or unsigned test evidence', () => {
  for (const change of [
    f => { f.input.productVersion = '3.0.8' },
    f => { f.adapterSource.files[0].sha256 = 'f'.repeat(64) },
    f => { f.receipt.testOnly = true },
    f => { f.receipt.signed = false },
    f => { f.receipt.installedSignedUpdate.nativeSignatureVerificationExecuted = false },
    f => { f.receipt.installedSignedUpdate.installerRestartedApp = false },
    f => { f.receipt.installedSignedUpdate.rootTrustInstalled = true },
    f => { f.receipt.assets[0].sha256 = 'f'.repeat(64) },
    f => { f.receipt.assets = []; delete f.receipt.installedSignedUpdate.signedInstallerSha256 },
    f => { delete f.receipt.installedSignedUpdate },
  ]) { const f = fixture(); change(f); assert.throws(() => validateSignedRecovery(f)) }
})
