/**
 * Post-publication verification of the public signed AgentRouter Desktop bits on a
 * disposable GitHub-hosted Windows worker (never on a personal machine).
 *
 *   node verify/published-client.mjs fresh  <version>            fresh install -> first launch
 *   node verify/published-client.mjs update <from> <to>           real updater from the public feed
 *
 * Writes screenshots and result.json into $OUT (default ./verify-out).
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Installs only on a disposable hosted worker')
const [mode, first, second] = process.argv.slice(2)
const out = process.env.OUT ?? join(process.cwd(), 'verify-out')
mkdirSync(out, { recursive: true })
const result = { mode, versions: { first, second }, steps: [] }
const save = () => writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2) + '\n')
const log = (step, data = {}) => { const row = { step, at: new Date().toISOString(), ...data }; result.steps.push(row); console.log(JSON.stringify(row)); save() }
const sleep = ms => new Promise(done => setTimeout(done, ms))
const home = join(homedir(), '.dsh')
const startupFile = join(home, 'desktop/startup.json')
const readJson = path => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return undefined } }
const psEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'psmodulepath'))
const ps = command => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true, env: psEnv }).trim()
const PORT = 9333
let shot = 0

async function download(version) {
  const file = `AgentRouter-${version}-x64-Setup.exe`
  const target = join(process.env.RUNNER_TEMP, file)
  const sources = [`https://agentrouter.top/downloads/desktop/v${version}/${file}`,
    `https://github.com/Maybank01/agentrouter-desktop-releases/releases/download/v${version}/${file}`]
  const probes = []
  for (const url of sources) {
    const started = Date.now()
    try {
      const response = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(30000) })
      probes.push({ url, status: response.status, bytes: Number(response.headers.get('content-length')) || undefined, ms: Date.now() - started })
    } catch (error) { probes.push({ url, error: String(error.message ?? error), ms: Date.now() - started }) }
  }
  const started = Date.now()
  const response = await fetch(sources[1], { redirect: 'follow' })
  assert.equal(response.status, 200)
  const bytes = Buffer.from(await response.arrayBuffer())
  writeFileSync(target, bytes)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const signature = JSON.parse(ps(`$s = Get-AuthenticodeSignature -LiteralPath '${target}'; $c = $s.SignerCertificate; @{ status = [string]$s.Status; subject = $c.Subject; sha256 = if ($c) { [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($c.RawData)).Replace('-','').ToLower() } } | ConvertTo-Json -Compress`))
  log('download', { version, bytes: bytes.length, sha256, ms: Date.now() - started, probes, signature })
  return target
}

function installedExecutable() {
  const uninstall = ps(`Get-ChildItem HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -like 'AgentRouter*' } | ForEach-Object { [string]$_.UninstallString } | Select-Object -First 1`)
  const location = /^"?([^"]+\\)[^\\"]+\.exe/i.exec(uninstall)?.[1]
  const candidates = [location && join(location, 'AgentRouter.exe'), join(process.env.LOCALAPPDATA, 'Programs/AgentRouter/AgentRouter.exe'),
    join(process.env.LOCALAPPDATA, 'Programs/agentrouter-desktop/AgentRouter.exe')].filter(Boolean)
  const found = candidates.find(path => existsSync(path))
  assert.ok(found, `Installed executable not found in ${candidates.join(', ')}`)
  return found
}

async function install(installer, label) {
  const started = Date.now()
  execFileSync(installer, ['/S'], { windowsHide: true, timeout: 20 * 60000 })
  const executable = installedExecutable()
  log('install', { label, ms: Date.now() - started, executable, installerPrepare: readJson(join(home, 'desktop/installer-prepare.json')) })
  return executable
}

let child, current
function tree(dir, depth = 0) {
  if (!existsSync(dir) || depth > 2) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? [entry.name + '/', ...tree(join(dir, entry.name), depth + 1).map(row => entry.name + '/' + row)] : [entry.name])
}
async function launch(executable, label) {
  const previous = readJson(startupFile)?.startedAt
  const started = Date.now()
  child = spawn(executable, [`--remote-debugging-port=${PORT}`, '--lang=zh-CN'], { detached: false, stdio: 'ignore', windowsHide: false })
  let browser
  for (let attempt = 0; attempt < 240 && !browser; attempt++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { timeout: 2000 }) } catch { await sleep(250) }
  }
  assert.ok(browser, 'CDP endpoint')
  // Usable: the application shell (not the startup/progress page) shows its Settings entry.
  let page
  const deadline = Date.now() + 480000
  while (!page && Date.now() < deadline) {
    for (const candidate of browser.contexts().flatMap(context => context.pages())) {
      current = candidate
      if (candidate.url().startsWith('dsh-app://app') && await candidate.getByRole('button', { name: /^(设置|Settings)$/ }).first().isVisible().catch(() => false)) { page = candidate; break }
    }
    if (!page) await sleep(250)
  }
  if (!page) {
    log('launch-diagnostics', { pages: browser.contexts().flatMap(context => context.pages()).map(row => row.url()),
      body: (await current?.evaluate(() => document.body?.innerText?.slice(0, 1500)).catch(() => undefined)), files: tree(home) })
    throw new Error('The application shell did not become usable within 480 s')
  }
  current = page
  const usableMs = Date.now() - started
  let startup
  for (let attempt = 0; attempt < 240; attempt++) {
    startup = readJson(startupFile)
    if (startup?.ready && startup.startedAt !== previous) break
    await sleep(250)
  }
  log('launch', { label, pid: child.pid, usableMs, startup: startup && { productVersion: startup.productVersion, visibleMs: startup.visibleMs, durationMs: startup.durationMs,
    rebuilt: startup.rebuilt, preparedRuntime: startup.preparedRuntime, stages: startup.events?.map(event => event.stage) } })
  await page.setViewportSize({ width: 1280, height: 860 }).catch(() => {})
  return { browser, page, usableMs, startup }
}

async function screenshot(page, name) {
  const path = join(out, `${String(++shot).padStart(2, '0')}-${name}.png`)
  await page.screenshot({ path })
  return path
}

async function dismiss(page) {
  for (let round = 0; round < 3; round++) {
    for (const name of ['继续', 'Continue', '稍后登录，关闭引导', '稍后登录', '稍后配置', '下次再说', '关闭通知']) {
      const button = page.getByRole('button', { name, exact: true }).first()
      if (await button.isVisible().catch(() => false)) await button.click({ timeout: 3000 }).catch(() => {})
    }
    await sleep(500)
  }
}

async function openAbout(page) {
  await dismiss(page)
  const panel = page.locator('section.aru')
  for (let attempt = 0; attempt < 20 && !await panel.isVisible().catch(() => false); attempt++) {
    const entry = page.locator('.aru-entry button')
    if (await entry.isVisible().catch(() => false)) await entry.click().catch(() => {})
    else {
      await page.getByRole('button', { name: /^(设置|Settings)$/ }).first().click({ timeout: 3000 }).catch(() => {})
      await page.getByRole('button', { name: '关于与更新', exact: true }).first().click({ timeout: 3000 }).catch(() => {})
    }
    await sleep(750)
    await dismiss(page)
  }
  await panel.waitFor({ state: 'visible', timeout: 30000 })
  return panel
}

const status = page => page.evaluate(async () => (await fetch('/api/agentrouter/v1/updates/status', { cache: 'no-store' })).json())

function kill(pid) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch {} }
async function closeApp(session) {
  await session.browser.close().catch(() => {})
  kill(child.pid)
  for (let attempt = 0; attempt < 60 && ps(`(Get-Process AgentRouter -ErrorAction SilentlyContinue | Measure-Object).Count`) !== '0'; attempt++) await sleep(500)
}

function updaterCache() {
  const rows = []
  for (const base of [process.env.LOCALAPPDATA]) {
    for (const name of readdirSync(base).filter(name => /updater$/i.test(name))) {
      const walk = dir => { for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path); else rows.push({ path: path.slice(base.length), bytes: statSync(path).size })
      } }
      walk(join(base, name))
    }
  }
  return rows
}

async function waitDownload(page, { interruptAtPercent } = {}) {
  const samples = []
  const started = Date.now()
  for (;;) {
    const view = await status(page).catch(error => ({ phase: 'unreachable', error: String(error.message ?? error) }))
    samples.push({ t: Date.now() - started, phase: view.phase, preparing: view.preparing, progress: view.progress })
    if (interruptAtPercent !== undefined && view.phase === 'downloading' && view.progress?.percent >= interruptAtPercent) return { interrupted: true, samples, view }
    if (['ready', 'error'].includes(view.phase) || Date.now() - started > 30 * 60000) return { interrupted: false, samples, view, ms: Date.now() - started }
    await sleep(500)
  }
}

try {
if (mode === 'fresh') {
  const installer = await download(first)
  const executable = await install(installer, `fresh ${first}`)
  let session = await launch(executable, 'first launch')
  await screenshot(session.page, 'first-launch')
  await dismiss(session.page)
  const panel = await openAbout(session.page)
  await session.page.getByText(/已是最新版本|现已推出/).first().waitFor({ timeout: 60000 }).catch(() => {})
  log('about', { title: await panel.locator('.aru-status h3').innerText().catch(() => undefined), versions: await panel.locator('.aru-versions').innerText().catch(() => undefined) })
  await screenshot(session.page, 'about-fresh')
  await closeApp(session)
  session = await launch(executable, 'second launch')
  await screenshot(session.page, 'second-launch')
  await closeApp(session)
} else if (mode === 'update') {
  const installer = await download(first)
  const executable = await install(installer, `baseline ${first}`)
  let session = await launch(executable, `baseline ${first}`)
  let panel = await openAbout(session.page)
  await panel.getByRole('heading', { name: new RegExp(`${second.replaceAll('.', '\\.')} 现已推出`) }).waitFor({ timeout: 120000 })
  await screenshot(session.page, 'update-available')
  await panel.getByRole('button', { name: '下载更新', exact: true }).click()
  const firstAttempt = await waitDownload(session.page, { interruptAtPercent: Number(process.env.INTERRUPT_AT ?? 30) })
  log('download-attempt-1', { interrupted: firstAttempt.interrupted, last: firstAttempt.view.progress, phase: firstAttempt.view.phase, samples: firstAttempt.samples.filter((_, index) => index % 4 === 0) })
  await screenshot(session.page, 'downloading')
  if (firstAttempt.interrupted) {
    // A real interruption: the client quits mid-transfer (as when a laptop sleeps or the user closes it).
    await closeApp(session)
    log('interrupted', { cache: updaterCache() })
    session = await launch(executable, `relaunch after interruption ${first}`)
    panel = await openAbout(session.page)
    await panel.getByRole('button', { name: /^(下载更新|继续下载|重新下载)$/ }).waitFor({ timeout: 120000 })
    const label = await panel.locator('.aru-primary').innerText()
    await screenshot(session.page, 'after-interruption')
    await panel.getByRole('button', { name: /^(下载更新|继续下载|重新下载)$/ }).click()
    const resumed = await waitDownload(session.page)
    const firstProgress = resumed.samples.find(sample => sample.progress)?.progress
    log('download-attempt-2', { action: label, ms: resumed.ms, phase: resumed.view.phase, firstProgress, last: resumed.samples.filter(sample => sample.progress).at(-1)?.progress,
      samples: resumed.samples.filter((_, index) => index % 4 === 0) })
    assert.equal(resumed.view.phase, 'ready', `Download ended in ${resumed.view.phase}: ${resumed.view.error ?? ''}`)
  } else assert.equal(firstAttempt.view.phase, 'ready', `Download ended in ${firstAttempt.view.phase}: ${firstAttempt.view.error ?? ''}`)
  await session.page.waitForTimeout(1000)
  const ready = await status(session.page)
  log('ready', { preparation: ready.preparation, canInstall: ready.canInstall, cache: updaterCache() })
  await screenshot(session.page, 'update-ready')
  const oldPid = child.pid
  const clicked = Date.now()
  await panel.getByRole('button', { name: '更新并重启', exact: true }).click()
  await session.browser.close().catch(() => {})
  let startup
  for (let attempt = 0; attempt < 1200; attempt++) {
    startup = readJson(startupFile)
    if (startup?.ready && startup.productVersion === second && Date.parse(startup.startedAt) > clicked) break
    await sleep(250)
  }
  assert.equal(startup?.productVersion, second, 'The updated client started')
  const oldExited = ps(`if (Get-Process -Id ${oldPid} -ErrorAction SilentlyContinue) { 'running' } else { 'exited' }`)
  log('update-restart', { clickToNewProcessMs: Date.parse(startup.startedAt) - clicked, clickToReadyMs: Date.parse(startup.startedAt) + startup.durationMs - clicked,
    newProcessReadyMs: startup.durationMs, rebuilt: startup.rebuilt, preparedRuntime: startup.preparedRuntime, stages: startup.events?.map(event => event.stage), oldExited,
    installedVersion: ps(`Get-ChildItem HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -like 'AgentRouter*' } | Select-Object -First 1 -ExpandProperty DisplayVersion`),
    preparedUpdate: readJson(join(home, 'desktop/prepared-update.json')) })
  // The updater relaunches the client without the debugging port; reopen it to inspect the result.
  for (const pid of ps(`(Get-Process AgentRouter -ErrorAction SilentlyContinue).Id -join ','`).split(',').filter(Boolean)) kill(Number(pid))
  await sleep(2000)
  session = await launch(executable, `after update ${second}`)
  panel = await openAbout(session.page)
  log('about-after-update', { versions: await panel.locator('.aru-versions').innerText().catch(() => undefined), title: await panel.locator('.aru-status h3').innerText().catch(() => undefined) })
  await screenshot(session.page, 'about-after-update')
  await closeApp(session)
} else throw new Error('Usage: published-client.mjs fresh <version> | update <from> <to>')
log('passed')
} catch (error) {
  if (current) await current.screenshot({ path: join(out, 'failure.png') }).catch(() => {})
  log('failed', { error: String(error.stack ?? error).slice(0, 3000), files: tree(home) })
  process.exitCode = 1
} finally { if (child) kill(child.pid) }
