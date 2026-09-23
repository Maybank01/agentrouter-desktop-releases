/** Reuse a successful ci.yml installed acceptance whose product inputs equal the release commit's. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { requiresInstalledAcceptance } from './ci-scope.mjs'

export const repository = 'Maybank01/agentrouter-desktop-releases'
export const ciWorkflow = '.github/workflows/ci.yml'
// Every ci.yml job that the release-side candidate acceptance would repeat.
export const requiredJobs = ['Source boundaries and provenance', 'Adapter transactions and pnpm store migration',
  'Installed native update and restart', 'Installed legacy Profile migration',
  'Installed fresh install with runtime and credential recovery']
const reusableEvents = ['push', 'pull_request', 'workflow_dispatch']

/** Digest of the files ci-scope marks as requiring installed acceptance (git tree entries). */
export function installedInputsDigest(entries) {
  const selected = entries.filter(entry => entry.type !== 'tree' && requiresInstalledAcceptance([entry.path]))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  assert.ok(selected.some(entry => entry.path === 'assembly/coordinated/adapter-source.json'),
    'adapter-source.json must be an installed-acceptance input')
  for (const entry of selected) {
    assert.match(entry.mode, /^[0-7]{6}$/); assert.match(entry.sha, /^[a-f0-9]{40}$/)
  }
  return createHash('sha256').update(selected.map(entry => `${entry.mode} ${entry.type} ${entry.sha}\t${entry.path}\n`).join('')).digest('hex')
}

export function parseLsTree(text) {
  return text.split('\0').filter(Boolean).map(line => {
    const match = /^(\d{6}) (\w+) ([a-f0-9]{40})\t(.+)$/s.exec(line)
    assert.ok(match, `Unexpected ls-tree entry: ${line}`)
    return { mode: match[1], type: match[2], sha: match[3], path: match[4] }
  })
}

/** Tree identity of a local commit, computed the same way as for the tested run. */
export function localInputs(commit, git) {
  assert.match(commit ?? '', /^[a-f0-9]{40}$/)
  return { commit, treeSha: git('rev-parse', `${commit}^{tree}`).trim(),
    inputsDigest: installedInputsDigest(parseLsTree(git('ls-tree', '-r', '-z', '--full-tree', commit))) }
}

function jobEvidence(jobs, run) {
  const recorded = []
  for (const name of requiredJobs) {
    const matches = jobs.filter(job => job.name === name)
    if (matches.length !== 1) return { reason: `${matches.length ? 'duplicate' : 'missing'} job: ${name}` }
    const [job] = matches
    if (job.conclusion !== 'success') return { reason: `${name} concluded ${job.conclusion ?? job.status}` }
    if (job.head_sha !== run.head_sha || Number(job.run_id) !== Number(run.id)) return { reason: `${name} belongs to another run or commit` }
    recorded.push({ name, id: job.id, runAttempt: job.run_attempt })
  }
  return { jobs: recorded }
}

/** Decide whether one ci.yml run proves installed acceptance for the release inputs.
 * A pull_request run tests its merge commit; it only equals the head tree when the
 * PR base is an ancestor of the head (compare status ahead/identical). */
export function evaluateRun({ run, jobs, tree, pull, baseComparison, release }) {
  const reject = reason => ({ matched: false, runId: run?.id, reason })
  if (run.repository?.full_name !== repository) return reject('another repository')
  if (run.head_repository?.full_name !== repository) return reject('fork or other head repository')
  if (run.path !== ciWorkflow) return reject('not ci.yml')
  if (!reusableEvents.includes(run.event)) return reject(`event ${run.event}`)
  if (run.status !== 'completed' || run.conclusion !== 'success') return reject(`run ${run.status}/${run.conclusion}`)
  if (!/^[a-f0-9]{40}$/.test(run.head_sha ?? '')) return reject('invalid head')
  if (!tree || tree.truncated !== false || !Array.isArray(tree.tree)) return reject('incomplete tree listing')
  if (!run.head_commit?.tree_id || tree.sha !== run.head_commit.tree_id) return reject('tree listing is not the tested head tree')
  const inputsDigest = installedInputsDigest(tree.tree)
  if (inputsDigest !== release.inputsDigest) return reject('installed-acceptance inputs differ')
  let pullRequest
  if (run.event === 'pull_request') {
    if (!pull) return reject('pull request not found')
    if (pull.head?.repo?.full_name !== repository || pull.base?.repo?.full_name !== repository) return reject('fork pull request')
    if (pull.base?.ref !== 'main' || pull.head?.ref !== run.head_branch) return reject('pull request does not target main from this branch')
    if (!['ahead', 'identical'].includes(baseComparison?.status)) return reject('PR base is not an ancestor of the tested head')
    if (baseComparison.merge_base_commit?.sha !== pull.base.sha) return reject('PR base comparison is inconsistent')
    pullRequest = { number: pull.number, baseSha: pull.base.sha }
  }
  const checked = jobEvidence(jobs, run)
  if (checked.reason) return reject(checked.reason)
  return { matched: true, evidence: { repository, workflow: ciWorkflow, runId: run.id, runAttempt: run.run_attempt,
    event: run.event, headSha: run.head_sha, ...(pullRequest ? { pullRequest } : {}),
    testedTreeSha: tree.sha, releaseCommit: release.commit, releaseTreeSha: release.treeSha,
    treeIdentical: tree.sha === release.treeSha, inputsDigest, jobs: checked.jobs, url: run.html_url } }
}

