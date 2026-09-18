import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const sourceRepository = 'Maybank01/agentrouter-dsh-plugins'
export const executionRepository = 'Maybank01/agentrouter-desktop-releases'
export const workflowPath = '.github/workflows/plugin-validation.yml'
const tasks = new Set(['verify', 'candidate', 'sync'])
const shaPattern = /^[a-f0-9]{40}$/

function requireValue(condition, code) {
  if (!condition) throw new Error(code)
}

export function requestFromEnvironment(env) {
  requireValue(tasks.has(env.AGENTROUTER_CI_TASK), 'INVALID_TASK')
  requireValue(shaPattern.test(env.AGENTROUTER_SOURCE_SHA ?? ''), 'INVALID_SOURCE_SHA')
  requireValue(/^[a-z0-9][a-z0-9-]{5,79}$/.test(env.AGENTROUTER_CI_REQUEST_ID ?? ''), 'INVALID_REQUEST_ID')
  requireValue(env.GITHUB_REPOSITORY === executionRepository, 'INVALID_EXECUTOR')
  requireValue(env.GITHUB_REF === 'refs/heads/main', 'INVALID_EXECUTOR_REF')
  requireValue(env.GITHUB_EVENT_NAME === 'workflow_dispatch', 'INVALID_EXECUTOR_EVENT')
  requireValue(env.GITHUB_WORKFLOW_REF === `${executionRepository}/${workflowPath}@refs/heads/main`, 'INVALID_EXECUTOR_WORKFLOW')
  requireValue(shaPattern.test(env.AGENTROUTER_EXECUTOR_WORKFLOW_SHA ?? ''), 'INVALID_WORKFLOW_SHA')
  requireValue(env.GITHUB_WORKFLOW_SHA === env.AGENTROUTER_EXECUTOR_WORKFLOW_SHA, 'WORKFLOW_SHA_MISMATCH')
  requireValue(/^\d+$/.test(env.GITHUB_RUN_ID ?? '') && /^\d+$/.test(env.GITHUB_RUN_ATTEMPT ?? ''), 'INVALID_EXECUTOR_RUN')
  requireValue(env.RUNNER_OS === 'Windows', 'INVALID_RUNNER_OS')
  return {
    schemaVersion: 1,
    sourceRepository,
    sourceSha: env.AGENTROUTER_SOURCE_SHA,
    executionRepository,
    workflowPath,
    workflowSha: env.AGENTROUTER_EXECUTOR_WORKFLOW_SHA,
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
    task: env.AGENTROUTER_CI_TASK,
    requestId: env.AGENTROUTER_CI_REQUEST_ID,
  }
}

export async function authorizeSource(request, api) {
  const compared = await api(`/repos/${sourceRepository}/compare/${request.sourceSha}...main`)
  requireValue(['ahead', 'identical'].includes(compared.status)
    && compared.merge_base_commit?.sha === request.sourceSha, 'SOURCE_NOT_ON_MAIN')
  return { kind: 'main-ancestor' }
}

// Subprocesses cannot send workflow commands through command files or inherit
// tokens used to fetch source, upload evidence, or access Actions services.
export function buildEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => {
    const upper = key.toUpperCase()
    return !['GH_TOKEN', 'GITHUB_TOKEN', 'GITHUB_ENV', 'GITHUB_OUTPUT', 'GITHUB_PATH',
      'GITHUB_STEP_SUMMARY', 'GITHUB_STATE', 'ACTIONS_RUNTIME_TOKEN',
      'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL'].includes(upper)
      && !upper.startsWith('GIT_CONFIG_')
  }))
}

function terminateTree(child, descriptor) {
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
    return Promise.resolve()
  }
  return new Promise(done => {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: ['ignore', descriptor, descriptor], windowsHide: true,
    })
    let settled = false
    const finished = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill('SIGKILL')
      done()
    }
    const timer = setTimeout(() => { killer.kill('SIGKILL'); finished() }, 20_000)
    killer.once('error', finished)
    killer.once('exit', finished)
  })
}

