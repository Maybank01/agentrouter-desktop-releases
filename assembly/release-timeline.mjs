/**
 * Measure a release.yml run per job (queue and execution separately) against
 * assembly/release-budgets.json. The publish job embeds the result in the
 * release receipt; the final job writes it to the run summary and opens an
 * incident issue when a job failed or a budget was exceeded.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const minute = 60_000
export const budgets = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'release-budgets.json'), 'utf8'))
export const releaseProfiles = ['standard', 'hotfix']

export function evaluateJobs(jobs, { profile = 'standard', dispatchedAt, finishedAt } = {}) {
  assert.ok(releaseProfiles.includes(profile), `Unknown release profile ${profile}`)
  const stages = jobs.filter(job => job.started_at && job.conclusion !== 'skipped').map(job => {
    const queueMs = Date.parse(job.started_at) - Date.parse(job.created_at)
    const durationMs = job.completed_at ? Date.parse(job.completed_at) - Date.parse(job.started_at) : undefined
    const budgetMinutes = budgets.jobs[job.name]
    return { name: job.name, attempt: job.run_attempt, conclusion: job.conclusion ?? job.status, startedAt: job.started_at,
      completedAt: job.completed_at, queueMs, durationMs, ...(budgetMinutes ? { budgetMs: budgetMinutes * minute } : {}),
      overBudget: Boolean(budgetMinutes && durationMs > budgetMinutes * minute), queueOverBudget: queueMs > budgets.queueMinutes * minute }
  })
  const end = finishedAt ?? stages.map(stage => stage.completedAt).filter(Boolean).sort().at(-1)
  const totalMs = dispatchedAt && end ? Date.parse(end) - Date.parse(dispatchedAt) : undefined
  const totalBudgetMs = budgets.totalMinutes[profile] * minute
  const failed = stages.filter(stage => stage.conclusion && !['success', 'in_progress', 'queued'].includes(stage.conclusion)).map(stage => stage.name)
  const breaches = [...stages.filter(stage => stage.overBudget).map(stage => `${stage.name} took ${Math.round(stage.durationMs / 1000)} s (budget ${stage.budgetMs / 1000} s)`),
    ...stages.filter(stage => stage.queueOverBudget).map(stage => `${stage.name} queued ${Math.round(stage.queueMs / 1000)} s`),
    ...(totalMs > totalBudgetMs ? [`total ${Math.round(totalMs / 1000)} s (budget ${totalBudgetMs / 1000} s)`] : [])]
  return { schemaVersion: 1, profile, dispatchedAt, finishedAt: end, totalMs, totalBudgetMs, stages, failed, breaches, incident: failed.length > 0 || breaches.length > 0 }
}

export function renderSummary(result) {
  const seconds = ms => ms === undefined ? '-' : `${Math.round(ms / 1000)} s`
  return ['## Release timeline', '', `Profile **${result.profile}**; dispatch to last job ${seconds(result.totalMs)} (budget ${seconds(result.totalBudgetMs)}).`, '',
    '| Job | Attempt | Queue | Duration | Budget | Result |', '| --- | --- | --- | --- | --- | --- |',
    ...result.stages.map(stage => `| ${stage.name} | ${stage.attempt} | ${seconds(stage.queueMs)} | ${seconds(stage.durationMs)} | ${seconds(stage.budgetMs)} | ${stage.conclusion}${stage.overBudget ? ' **over budget**' : ''} |`),
    '', result.incident ? `**Incident:** ${[...result.failed.map(name => `${name} failed`), ...result.breaches].join('; ')}` : 'No budget breach.', ''].join('\n')
}

const gh = args => execFileSync('gh', args, { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] })

/** Timeline of this run's latest attempt, from the Actions API (read-only). */
export function currentRun(env = process.env) {
  const repo = env.GITHUB_REPOSITORY, id = env.GITHUB_RUN_ID
  assert.match(id ?? '', /^\d+$/)
  const run = JSON.parse(gh(['api', `repos/${repo}/actions/runs/${id}`]))
  const { jobs } = JSON.parse(gh(['api', `repos/${repo}/actions/runs/${id}/jobs?filter=latest&per_page=100`]))
  return { run, jobs }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const profile = process.env.RELEASE_PROFILE || 'standard'
  const { run, jobs } = currentRun()
  // Exclude this reporting job itself; it is still running.
  const result = evaluateJobs(jobs.filter(job => job.name !== process.env.TIMELINE_JOB_NAME), { profile, dispatchedAt: run.created_at })
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, renderSummary(result))
  console.log(JSON.stringify(result))
  if (result.incident && process.argv.includes('--incident')) {
    const title = `Release incident: ${run.name} #${run.id} (${profile})`
    const body = `${renderSummary(result)}\nRun: ${run.html_url}\n\nOpened automatically by release.yml. Investigate the failed or slow stage; do not rerun blindly.`
    gh(['issue', 'create', '--repo', process.env.GITHUB_REPOSITORY, '--title', title, '--body', body])
  }
}
