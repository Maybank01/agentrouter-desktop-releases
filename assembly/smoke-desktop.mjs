/** Black-box UI check of the real native executable. All data is disposable. */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { access, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { createServer } from 'node:net'

const [executable, evidence] = process.argv.slice(2)
assert.ok(isAbsolute(executable ?? '') && isAbsolute(evidence ?? ''))
await access(executable)
const require = createRequire(new URL('../artifacts/desktop-smoke-deps/package.json', import.meta.url))
const { chromium } = require('playwright')
const root = await mkdtemp(join(tmpdir(), 'agentrouter-native-smoke-'))
await mkdir(evidence, { recursive: true })
const server = createServer()
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
await new Promise(resolve => server.close(resolve))
const env = { ...process.env, DSH_HOME: join(root, 'home'), DSH_TELEMETRY_DISABLED: '1' }
for (const key of Object.keys(env)) if (/API_KEY|CODEX_HOME|RELAY_CODEX|NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE/i.test(key)) delete env[key]
const child = spawn(executable, [`--user-data-dir=${join(root, 'user-data')}`, `--remote-debugging-port=${port}`],
  { env, cwd: dirname(executable), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
let output = ''
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk.toString()).slice(-120000) })
console.log(JSON.stringify({ stage: 'launch', root, port, pid: child.pid }))
let browser, accepted = false, lastPage, skippedWizards = 0, wizardWindows = 0, restartConfirmations = 0
const pageErrors = new Set()
const observedPages = new WeakSet()
const observedWizards = new WeakSet()
const dismissExpectedOnboarding = async page => {
  const steps = [
    { title: /^(Internal Testing Notice|内测声明)$/, action: /^(Continue|继续)$/ },
    { title: /^(Add an API key to get started|添加一个 API Key 开始使用)$/, action: /^(Configure later|稍后配置)$/ },
    { title: /^(Connect AgentRouter|连接 AgentRouter)$/, action: /^稍后登录(?:，关闭引导)?$/ },
  ]
  for (const step of steps) {
    const dialog = page.getByRole('dialog', { name: step.title }).first()
    if (!await dialog.isVisible()) continue
    const action = dialog.getByRole('button', { name: step.action }).first()
    if (!await action.isVisible()) continue
    await action.click()
    await dialog.waitFor({ state: 'detached', timeout: 15000 })
    return true
  }
  return false
}
const bounded = async operation => {
  let timer
  try { return await Promise.race([operation, new Promise(resolve => { timer = setTimeout(resolve, 3000) })]) }
  finally { clearTimeout(timer) }
}
try {
  const deadline = Date.now() + 180000
  while (Date.now() < deadline) {
    try {
      if (!browser?.isConnected()) browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 2000 })
      const pages = browser.contexts().flatMap(context => context.pages())
      for (const page of pages) {
        if (!observedPages.has(page)) {
          observedPages.add(page)
          page.on('pageerror', error => pageErrors.add(error.message))
          // Keep unattended validation from taking focus from the user's app.
          const cdp = await page.context().newCDPSession(page)
          const window = await cdp.send('Browser.getWindowForTarget').catch(() => undefined)
          if (window) await cdp.send('Browser.setWindowBounds', { windowId: window.windowId, bounds: { windowState: 'minimized' } }).catch(() => {})
          await cdp.detach()
        }
        lastPage = page
        if (page.url().includes('desktop-dialog.html')) {
          const restart = page.getByRole('button', { name: /^(Restart|重启)$/ })
          if (await restart.isVisible() && /Restart DSH Desktop now|重启 DSH Desktop/.test(await page.locator('body').innerText())) {
            restartConfirmations++
            assert.fail('Preinstallation must activate on its first generation without a restart confirmation.')
          }
          continue
        }
        if (page.url().includes('setup-wizard.html')) {
          if (!observedWizards.has(page)) {
            observedWizards.add(page)
            assert.equal(++wizardWindows, 1, 'Preinstallation must not open a second setup wizard.')
          }
          const dialog = page.getByRole('alertdialog')
          const skip = (await dialog.count() ? dialog : page).getByRole('button', { name: /^(Skip setup|跳过设置|确认跳过)$/ }).first()
          if (await skip.isVisible()) {
            assert.ok(skippedWizards < 2, 'Never keep clicking a repeating setup prompt.')
            await skip.click(); skippedWizards++
          }
          continue
        }
        if (!/^https?:\/\/127\.0\.0\.1/.test(page.url())) continue
        if (await dismissExpectedOnboarding(page)) continue
        const state = await page.evaluate(async () => {
          const get = async path => { const response = await fetch(path); return response.ok ? response.json() : null }
          return { account: await get('/api/agentrouter/v1/status'), updates: await get('/api/agentrouter/v1/updates/status'),
            viewer: !!document.querySelector('style[data-plugin="dsh-image-viewer"]') }
        })
        if (!state.account || !state.viewer) continue
        const receipt = JSON.parse(await readFile(join(root, 'home/agentrouter/desktop-preinstall.json'), 'utf8'))
        assert.equal(receipt.phase, 'seeded')
        assert.equal(receipt.profile, 'desktop')
        assert.equal(state.account.connected, false)
        assert.equal(state.account.environment.id, 'v3-candidate')
        assert.equal(state.updates.profile, 'desktop')
        assert.equal(state.updates.unavailableReason, undefined)
        const consoles = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File',
          join(import.meta.dirname, 'visible-codex-consoles.ps1'), '-ApplicationDirectory', dirname(executable)],
        { encoding: 'utf8', windowsHide: true }))
        assert.deepEqual(consoles, [], 'Bundled Codex must not create a visible console window.')
        const manifest = JSON.parse(await readFile(join(root, 'home/profiles/desktop/package.json'), 'utf8'))
        assert.ok(manifest.dsh.profile.bundles.includes('@agentrouter-top/dsh-codex'))
        assert.ok(manifest.dsh.profile.bundles.includes('dsh-image-viewer'))
        const patch = await readFile(join(root, 'home/profiles/desktop/cordis.patch.yml'), 'utf8')
        assert.match(patch, /mode: codex-only/)
        await page.getByRole('button', { name: /^(Settings|设置)$/ }).click()
        await page.getByRole('button', { name: /检查更新|Check.*update/i }).first().waitFor({ state: 'visible', timeout: 15000 })
        await page.screenshot({ path: join(evidence, 'installed-settings.png') })
        const result = { passed: true, root, executable, realNativeWindow: true, sameProfileRetained: true, wizardWindows, restartConfirmations,
          codexOnlyProfile: true, viewerLoaded: true, loggedOutPluginUpdateTarget: true,
          visibleCodexConsoles: consoles.length,
          version: state.updates.currentVersion, skippedWizardClicks: skippedWizards, pageErrors: [...pageErrors],
          realAccountUsed: false, installerExecuted: false }
        assert.deepEqual(result.pageErrors, [])
        await writeFile(join(evidence, 'native-smoke.json'), JSON.stringify(result, null, 2) + '\n')
        console.log(JSON.stringify(result))
        accepted = true
        break
      }
      if (accepted) break
    } catch (error) {
      if (error instanceof assert.AssertionError) throw error
      if (Date.now() + 3000 >= deadline) throw error
    }
    await new Promise(resolve => setTimeout(resolve, 700))
  }
  assert.ok(accepted, 'The packaged native application did not reach the preinstalled product profile.')
} finally {
  await writeFile(join(evidence, 'native-process.log'), output)
  if (!accepted) {
    await bounded(lastPage?.screenshot({ path: join(evidence, 'failure.png'), timeout: 2000 }).catch(() => {}))
    console.log(JSON.stringify({ accepted, root, lastPage: lastPage?.url().split('?')[0] }))
  }
  if (browser?.isConnected()) {
    const session = await browser.newBrowserCDPSession().catch(() => undefined)
    if (session) await bounded(session.send('Browser.close').catch(() => {}))
    await bounded(browser.close().catch(() => {}))
  }
  child.stdout.destroy(); child.stderr.destroy(); child.unref()
}