/** Re-check a recorded identity (signing, recovery) against immutable job records. */
export function verifyRecordedEvidence({ evidence, jobs, tree, release }) {
  assert.equal(evidence.repository, repository)
  assert.equal(evidence.workflow, ciWorkflow)
  assert.equal(evidence.releaseCommit, release.commit)
  assert.equal(evidence.inputsDigest, release.inputsDigest)
  assert.match(evidence.headSha, /^[a-f0-9]{40}$/)
  assert.deepEqual(evidence.jobs.map(job => job.name), requiredJobs)
  if (tree) {
    assert.equal(tree.truncated, false)
    assert.equal(tree.sha, evidence.testedTreeSha)
    assert.equal(installedInputsDigest(tree.tree), evidence.inputsDigest)
  }
  if (jobs) {
    const checked = jobEvidence(jobs, { id: evidence.runId, head_sha: evidence.headSha })
    assert.equal(checked.reason, undefined, checked.reason)
    assert.deepEqual(checked.jobs, evidence.jobs)
  }
  return evidence
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.env.GITHUB_REPOSITORY, repository)
  const api = path => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 }))
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  const release = localInputs(process.env.GITHUB_SHA, git)
  const base = `repos/${repository}/actions/workflows/ci.yml/runs?status=success`
  const runs = new Map()
  for (const run of [...api(`${base}&head_sha=${release.commit}&per_page=20`).workflow_runs, ...api(`${base}&per_page=50`).workflow_runs]) runs.set(run.id, run)
  const trees = new Map(), examined = []
  let result
  for (const run of runs.values()) {
    const treeSha = run.head_commit?.tree_id
    if (!/^[a-f0-9]{40}$/.test(treeSha ?? '')) { examined.push({ runId: run.id, reason: 'no head tree' }); continue }
    if (!trees.has(treeSha)) trees.set(treeSha, api(`repos/${repository}/git/trees/${treeSha}?recursive=1`))
    const tree = trees.get(treeSha)
    // Avoid job/PR requests for runs whose product inputs already differ.
    if (tree.truncated !== false || installedInputsDigest(tree.tree) !== release.inputsDigest) {
      examined.push({ runId: run.id, reason: 'installed-acceptance inputs differ' }); continue
    }
    const { jobs } = api(`repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`)
    let pull, baseComparison
    if (run.event === 'pull_request') {
      pull = api(`repos/${repository}/commits/${run.head_sha}/pulls`)
        .find(entry => entry.head?.ref === run.head_branch && entry.head?.repo?.full_name === repository)
      if (pull) baseComparison = api(`repos/${repository}/compare/${pull.base.sha}...${run.head_sha}?per_page=1`)
    }
    result = evaluateRun({ run, jobs, tree, pull, baseComparison, release })
    examined.push({ runId: run.id, reason: result.reason ?? 'matched' })
    if (result.matched) break
  }
  const found = Boolean(result?.matched)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
    `found=${found}\n` + (found ? `evidence=${JSON.stringify(result.evidence)}\n` : ''))
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, '## Installed acceptance evidence\n\n'
    + (found ? `Reusing [ci.yml run ${result.evidence.runId}](${result.evidence.url}) attempt ${result.evidence.runAttempt}; release candidate acceptance is skipped.\n\n`
      : 'No reusable ci.yml run; the release repeats candidate acceptance.\n\n')
    + '```json\n' + JSON.stringify({ release, evidence: result?.evidence, examined: examined.slice(0, 20) }, null, 2) + '\n```\n')
  console.log(JSON.stringify({ found, release, evidence: result?.evidence }))
}
