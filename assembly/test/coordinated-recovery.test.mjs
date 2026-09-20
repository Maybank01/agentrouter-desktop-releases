import assert from 'node:assert/strict'
import test from 'node:test'
import { validateSignedRecovery } from '../coordinated-recovery.mjs'

function fixture() {
  const input = { candidateOnly: false, productVersion: '3.0.7', signing: { mode: 'self-signed', certificateSha256: 'b'.repeat(64) } }
  const adapterSource = { commit: 'c'.repeat(40), files: [{ path: 'release.json', sha256: 'd'.repeat(64) }] }
  const run = { repository: { full_name: 'Maybank01/agentrouter-desktop-releases' }, path: '.github/workflows/release.yml',
    event: 'workflow_dispatch', head_branch: 'main', head_sha: 'a'.repeat(40), status: 'completed', conclusion: 'failure' }
  const jobs = ['Accept coordinated installers before signing', 'Sign and stage the exact product release']
    .map(name => ({ name, conclusion: 'success' }))
  const receipt = { sourceCommit: run.head_sha, input: structuredClone(input), adapterSource: structuredClone(adapterSource),
    signed: true, testOnly: false, signing: structuredClone(input.signing), assets: [{ name: 'AgentRouter-3.0.7-x64-Setup.exe', sha256: 'e'.repeat(64) }],
    installedSignedUpdate: { passed: true, nativeUpdaterExecuted: true, nativeSignatureVerificationExecuted: true,
      installerRestartedApp: true, rootTrustInstalled: false, signedInstallerSha256: 'e'.repeat(64) } }
  return { run, jobs, receipt, input, adapterSource }
}

test('a failed publication can retain the original accepted signing source', () => {
  const f = fixture()
  assert.deepEqual(validateSignedRecovery(f), { sourceCommit: f.run.head_sha })
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
  ]) { const f = fixture(); change(f); assert.throws(() => validateSignedRecovery(f)) }
})
