/** Record the exported adapter source and public executor identity in a CI job summary. */
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { root } from './lib.mjs'

const bytes = readFileSync(join(root, 'assembly/coordinated/adapter-source.json'))
const source = JSON.parse(bytes)
const env = process.env
const identity = {
  sourceRepository: source.repository, sourceCommit: source.commit,
  adapterManifestSha256: createHash('sha256').update(bytes).digest('hex'),
  executorRepository: env.GITHUB_REPOSITORY, executorCommit: env.GITHUB_SHA,
  workflow: env.AGENTROUTER_EXECUTOR_WORKFLOW_REF,
  workflowCommit: env.AGENTROUTER_EXECUTOR_WORKFLOW_SHA,
  runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
  job: env.GITHUB_JOB, check: process.argv[2], platform: env.RUNNER_OS,
}
const json = JSON.stringify(identity, null, 2)
if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, '## Desktop validation inputs\n\n```json\n' + json + '\n```\n\n'
  + 'Acceptance requires every job of this run to pass. Installer hashes and migration results are recorded in the installed acceptance step. Test installers stay on this disposable worker.\n')
console.log(json)
