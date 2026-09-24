/**
 * One update-matrix cell on a disposable hosted Windows worker: install the REAL
 * published installer of a baseline, run it once, seed a connected session, then
 * update it to the candidate through the product's own update routes (the ones
 * the update page's buttons call) while GitHub and the mirror are served locally
 * under the cell's network mode. Asserts the installed candidate starts usable
 * and keeps the session, credential and user configuration.
 *
 *   node assembly/update-matrix/run.mjs --baseline=3.0.19 --mode=normal --candidate=3.0.20 --candidate-tag=v3.0.20 --out=<dir>
 *
 * Writes <out>/update-matrix-<baseline>-<mode>.json and exits non-zero only when
 * the cell fails its gate (a documented known failure passes the gate).
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readInstalledProductVersion } from '../coordinated/installed-version.mjs'
import { observeInstalledProcessExit } from '../coordinated/installed-process.mjs'
import { downloadVerified, releaseByTag, updateFiles } from './assets.mjs'
import { createCertificates } from './certs.mjs'
import { compareVersions, expectationFor, feedVersion, mirrorTransportSince } from './plan.mjs'
import { interceptedHosts, startInterceptor, summarizeEvents } from './server.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const adapter = resolve(here, '../coordinated')
const require = createRequire(join(adapter, 'package.json'))
const { _electron, expect } = require('@playwright/test')
const { load, dump } = require('js-yaml')

const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const baseline = option('baseline'), mode = option('mode'), candidate = option('candidate')
const candidateTag = option('candidate-tag') ?? `v${candidate}`
const out = resolve(option('out') ?? join(process.env.RUNNER_TEMP ?? '.', 'update-matrix'))
assert.match(baseline ?? '', /^\d+\.\d+\.\d+$/, '--baseline=X.Y.Z is required')
assert.match(candidate ?? '', /^\d+\.\d+\.\d+$/, '--candidate=X.Y.Z is required')
const expectation = expectationFor(baseline, mode)
assert.equal(process.platform, 'win32')
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Installing published installers requires a disposable hosted Windows worker')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted', 'Installing published installers requires a disposable hosted Windows worker')

const json = path => JSON.parse(readFileSync(path, 'utf8'))
const tryJson = path => { try { return json(path) } catch { return undefined } }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const logLine = entry => console.error(JSON.stringify({ updateMatrix: `${baseline}-${mode}`, ...entry }))
mkdirSync(out, { recursive: true })
const work = join(process.env.RUNNER_TEMP, 'agentrouter-update-matrix')
const installDir = join(work, 'installed')
const executable = join(installDir, 'AgentRouter.exe')
// The NSIS restart goes through Explorer and does not inherit a driver's
// DSH_HOME or --user-data-dir, so every launch uses the (empty) default
// locations of this disposable worker, exactly like a user's machine.
const home = join(homedir(), '.dsh')
const profile = join(home, 'profiles/desktop')
const desktopRoot = join(home, 'desktop')
const electronHome = join(process.env.APPDATA, 'AgentRouter')
const updaterCache = join(process.env.LOCALAPPDATA, '@agentrouterdesktop-updater')
const systemState = join(work, 'system-state.json')
const resultFile = join(out, `update-matrix-${baseline}-${mode}.json`)

const result = { schemaVersion: 1, kind: 'update-matrix-cell', baseline, candidate, candidateTag, mode, ...expectation,
  outcome: undefined, gatePassed: false, failedStep: undefined, error: undefined, steps: [], durations: {},
  runner: { runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT, job: process.env.GITHUB_JOB, sha: process.env.GITHUB_SHA,
    image: process.env.ImageOS, imageVersion: process.env.ImageVersion } }
const started = Date.now()
let currentStep
async function step(name, operation) {
  currentStep = name
  const begin = Date.now()
  logLine({ step: name, phase: 'started' })
  try {
    const value = await operation()
    result.steps.push({ name, ok: true, ms: Date.now() - begin })
    logLine({ step: name, phase: 'passed', ms: Date.now() - begin })
    return value
  } catch (error) {
    result.steps.push({ name, ok: false, ms: Date.now() - begin })
    logLine({ step: name, phase: 'failed', ms: Date.now() - begin, error: String(error?.stack ?? error).slice(0, 4000) })
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { updateMatrixStep: name })
  }
}
async function poll(read, accept, { timeout, interval = 1000, what }) {
  const deadline = Date.now() + timeout
  let last
  for (;;) {
    try { last = await read() } catch (error) { last = { pollError: String(error?.message ?? error) } }
    if (accept(last)) return last
    if (Date.now() > deadline) throw Object.assign(new Error(`Timed out after ${timeout} ms waiting for ${what}: ${JSON.stringify(last)?.slice(0, 2000)}`), { last })
    await sleep(interval)
  }
}

/** The app gets no runner credentials; NODE_EXTRA_CA_CERTS lets its Node fetch trust the test CA. */
function appEnvironment(ca) {
  const env = { ...process.env }
  for (const name of Object.keys(env)) {
    if (/TOKEN|SECRET|PASSWORD|API_KEY|NODE_OPTIONS|ELECTRON_RUN_AS_NODE|CODEX_HOME|^DSH_HOME$|^ACTIONS_|^(?:WIN_)?CSC_/i.test(name)) delete env[name]
  }
  return { ...env, DSH_TELEMETRY_DISABLED: '1', NODE_EXTRA_CA_CERTS: ca }
}

