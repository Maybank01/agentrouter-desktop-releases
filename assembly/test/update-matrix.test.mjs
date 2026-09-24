import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { get as httpsGet } from 'node:https'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect as tlsConnect } from 'node:tls'
import { requiresInstalledAcceptance } from '../ci-scope.mjs'
import { releaseJobs, updateMatrixResultJob, validateSignedRecovery } from '../coordinated-recovery.mjs'
import { combine, renderTable } from '../update-matrix/aggregate.mjs'
import { createCertificates } from '../update-matrix/certs.mjs'
import { defaultBaselines, expectationFor, feedVersion, planMatrix } from '../update-matrix/plan.mjs'
import { directConnectionBlocked, interceptedHosts, parseClientHelloSni, parseRange, routeRequest, startInterceptor, summarizeEvents } from '../update-matrix/server.mjs'

const release = (tag, extra = {}) => ({ tag_name: tag, draft: false, prerelease: false, published_at: '2026-09-24T00:00:00Z', ...extra })
const releases = [release('v3.0.21', { draft: true, published_at: null }), release('v3.0.20'), release('v3.0.19'), release('v3.0.18'), release('v3.0.17'),
  release('v3.0.14'), release('v3.0.13'), release('rehearsal-7', { draft: true, prerelease: true, published_at: null }), release('v2.0.5-preinstalled.5')]

test('default baselines keep the field versions and the latest two formal versions below the candidate', () => {
  assert.deepEqual(defaultBaselines('3.0.21', releases), ['3.0.14', '3.0.17', '3.0.19', '3.0.20'])
  assert.deepEqual(defaultBaselines('3.0.20', releases), ['3.0.14', '3.0.17', '3.0.18', '3.0.19'])
  assert.deepEqual(defaultBaselines('3.0.30', [...releases, release('v3.0.29'), release('v3.0.28')]), ['3.0.14', '3.0.17', '3.0.19', '3.0.20', '3.0.28', '3.0.29'])
})

test('only baselines before the mirror transport may fail without direct GitHub, at the documented step', () => {
  assert.deepEqual(expectationFor('3.0.19', 'normal'), { expected: 'pass', knownFailureSteps: [] })
  assert.deepEqual(expectationFor('3.0.19', 'github-blocked'), { expected: 'known-failure', knownFailureSteps: ['check', 'download'] })
  assert.deepEqual(expectationFor('3.0.14', 'system-proxy'), { expected: 'known-failure', knownFailureSteps: ['download'] })
  for (const mode of ['normal', 'system-proxy', 'faults']) assert.equal(expectationFor('3.0.20', mode).expected, 'pass', mode)
  // 3.0.20+ check latest.yml?noCache=... against GitHub only until the adapter fix ships.
  assert.deepEqual(expectationFor('3.0.21', 'github-blocked'), { expected: 'known-failure', knownFailureSteps: ['check'] })
  assert.throws(() => expectationFor('3.0.20', 'offline'))
})

test('the matrix fans out baseline x mode plus one fault cell and refuses unpublished or newer baselines', () => {
  const cells = planMatrix({ candidate: '3.0.21', baselines: ['3.0.19', '3.0.14', '3.0.20'], releases })
  assert.equal(cells.length, 10)
  assert.deepEqual(cells.find(cell => cell.id === '3.0.20-github-blocked').knownFailureSteps, ['check'])
  assert.deepEqual(cells.at(-1), { baseline: '3.0.20', mode: 'faults', expected: 'pass', knownFailureSteps: [], id: '3.0.20-faults' })
  assert.deepEqual(cells.slice(0, 3).map(cell => cell.id), ['3.0.14-normal', '3.0.14-github-blocked', '3.0.14-system-proxy'])
  assert.equal(planMatrix({ candidate: '3.0.21', baselines: ['3.0.20'], modes: ['normal'], faults: false, releases }).length, 1)
  assert.throws(() => planMatrix({ candidate: '3.0.20', baselines: ['3.0.20'], releases }), /not older/)
  assert.throws(() => planMatrix({ candidate: '3.0.22', baselines: ['3.0.21'], releases }), /not a published/)
  assert.throws(() => planMatrix({ candidate: '3.0.21', baselines: ['3.0.20'], modes: ['faults'], releases }))
  assert.equal(feedVersion("version: 3.0.20\nfiles:\n  - url: AgentRouter-3.0.20-x64-Setup.exe\n"), '3.0.20')
  assert.throws(() => feedVersion('version: 3.0.20-beta.1\n'))
})

