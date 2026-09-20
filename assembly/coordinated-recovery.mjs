/** Resume immutable signed bytes after a publishing-only failure. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { root } from './lib.mjs'

export function validateSignedRecovery({ run, jobs, receipt, input, adapterSource }) {
  assert.equal(run.repository.full_name, 'Maybank01/agentrouter-desktop-releases')
  assert.equal(run.path, '.github/workflows/release.yml')
  assert.equal(run.event, 'workflow_dispatch')
  assert.equal(run.head_branch, 'main')
  assert.equal(run.status, 'completed')
  assert.match(run.head_sha, /^[a-f0-9]{40}$/)
  assert.equal(receipt.sourceCommit, run.head_sha)
  assert.deepEqual(receipt.input, input)
  assert.deepEqual(receipt.adapterSource, adapterSource)
  assert.equal(input.candidateOnly, false)
  assert.equal(input.signing.mode, 'self-signed')
  assert.equal(receipt.signed, true)
  assert.equal(receipt.testOnly, false)
  assert.deepEqual(receipt.signing, input.signing)
  assert.equal(receipt.installedSignedUpdate.passed, true)
  assert.equal(receipt.installedSignedUpdate.nativeUpdaterExecuted, true)
  assert.equal(receipt.installedSignedUpdate.nativeSignatureVerificationExecuted, true)
  assert.equal(receipt.installedSignedUpdate.installerRestartedApp, true)
  assert.equal(receipt.installedSignedUpdate.rootTrustInstalled, false)
  const installers = receipt.assets.filter(file => file.name.endsWith('.exe'))
  assert.equal(installers.length, 1)
  assert.match(installers[0].sha256, /^[a-f0-9]{64}$/)
  assert.equal(receipt.installedSignedUpdate.signedInstallerSha256, installers[0].sha256)
  for (const name of ['Accept coordinated installers before signing', 'Sign and stage the exact product release']) {
    const matches = jobs.filter(job => job.name === name)
    assert.equal(matches.length, 1)
    assert.equal(matches[0].conclusion, 'success', `The original ${name} job must have passed`)
  }
  return { sourceCommit: run.head_sha }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repo = 'Maybank01/agentrouter-desktop-releases'
  assert.equal(process.env.GITHUB_REPOSITORY, repo)
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main')
  assert.equal(process.env.GITHUB_EVENT_NAME, 'workflow_dispatch')
  assert.equal(process.env.GITHUB_ACTIONS, 'true')
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
  const runId = process.env.RESUME_SIGNED_RUN
  assert.match(runId ?? '', /^[1-9][0-9]{0,19}$/)
  const gh = args => JSON.parse(execFileSync('gh', args, { cwd: root, encoding: 'utf8', windowsHide: true }))
  const json = file => JSON.parse(readFileSync(file, 'utf8'))
  const run = gh(['api', `repos/${repo}/actions/runs/${runId}`])
  const { jobs } = gh(['api', `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`])
  const accepted = validateSignedRecovery({ run, jobs,
    receipt: json(join(resolve(process.argv[2]), 'release-receipt.json')),
    input: json(join(root, 'assembly/coordinated/release.json')),
    adapterSource: json(join(root, 'assembly/coordinated/adapter-source.json')) })
  execFileSync('git', ['merge-base', '--is-ancestor', accepted.sourceCommit, 'HEAD'], { cwd: root, windowsHide: true })
  execFileSync('git', ['diff', '--exit-code', accepted.sourceCommit, 'HEAD', '--', 'assembly/coordinated'], { cwd: root, windowsHide: true })
  appendFileSync(process.env.GITHUB_ENV, `AGENTROUTER_STAGED_SOURCE_SHA=${accepted.sourceCommit}\n`)
  console.log(JSON.stringify({ resumedRun: runId, ...accepted, rebuild: false, signedInstallationStillRequired: true }))
}