// Synthetic account and model gateway (same fixture as the installed acceptance).
const apiKey = 'sk-desktop-acceptance-fixture'
let modelRequests = 0
const modelInputs = []
const gateway = createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${apiKey}`) { res.writeHead(401); res.end('{}'); return }
  if (req.url === '/v1/chat/completions') {
    let body = ''; for await (const chunk of req) body += chunk
    modelInputs.push(JSON.parse(body)); modelRequests++
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ id: 'update_matrix', choices: [{ index: 0, delta: { role: 'assistant', content: 'UPDATE_MATRIX_OK' }, finish_reason: null }] })}\n\n`)
    res.end(`data: ${JSON.stringify({ id: 'update_matrix', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`)
    return
  }
  if (req.url !== '/v1/models') { res.writeHead(404); res.end('{}'); return }
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ data: [{ id: 'gpt-6-astra' }, { id: 'deepseek-flash' }] }))
})

let app, page, interceptor, certs, env
const debuggerDetach = new WeakSet()
async function launch(label, expectedVersion) {
  const begin = Date.now()
  app = await _electron.launch({ executablePath: executable, args: ['--lang=zh-CN'], env, cwd: work, timeout: 180000 })
  const launched = app
  const logFile = join(out, `electron-${label}.log`)
  for (const stream of [app.process().stdout, app.process().stderr]) stream?.on('data', bytes => {
    appendFileSync(logFile, bytes)
    if (String(bytes).includes('Waiting for the debugger to disconnect')) debuggerDetach.add(launched)
  })
  page = await app.firstWindow({ timeout: 180000 })
  // Error dialogs go to the evidence instead of stalling the worker.
  await app.evaluate(({ dialog, app }, diagnostic) => {
    const { appendFileSync } = process.getBuiltinModule('fs')
    const original = dialog.showMessageBox.bind(dialog)
    dialog.showErrorBox = (title, content) => { appendFileSync(diagnostic, `${title}: ${content}\n`); app.exit(1) }
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1)
      if (options.type !== 'error') return original(...args)
      appendFileSync(diagnostic, `${options.title}: ${options.message}\n`)
      return { response: options.cancelId ?? 1, checkboxChecked: false }
    }
  }, join(out, 'dialogs.log'))
  await page.waitForURL('dsh-app://app/index.html', { timeout: 300000 })
  await expect(page.getByRole('button', { name: '选择工作区', exact: true })).toBeVisible({ timeout: 120000 })
  const usableMs = Date.now() - begin
  const notice = page.getByRole('dialog', { name: '内测声明', exact: true })
  if (await notice.isVisible().catch(() => false)) {
    await expect(async () => {
      if (await notice.isVisible()) await notice.getByRole('button', { name: '继续', exact: true }).click()
      await expect(notice).toBeHidden({ timeout: 15000 })
    }).toPass({ timeout: 45000, intervals: [1000] })
  }
  for (const title of ['稍后配置', '稍后登录，关闭引导']) {
    const button = page.getByRole('button', { name: title, exact: true })
    if (await button.isVisible().catch(() => false)) await button.click().catch(() => {})
  }
  const facts = await app.evaluate(({ app }) => ({ version: app.getVersion(), userData: app.getPath('userData'), packaged: app.isPackaged }))
  assert.equal(facts.version, expectedVersion)
  assert.equal(resolve(facts.userData), resolve(electronHome))
  assert.equal(facts.packaged, true)
  logLine({ launched: label, version: facts.version, usableMs })
  return { usableMs }
}
async function close() {
  const current = app
  if (!current) return
  app = undefined; page = undefined
  let timer
  try {
    await Promise.race([current.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The app did not close within 20 seconds')), 20000) })])
  } catch (error) {
    // Only the known harness deadlock (Node waits for Playwright's inspector) is tolerated.
    const child = current.process()
    child.kill()
    if (!debuggerDetach.has(current)) throw error
  } finally { clearTimeout(timer) }
}
const request = (path, body) => page.evaluate(async ({ path, body }) => {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
  const text = await response.text()
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}: ${text.slice(0, 2000)}`)
  return JSON.parse(text)
}, { path, body })
const api = (path, body) => request('/api/agentrouter/v1/' + path, body)
const rpc = async (method, args) => {
  const reply = await request('/api/' + method, { type: 'client-request', rpcId: randomUUID(), method, payload: { args } })
  assert.equal(reply.result.ok, true, JSON.stringify(reply.result))
  return reply.result.value
}
const sessionStatus = async sessionId => (await rpc('session/list', { _request: {} })).items.find(item => item.sessionId === sessionId)
const powershell = (command, extraEnv = {}) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
  { encoding: 'utf8', windowsHide: true, timeout: 120000, env: { ...process.env, ...extraEnv } })
const fileHash = path => existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null

/** Main-process network view of the running app: Node fetch (the <=3.0.19 verifier) and Chromium's net.fetch. */
async function networkPreflight() {
  const probe = async url => app.evaluate(async ({ net }, url) => {
    const attempt = async fetcher => {
      try {
        const response = await fetcher(url, { headers: { 'x-update-matrix-preflight': '1' }, signal: AbortSignal.timeout(20000) })
        await response.arrayBuffer().catch(() => {})
        return { status: response.status }
      } catch (error) { return { error: String(error?.cause?.code ?? error?.cause?.message ?? error?.message ?? error).slice(0, 300) } }
    }
    return { node: await attempt(fetch), chromium: await attempt((target, init) => net.fetch(target, init)) }
  }, url)
  const github = `https://github.com/Maybank01/agentrouter-desktop-releases/releases/download/v${candidate}/latest.yml`
  const mirror = 'https://agentrouter.top/downloads/desktop/latest.yml'
  const observed = { github: await probe(github), mirror: await probe(mirror) }
  const ok = entry => entry.status === 200
  const expected = {
    normal: { github: { node: true, chromium: true }, mirror: { node: true, chromium: true } },
    faults: { github: { node: true, chromium: true }, mirror: { node: true, chromium: true } },
    'github-blocked': { github: { node: false, chromium: false }, mirror: { node: true, chromium: true } },
    'system-proxy': { github: { node: false, chromium: true }, mirror: { node: true, chromium: true } },
  }[mode]
  for (const target of ['github', 'mirror']) for (const stack of ['node', 'chromium']) {
    assert.equal(ok(observed[target][stack]), expected[target][stack],
      `Harness network check: ${stack} ${target} in ${mode} mode observed ${JSON.stringify(observed[target][stack])}`)
  }
  return observed
}

async function diagnostics() {
  const files = { 'startup.json': join(desktopRoot, 'startup.json'), 'prepared-update.json': join(desktopRoot, 'prepared-update.json'),
    'installer-prepare.json': join(desktopRoot, 'installer-prepare.json'), 'desktop-release.json': join(profile, 'desktop-release.json') }
  for (const [name, path] of Object.entries(files)) if (existsSync(path)) copyFileSync(path, join(out, `diagnostic-${name}`))
  for (const directory of [join(electronHome, 'logs'), join(updaterCache, 'pending')]) {
    if (!existsSync(directory)) continue
    for (const name of readdirSync(directory)) {
      const path = join(directory, name)
      if (statSync(path).isFile() && statSync(path).size < 4 * 1024 * 1024) copyFileSync(path, join(out, `diagnostic-${name}`))
    }
  }
  try {
    writeFileSync(join(out, 'diagnostic-windows.json'), execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      join(adapter, 'installer-diagnostics.ps1')], { encoding: 'utf8', windowsHide: true, timeout: 30000 }))
  } catch {}
  try {
    powershell(`Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b = [Windows.Forms.SystemInformation]::VirtualScreen; $i = New-Object Drawing.Bitmap $b.Width, $b.Height; $g = [Drawing.Graphics]::FromImage($i); $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $i.Size); $i.Save($env:UPDATE_MATRIX_SHOT)`,
      { UPDATE_MATRIX_SHOT: join(out, 'diagnostic-desktop.png') })
  } catch {}
}