export function runPrivate(command, args, { cwd, env, logPath, timeoutMs = 10 * 60_000 }) {
  return new Promise((done, reject) => {
    const descriptor = openSync(logPath, 'a')
    let child
    let settled = false
    let timedOut = false
    let timer
    let killFallback
    let termination
    const finish = (error, result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killFallback)
      closeSync(descriptor)
      if (error) reject(error)
      else done({ ...result, ...(timedOut ? { code: 124, timedOut: true } : {}) })
    }
    try {
      child = spawn(command, args, { cwd, env, stdio: ['ignore', descriptor, descriptor],
        detached: process.platform !== 'win32', windowsHide: true })
    } catch (error) {
      finish(error)
      return
    }
    child.once('error', error => finish(error))
    child.once('exit', (code, signal) => {
      if (termination) termination.then(() => finish(null, { code, signal }))
      else finish(null, { code, signal })
    })
    timer = setTimeout(() => {
      timedOut = true
      appendFileSync(logPath, '\nExecutor timeout: terminating the private task process tree.\n')
      termination = terminateTree(child, descriptor)
      termination.then(() => {
        if (!settled) killFallback = setTimeout(() => finish(null, { code: 124, signal: 'SIGKILL' }), 5_000)
      })
    }, timeoutMs)
  })
}

function paths(env) {
  requireValue(env.RUNNER_TEMP, 'MISSING_RUNNER_TEMP')
  const root = resolve(env.RUNNER_TEMP, 'agentrouter-plugin-ci')
  mkdirSync(root, { recursive: true })
  return { root, source: join(root, 'source'), state: join(root, 'state.json'), receipt: join(root, 'result.json') }
}

function saveState(file, state) {
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`)
}

function loadState(file, request) {
  const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { ...request, passed: false, stage: 'prepare' }
  for (const [key, value] of Object.entries(request)) requireValue(state[key] === value, 'STATE_IDENTITY_MISMATCH')
  return state
}

export function githubApi(token, transport = fetch) {
  requireValue(typeof token === 'string' && token.length > 0, 'MISSING_CI_CREDENTIAL')
  return async (path, { method = 'GET', body, binary = false, allowMissing = false } = {}) => {
    requireValue(path === `/repos/${sourceRepository}` || path.startsWith(`/repos/${sourceRepository}/`) || path.startsWith(`https://uploads.github.com/repos/${sourceRepository}/`), 'UNEXPECTED_API_DESTINATION')
    const response = await transport(path.startsWith('https:') ? path : `https://api.github.com${path}`, {
      method,
      redirect: 'error',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(body ? { 'content-type': binary ? 'application/octet-stream' : 'application/json' } : {}),
      },
      body: body ? binary ? body : JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(120_000),
    })
    if (allowMissing && response.status === 404) return null
    requireValue(response.ok, `GITHUB_API_${response.status}`)
    return response.status === 204 ? null : response.json()
  }
}

export async function prepare(env) {
  const request = requestFromEnvironment(env)
  const files = paths(env)
  const state = { ...request, passed: false, stage: 'prepare', startedAt: new Date().toISOString() }
  saveState(files.state, state)
  const api = githubApi(env.GH_TOKEN)
  requireValue((await api(`/repos/${sourceRepository}`)).private === true, 'SOURCE_REPOSITORY_MUST_BE_PRIVATE')
  state.sourceAuthorization = await authorizeSource(request, api)
  requireValue(!existsSync(files.source), 'SOURCE_ALREADY_EXISTS')
  mkdirSync(files.source)
  const logPath = join(files.root, 'prepare.log')
  const gitEnv = {
    ...buildEnvironment(env),
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${env.GH_TOKEN}`).toString('base64')}`,
  }
  for (const args of [
    ['init', '--quiet'],
    ['remote', 'add', 'origin', `https://github.com/${sourceRepository}.git`],
    ['fetch', '--quiet', '--no-tags', '--depth=1', 'origin', 'refs/heads/main:refs/remotes/origin/main'],
    ['fetch', '--quiet', '--no-tags', '--depth=1', 'origin', request.sourceSha],
    ['checkout', '--quiet', '--detach', request.sourceSha],
  ]) {
    const result = await runPrivate('git', args, { cwd: files.source, env: gitEnv, logPath })
    requireValue(result.code === 0, 'PRIVATE_CHECKOUT_FAILED')
  }
  state.stage = 'ready'
  saveState(files.state, state)
}