test('the local release service answers like GitHub and the mirror', () => {
  const file = { path: 'x', bytes: 10 }
  const served = new Map([['v3.0.20', new Map([['latest.yml', file], ['AgentRouter-3.0.20-x64-Setup.exe', file]])],
    ['v3.0.19', new Map([['AgentRouter-3.0.19-x64-Setup.exe.blockmap', file]])]])
  const route = (host, path) => routeRequest({ host, path, releases: served, latest: 'v3.0.20' })
  const repo = '/Maybank01/agentrouter-desktop-releases/releases/'
  assert.deepEqual(route('github.com', repo + 'latest/download/latest.yml'), { status: 302, location: `https://github.com${repo}download/v3.0.20/latest.yml` })
  // Like GitHub: an older release's asset is not under latest/download.
  assert.deepEqual(route('github.com', repo + 'latest/download/AgentRouter-3.0.19-x64-Setup.exe.blockmap'), { status: 404 })
  const redirect = route('github.com', repo + 'download/v3.0.19/AgentRouter-3.0.19-x64-Setup.exe.blockmap')
  assert.equal(redirect.status, 302)
  const target = new URL(redirect.location)
  assert.equal(target.hostname, 'release-assets.githubusercontent.com')
  assert.equal(route(target.hostname, target.pathname + target.search).file, file)
  assert.equal(route('agentrouter.top', '/downloads/desktop/latest.yml').file, file)
  assert.equal(route('agentrouter.top', '/downloads/desktop/v3.0.20/AgentRouter-3.0.20-x64-Setup.exe').file, file)
  assert.deepEqual(route('agentrouter.top', '/downloads/desktop/v3.0.18/latest.yml'), { status: 404 })
  assert.deepEqual(route('raw.githubusercontent.com', '/anything'), { status: 404 })
  assert.deepEqual(parseRange('bytes=5-', 10), { kind: 'range', start: 5, end: 9 })
  assert.deepEqual(parseRange('bytes=2-3', 10), { kind: 'range', start: 2, end: 3 })
  assert.deepEqual(parseRange('bytes=-4', 10), { kind: 'range', start: 6, end: 9 })
  assert.deepEqual(parseRange('bytes=0-1, 4-5', 10), { kind: 'multipart' })
  assert.deepEqual(parseRange('bytes=10-', 10), { kind: 'unsatisfiable' })
  assert.equal(directConnectionBlocked('github-blocked', 'objects.githubusercontent.com'), true)
  assert.equal(directConnectionBlocked('system-proxy', 'github.com'), true)
  assert.equal(directConnectionBlocked('system-proxy', 'agentrouter.top'), false)
  assert.equal(directConnectionBlocked('normal', 'github.com'), false)
})

test('the SNI of a real TLS ClientHello is read before any certificate is presented', async () => {
  const hello = await new Promise(resolve => {
    const server = createServer(socket => {
      let buffered = Buffer.alloc(0)
      socket.on('data', chunk => {
        buffered = Buffer.concat([buffered, chunk])
        const parsed = parseClientHelloSni(buffered)
        if (parsed.complete) { socket.destroy(); server.close(); resolve({ parsed, partial: parseClientHelloSni(buffered.subarray(0, 20)) }) }
      })
    }).listen(0, '127.0.0.1', () => tlsConnect({ port: server.address().port, host: '127.0.0.1', servername: 'GitHub.com' }).on('error', () => {}))
  })
  assert.deepEqual(hello.parsed, { complete: true, sni: 'github.com' })
  assert.deepEqual(hello.partial, { complete: false })
  assert.deepEqual(parseClientHelloSni(Buffer.from('GET / HTTP/1.1\r\n')), { complete: true })
})

