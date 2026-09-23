/** Real Electron and offline profile installation; synthetic account only. */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { load, dump } from 'js-yaml'
import { _electron, expect } from '@playwright/test'
import { directory, root } from './prepare.mjs'
import { assertExternalWebNavigation } from './external-navigation-acceptance.mjs'
import { assertCredentialRecovery } from './credential-recovery-acceptance.mjs'
import { assertRuntimeRecovery } from './runtime-recovery-acceptance.mjs'
import { readInstalledProductVersion } from './installed-version.mjs'

const json = path => JSON.parse(readFileSync(path, 'utf8'))
const legacyExecutable = process.argv.find(value => value.startsWith('--legacy-executable='))?.slice('--legacy-executable='.length)
const first = json(resolve(process.argv[2]))
const baseline = legacyExecutable ? { executable: resolve(legacyExecutable), legacy: true,
  input: { productVersion: '2.0.5', dshVersion: '0.1.2-rc.1', plugin: { version: '0.1.0-beta.23' } } } : first
const candidate = legacyExecutable ? first : process.argv[3] && !process.argv[3].startsWith('--') ? json(resolve(process.argv[3])) : undefined
const migratePnpm10 = process.argv.includes('--pnpm10')
const nativeUpdate = process.argv.includes('--native-update')
if (nativeUpdate) {
  assert.equal(process.platform, 'win32')
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Installer acceptance requires a disposable hosted Windows runner')
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
  assert.ok(candidate && !legacyExecutable)
  assert.equal(candidate.executable, baseline.executable)
  assert.ok(resolve(baseline.executable).startsWith(resolve(process.env.RUNNER_TEMP) + sep))
}
assert.ok(!migratePnpm10 || candidate, '--pnpm10 requires a baseline and target candidate')
const stateRoot = join(root, '.local/coordinated/acceptance')
mkdirSync(stateRoot, { recursive: true })
const state = mkdtempSync(join(stateRoot, 'run-'))
const home = nativeUpdate ? join(homedir(), '.dsh') : join(state, 'home')
const electronHome = nativeUpdate ? join(process.env.APPDATA, 'AgentRouter') : join(state, 'electron')
if (nativeUpdate) {
  // NSIS starts the updated app through Explorer, which does not inherit the
  // driver's DSH_HOME or --user-data-dir. Give this disposable worker's empty
  // default locations isolated targets so both launches use the same data.
  // Never replace an existing Home, and never create these aliases locally.
  for (const [location, target] of [[home, join(state, 'home')], [electronHome, join(state, 'electron')]]) {
    assert.equal(existsSync(location), false, `Installer acceptance requires an empty worker profile: ${location}`)
    mkdirSync(target, { recursive: true })
    mkdirSync(dirname(location), { recursive: true })
    symlinkSync(target, location, 'junction')
  }
}
const env = { ...process.env }
for (const name of Object.keys(env)) if (/API_KEY|CODEX_HOME|RELAY_CODEX|NODE_OPTIONS|NODE_AUTH_TOKEN|NPM_TOKEN|^(?:WIN_)?CSC_/i.test(name)
  || /^(?:GH_TOKEN|GITHUB_TOKEN|DSH_DESKTOP_WINDOWS_)/i.test(name)
  || ['dsh_home', 'npm_config_userconfig', 'electron_run_as_node'].includes(name.toLowerCase())) delete env[name]
Object.assign(env, { ...(!nativeUpdate ? { DSH_HOME: home } : {}), DSH_TELEMETRY_DISABLED: '1',
  DSH_DESKTOP_DIAGNOSTIC_FILE: join(state, 'startup-error.log') })