export async function execute(env) {
  const request = requestFromEnvironment(env)
  const files = paths(env)
  const state = loadState(files.state, request)
  requireValue(state.stage === 'ready', 'SOURCE_NOT_PREPARED')
  state.stage = 'validation'
  saveState(files.state, state)
  const result = await runPrivate(process.execPath, ['scripts/public-client-task.mjs', request.task], {
    cwd: files.source, env: buildEnvironment(env), logPath: join(files.root, 'validation.log'),
    timeoutMs: 75 * 60_000,
  })
  state.validationPassed = result.code === 0
  state.exitCode = result.code
  state.signal = result.signal
  state.timedOut = result.timedOut === true
  state.stage = result.timedOut ? 'validation-timeout' : result.code === 0 ? 'validated' : 'validation-failed'
  saveState(files.state, state)
  requireValue(state.validationPassed, 'PRIVATE_VALIDATION_FAILED')
}

export function resultReceipt(request, state) {
  return {
    ...request,
    passed: state.validationPassed === true && state.deliveryPassed === true,
    stage: state.stage,
    validationPassed: state.validationPassed === true,
    deliveryPassed: state.deliveryPassed === true,
    timedOut: state.timedOut === true,
    ...(state.startedAt ? { startedAt: state.startedAt } : {}),
    finishedAt: new Date().toISOString(),
    ...(state.sourceAuthorization ? { sourceAuthorization: state.sourceAuthorization } : {}),
    ...(state.candidateTag ? { candidateTag: state.candidateTag } : {}),
    ...(state.package ? { package: state.package } : {}),
  }
}

function redactCredential(bytes, token) {
  let content = bytes.toString('utf8')
  for (const value of [token, Buffer.from(`x-access-token:${token}`).toString('base64')]) {
    content = content.split(value).join('[REDACTED]')
  }
  return Buffer.from(content)
}