test('the interceptor serves, resets and proxies by mode with a disposable CA', async t => {
  let certs
  try { certs = createCertificates(mkdtempSync(join(tmpdir(), 'update-matrix-certs-')), interceptedHosts) }
  catch (error) { t.skip(`OpenSSL unavailable: ${error.message}`); return }
  const directory = mkdtempSync(join(tmpdir(), 'update-matrix-files-'))
  writeFileSync(join(directory, 'setup.exe'), Buffer.alloc(512 * 1024, 1))
  const served = new Map([['v3.0.20', new Map([['AgentRouter-3.0.20-x64-Setup.exe', { path: join(directory, 'setup.exe'), bytes: 512 * 1024 }]])]])
  const ca = readFileSync(certs.ca)
  const interceptor = await startInterceptor({ mode: 'system-proxy', releases: served, latest: 'v3.0.20', key: readFileSync(certs.key),
    cert: readFileSync(certs.cert), directPort: 0, dropInstallerTransferOnce: true })
  try {
    const direct = (host, path, headers = {}) => new Promise(resolve => {
      httpsGet({ host: '127.0.0.1', port: interceptor.directPort, servername: host, path, ca, headers: { host, ...headers } }, response => {
        let bytes = 0
        response.on('data', chunk => { bytes += chunk.length })
        response.on('end', () => resolve({ status: response.statusCode, bytes }))
        response.on('error', error => resolve({ status: response.statusCode, bytes, error: error.code }))
      }).on('error', error => resolve({ error: error.code }))
    })
    const mirror = '/downloads/desktop/v3.0.20/AgentRouter-3.0.20-x64-Setup.exe'
    const dropped = await direct('agentrouter.top', mirror)
    assert.ok(dropped.bytes < 512 * 1024, 'the first installer transfer is dropped midway')
    assert.deepEqual(await direct('agentrouter.top', mirror, { range: 'bytes=1024-' }), { status: 206, bytes: 511 * 1024 })
    assert.match((await direct('github.com', '/Maybank01/agentrouter-desktop-releases/releases/latest/download/latest.yml')).error, /ECONNRESET|EPIPE/)
    const proxied = await new Promise((resolve, reject) => {
      httpRequest({ host: '127.0.0.1', port: interceptor.proxyPort, method: 'CONNECT', path: 'github.com:443' }).on('connect', (_, socket) => {
        const secure = tlsConnect({ socket, servername: 'github.com', ca }, () => secure.end(
          'GET /Maybank01/agentrouter-desktop-releases/releases/latest/download/AgentRouter-3.0.20-x64-Setup.exe HTTP/1.1\r\nHost: github.com\r\nConnection: close\r\n\r\n'))
        let text = ''
        secure.on('data', chunk => { text += chunk }).on('end', () => resolve(text.split('\r\n')[0])).on('error', reject)
      }).on('error', reject).end()
    })
    assert.equal(proxied, 'HTTP/1.1 302 Found')
    const summary = summarizeEvents(interceptor.events)
    assert.deepEqual(summary.resets, { 'github.com': 1 })
    assert.equal(summary.faults.length, 1)
    assert.equal(summary.byHostStatus['proxy github.com 302'], 1)
  } finally { await interceptor.close() }
})