if (legacyExecutable) env.DEEPSEEK_API_KEY = 'sk-desktop-acceptance-fixture'
let modelRequests = 0
const modelInputs = []
const gateway = createServer(async (req, res) => {
  if (req.headers.authorization !== 'Bearer sk-desktop-acceptance-fixture') { res.writeHead(401); res.end('{}'); return }
  if (req.url === '/v1/chat/completions') {
    let body = ''; for await (const chunk of req) body += chunk
    const input = JSON.parse(body)
    assert.equal(input.model, 'deepseek-flash')
    modelInputs.push(input)
    modelRequests++
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ id: 'desktop_acceptance', choices: [{ index: 0, delta: { role: 'assistant', content: 'DESKTOP_MIGRATION_OK' }, finish_reason: null }] })}\n\n`)
    res.end(`data: ${JSON.stringify({ id: 'desktop_acceptance', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`)
    return
  }
  if (req.url !== '/v1/models') { res.writeHead(404); res.end('{}'); return }
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ data: [{ id: 'gpt-6-astra' }, { id: 'deepseek-flash' }] }))
})
await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${gateway.address().port}`
let app, page
const launches = []
let nativeUpdateMetrics
let unrelatedProcess
let externalBrowserNavigation = false
const launch = async receipt => {
  const started = Date.now()
  console.log(JSON.stringify({ phase: 'launching', productVersion: receipt.input.productVersion }))
  app = await _electron.launch({ executablePath: receipt.executable,
    args: ['--lang=zh-CN', ...(!nativeUpdate ? [`--user-data-dir=${electronHome}`] : [])], cwd: state, env, timeout: 180000 })
  app.process().stderr.on('data', bytes => writeFileSync(join(state, 'electron.log'), bytes, { flag: 'a' }))
  // The preceding Electron 43 host must finish initializing its main process
  // before Playwright evaluates Electron's module handle.
  page = await app.firstWindow({ timeout: 180000 })
  // Test failures belong in the isolated diagnostics, not in native dialogs on
  // the developer's desktop or dialogs that stall a disposable CI worker.
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
  }, join(state, 'startup-error.log'))
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  if (receipt.legacy) {
    const deadline = Date.now() + 180000
    let found = false
    while (Date.now() < deadline && !found) {
      for (const window of app.windows()) {
        if (window.url().includes('setup-wizard.html')) {
          const skip = window.getByRole('button', { name: /^(Skip setup|跳过设置|确认跳过)$/ }).first()
          if (await skip.isVisible()) await skip.click()
        } else if (/^http:\/\/127\.0\.0\.1/.test(window.url())) {
          page = window; found = true; break
        }
      }
      if (!found) await new Promise(resolve => setTimeout(resolve, 250))
    }
    assert.ok(found, 'The preceding public Desktop must boot its real Web carrier.')
  } else {
    await page.waitForURL('dsh-app://app/index.html', { timeout: 180000 })
    if (receipt.input.productVersion === candidate?.input.productVersion) {
      await expect.poll(() => json(join(home, 'desktop/startup.json')).ready, { timeout: 10000 }).toBe(true)
      const startup = json(join(home, 'desktop/startup.json'))
      assert.ok(Number.isFinite(startup.maxMainThreadDelayMs) && startup.maxMainThreadDelayMs < 5000,
        `Startup must keep the native window responsive, longest stall: ${startup.maxMainThreadDelayMs} ms`)
      console.log(JSON.stringify({ phase: 'startup-responsive', startup }))
    }
  }
  await expect(page.getByRole('button', { name: '选择工作区', exact: true })).toBeVisible({ timeout: 90000 })
  const notice = page.getByRole('dialog', { name: '内测声明', exact: true })
  if (await notice.isVisible()) {
    // The preceding Desktop can reload its profile while saving first-run
    // settings. Retry only this idempotent acknowledgement and require the real
    // modal to close, instead of assuming a cold worker settles within 5 seconds.
    await expect(async () => {
      if (await notice.isVisible()) await notice.getByRole('button', { name: '继续', exact: true }).click()
      await expect(notice).toBeHidden({ timeout: 15000 })
    }).toPass({ timeout: 45000, intervals: [1000] })
  }
  for (const title of ['稍后配置', '稍后登录，关闭引导']) {
    const button = page.getByRole('button', { name: title, exact: true })
    if (await button.isVisible()) await button.click()
  }
  const facts = await app.evaluate(({ app }) => ({ version: app.getVersion(), userData: app.getPath('userData'), packaged: app.isPackaged }))
  assert.equal(facts.version, receipt.input.productVersion)
  assert.equal(resolve(facts.userData), resolve(electronHome))
  assert.equal(facts.packaged, true)
  assert.deepEqual(errors, [])
  if (!receipt.legacy) {
    const window = await app.browserWindow(page)
    const title = () => window.evaluate(window => window.getTitle())
    await expect.poll(title).toMatch(/AgentRouter$/)
    const originalTitle = await page.title()
    const originalWindowTitle = await title()
    await page.evaluate(() => { document.title = 'Native appearance acceptance — DeepSeek Harness' })
    await expect.poll(title).toBe('Native appearance acceptance — AgentRouter')
    await page.evaluate(value => { document.title = value }, originalTitle)
    await expect.poll(title).toBe(originalWindowTitle)
    if (process.platform === 'win32') {
      const pressAlt = () => window.evaluate(window => {
        window.focus()
        window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Alt' })
        window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Alt' })
      })
      assert.equal(await window.evaluate(window => window.isMenuBarVisible()), false)
      await pressAlt()
      await expect.poll(() => window.evaluate(window => window.isMenuBarVisible())).toBe(true)
      await pressAlt()
      await expect.poll(() => window.evaluate(window => window.isMenuBarVisible())).toBe(false)
      if (existsSync(join(dirname(receipt.executable), 'resources/app.asar'))) {
        execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File',
          join(directory, 'verify-native-icon.ps1'), '-Executable', receipt.executable,
          '-ExpectedIcon', join(directory, 'agentrouter-icon.ico')], { windowsHide: true, timeout: 30000 })
      }
    }
  }
  let startup
  if (!receipt.legacy && existsSync(join(home, 'desktop/startup.json'))) {
    await expect.poll(() => { try { return json(join(home, 'desktop/startup.json')).ready } catch { return false } }, { timeout: 15000 }).toBe(true)
    startup = json(join(home, 'desktop/startup.json'))
    assert.ok(startup.visibleMs < 10000, 'Show startup progress within ten seconds')
  }
  launches.push({ productVersion: receipt.input.productVersion, durationMs: Date.now() - started, startup })
  if (!receipt.legacy && (!candidate || receipt === candidate)) {
    await assertExternalWebNavigation(app, page)
    externalBrowserNavigation = true
  }
  console.log(JSON.stringify({ phase: 'ready', ...launches.at(-1) }))
}
const close = async () => {
  const current = app
  if (!current) return
  let timeout
  try {
    await Promise.race([current.close(), new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('The isolated client did not close within 20 seconds')), 20000)
    })])
    app = undefined
  } finally { clearTimeout(timeout) }
}
const request = (path, body) => page.evaluate(async ({ path, body }) => {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}: ${(await response.text()).slice(0, 2000)}`)
  return response.json()
}, { path, body })
const api = (path, body) => request('/api/agentrouter/v1/' + path, body)
const rpc = async (method, args) => {
  const result = await request('/api/' + method, { type: 'client-request', rpcId: randomUUID(), method, payload: { args } })
  assert.equal(result.result.ok, true, JSON.stringify(result.result))
  return result.result.value
}
const sessionStatus = async sessionId => {
  const listing = await rpc('session/list', { _request: {} })
  return listing.items.find(item => item.sessionId === sessionId)
}
const oldPnpmGraph = profile => {
  console.log(JSON.stringify({ phase: 'preparing-pnpm10-fixture' }))
  assert.equal(app, undefined, 'Close the isolated app before rebuilding its dependencies')
  const modules = resolve(profile, 'node_modules')
  const backup = resolve(state, `modules-before-pnpm10-${randomUUID()}`)
  assert.ok(modules.startsWith(resolve(home) + sep) && backup.startsWith(resolve(state) + sep))
  renameSync(modules, backup)
  const npmrc = join(state, 'pnpm10-npmrc')
  writeFileSync(npmrc, 'registry=https://registry.npmjs.org/\n')
  const commandEnv = { ...env }
  for (const name of Object.keys(commandEnv)) if (/^(?:npm|pnpm|corepack)_/i.test(name)) delete commandEnv[name]
  const pnpm = join(directory, 'node_modules/pnpm10/bin/pnpm.cjs')
  const workspacePath = join(profile, 'pnpm-workspace.yaml')
  const workspaceText = readFileSync(workspacePath, 'utf8')
  const workspace = load(workspaceText)
  // pnpm 10 cannot parse pnpm 11's file-qualified allowBuilds keys. Creating the
  // old graph never runs scripts; restore the immutable Desktop config afterwards.
  delete workspace.allowBuilds
  writeFileSync(workspacePath, dump(workspace))
  try {
    execFileSync(process.execPath, [pnpm, `--config.store-dir=${join(home, 'desktop/pnpm/store')}`,
      `--config.userconfig=${npmrc}`, 'add', 'dsh-image-viewer@0.1.0-beta.11', '--save-exact', '--ignore-scripts'],
    { cwd: profile, env: { ...commandEnv, CI: '1' }, encoding: 'utf8', windowsHide: true,
      timeout: 480000, stdio: 'pipe', maxBuffer: 8 * 1024 * 1024 })
  } finally { writeFileSync(workspacePath, workspaceText) }
  const manifestPath = join(profile, 'package.json')
  const manifest = json(manifestPath)
  if (!manifest.dsh.profile.bundles.includes('dsh-image-viewer')) manifest.dsh.profile.bundles.push('dsh-image-viewer')
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  assert.match(load(readFileSync(join(modules, '.modules.yaml'), 'utf8')).packageManager, /^pnpm@10\./)
  console.log(JSON.stringify({ phase: 'pnpm10-fixture-ready' }))
}
const verifyMigratedGraph = profile => {
  assert.match(load(readFileSync(join(profile, 'node_modules/.modules.yaml'), 'utf8')).packageManager, /^pnpm@11\./)
  assert.equal(json(join(profile, 'node_modules/dsh-image-viewer/package.json')).version, '0.1.0-beta.11')
}
const staleRegistryMetadata = !!candidate && (migratePnpm10 || !!legacyExecutable)
const prepareStaleRegistryMetadata = async () => {
  if (!staleRegistryMetadata) return
  const metadata = join(home, 'desktop/pnpm/cache/pnpm/v11/metadata/registry.npmjs.org')
  mkdirSync(join(metadata, '@agentrouter-top'), { recursive: true })
  // A preceding installation knows only its old managed plugin version. The
  // next seed contains the new package bytes, but an add of a retained user
  // plugin still asks pnpm to resolve the managed package against this index.
  const name = '@agentrouter-top/dsh-codex'
  const version = baseline.input.plugin.version
  writeFileSync(join(metadata, name + '.jsonl'), '{}\n' + JSON.stringify({ name,
    'dist-tags': { next: version }, versions: { [version]: { name, version } } }) + '\n')
  const response = await fetch('https://registry.npmjs.org/dsh-image-viewer', { signal: AbortSignal.timeout(30000) })
  assert.equal(response.status, 200)
  const viewer = await response.json()
  assert.ok(viewer.versions['0.1.0-beta.11'])
  writeFileSync(join(metadata, 'dsh-image-viewer.jsonl'), JSON.stringify({ etag: response.headers.get('etag') }) + '\n' + JSON.stringify(viewer) + '\n')
}
const prepareLegacyMigrationCases = async profile => {
  assert.equal(app, undefined, 'Close the old isolated app before preparing its migration')
  assert.ok(resolve(profile).startsWith(resolve(home) + sep))
  const viewer = 'dsh-image-viewer'
  assert.equal(json(join(profile, 'package.json')).dependencies[viewer], '0.1.0-beta.11')
  const response = await fetch('https://registry.npmjs.org/dsh-image-viewer/-/dsh-image-viewer-0.1.0-beta.11.tgz',
    { signal: AbortSignal.timeout(30000) })
  assert.equal(response.status, 200)
  const bytes = Buffer.from(await response.arrayBuffer())
  assert.equal('sha512-' + createHash('sha512').update(bytes).digest('base64'),
    'sha512-Ea0u5MKSNYvyazirUM8i+o8B4fz9Uv6B+Cl4o39QJFXVe/FT/Dphv1kwzNr6u5mp8Do2GviV0isKuTQ17Z2WiQ==')
  const tarball = join(state, 'legacy-viewer.tgz')
  writeFileSync(tarball, bytes)
  const commandEnv = { ...env, CI: '1' }
  for (const name of Object.keys(commandEnv)) if (/^(?:npm|pnpm|corepack)_/i.test(name)) delete commandEnv[name]
  const npmrc = join(state, 'legacy-npmrc')
  writeFileSync(npmrc, 'registry=https://registry.npmjs.org/\n')
  execFileSync(process.execPath, [join(directory, 'node_modules/pnpm10/bin/pnpm.cjs'),
    `--config.store-dir=${join(state, 'legacy-pnpm-store')}`, `--config.userconfig=${npmrc}`,
    'add', tarball, '--save-exact', '--lockfile-only', '--ignore-scripts', '--ignore-pnpmfile'],
  { cwd: profile, env: commandEnv, encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 8 * 1024 * 1024 })
  const manifestPath = join(profile, 'package.json')
  const manifest = json(manifestPath)
  assert.match(manifest.dependencies[viewer], /^file:/)
  assert.equal(json(join(profile, 'agentrouter-preinstalled.json')).package, '@agentrouter-top/dsh-codex')
  manifest.dsh.profile.bundles.push('@agentrouter-top/dsh-plugin')
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  // Simulate an old installation whose archived file and module fallback are no
  // longer present. Move only entries inside this disposable Home, never a target
  // reached by following a module junction into the previous executable.
  const modules = join(profile, 'node_modules')
  if (existsSync(modules)) renameSync(modules, join(state, 'legacy-profile-modules'))
  renameSync(tarball, join(state, 'retained-legacy-viewer.tgz'))
  return { manifest: readFileSync(manifestPath, 'utf8'), lock: readFileSync(join(profile, 'pnpm-lock.yaml'), 'utf8') }
}
try {
  await launch(baseline)
  await page.screenshot({ path: join(state, 'fresh-install.png') })
  await close()
  const profile = join(home, 'profiles/desktop')
  let legacyManifest = legacyExecutable ? readFileSync(join(profile, 'package.json'), 'utf8') : undefined
  let legacyLock
  const legacyViewer = legacyExecutable ? JSON.parse(legacyManifest).dependencies['dsh-image-viewer'] : undefined
  if (legacyExecutable) baseline.input.plugin.version = JSON.parse(legacyManifest).dependencies['@agentrouter-top/dsh-codex']
  const existingPatch = existsSync(join(profile, 'cordis.patch.yml')) ? load(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')) : []
  assert.ok(Array.isArray(existingPatch))
  const patch = dump([...existingPatch, { id: 'agentrouter-auth', config: { environment: {
    id: 'loopback-test', loopbackControlOrigin: origin, loopbackModelApiOrigin: origin + '/v1' } } },
  { id: 'agentrouter-plugin-updates', config: { automatic: false } },
  ...(legacyExecutable ? [{ id: 'llm-deepseek', config: { baseURL: origin + '/v1', models: [{ id: 'deepseek-flash' }] } }] : [])])
  writeFileSync(join(profile, 'cordis.patch.yml'), patch)
  await launch(baseline)
  assert.equal((await api('connect', { apiKey: 'sk-desktop-acceptance-fixture' })).connected, true)
  const session = await rpc('session/create', { request: { cwd: state } })
  assert.ok(session.sessionId)
  await rpc('session/selectModel', { request: { sessionId: session.sessionId,
    provider: legacyExecutable ? 'deepseek-official' : 'agentrouter-deepseek', model: 'deepseek-flash' } })
  const requestId = randomUUID()
  await rpc('session/prompt', { request: { requestId, sessionId: session.sessionId, mode: 'queue',
    content: [{ type: 'text', text: 'Remember this conversation across a product update.' }] } })
  await expect.poll(async () => {
    const status = await sessionStatus(session.sessionId)
    return modelRequests > 0 && status?.running === false
  }, { timeout: 45000 }).toBe(true)
  assert.ok(modelRequests > 0)
  await close()
  if (legacyExecutable) {
    const prepared = await prepareLegacyMigrationCases(profile)
    legacyManifest = prepared.manifest
    legacyLock = prepared.lock
  }
  if (candidate) {
    if (!legacyExecutable) assert.equal(baseline.input.dshVersion, candidate.input.dshVersion, 'This test must update the plugin while retaining DSH.')
    if (!nativeUpdate) assert.notEqual(baseline.input.plugin.version, candidate.input.plugin.version)
    if (migratePnpm10) oldPnpmGraph(profile)
    if (nativeUpdate) {
      await launch(baseline)
      // The native menu still checks the same coordinator; defer its combined
      // action and exercise the public page's separate download/restart routes.
      await app.evaluate(({ dialog, Menu }) => {
        const previous = dialog.showMessageBox.bind(dialog)
        dialog.showMessageBox = async (...args) => {
          const options = args.at(-1)
          if (options.type === 'info' && options.buttons?.length === 2)
            return { response: 1, checkboxChecked: false }
          return previous(...args)
        }
        const item = Menu.getApplicationMenu()?.getMenuItemById('product-update')
        if (!item?.enabled) throw new Error('The product update entry is unavailable')
        item.click()
      })
      await expect.poll(async () => (await api('updates/status')).phase, { timeout: 60000 }).toBe('available')
      const discovered = await api('updates/status')
      assert.equal(discovered.product.version, baseline.input.productVersion)
      assert.equal(discovered.currentVersion, baseline.input.plugin.version)
      assert.equal(discovered.product.latestVersion, candidate.input.productVersion)
      assert.equal(discovered.product.latestPluginVersion, candidate.input.plugin.version)
      await api('updates/download', { version: candidate.input.productVersion })
      await expect.poll(async () => (await api('updates/status')).phase, { timeout: 300000 }).toBe('ready')
      assert.equal((await api('updates/status')).canInstall, true)
      assert.equal(await app.evaluate(({ app }) => app.getVersion()), baseline.input.productVersion,
        'Download alone does not restart or activate the installer')
      const pending = join(process.env.LOCALAPPDATA, '@agentrouterdesktop-updater/pending')
      const pendingInfo = json(join(pending, 'update-info.json'))
      assert.equal(pendingInfo.fileName, `AgentRouter-${candidate.input.productVersion}-x64-Setup.exe`)
      const cachedInstaller = join(pending, pendingInfo.fileName)
      const cachedDigest = createHash('sha512').update(readFileSync(cachedInstaller)).digest('base64')
      assert.equal(cachedDigest, pendingInfo.sha512)
      await close()
      // Run the real NSIS Cancel flow against an identical disposable copy.
      // The updater's original pending file must remain the exact byte source
      // for the subsequent reopen/retry path.
      const cancelInstaller = join(state, pendingInfo.fileName)
      copyFileSync(cachedInstaller, cancelInstaller)
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
        join(directory, 'update-cancel-acceptance.ps1'), '-Installer', cancelInstaller, '-InstallDirectory', dirname(candidate.executable)],
      { env, windowsHide: true, stdio: 'inherit', timeout: 75000 })
      assert.equal(readInstalledProductVersion(dirname(candidate.executable)),
        baseline.input.productVersion, 'Cancel must preserve the installed version')
      assert.equal(createHash('sha512').update(readFileSync(cachedInstaller)).digest('base64'), cachedDigest,
        'Cancel must preserve the verified download')
      await launch(baseline)
      await api('updates/check', {})
      await expect.poll(async () => (await api('updates/status')).phase, { timeout: 60000 }).toBe('available')
      await api('updates/download', { version: candidate.input.productVersion })
      await expect.poll(async () => (await api('updates/status')).phase, { timeout: 60000 }).toBe('ready')
      const sibling = dirname(candidate.executable) + '-unrelated'
      mkdirSync(sibling)
      const siblingExecutable = join(sibling, 'AgentRouter.exe')
      copyFileSync(process.execPath, siblingExecutable)
      unrelatedProcess = spawn(siblingExecutable, ['-e', 'process.stdout.write("ready\\n");setInterval(()=>{},1000)'],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env })
      await once(unrelatedProcess.stdout, 'data')
      // Reproduce both startup-recovery and renderer-unload quit vetoes on the
      // actual installed shell. Only the verified updater handoff may bypass them.
      await app.evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) window.setClosable(false)
      })
      await page.evaluate(() => { window.onbeforeunload = () => false })
      await prepareStaleRegistryMetadata()
      const modulesPath = join(profile, 'node_modules/.modules.yaml')
      const modulesBefore = { bytes: readFileSync(modulesPath, 'utf8'), mtime: statSync(modulesPath).mtimeMs }
      const restartStarted = Date.now()
      const closing = app.waitForEvent('close', { timeout: 45000 })
      await api('updates/install', { version: candidate.input.productVersion, interrupt: false })
      await closing
      app = undefined
      await expect.poll(() => {
        try {
          return readInstalledProductVersion(dirname(candidate.executable))
        } catch { return undefined }
      }, { timeout: 180000 }).toBe(candidate.input.productVersion)
      console.log(JSON.stringify({ phase: 'installer-replaced-app', productVersion: candidate.input.productVersion }))
      // The NSIS run-after-install process must start the new host and activate
      // its seed before the driver reconnects for conversation checks.
      await expect.poll(() => {
        try { return json(join(profile, 'desktop-release.json')).productVersion } catch { return undefined }
      }, { timeout: 180000 }).toBe(candidate.input.productVersion)
      console.log(JSON.stringify({ phase: 'restarted-app-activated-profile', productVersion: candidate.input.productVersion }))
      await expect.poll(() => {
        try { const startup = json(join(home, 'desktop/startup.json')); return startup.productVersion === candidate.input.productVersion && startup.ready }
        catch { return false }
      }, { timeout: 180000 }).toBe(true)
      const startup = json(join(home, 'desktop/startup.json'))
      assert.equal(startup.rebuilt, false, 'An identical runtime must not be installed again')
      assert.ok(startup.visibleMs < 10000, 'Update restart must show its startup window within ten seconds')
      assert.ok(startup.durationMs < 30000, 'An unchanged runtime must become ready within thirty seconds')
      assert.deepEqual({ bytes: readFileSync(modulesPath, 'utf8'), mtime: statSync(modulesPath).mtimeMs }, modulesBefore)
      assert.equal(unrelatedProcess.exitCode, null, 'Installer must leave the same-name sibling process running')
      unrelatedProcess.kill(); unrelatedProcess = undefined
      nativeUpdateMetrics = { restartToReadyMs: Date.now() - restartStarted, startup, dependenciesRetained: true,
        cancelledInstallerRetried: true, verifiedDownloadRetained: true, quitVetoHandled: true, unrelatedProcessPreserved: true }
      console.log(JSON.stringify({ nativeUpdateMetrics }))
      const processEnv = { ...env, AGENTROUTER_TEST_INSTALLED_EXE: candidate.executable }
      await expect.poll(() => Number(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '@(Get-Process | Where-Object { $_.Path -eq $env:AGENTROUTER_TEST_INSTALLED_EXE -and $_.MainWindowHandle -ne 0 }).Count'],
      { env: processEnv, encoding: 'utf8', windowsHide: true }).trim()), { timeout: 90000 }).toBeGreaterThan(0)
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '$p = @(Get-Process | Where-Object { $_.Path -eq $env:AGENTROUTER_TEST_INSTALLED_EXE -and $_.MainWindowHandle -ne 0 }); if ($p.Count -eq 0) { throw "Installer did not restart the app" }; foreach ($appProcess in $p) { if (!$appProcess.CloseMainWindow() -or !$appProcess.WaitForExit(15000)) { throw "Restarted app did not close cleanly" } }'],
      { env: processEnv, windowsHide: true, stdio: 'inherit' })
    }
    if (!nativeUpdate) await prepareStaleRegistryMetadata()
    await launch(candidate)
    if (staleRegistryMetadata) {
      const refreshed = JSON.parse(readFileSync(join(home,
        'desktop/pnpm/cache/pnpm/v11/metadata/registry.npmjs.org/@agentrouter-top/dsh-codex.jsonl'), 'utf8').trim().split('\n')[1])
      assert.ok(refreshed.versions[candidate.input.plugin.version], 'The actual installed upgrade must refresh the stale managed-plugin index')
    }
    if (legacyExecutable) {
      const migration = json(join(profile, 'agentrouter-legacy-migration.json'))
      assert.equal(readFileSync(join(migration.backup, 'package.json'), 'utf8'), legacyManifest)
      assert.equal(readFileSync(join(migration.backup, 'pnpm-lock.yaml'), 'utf8'), legacyLock)
      assert.equal(json(join(profile, 'node_modules/dsh-image-viewer/package.json')).version, legacyViewer)
      assert.ok(!json(join(profile, 'package.json')).dsh.profile.bundles.includes('@agentrouter-top/dsh-plugin'))
    }
    if (migratePnpm10) verifyMigratedGraph(profile)
    assert.equal((await api('status')).connected, true)
    assert.equal((await api('updates/status')).owner, 'product')
    assert.equal((await api('updates/status')).canInstall, false)
    assert.deepEqual((await api('kernel/status')).supportedKernels, ['native', 'codex'])
    const restored = await sessionStatus(session.sessionId)
    assert.ok(restored && !restored.blank)
    assert.equal(resolve(restored.cwd), resolve(state))
    const beforeContinuation = modelRequests
    await rpc('session/prompt', { request: { requestId: randomUUID(), sessionId: session.sessionId, mode: 'queue',
      content: [{ type: 'text', text: 'Continue the same conversation after the update.' }] } })
    await expect.poll(async () => {
      const status = await sessionStatus(session.sessionId)
      return modelRequests > beforeContinuation && status?.running === false
    }, { timeout: 45000 }).toBe(true)
    assert.ok(modelInputs.slice(beforeContinuation).some(input => {
      const history = JSON.stringify(input.messages)
      return history.includes('Remember this conversation across a product update.')
        && history.includes('DESKTOP_MIGRATION_OK')
        && history.includes('Continue the same conversation after the update.')
    }), 'The real post-upgrade model request must retain the old conversation')
    await expect(page.getByRole('button', { name: /检查更新|更新并重启|查看更新/ })).toHaveCount(0)
    const menu = await app.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById('product-update')
      return { exists: !!item, visible: item?.visible, enabled: item?.enabled }
    })
    assert.deepEqual(menu, { exists: true, visible: true, enabled: true })
    assert.equal(json(join(profile, 'node_modules/@agentrouter-top/dsh-codex/package.json')).version, candidate.input.plugin.version)
    assert.equal(json(join(profile, 'node_modules/@deepseek-ai/dsh/package.json')).version, candidate.input.dshVersion)
    assert.equal(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8'), patch)
    await page.screenshot({ path: join(state, 'product-upgrade.png') })
    await close()
    if (migratePnpm10) {
      oldPnpmGraph(profile)
      await launch(candidate)
      verifyMigratedGraph(profile)
      assert.equal((await api('status')).connected, true)
      assert.ok(await sessionStatus(session.sessionId))
      assert.equal(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8'), patch)
      await close()
      const modules = join(profile, 'node_modules/.modules.yaml')
      const beforeStartup = { text: readFileSync(modules, 'utf8'), mtime: statSync(modules).mtimeMs }
      await launch(candidate)
      assert.equal((await api('status')).connected, true)
      await close()
      assert.deepEqual({ text: readFileSync(modules, 'utf8'), mtime: statSync(modules).mtimeMs }, beforeStartup)
    }
  }
  let credentialRecovery, runtimeRecovery
  if (!candidate && !legacyExecutable) {
    await close()
    if (process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted') {
      runtimeRecovery = await assertRuntimeRecovery({ executablePath: baseline.executable, state, home, electronHome, env })
    }
    credentialRecovery = await assertCredentialRecovery({ executablePath: baseline.executable, state, home, electronHome, env })
    await launch(baseline)
    assert.equal((await api('status')).connected, false)
    assert.ok(await sessionStatus(session.sessionId), 'Credential recovery must retain the existing conversation')
    assert.equal((await api('connect', { apiKey: 'sk-desktop-acceptance-fixture' })).connected, true)
    credentialRecovery.existingSessionRetained = true
    credentialRecovery.signInAvailable = true
  }
  const receipt = { passed: true, state, electronGui: true, offlineSeedInstall: true, accountFixture: true,
    productUpgrade: !!candidate, dshUnchanged: candidate?.input.dshVersion === baseline.input.dshVersion, credentialsPreserved: !!candidate,
    sessionMetadataPreserved: !!candidate, existingConversationContinued: !!candidate, modelRequests, singleUpdateEntry: !!candidate,
    baseline: baseline.input, target: candidate?.input, pluginSha256: candidate?.pluginSha256,
    realAccountUsed: false, nativeSessionApi: true, nativeModelHistoryRetained: !!candidate, installerUpgrade: nativeUpdate, loopbackFeedUpgrade: nativeUpdate,
    automaticInstallerRestart: nativeUpdate, publicFeedUpgrade: false, legacyProfileMigration: !!legacyExecutable,
    legacyFileTarballMigrated: !!legacyExecutable, legacyDanglingBundleReconciled: !!legacyExecutable }
  Object.assign(receipt, { pnpm10To11: migratePnpm10, sameReleaseStoreRepair: migratePnpm10,
    thirdPartyPluginPreserved: migratePnpm10 || !!legacyExecutable, staleRegistryMetadataRefreshed: staleRegistryMetadata,
    repeatedStartupDoesNotRebuild: migratePnpm10, nativeUpdateMetrics, externalBrowserNavigation, credentialRecovery, runtimeRecovery, launches })
  writeFileSync(join(state, 'acceptance.json'), JSON.stringify(receipt, null, 2) + '\n')
  if (candidate) writeFileSync(join(candidate.output, 'acceptance.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify(receipt))
} catch (error) {
  console.error(error)
  if (existsSync(join(state, 'startup-error.log'))) console.error(readFileSync(join(state, 'startup-error.log'), 'utf8'))
  if (nativeUpdate && process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted') {
    if (existsSync(join(state, 'electron.log'))) console.error(readFileSync(join(state, 'electron.log'), 'utf8').slice(-16000))
    try {
      console.error(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
        join(directory, 'installer-diagnostics.ps1')], { encoding: 'utf8', windowsHide: true, timeout: 15000 }))
    } catch { console.error('Installer window diagnostics were unavailable') }
  }
  console.error(`Acceptance state: ${state}`)
  throw error
} finally {
  unrelatedProcess?.kill()
  try { await close() }
  catch (error) {
    // This is cleanup after acceptance failed, never proof of a successful
    // updater handoff. Kill only the process launched by this isolated driver.
    console.error(error)
    app?.process().kill()
    throw error
  } finally {
    gateway.closeAllConnections()
    await new Promise(resolve => gateway.close(resolve))
  }
}