export async function storeResult({ request, files, receipt, token, api }) {
  requireValue((await api(`/repos/${sourceRepository}`)).private === true, 'RESULT_REPOSITORY_MUST_BE_PRIVATE')
  const tag = `client-ci-${request.requestId}`
  let release = await api(`/repos/${sourceRepository}/releases/tags/${tag}`, { allowMissing: true })
  if (release) {
    let prior
    try { prior = JSON.parse(release.body) } catch { throw new Error('RESULT_TAG_COLLISION') }
    for (const key of ['sourceRepository', 'sourceSha', 'executionRepository', 'workflowPath', 'workflowSha', 'runId', 'task', 'requestId']) {
      requireValue(prior[key] === request[key], 'RESULT_TAG_COLLISION')
    }
    requireValue(release.prerelease && !release.draft, 'INVALID_RESULT_RELEASE')
  } else {
    release = await api(`/repos/${sourceRepository}/releases`, { method: 'POST', body: {
      tag_name: tag, target_commitish: request.sourceSha,
      name: `Private client CI ${request.requestId}`, body: JSON.stringify(request),
      prerelease: true, draft: false, make_latest: 'false',
    } })
  }
  // Result JSON is uploaded last: a consumer cannot mistake partial evidence
  // transport for a complete result. Failed runs retain their private logs too.
  const payloads = ['prepare.log', 'validation.log', 'delivery.log', 'executor.log']
    .filter(name => existsSync(join(files.root, name)))
    .map(name => ({ name, bytes: redactCredential(readFileSync(join(files.root, name)), token) }))
  receipt.logs = payloads.map(({ name, bytes }) => ({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }))
  writeFileSync(files.receipt, `${JSON.stringify(receipt, null, 2)}\n`)
  payloads.push({ name: 'result.json', bytes: readFileSync(files.receipt) })
  for (const { name, bytes } of payloads) {
    const existing = release.assets?.find(asset => asset.name === name)
    if (existing) await api(`/repos/${sourceRepository}/releases/assets/${existing.id}`, { method: 'DELETE' })
    await api(`https://uploads.github.com/repos/${sourceRepository}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, {
      method: 'POST', body: bytes, binary: true,
    })
  }
  return tag
}

export async function finalize(env) {
  const request = requestFromEnvironment(env)
  const files = paths(env)
  const state = loadState(files.state, request)
  const api = githubApi(env.GH_TOKEN)
  state.deliveryPassed = true
  const deliveryEnv = { ...buildEnvironment(env), GH_TOKEN: env.GH_TOKEN }
  const logPath = join(files.root, 'delivery.log')
  try {
    if (request.task === 'candidate' && state.validationPassed) {
      const result = await runPrivate(process.execPath, ['scripts/store-client-candidate.mjs'], { cwd: files.source, env: deliveryEnv, logPath })
      state.deliveryPassed = result.code === 0
      if (state.deliveryPassed) {
        const lines = readFileSync(logPath, 'utf8').trim().split(/\r?\n/)
        let stored
        try { stored = JSON.parse(lines.at(-1)) } catch { /* Never expose captured output. */ }
        const candidateTag = stored?.candidateTag ?? stored?.tag
        state.deliveryPassed = typeof candidateTag === 'string' && /^codex-candidate-[a-z0-9-]+$/.test(candidateTag)
        if (state.deliveryPassed) {
          requireValue(stored.package?.name === '@agentrouter-top/dsh-codex'
            && /^[a-f0-9]{64}$/.test(stored.package.sha256 ?? '')
            && Number.isSafeInteger(stored.package.size) && stored.package.size > 0, 'INVALID_CANDIDATE_PACKAGE')
          state.candidateTag = candidateTag
          state.package = stored.package
        }
      }
    } else if (request.task === 'sync' && existsSync(join(files.source, '.local/public-ci/sync.json'))) {
      const result = await runPrivate(process.execPath, ['scripts/public-client-task.mjs', 'sync-publish'], {
        cwd: files.source, env: deliveryEnv, logPath,
      })
      state.deliveryPassed = result.code === 0
    }
  } catch (error) {
    state.deliveryPassed = false
    appendFileSync(logPath, `${error.stack ?? error}\n`)
  }
  state.stage = !state.validationPassed ? state.stage : state.deliveryPassed ? 'completed' : 'delivery-failed'
  saveState(files.state, state)
  const receipt = resultReceipt(request, state)
  await storeResult({ request, files, receipt, token: env.GH_TOKEN, api })
  requireValue(receipt.passed, 'PRIVATE_TASK_FAILED')
}

async function main() {
  const action = process.argv[2]
  const operation = { prepare, execute, finalize }[action]
  if (!operation) throw new Error('INVALID_EXECUTOR_STAGE')
  process.stdout.write(`AgentRouter private validation: ${action} started.\n`)
  try {
    await operation(process.env)
    process.stdout.write(`AgentRouter private validation: ${action} completed.\n`)
  } catch (error) {
    try {
      requestFromEnvironment(process.env)
      appendFileSync(join(paths(process.env).root, 'executor.log'), `${action}: ${error.stack ?? error}\n`)
    } catch { /* Invalid requests cannot choose a destination or disclose data. */ }
    // All private command output stays in the private evidence release. Do not
    // expose exception messages, source snippets, API bodies, or stack traces.
    process.stderr.write(`AgentRouter private validation: ${action} failed; inspect the private CI evidence or credential configuration.\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
