import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { authorizeSource, buildEnvironment, executionRepository, githubApi, requestFromEnvironment,
  resultReceipt, runPrivate, sourceRepository, storeResult, workflowPath } from '../plugin-ci/executor.mjs'

const sourceSha = 'a'.repeat(40)
const workflowSha = 'b'.repeat(40)
const environment = {
  AGENTROUTER_CI_TASK: 'verify', AGENTROUTER_SOURCE_SHA: sourceSha,
  AGENTROUTER_CI_REQUEST_ID: 'verify-123456-abcd',
  AGENTROUTER_EXECUTOR_WORKFLOW_SHA: workflowSha,
  GITHUB_REPOSITORY: executionRepository, GITHUB_REF: 'refs/heads/main',
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_WORKFLOW_SHA: workflowSha,
  GITHUB_WORKFLOW_REF: `${executionRepository}/${workflowPath}@refs/heads/main`,
  GITHUB_RUN_ID: '123456', GITHUB_RUN_ATTEMPT: '1', RUNNER_OS: 'Windows',
}

test('private CI requests bind immutable source and public main execution identity', () => {
  const request = requestFromEnvironment(environment)
  assert.equal(request.sourceRepository, sourceRepository)
  assert.equal(request.workflowSha, workflowSha)
  for (const values of [
    { AGENTROUTER_SOURCE_SHA: 'main' }, { AGENTROUTER_SOURCE_SHA: `${sourceSha}\n` },
    { AGENTROUTER_CI_REQUEST_ID: '../other-repo' }, { AGENTROUTER_CI_TASK: 'publish' },
    { GITHUB_REPOSITORY: sourceRepository }, { GITHUB_REF: 'refs/heads/untrusted' },
    { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_WORKFLOW_SHA: sourceSha },
    { GITHUB_WORKFLOW_REF: `${executionRepository}/.github/workflows/release.yml@refs/heads/main` },
    { RUNNER_OS: 'Linux' },
  ]) assert.throws(() => requestFromEnvironment({ ...environment, ...values }))
})

test('every task requires a main ancestor and never accepts an unmerged PR head or merge', async () => {
  const request = requestFromEnvironment(environment)
  const mainApi = async () => ({ status: 'ahead', merge_base_commit: { sha: sourceSha } })
  for (const task of ['verify', 'candidate', 'sync']) {
    assert.deepEqual(await authorizeSource({ ...request, task }, mainApi), { kind: 'main-ancestor' })
    for (const compared of [
      { status: 'diverged', merge_base_commit: { sha: 'd'.repeat(40) } },
      { status: 'behind', merge_base_commit: { sha: sourceSha } },
      { status: 'ahead', merge_base_commit: { sha: 'e'.repeat(40) } },
    ]) {
      const called = []
      await assert.rejects(authorizeSource({ ...request, task }, async path => { called.push(path); return compared }), /SOURCE_NOT_ON_MAIN/)
      assert.equal(called.length, 1)
      assert.match(called[0], /\/compare\//)
    }
  }
})

test('authenticated API requests reject redirects and unexpected repositories', async () => {
  const calls = []
  const api = githubApi('fixture-token', async (url, options) => {
    calls.push({ url, options })
    return { ok: true, status: 200, json: async () => ({ private: true }) }
  })
  await api(`/repos/${sourceRepository}`)
  assert.equal(calls[0].options.redirect, 'error')
  await assert.rejects(api('/repos/other/repository'), /UNEXPECTED_API_DESTINATION/)
  assert.equal(calls.length, 1)
})

test('builds inherit no transport credentials or public workflow command files', () => {
  const env = buildEnvironment({ ...environment, PATH: 'tools', GH_TOKEN: 'secret',
    github_token: 'case-insensitive-secret', GITHUB_OUTPUT: '/output', GITHUB_ENV: '/env',
    GITHUB_STEP_SUMMARY: '/summary', GITHUB_PATH: '/path', GITHUB_STATE: '/state',
    ACTIONS_RUNTIME_TOKEN: 'runtime', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'id-token',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_VALUE_0: 'secret' })
  assert.equal(env.PATH, 'tools')
  assert.equal(env.GITHUB_RUN_ID, environment.GITHUB_RUN_ID)
  assert.doesNotMatch(JSON.stringify(env), /secret|\/summary|\/output|runtime|id-token/)
})

test('failed child stdout and stderr are retained privately without altering the result', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentrouter-ci-output-'))
  try {
    const logPath = join(root, 'validation.log')
    const result = await runPrivate(process.execPath, ['-e', 'console.log("private-source"); console.error("private-error"); process.exit(7)'], {
      cwd: root, env: buildEnvironment(process.env), logPath,
    })
    assert.equal(result.code, 7)
    assert.match(readFileSync(logPath, 'utf8'), /private-source[\s\S]*private-error/)
    const receipt = resultReceipt(requestFromEnvironment(environment), { validationPassed: false, deliveryPassed: true, stage: 'validation-failed' })
    assert.equal(receipt.passed, false)
    await assert.rejects(runPrivate(join(root, 'does-not-exist'), [], {
      cwd: root, env: buildEnvironment(process.env), logPath,
    }), { code: 'ENOENT' })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('soft timeout terminates the private process tree and preserves a failure receipt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentrouter-ci-timeout-'))
  let descendantPid
  try {
    const logPath = join(root, 'validation.log')
    const pidPath = join(root, 'descendant.pid')
    const result = await runPrivate(process.execPath, ['-e',
      'const {spawn}=require("node:child_process"); const {writeFileSync}=require("node:fs"); const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",windowsHide:true}); writeFileSync(process.argv[1],String(child.pid)); setInterval(()=>{},1000)',
      pidPath], { cwd: root, env: buildEnvironment(process.env), logPath, timeoutMs: 700 })
    descendantPid = Number(readFileSync(pidPath, 'utf8'))
    assert.equal(result.code, 124)
    assert.equal(result.timedOut, true)
    assert.match(readFileSync(logPath, 'utf8'), /Executor timeout/)
    if (process.platform === 'win32') assert.throws(() => process.kill(descendantPid, 0), { code: 'ESRCH' })
    const receipt = resultReceipt(requestFromEnvironment(environment), {
      validationPassed: false, deliveryPassed: true, timedOut: true, stage: 'validation-timeout',
    })
    assert.equal(receipt.passed, false)
    assert.equal(receipt.timedOut, true)
    assert.equal(receipt.stage, 'validation-timeout')
  } finally {
    if (descendantPid) { try { process.kill(descendantPid, 'SIGKILL') } catch { /* Already reaped. */ } }
    rmSync(root, { recursive: true, force: true })
  }
})

