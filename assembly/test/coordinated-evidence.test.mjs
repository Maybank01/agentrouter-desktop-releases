import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateRun, installedInputsDigest, parseLsTree, repository, requiredJobs, verifyRecordedEvidence } from '../coordinated-evidence.mjs'

const sha = c => c.repeat(40)
const entries = () => [
  { path: 'assembly/coordinated/adapter-source.json', mode: '100644', type: 'blob', sha: sha('1') },
  { path: 'assembly/coordinated/release.json', mode: '100644', type: 'blob', sha: sha('2') },
  { path: 'assembly/coordinated', mode: '040000', type: 'tree', sha: sha('3') },
  { path: 'README.md', mode: '100644', type: 'blob', sha: sha('4') },
  { path: 'assembly/test/ci-scope.test.mjs', mode: '100644', type: 'blob', sha: sha('5') },
]

function fixture(event = 'push') {
  const tree = { sha: sha('7'), truncated: false, tree: entries() }
  const release = { commit: sha('a'), treeSha: sha('7'), inputsDigest: installedInputsDigest(entries()) }
  const run = { id: 101, run_attempt: 2, event, status: 'completed', conclusion: 'success', path: '.github/workflows/ci.yml',
    head_sha: sha('b'), head_branch: event === 'pull_request' ? 'feature' : 'main', head_commit: { tree_id: tree.sha },
    repository: { full_name: repository }, head_repository: { full_name: repository }, html_url: 'https://example.invalid/run' }
  const jobs = requiredJobs.map((name, index) => ({ name, id: 900 + index, run_id: 101, run_attempt: 2, head_sha: run.head_sha, conclusion: 'success' }))
  const pull = { number: 38, head: { ref: 'feature', repo: { full_name: repository } }, base: { ref: 'main', sha: sha('c'), repo: { full_name: repository } } }
  const baseComparison = { status: 'ahead', merge_base_commit: { sha: sha('c') } }
  return { run, jobs, tree, release, ...(event === 'pull_request' ? { pull, baseComparison } : {}) }
}

test('the digest covers only installed-acceptance inputs and ignores docs, tests and tree order', () => {
  const digest = installedInputsDigest(entries())
  assert.equal(installedInputsDigest([...entries()].reverse()), digest)
  const docs = entries(); docs[3].sha = sha('9'); docs[4].sha = sha('9')
  assert.equal(installedInputsDigest(docs), digest)
  const product = entries(); product[1].sha = sha('9')
  assert.notEqual(installedInputsDigest(product), digest)
  const mode = entries(); mode[1].mode = '100755'
  assert.notEqual(installedInputsDigest(mode), digest)
  assert.throws(() => installedInputsDigest(entries().filter(entry => !entry.path.endsWith('adapter-source.json'))))
})

test('local ls-tree entries produce the same digest as the API tree listing', () => {
  const text = entries().filter(entry => entry.type !== 'tree')
    .map(entry => `${entry.mode} ${entry.type} ${entry.sha}\t${entry.path}`).join('\0') + '\0'
  assert.equal(installedInputsDigest(parseLsTree(text)), installedInputsDigest(entries()))
})

test('a successful push or same-repository PR run with identical inputs is reusable evidence', () => {
  for (const event of ['push', 'pull_request']) {
    const result = evaluateRun(fixture(event))
    assert.equal(result.matched, true, result.reason)
    assert.equal(result.evidence.runId, 101)
    assert.equal(result.evidence.runAttempt, 2)
    assert.equal(result.evidence.treeIdentical, true)
    assert.deepEqual(result.evidence.jobs.map(job => job.id), [900, 901, 902, 903, 904])
    assert.equal(result.evidence.pullRequest?.number, event === 'pull_request' ? 38 : undefined)
  }
})