test('the matrix result fails on any failed or missing cell and accepts documented known failures', () => {
  const cells = planMatrix({ candidate: '3.0.20', baselines: ['3.0.14', '3.0.19'], modes: ['normal', 'github-blocked'], releases })
  const plan = { candidate: '3.0.20', candidateTag: 'v3.0.20', cells }
  const record = (cell, outcome, failedStep) => ({ baseline: cell.baseline, mode: cell.mode, candidate: '3.0.20', expected: cell.expected,
    outcome, failedStep, gatePassed: outcome !== 'FAIL', durations: { totalMs: 600000 } })
  const good = cells.map(cell => record(cell, cell.expected === 'pass' ? 'pass' : 'known-failure', cell.expected === 'pass' ? undefined : 'check'))
  const passed = combine(plan, good)
  assert.equal(passed.passed, true)
  assert.match(renderTable(passed), /\| 3\.0\.14 \| pass 10 min \| known failure \(check\) 10 min \| - \|\n\| 3\.0\.19 \| pass 10 min \| known failure \(check\) 10 min \| pass 10 min \|/)
  assert.equal(combine(plan, good.slice(1)).passed, false, 'a missing cell fails the matrix')
  assert.equal(combine(plan, good.map((item, index) => index === 0 ? { ...item, outcome: 'FAIL', gatePassed: false, failedStep: 'restart' } : item)).passed, false)
  assert.match(renderTable(combine(plan, good.slice(1))), /\*\*FAIL\*\* \(no record\)/)
  assert.throws(() => combine(plan, [...good, { ...good[0] }]), /Duplicate/)
  assert.throws(() => combine(plan, good.map(item => ({ ...item, candidate: '3.0.19' }))), /another candidate/)
})

test('the matrix harness is a release gate, not a product input', () => {
  for (const path of ['assembly/update-matrix/run.mjs', 'assembly/update-matrix/system.ps1', '.github/workflows/update-matrix.yml']) {
    assert.equal(requiresInstalledAcceptance([path]), false, path)
  }
  const workflow = readFileSync(new URL('../../.github/workflows/update-matrix.yml', import.meta.url), 'utf8')
  assert.match(workflow, /workflow_call:/)
  assert.match(workflow, /workflow_dispatch:/)
  assert.match(workflow, /fail-fast: false/)
  assert.match(workflow, /runs-on: windows-2025/)
  assert.match(workflow, /if: \$\{\{ always\(\) && needs\.plan\.result == 'success' \}\}/)
  assert.doesNotMatch(workflow, /secrets\.|environment:|pull_request_target|self-hosted/)
  assert.equal((workflow.match(/persist-credentials: false/g) ?? []).length, 3)
})

test('signed recovery requires the original update path matrix when the run carried one', () => {
  const run = { id: 77, repository: { full_name: 'Maybank01/agentrouter-desktop-releases' }, path: '.github/workflows/release.yml',
    event: 'workflow_dispatch', head_branch: 'main', head_sha: 'a'.repeat(40), status: 'completed', conclusion: 'failure' }
  const input = { candidateOnly: false, productVersion: '3.0.21', signing: { mode: 'self-signed', certificateSha256: 'b'.repeat(64) } }
  const adapterSource = { commit: 'c'.repeat(40) }
  const receipt = { schemaVersion: 2, sourceCommit: run.head_sha, input, adapterSource, signed: true, testOnly: false, signing: input.signing,
    workflowRun: { id: '77' }, acceptanceEvidence: { runId: 1 }, assets: [{ name: 'AgentRouter-3.0.21-x64-Setup.exe', sha256: 'e'.repeat(64) }] }
  const jobs = [releaseJobs.evidence, releaseJobs.sign, releaseJobs.signedUpdate, releaseJobs.signedLegacy].map(name => ({ name, conclusion: 'success' }))
  const validate = extra => validateSignedRecovery({ run, jobs: [...jobs, ...extra], receipt, input, adapterSource })
  assert.ok(validate([]), 'runs before the matrix existed')
  assert.ok(validate([{ name: `${releaseJobs.updateMatrix} / Plan the update path matrix`, conclusion: 'success' }, { name: updateMatrixResultJob, conclusion: 'success' }]))
  assert.throws(() => validate([{ name: updateMatrixResultJob, conclusion: 'failure' }]), /update path matrix must have passed/)
  assert.throws(() => validate([{ name: releaseJobs.updateMatrix, conclusion: 'skipped' }]), /did not produce its result/)
})