/** Break the prepared runtime's host entry (a fresh file, never the shared pnpm store copy). */
function sabotagePreparedRuntime() {
  const modules = join(desktopRoot, 'prepared/profile/node_modules')
  if (!existsSync(join(desktopRoot, 'prepared/prepared.json')) || !existsSync(modules)) return undefined
  const entries = []
  for (const scope of readdirSync(modules).filter(name => name.startsWith('@'))) {
    for (const name of readdirSync(join(modules, scope))) {
      const manifest = tryJson(join(modules, scope, name, 'package.json'))
      if (manifest && /desktop/.test(manifest.name) && existsSync(join(modules, scope, name, 'lib/index.js'))) entries.push(join(modules, scope, name, 'lib/index.js'))
    }
  }
  assert.equal(entries.length, 1, `Expected one desktop host entry in the prepared runtime, found ${entries.join(', ') || 'none'}`)
  const entry = entries[0]
  const original = readFileSync(entry)
  rmSync(entry)
  writeFileSync(entry, `throw new Error('update-matrix: injected failure of the prepared runtime first start')\n`)
  return { entry, originalSha256: createHash('sha256').update(original).digest('hex') }
}

const cleanupProcesses = () => {
  try {
    powershell('Get-Process | Where-Object { $_.Path -eq $env:UPDATE_MATRIX_EXE } | Stop-Process -Force -ErrorAction SilentlyContinue', { UPDATE_MATRIX_EXE: executable })
  } catch {}
}