test('different product inputs are rejected; unrelated tree differences are allowed', () => {
  const changed = fixture(); changed.tree.tree[1].sha = sha('9')
  assert.match(evaluateRun(changed).reason, /inputs differ/)
  const docs = fixture(); docs.tree.tree[3].sha = sha('9'); docs.tree.sha = sha('8'); docs.run.head_commit.tree_id = sha('8')
  const result = evaluateRun(docs)
  assert.equal(result.matched, true)
  assert.equal(result.evidence.treeIdentical, false)
  const truncated = fixture(); truncated.tree.truncated = true
  assert.match(evaluateRun(truncated).reason, /incomplete/)
  const otherTree = fixture(); otherTree.run.head_commit.tree_id = sha('8')
  assert.match(evaluateRun(otherTree).reason, /tested head tree/)
})

test('failed, skipped, cancelled, duplicate or missing installed scenarios are rejected', () => {
  for (const [change, pattern] of [
    [f => { f.jobs[2].conclusion = 'failure' }, /concluded failure/],
    [f => { f.jobs[3].conclusion = 'skipped' }, /concluded skipped/],
    [f => { f.jobs[4].conclusion = 'cancelled' }, /concluded cancelled/],
    [f => { f.jobs.splice(4, 1) }, /missing job: Installed fresh install/],
    [f => { f.jobs.push({ ...f.jobs[2], id: 999 }) }, /duplicate job/],
    [f => { f.jobs[1].head_sha = sha('d') }, /another run or commit/],
    [f => { f.jobs[1].run_id = 102 }, /another run or commit/],
    [f => { f.run.conclusion = 'failure' }, /run completed\/failure/],
  ]) { const f = fixture(); change(f); assert.match(evaluateRun(f).reason, pattern) }
})

test('forks, other repositories, workflows and events never supply evidence', () => {
  for (const [change, pattern] of [
    [f => { f.run.head_repository.full_name = 'someone/fork' }, /fork/],
    [f => { f.run.repository.full_name = 'other/repository' }, /another repository/],
    [f => { f.run.path = '.github/workflows/release.yml' }, /not ci\.yml/],
    [f => { f.run.event = 'pull_request_target' }, /event/],
  ]) { const f = fixture(); change(f); assert.match(evaluateRun(f).reason, pattern) }
  const forkPull = fixture('pull_request'); forkPull.pull.head.repo.full_name = 'someone/fork'
  assert.match(evaluateRun(forkPull).reason, /fork pull request/)
  const missing = fixture('pull_request'); delete missing.pull
  assert.match(evaluateRun(missing).reason, /not found/)
})

test('a PR run whose base is not an ancestor of its head tested a different merge tree', () => {
  for (const status of ['diverged', 'behind', undefined]) {
    const f = fixture('pull_request'); f.baseComparison.status = status
    assert.match(evaluateRun(f).reason, /not an ancestor/)
  }
  const identical = fixture('pull_request'); identical.baseComparison.status = 'identical'
  assert.equal(evaluateRun(identical).matched, true)
  const inconsistent = fixture('pull_request'); inconsistent.baseComparison.merge_base_commit.sha = sha('e')
  assert.match(evaluateRun(inconsistent).reason, /inconsistent/)
  const otherBase = fixture('pull_request'); otherBase.pull.base.ref = 'dev'
  assert.match(evaluateRun(otherBase).reason, /target main/)
})

test('a recorded identity is re-verified against the release inputs and immutable job records', () => {
  const f = fixture()
  const { evidence } = evaluateRun(f)
  assert.deepEqual(verifyRecordedEvidence({ evidence, jobs: f.jobs, tree: f.tree, release: f.release }), evidence)
  assert.throws(() => verifyRecordedEvidence({ evidence, release: { ...f.release, commit: sha('f') } }))
  assert.throws(() => verifyRecordedEvidence({ evidence, release: { ...f.release, inputsDigest: '0'.repeat(64) } }))
  assert.throws(() => verifyRecordedEvidence({ evidence: { ...evidence, jobs: evidence.jobs.slice(1) }, release: f.release }))
  const failed = structuredClone(f.jobs); failed[2].conclusion = 'failure'
  assert.throws(() => verifyRecordedEvidence({ evidence, jobs: failed, release: f.release }))
  const tree = structuredClone(f.tree); tree.tree[1].sha = sha('9')
  assert.throws(() => verifyRecordedEvidence({ evidence, tree, release: f.release }))
})