test('failure evidence is uploaded only to private storage; credentials are redacted and receipt follows logs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentrouter-ci-store-'))
  try {
    const token = 'fake-fixture-credential'
    writeFileSync(join(root, 'validation.log'), `failed private source\n${token}\n`)
    const request = requestFromEnvironment(environment)
    const receipt = resultReceipt(request, { validationPassed: false, deliveryPassed: true, stage: 'validation-failed' })
    const calls = []
    const api = async (path, options) => {
      calls.push({ path, options })
      if (path === `/repos/${sourceRepository}`) return { private: true }
      if (path.includes('/releases/tags/')) return null
      if (path.endsWith('/releases')) return { id: 42, assets: [] }
      return { id: 43 }
    }
    await storeResult({ request, files: { root, receipt: join(root, 'result.json') }, receipt, token, api })
    assert.ok(calls.every(call => call.path === `/repos/${sourceRepository}` || call.path.includes(`/repos/${sourceRepository}/`)))
    assert.equal(calls[2].options.body.prerelease, true)
    assert.equal(calls[2].options.body.make_latest, 'false')
    const uploads = calls.filter(call => call.path.includes('/assets?'))
    assert.match(uploads.at(-1).path, /name=result.json$/)
    assert.doesNotMatch(uploads[0].options.body.toString(), /fake-fixture-credential/)
    const uploaded = JSON.parse(uploads.at(-1).options.body)
    assert.equal(uploaded.passed, false)
    assert.equal(uploaded.runId, request.runId)
    assert.match(uploaded.logs[0].sha256, /^[a-f0-9]{64}$/)
    await assert.rejects(storeResult({ request, files: { root }, receipt, token,
      api: async path => path === `/repos/${sourceRepository}` ? { private: true }
        : { body: JSON.stringify({ ...request, sourceSha: 'f'.repeat(40) }), prerelease: true, draft: false } }), /RESULT_TAG_COLLISION/)
    await assert.rejects(storeResult({ request, files: { root }, receipt, token,
      api: async () => ({ private: false }) }), /RESULT_REPOSITORY_MUST_BE_PRIVATE/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