let sessionId, seededPatch, credentialHash
try {
  await step('prepare', async () => {
    for (const path of [home, electronHome, updaterCache, installDir]) assert.equal(existsSync(path), false, `The worker must be fresh: ${path} exists`)
    mkdirSync(work, { recursive: true })
    const candidateRelease = releaseByTag(candidateTag)
    const baselineRelease = releaseByTag(`v${baseline}`)
    assert.equal(baselineRelease.draft, false); assert.equal(baselineRelease.prerelease, false)
    const candidateFiles = await downloadVerified(candidateRelease, updateFiles(candidate), join(work, 'candidate'))
    assert.equal(feedVersion(readFileSync(candidateFiles.get('latest.yml').path, 'utf8')), candidate)
    const baselineFiles = await downloadVerified(baselineRelease, updateFiles(baseline), join(work, 'baseline'))
    result.installers = { baseline: { tag: baselineRelease.tag_name, sha256: baselineFiles.get(`AgentRouter-${baseline}-x64-Setup.exe`).sha256 },
      candidate: { tag: candidateRelease.tag_name, draft: candidateRelease.draft, sha256: candidateFiles.get(`AgentRouter-${candidate}-x64-Setup.exe`).sha256 } }
    // A rehearsal draft still serves under the version tag the product derives.
    const releases = new Map([[`v${candidate}`, candidateFiles], [`v${baseline}`, baselineFiles]])
    certs = createCertificates(join(work, 'certs'), interceptedHosts)
    const log = join(out, 'requests.jsonl')
    interceptor = await startInterceptor({ mode, releases, latest: `v${candidate}`, key: readFileSync(certs.key), cert: readFileSync(certs.cert),
      proxyPort: 18080, dropInstallerTransferOnce: mode === 'faults', log: entry => appendFileSync(log, JSON.stringify(entry) + '\n') })
    const setup = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'system.ps1'),
      '-Action', 'Setup', '-StateFile', systemState, '-CaFile', certs.ca, '-HostNames', interceptedHosts.join(','),
      ...(interceptor.proxyPort ? ['-ProxyServer', `127.0.0.1:${interceptor.proxyPort}`] : [])], { encoding: 'utf8', windowsHide: true, timeout: 120000 })
    result.network = { ...JSON.parse(setup.trim().split(/\r?\n/).at(-1)), hosts: interceptedHosts }
    for (const host of interceptedHosts) assert.equal((await lookup(host, { family: 4 })).address, '127.0.0.1', `${host} is not intercepted`)
    env = appEnvironment(certs.ca)
    await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve))
  })

  await step('install-baseline', async () => {
    const installer = join(work, 'baseline', `AgentRouter-${baseline}-x64-Setup.exe`)
    const begin = Date.now()
    const outcome = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$p = Start-Process -FilePath $env:UPDATE_MATRIX_INSTALLER -ArgumentList "/S", "/currentuser", "/D=$env:UPDATE_MATRIX_INSTALL_DIR" -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode'],
    { env: { ...env, UPDATE_MATRIX_INSTALLER: installer, UPDATE_MATRIX_INSTALL_DIR: installDir }, windowsHide: true, timeout: 600000, encoding: 'utf8' })
    assert.equal(outcome.status, 0, `Baseline installer failed: ${outcome.status} ${outcome.stderr}`)
    assert.ok(existsSync(executable), 'The baseline installer did not install AgentRouter.exe')
    assert.equal(readInstalledProductVersion(installDir), baseline)
    result.durations.installBaselineMs = Date.now() - begin
  })

  await step('baseline-first-launch', async () => {
    const { usableMs } = await launch('baseline-first', baseline)
    result.durations.baselineFirstLaunchMs = usableMs
    result.networkPreflight = await networkPreflight()
    await close()
  })

  await step('seed', async () => {
    const patchFile = join(profile, 'cordis.patch.yml')
    const existing = existsSync(patchFile) ? load(readFileSync(patchFile, 'utf8')) ?? [] : []
    assert.ok(Array.isArray(existing))
    const origin = `http://127.0.0.1:${gateway.address().port}`
    seededPatch = dump([...existing, { id: 'agentrouter-auth', config: { environment: { id: 'loopback-test', loopbackControlOrigin: origin, loopbackModelApiOrigin: origin + '/v1' } } },
      { id: 'agentrouter-plugin-updates', config: { automatic: false } }])
    writeFileSync(patchFile, seededPatch)
    await launch('baseline-seed', baseline)
    assert.equal((await api('connect', { apiKey })).connected, true)
    const session = await rpc('session/create', { request: { cwd: work } })
    sessionId = session.sessionId
    assert.ok(sessionId)
    await rpc('session/selectModel', { request: { sessionId, provider: 'agentrouter-deepseek', model: 'deepseek-flash' } })
    await rpc('session/prompt', { request: { requestId: randomUUID(), sessionId, mode: 'queue',
      content: [{ type: 'text', text: 'Remember this conversation across a product update.' }] } })
    await poll(() => sessionStatus(sessionId), status => modelRequests > 0 && status?.running === false, { timeout: 60000, what: 'the seeded conversation' })
    credentialHash = fileHash(join(home, '.credentials.yaml'))
    result.seed = { sessionId, credentialFile: credentialHash !== null, modelRequests }
  })

  await step('check', async () => {
    await api('updates/check', {})
    const status = await poll(() => api('updates/status'), s => ['available', 'current', 'error'].includes(s.phase), { timeout: 180000, what: 'the update check' })
    result.checkStatus = { phase: status.phase, error: status.error, latestVersion: status.product?.latestVersion }
    assert.equal(status.phase, 'available', `The update check ended in ${status.phase}: ${status.error ?? ''}`)
    assert.equal(status.product.version, baseline)
    assert.equal(status.product.latestVersion, candidate)
  })

  await step('download', async () => {
    const begin = Date.now()
    const download = async () => {
      await api('updates/download', { version: candidate })
      return poll(() => api('updates/status'), s => ['ready', 'error'].includes(s.phase), { timeout: 720000, interval: 2000, what: 'the update download' })
    }
    let status = await download()
    if (status.phase === 'error' && mode === 'faults' && compareVersions(baseline, mirrorTransportSince) < 0) {
      // Releases before the resumable transport surface a dropped transfer as an
      // error; the user continues the download, which must then complete.
      result.interruptionRetry = { firstError: status.error, userRetryRequired: true }
      if (!status.canDownload) {
        await api('updates/check', {})
        await poll(() => api('updates/status'), s => ['available', 'error'].includes(s.phase), { timeout: 180000, what: 'the check before retrying' })
      }
      status = await download()
    }
    result.downloadStatus = { phase: status.phase, error: status.error, preparation: status.preparation, canInstall: status.canInstall }
    assert.equal(status.phase, 'ready', `The update download ended in ${status.phase}: ${status.error ?? ''}`)
    assert.equal(status.canInstall, true)
    result.durations.downloadMs = Date.now() - begin
  })

  if (mode === 'faults') {
    await step('inject-activation-failure', async () => {
      const preparation = (await api('updates/status')).preparation
      const sabotage = preparation?.outcome === 'prepared' ? sabotagePreparedRuntime() : undefined
      if (preparation?.outcome === 'prepared') assert.ok(sabotage, 'The baseline reported a prepared runtime but no prepared slot exists')
      result.rollback = sabotage ? { applicable: true, ...sabotage }
        : { applicable: false, reason: `The baseline did not prepare the next runtime (preparation: ${preparation?.outcome ?? 'unsupported before 3.0.20'})` }
    })
  }

  let restartBegin
  await step('install', async () => {
    const pid = await app.evaluate(() => process.pid)
    const observer = await observeInstalledProcessExit(pid, executable, 120000)
    restartBegin = Date.now()
    let processExit
    try {
      try { await api('updates/install', { version: candidate, interrupt: false }) }
      catch (error) { logLine({ installRequest: 'interrupted by the quitting app', error: String(error?.message ?? error).slice(0, 300) }) }
      processExit = await observer.exited
    } finally { observer.cancel() }
    app = undefined; page = undefined
    result.processExit = processExit
    await poll(() => readInstalledProductVersion(installDir), version => version === candidate, { timeout: 300000, interval: 2000, what: 'the installer to replace the app' })
    result.durations.installMs = Date.now() - restartBegin
  })

  await step('restart', async () => {
    const startup = await poll(() => json(join(desktopRoot, 'startup.json')), s => s?.productVersion === candidate && s.ready === true,
      { timeout: 300000, interval: 2000, what: 'the restarted candidate to become ready' })
    await poll(() => json(join(profile, 'desktop-release.json')).productVersion, version => version === candidate, { timeout: 60000, what: 'the activated profile' })
    result.restartStartup = startup
    result.durations.restartToReadyMs = Date.now() - restartBegin
    const count = () => Number(powershell('@(Get-Process | Where-Object { $_.Path -eq $env:UPDATE_MATRIX_EXE -and $_.MainWindowHandle -ne 0 }).Count', { UPDATE_MATRIX_EXE: executable }).trim())
    await poll(count, value => value > 0, { timeout: 90000, what: 'the restarted window' })
    powershell('$p = @(Get-Process | Where-Object { $_.Path -eq $env:UPDATE_MATRIX_EXE -and $_.MainWindowHandle -ne 0 }); foreach ($a in $p) { if (!$a.CloseMainWindow() -or !$a.WaitForExit(20000)) { throw "The restarted app did not close" } }',
      { UPDATE_MATRIX_EXE: executable })
    await poll(() => Number(powershell('@(Get-Process | Where-Object { $_.Path -eq $env:UPDATE_MATRIX_EXE }).Count', { UPDATE_MATRIX_EXE: executable }).trim()),
      value => value === 0, { timeout: 30000, what: 'the restarted app to exit' })
  })

  await step('relaunch', async () => {
    const { usableMs } = await launch('candidate', candidate)
    result.durations.candidateLaunchMs = usableMs
  })

  await step('retention', async () => {
    assert.equal((await api('status')).connected, true, 'The credential must survive the update')
    assert.ok(existsSync(join(home, '.credentials.yaml')), 'The credential file must survive the update')
    const restored = await sessionStatus(sessionId)
    assert.ok(restored && !restored.blank, 'The seeded conversation must survive the update')
    assert.equal(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8'), seededPatch, 'User configuration must survive the update')
    const before = modelRequests
    await rpc('session/prompt', { request: { requestId: randomUUID(), sessionId, mode: 'queue',
      content: [{ type: 'text', text: 'Continue the same conversation after the update.' }] } })
    await poll(() => sessionStatus(sessionId), status => modelRequests > before && status?.running === false, { timeout: 60000, what: 'the continued conversation' })
    assert.ok(modelInputs.slice(before).some(input => {
      const history = JSON.stringify(input.messages)
      return history.includes('Remember this conversation across a product update.') && history.includes('Continue the same conversation after the update.')
    }), 'The post-update request must carry the old conversation')
    const updates = await api('updates/status')
    assert.equal(updates.product.version, candidate)
    result.retention = { connected: true, sessionRetained: true, conversationContinued: true, configRetained: true,
      credentialFileUnchanged: fileHash(join(home, '.credentials.yaml')) === credentialHash, updatePhaseAfter: updates.phase }
    await close()
  })

  if (mode === 'faults') {
    await step('verify-faults', async () => {
      const summary = summarizeEvents(interceptor.events)
      assert.equal(summary.faults.length, 1, 'One installer transfer must have been interrupted')
      result.interruption = { ...summary.faults[0], updateCompleted: true, userRetryRequired: Boolean(result.interruptionRetry) }
      if (compareVersions(baseline, mirrorTransportSince) >= 0) assert.equal(result.interruptionRetry, undefined, 'The resumable transport must complete without a user retry')
      if (result.rollback.applicable) {
        const startup = result.restartStartup
        assert.ok(startup.preparedFallback, 'The failed prepared runtime must fall back to the previous profile')
        assert.ok(startup.events?.some(event => event.stage === 'prepared-fallback'))
        Object.assign(result.rollback, { preparedFallback: startup.preparedFallback, restoredAndRebuilt: true, endedUsable: true })
      }
    })
  }
  result.outcome = expectation.expected === 'known-failure' ? 'unexpected-pass' : 'pass'
} catch (error) {
  const failedStep = error.updateMatrixStep ?? currentStep
  result.failedStep = failedStep
  result.error = String(error?.message ?? error).slice(0, 4000)
  const matchesKnown = expectation.expected === 'known-failure' && expectation.knownFailureSteps.includes(failedStep)
  if (matchesKnown) {
    // The documented failure must leave the old installation intact and running.
    try {
      await step('intact-after-known-failure', async () => {
        assert.equal(readInstalledProductVersion(installDir), baseline)
        const status = await api('updates/status')
        assert.equal(status.product.version, baseline)
        result.knownFailure = { step: failedStep, phase: status.phase, message: status.error,
          evidence: summarizeEvents(interceptor.events).resets }
      })
      knownFailure = true
      result.outcome = 'known-failure'
    } catch (intact) {
      result.failedStep = 'intact-after-known-failure'
      result.error = `${result.error}; then: ${String(intact?.message ?? intact).slice(0, 2000)}`
      result.outcome = 'FAIL'
    }
  } else result.outcome = 'FAIL'
  if (result.outcome === 'FAIL') await diagnostics()
} finally {
  try { if (app) await close() } catch {}
  cleanupProcesses()
  result.durations.totalMs = Date.now() - started
  if (interceptor) {
    result.requestLog = summarizeEvents(interceptor.events)
    writeFileSync(join(out, 'requests.json'), JSON.stringify(interceptor.events, null, 1))
    await interceptor.close().catch(() => {})
  }
  gateway.closeAllConnections?.(); gateway.close()
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'system.ps1'),
      '-Action', 'Restore', '-StateFile', systemState], { encoding: 'utf8', windowsHide: true, timeout: 120000 })
  } catch (error) { result.restoreError = String(error?.message ?? error).slice(0, 1000) }
  result.gatePassed = result.outcome === 'pass' || result.outcome === 'known-failure' || result.outcome === 'unexpected-pass'
  writeFileSync(resultFile, JSON.stringify(result, null, 2) + '\n')
  logLine({ outcome: result.outcome, failedStep: result.failedStep, gatePassed: result.gatePassed, totalMs: result.durations.totalMs })
  console.log(JSON.stringify({ result: resultFile, outcome: result.outcome, gatePassed: result.gatePassed }))
  process.exitCode = result.gatePassed ? 0 : 1
  setTimeout(() => process.exit(), 10000).unref()
}
