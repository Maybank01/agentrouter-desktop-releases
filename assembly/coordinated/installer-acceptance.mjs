/** Executes NSIS and the native updater only on a disposable hosted Windows worker. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { directory, root } from './prepare.mjs'

assert.equal(process.platform, 'win32')
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Run installers only on a disposable hosted Windows worker')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
const json = path => JSON.parse(readFileSync(path, 'utf8'))
const writeJson = (path, data) => writeFileSync(path, JSON.stringify(data, null, 2) + '\n')
const targetFile = resolve(process.argv[2])
const target = json(targetFile)
const work = mkdtempSync(join(process.env.RUNNER_TEMP, 'agentrouter-installed-'))
const env = { ...process.env, AGENTROUTER_COORDINATED_WORK_DIR: join(work, 'candidates') }
async function run(exe, args, name, overrides = {}) {
  const started = Date.now()
  console.error(JSON.stringify({ installerAcceptance: name, phase: 'started' }))
  const log = join(work, name + '.log')
  const output = createWriteStream(log)
  const child = spawn(exe, args, { cwd: root, env: { ...env, ...overrides }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(output, { end: false }); child.stderr.pipe(output, { end: false })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  await new Promise(resolve => output.end(resolve))
  if (code !== 0) throw new Error(`${name} failed (${code}); ${log}\n${readFileSync(log, 'utf8').slice(-6000)}`)
  console.error(JSON.stringify({ installerAcceptance: name, phase: 'passed', durationMs: Date.now() - started }))
  return log
}
const node = (script, args, name) => run(process.execPath, [join(directory, script), ...args], name)
const lastResult = log => JSON.parse(readFileSync(log, 'utf8').trim().split(/\r?\n/).at(-1))
const baselineInput = json(join(directory, 'installer-baseline.json'))
assert.equal(baselineInput.dshVersion, target.input.dshVersion)
assert.notEqual(baselineInput.plugin.version, target.input.plugin.version)
const baselineFile = lastResult(await node('build.mjs', [join(directory, 'installer-baseline.json')], 'build-baseline')).candidate
const baseline = json(baselineFile)
const files = new Map()
const requests = []
const server = createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname.slice(1))
  const file = files.get(name)
  if (!file) { res.writeHead(404); res.end(); return }
  requests.push(name)
  res.setHeader('content-length', file.bytes)
  res.setHeader('content-type', name.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream')
  // A complete 200 response also supports the updater's verified full-download fallback.
  if (req.method === 'HEAD') res.end()
  else createReadStream(file.path).pipe(res)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const feed = `http://127.0.0.1:${server.address().port}/`
const install = (installer, destination, name) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  '$ErrorActionPreference = "Stop"; $p = Start-Process -FilePath $env:AGENTROUTER_TEST_INSTALLER -ArgumentList "/S", "/currentuser", "/D=$env:AGENTROUTER_TEST_INSTALL_DIR" -WindowStyle Hidden -Wait -PassThru; if ($p.ExitCode -ne 0) { throw "NSIS failed: $($p.ExitCode)" }'], name,
{ AGENTROUTER_TEST_INSTALLER: installer, AGENTROUTER_TEST_INSTALL_DIR: destination })
try {
  const baselinePackage = json(lastResult(await node('package-installer.mjs', [baselineFile, '--test-feed=' + feed], 'package-baseline')).installerReceipt)
  const targetPackageFile = lastResult(await node('package-installer.mjs', [targetFile, '--test-feed=' + feed], 'package-target')).installerReceipt
  const targetPackage = json(targetPackageFile)
  for (const receipt of [baselinePackage, targetPackage]) for (const file of receipt.assets) files.set(file.name, { path: join(receipt.output, file.name), bytes: file.bytes })
  const installed = join(work, 'installed')
  await install(baselinePackage.installer, installed, 'install-baseline')
  const executable = join(installed, 'AgentRouter.exe')
  assert.ok(existsSync(executable))
  const installedBaseline = join(work, 'baseline-installed.json')
  const installedTarget = join(work, 'target-installed.json')
  writeJson(installedBaseline, { ...baseline, executable })
  writeJson(installedTarget, { ...target, executable })
  await node('acceptance.mjs', [installedBaseline, installedTarget, '--native-update'], 'native-updater')
  const update = json(join(target.output, 'acceptance.json'))
  assert.equal(update.installerUpgrade, true)
  assert.ok(requests.includes('latest.yml') && requests.some(name => name === targetPackage.assets.find(asset => asset.name.endsWith('.exe')).name))

  const legacy = json(join(directory, 'legacy-installer.json'))
  const legacyInstaller = join(work, legacy.filename)
  const response = await fetch(legacy.url)
  assert.equal(response.status, 200)
  await pipeline(Readable.fromWeb(response.body), createWriteStream(legacyInstaller))
  assert.equal(createHash('sha256').update(readFileSync(legacyInstaller)).digest('hex'), legacy.sha256)
  const legacyDirectory = join(work, 'previous-community')
  await install(legacyInstaller, legacyDirectory, 'install-legacy')
  await node('acceptance.mjs', [installedTarget, '--legacy-executable=' + join(legacyDirectory, 'DSH Desktop.exe')], 'legacy-migration')
  const migration = json(join(target.output, 'acceptance.json'))
  assert.equal(migration.legacyProfileMigration, true)
  const receipt = { schemaVersion: 1, passed: true, testOnly: true, signed: false,
    productVersion: target.input.productVersion, plugin: target.input.plugin, patchSha256: target.patchSha256,
    targetInstaller: targetPackage, legacyInstaller: legacy,
    freshInstallerExecuted: true, nativeUpdaterExecuted: true, installerRestartedApp: true,
    legacyInstallerExecuted: true, publicFeedChanged: false, update, migration,
    feedRequests: [...new Set(requests)] }
  writeJson(join(target.output, 'installer-acceptance.json'), receipt)
  console.log(JSON.stringify({ passed: true, receipt: join(target.output, 'installer-acceptance.json') }))
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
