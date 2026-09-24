import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { observePlugin, waitForPlugin } from '../wait-plugin.mjs'
import { evaluateJobs, renderSummary } from '../release-timeline.mjs'
import { hotfixDeferral, releaseProfileRecord, validateDeferredPreSign, validateStagedReceipt } from '../coordinated-signed.mjs'
import { requiresInstalledAcceptance } from '../ci-scope.mjs'

const bytes = Buffer.from('exact candidate tarball')
const plugin = { name: '@agentrouter-top/dsh-codex', version: '0.16.2', size: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'), integrity: 'sha512-candidate' }
const packument = (overrides = {}) => ({ 'dist-tags': { next: '0.16.2' }, time: { '0.16.2': '2026-09-24T03:34:32Z' },
  versions: { '0.16.2': { dist: { integrity: plugin.integrity, tarball: 'https://registry.npmjs.org/t.tgz' } } }, ...overrides })
const response = (status, body) => ({ status, json: async () => body, arrayBuffer: async () => body })
const registry = (metadata, tarball = bytes) => async url => url.endsWith('.tgz') ? (tarball ? response(200, tarball) : response(404)) : metadata ? response(200, metadata) : response(404)

test('npm wait accepts only the exact locked candidate bytes', async () => {
  assert.equal((await observePlugin(plugin, { fetcher: registry(undefined) })).state, 'pending')
  assert.equal((await observePlugin(plugin, { fetcher: registry(packument({ versions: {} })) })).state, 'pending')
  assert.equal((await observePlugin(plugin, { fetcher: registry(packument(), null) })).state, 'pending')
  assert.equal((await observePlugin(plugin, { requireNext: true, fetcher: registry(packument({ 'dist-tags': { next: '0.16.1' } })) })).state, 'pending')
  assert.equal((await observePlugin(plugin, { requireNext: true, fetcher: registry(packument()) })).state, 'verified')
  await assert.rejects(observePlugin(plugin, { fetcher: registry(packument({ versions: { '0.16.2': { dist: { integrity: 'sha512-other', tarball: 'x.tgz' } } } })) }), /different artifact/)
  await assert.rejects(observePlugin(plugin, { fetcher: registry(packument(), Buffer.from('other bytes of equal size!')) }), /size|SHA-256/)
})

test('npm wait polls until publication and fails after its bounded budget', async () => {
  let clock = 0, calls = 0
  const fetcher = async url => { calls++; return clock >= 60_000 ? registry(packument())(url) : response(404) }
  const result = await waitForPlugin(plugin, { fetcher, now: () => clock, sleep: async ms => { clock += ms }, intervalMs: 15_000, log: () => {} })
  assert.equal(result.state, 'verified')
  assert.equal(result.waitedMs, 60_000)
  assert.ok(calls >= 5)
  clock = 0
  await assert.rejects(waitForPlugin(plugin, { fetcher: async () => response(404), now: () => clock, sleep: async ms => { clock += ms },
    timeoutMs: 60_000, intervalMs: 15_000, log: () => {} }), /within 1 minutes/)
})

const job = (name, created, started, completed, conclusion = 'success') => ({ name, run_attempt: 1, conclusion,
  created_at: `2026-09-24T${created}Z`, started_at: `2026-09-24T${started}Z`, completed_at: `2026-09-24T${completed}Z` })

test('the 3.0.19 release jobs breach their budgets where time was lost', () => {
  const jobs = [
    job('Select reusable installed acceptance evidence', '04:08:29', '04:08:32', '04:08:54'),
    job('Sign and stage the exact product release', '04:08:55', '04:08:59', '04:13:27'),
    job('Signed native update and restart', '04:13:27', '04:13:31', '04:27:13'),
    job('Signed legacy Profile migration', '04:13:27', '04:13:29', '04:19:20'),
    job('Install signed bytes on a clean worker', '04:13:27', '04:13:41', '04:17:59', 'failure'),
    { name: 'Accept coordinated installers before signing', conclusion: 'skipped', created_at: '2026-09-24T04:08:55Z', started_at: '2026-09-24T04:08:55Z', completed_at: '2026-09-24T04:08:54Z' },
  ]
  const result = evaluateJobs(jobs, { profile: 'hotfix', dispatchedAt: '2026-09-24T04:08:28Z', finishedAt: '2026-09-24T04:33:37Z' })
  assert.deepEqual(result.failed, ['Install signed bytes on a clean worker'])
  assert.equal(result.stages.length, 5, 'skipped jobs are not stages')
  assert.ok(result.breaches.some(breach => breach.startsWith('total')))
  assert.equal(result.incident, true)
  assert.match(renderSummary(result), /\*\*Incident:\*\* Install signed bytes on a clean worker failed/)
  const quick = evaluateJobs(jobs.slice(0, 2), { profile: 'standard', dispatchedAt: '2026-09-24T04:08:28Z' })
  assert.equal(quick.incident, false)
  assert.throws(() => evaluateJobs([], { profile: 'fast' }))
})

test('the hotfix profile records its single deferral and keeps every signed check', () => {
  assert.deepEqual(releaseProfileRecord('standard', true), { name: 'standard', preSignInstalledAcceptance: 'executed-or-reused' })
  assert.deepEqual(releaseProfileRecord('hotfix', false), hotfixDeferral)
  assert.throws(() => releaseProfileRecord('standard', false), /exactly one installed acceptance source/)
  assert.throws(() => validateDeferredPreSign(undefined))
  assert.throws(() => validateDeferredPreSign({ ...hotfixDeferral, retained: [] }))
  for (const check of ['Authenticode', 'signed native update', 'signed legacy', 'clean-worker', 'feed verification', 'authorized npm candidate']) {
    assert.ok(hotfixDeferral.retained.some(entry => entry.includes(check)), check)
  }
  const staged = { schemaVersion: 2, sourceCommit: 'a'.repeat(40), signed: true, testOnly: false,
    workflowRun: { id: '7', workflow: '.github/workflows/release.yml' }, releaseProfile: { ...hotfixDeferral } }
  assert.equal(validateStagedReceipt(staged, { sourceCommit: 'a'.repeat(40), runId: '7' }), staged)
  assert.throws(() => validateStagedReceipt({ ...staged, releaseProfile: { name: 'standard' } }, { sourceCommit: 'a'.repeat(40), runId: '7' }))
})

test('release tooling does not change the installed-acceptance inputs', () => {
  for (const path of ['assembly/wait-plugin.mjs', 'assembly/release-timeline.mjs', 'assembly/release-budgets.json']) assert.equal(requiresInstalledAcceptance([path]), false, path)
  assert.equal(requiresInstalledAcceptance(['assembly/coordinated/release.json']), true)
})
