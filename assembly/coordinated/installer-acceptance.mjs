/** Executes NSIS and the native updater only on a disposable hosted Windows worker. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { directory, root } from './prepare.mjs'
import { inspectWindowsSignature, loadSigningPolicy } from './windows-signing.mjs'

assert.equal(process.platform, 'win32')
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Run installers only on a disposable hosted Windows worker')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
const json = path => JSON.parse(readFileSync(path, 'utf8'))
const writeJson = (path, data) => writeFileSync(path, JSON.stringify(data, null, 2) + '\n')
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
// A signed loopback baseline can be produced once per release run on its own
// worker (--prepare-baseline, from the reviewed release input) and reused by the
// signed native update (--baseline-package). Its feed is baked into the signed
// bytes, so both use this fixed loopback port instead of an ephemeral one.
const SIGNED_BASELINE_FEED_PORT = 47831
const signedBaselineFeed = `http://127.0.0.1:${SIGNED_BASELINE_FEED_PORT}/`
const prepareBaseline = option('prepare-baseline')
const baselinePackageDir = option('baseline-package')
const targetFile = resolve(process.argv[2])
const target = json(targetFile)
/** The native-update baseline: the pinned old product with the target's exact plugin (and signing identity). */
// The recorded preceding plugin makes the native update change the runtime;
// without one the baseline keeps the target's plugin.
const baselineInputFor = (input, signed) => {
  const recorded = json(join(directory, 'installer-baseline.json'))
  return { ...recorded, plugin: recorded.plugin ?? input.plugin, ...(signed ? { signing: input.signing } : {}) }
}
const signedReceiptFile = process.argv.find(value => value.startsWith('--signed-installer='))?.slice('--signed-installer='.length)
// Each scenario installs the target on its own disposable worker so CI can run
// them in parallel. Without --scenario the release path keeps its full sequence:
// native update from the baseline, then legacy migration onto that installation.
const scenarios = ['native-updater', 'legacy-migration', 'fresh-install-recovery']
const scenario = process.argv.find(value => value.startsWith('--scenario='))?.slice('--scenario='.length)
assert.ok(scenario === undefined || scenarios.includes(scenario), `Unknown scenario ${scenario}; expected one of ${scenarios.join(', ')}`)
const selected = new Set(scenario ? [scenario] : ['native-updater', 'legacy-migration'])
// The fresh-install scenario shares its acceptance state with the installer.
const acceptanceState = selected.has('fresh-install-recovery') && !selected.has('native-updater')
  ? (mkdirSync(join(root, '.local/coordinated/acceptance'), { recursive: true }),
    mkdtempSync(join(root, '.local/coordinated/acceptance', 'installed-')))
  : undefined
const nativeUpdater = selected.has('native-updater')
const signedTarget = signedReceiptFile ? json(resolve(signedReceiptFile)) : undefined
assert.ok(!baselinePackageDir || (signedTarget && nativeUpdater), 'A prebuilt baseline is only used by the signed native update')
assert.ok(!prepareBaseline || (!signedTarget && !scenario), 'Preparing the baseline runs no scenario')
if (signedTarget) {
  assert.equal(signedTarget.signed, true)
  assert.equal(signedTarget.testOnly, false)
  assert.equal(signedTarget.productVersion, target.input.productVersion)
  assert.equal(signedTarget.patchSha256, target.patchSha256)
  assert.deepEqual(signedTarget.plugin, target.input.plugin)
}
const work = mkdtempSync(join(process.env.RUNNER_TEMP, 'agentrouter-installed-'))
const env = { ...process.env, AGENTROUTER_COORDINATED_WORK_DIR: join(work, 'candidates') }
async function run(exe, args, name, overrides = {}) {
  const started = Date.now()
  console.error(JSON.stringify({ installerAcceptance: name, phase: 'started' }))
  const log = join(work, name + '.log')
  const output = createWriteStream(log)
  const child = spawn(exe, args, { cwd: root, env: { ...env, ...overrides }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(output, { end: false }); child.stderr.pipe(output, { end: false })
  // Native acceptance uses only synthetic accounts. Stream its evidence so a
  // failing cleanup cannot hide the actual fault until the job-level timeout.
  if (scenarios.includes(name)) {
    child.stdout.pipe(process.stderr, { end: false })
    child.stderr.pipe(process.stderr, { end: false })
  }
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  await new Promise(resolve => output.end(resolve))
  if (code !== 0) throw new Error(`${name} failed (${code}); ${log}\n${readFileSync(log, 'utf8').slice(-6000)}`)
  console.error(JSON.stringify({ installerAcceptance: name, phase: 'passed', durationMs: Date.now() - started }))
  return log
}
const node = (script, args, name, overrides) => run(process.execPath, [join(directory, script), ...args], name, overrides)
const lastResult = log => JSON.parse(readFileSync(log, 'utf8').trim().split(/\r?\n/).at(-1))
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
if (prepareBaseline) {
  // argv[2] is the reviewed release input (release.json); only its plugin and
  // signing identity enter the baseline. The result is test-only: its feed is
  // loopback, it is never a release asset, and the consumer re-verifies it.
  const input = target
  assert.equal(input.schemaVersion, 1)
  assert.equal(input.signing?.mode, 'self-signed', 'Only the self-signed product has a signed native-update baseline')
  const baselineInput = baselineInputFor(input, true)
  assert.equal(baselineInput.dshVersion, input.dshVersion)
  const baselineInputFile = join(work, 'signed-baseline-input.json')
  writeJson(baselineInputFile, baselineInput)
  const candidateFile = lastResult(await node('build.mjs', [baselineInputFile], 'build-baseline')).candidate
  const candidate = json(candidateFile)
  const packaged = json(lastResult(await node('package-installer.mjs', [candidateFile, '--signed-test-feed=' + signedBaselineFeed], 'package-baseline')).installerReceipt)
  assert.equal(packaged.testOnly, true); assert.equal(packaged.signed, true); assert.equal(packaged.feed, signedBaselineFeed)
  const destination = resolve(prepareBaseline)
  mkdirSync(destination, { recursive: true })
  for (const file of packaged.assets) copyFileSync(join(packaged.output, file.name), join(destination, file.name))
  const manifest = { schemaVersion: 1, kind: 'signed-loopback-native-update-baseline', testOnly: true, feed: signedBaselineFeed,
    input: baselineInput, candidate: { input: candidate.input, patchSha256: candidate.patchSha256, upstreamCommit: candidate.upstreamCommit,
      pluginSha256: candidate.pluginSha256 },
    package: { ...packaged, output: undefined, candidate: undefined, installer: basename(packaged.installer) } }
  writeJson(join(destination, 'signed-baseline.json'), manifest)
  console.log(JSON.stringify({ preparedBaseline: destination, installer: manifest.package.installer,
    installerSha256: packaged.assets.find(file => file.name === manifest.package.installer)?.sha256 }))
  process.exit(0)
}
/** Verify a prebuilt signed baseline against this target before installing it. */
function loadPrebuiltBaseline(dir) {
  const manifest = json(join(dir, 'signed-baseline.json'))
  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.kind, 'signed-loopback-native-update-baseline')
  assert.equal(manifest.testOnly, true); assert.equal(manifest.feed, signedBaselineFeed)
  // Every input byte that decides the baseline: pinned baseline, target plugin and
  // signing identity, and the same adapter patch and upstream commit as the target.
  assert.deepEqual(manifest.input, baselineInputFor(target.input, true))
  assert.deepEqual(manifest.candidate.input, manifest.input)
  assert.equal(manifest.candidate.patchSha256, target.patchSha256)
  assert.equal(manifest.candidate.upstreamCommit, target.upstreamCommit)
  const receipt = manifest.package
  assert.equal(receipt.testOnly, true); assert.equal(receipt.signed, true); assert.equal(receipt.feed, signedBaselineFeed)
  assert.equal(receipt.productVersion, manifest.input.productVersion)
  assert.deepEqual(receipt.plugin, manifest.input.plugin)
  assert.equal(receipt.patchSha256, target.patchSha256)
  assert.equal(basename(receipt.installer), receipt.installer)
  for (const file of receipt.assets) {
    assert.equal(basename(file.name), file.name)
    const bytes = readFileSync(join(dir, file.name))
    assert.equal(bytes.length, file.bytes, `${file.name} size differs from the baseline receipt`)
    assert.equal(sha256(bytes), file.sha256, `${file.name} digest differs from the baseline receipt`)
  }
  assert.ok(receipt.assets.some(file => file.name === receipt.installer))
  const policy = loadSigningPolicy()
  assert.equal(target.input.signing.certificateSha256, policy.certificateSha256)
  for (const path of [join(dir, receipt.installer)]) {
    assert.equal(inspectWindowsSignature(path, policy).certificateSha256, policy.certificateSha256)
  }
  console.error(JSON.stringify({ installerAcceptance: 'prebuilt-baseline', phase: 'verified', installer: receipt.installer }))
  return { candidate: { ...manifest.candidate, output: join(work, 'prebuilt-baseline') },
    package: { ...receipt, output: dir, installer: join(dir, receipt.installer) } }
}
let baselineFile, baseline, prebuiltBaseline
if (nativeUpdater && baselinePackageDir) {
  prebuiltBaseline = loadPrebuiltBaseline(resolve(baselinePackageDir))
  baseline = prebuiltBaseline.candidate
  mkdirSync(baseline.output, { recursive: true })
} else if (nativeUpdater) {
  // A product update normally ships another managed plugin: the baseline takes the
  // recorded preceding plugin, so the restart must activate a runtime prepared in
  // the background. Without a recorded plugin (or when it equals the target's) the
  // same run proves an identical runtime is retained. The legacy installer still
  // exercises a real old-plugin migration, including stale registry metadata.
  const baselineInput = baselineInputFor(target.input, Boolean(signedTarget))
  assert.equal(baselineInput.dshVersion, target.input.dshVersion)
  const baselineInputFile = join(work, signedTarget ? 'signed-baseline-input.json' : 'baseline-input.json')
  writeJson(baselineInputFile, baselineInput)
  baselineFile = lastResult(await node('build.mjs', [baselineInputFile], 'build-baseline')).candidate
  baseline = json(baselineFile)
}
const files = new Map()
const requests = []
const transfers = []
// Interrupt the first ranged installer response mid-body, as a dropped mobile or
// cross-border connection would; the updater must resume and still complete.
const faults = []
let dropNextInstallerRange = nativeUpdater
const server = createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname.slice(1))
  const file = files.get(name)
  if (!file) { res.writeHead(404); res.end(); return }
  requests.push(name)
  res.setHeader('content-length', file.bytes)
  res.setHeader('content-type', name.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream')
  const range = req.headers.range
  if (range) {
    // Match GitHub's real behavior: reject multipart ranges, serve single ranges.
    const match = /^bytes=(\d+)-(\d+)$/.exec(range)
    if (!match) { res.removeHeader('content-length'); res.writeHead(501); res.end(); return }
    const start = Number(match[1]), end = Math.min(Number(match[2]), file.bytes - 1)
    assert.ok(start <= end && start >= 0)
    const bytes = end - start + 1
    res.setHeader('content-length', bytes)
    res.setHeader('accept-ranges', 'bytes')
    res.setHeader('content-range', 'bytes ' + start + '-' + end + '/' + file.bytes)
    res.writeHead(206)
    if (dropNextInstallerRange && name.endsWith('.exe') && bytes > 1024) {
      dropNextInstallerRange = false
      const sent = Math.floor(bytes / 2)
      faults.push({ name, range, sent })
      transfers.push({ name, bytes: sent, range, interrupted: true })
      createReadStream(file.path, { start, end: start + sent - 1 }).on('data', chunk => res.write(chunk))
        .on('end', () => { res.socket.destroy() })
      return
    }
    transfers.push({ name, bytes, range })
    createReadStream(file.path, { start, end }).pipe(res)
  } else if (req.method === 'HEAD') res.end()
  else { transfers.push({ name, bytes: file.bytes }); createReadStream(file.path).pipe(res) }
})
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(prebuiltBaseline ? SIGNED_BASELINE_FEED_PORT : 0, '127.0.0.1', resolve) })
const feed = `http://127.0.0.1:${server.address().port}/`
// The installer materializes the runtime in the Home it runs with; each install
// names an isolated Home so no default location of the worker is touched early.
const install = async (installer, destination, name, home) => {
  const started = Date.now()
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference = "Stop"; $p = Start-Process -FilePath $env:AGENTROUTER_TEST_INSTALLER -ArgumentList "/S", "/currentuser", "/D=$env:AGENTROUTER_TEST_INSTALL_DIR" -WindowStyle Hidden -Wait -PassThru; if ($p.ExitCode -ne 0) { throw "NSIS failed: $($p.ExitCode)" }'], name,
  { AGENTROUTER_TEST_INSTALLER: installer, AGENTROUTER_TEST_INSTALL_DIR: destination, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' })
  const preparation = join(home, 'desktop/installer-prepare.json')
  const record = { name, installMs: Date.now() - started,
    installerPrepare: existsSync(preparation) ? json(preparation) : undefined }
  console.error(JSON.stringify({ installed: record }))
  installs.push(record)
  return record
}
const installs = []
try {
  // Packages go to separate candidate outputs; build both NSIS installers at once.
  const packageInstaller = (candidate, feedArg, name) => node('package-installer.mjs', [candidate, feedArg + feed], name)
    .then(log => json(lastResult(log).installerReceipt))
  const [baselinePackage, targetPackage] = await Promise.all([
    prebuiltBaseline ? prebuiltBaseline.package
      : nativeUpdater ? packageInstaller(baselineFile, signedTarget ? '--signed-test-feed=' : '--test-feed=', 'package-baseline') : undefined,
    signedReceiptFile ? json(signedReceiptFile) : packageInstaller(targetFile, '--test-feed=', 'package-target'),
  ])
  for (const receipt of [baselinePackage, targetPackage]) if (receipt) for (const file of receipt.assets) files.set(file.name, { path: join(receipt.output, file.name), bytes: file.bytes })
  const installed = join(work, 'installed')
  const executable = join(installed, 'AgentRouter.exe')
  const installedTarget = join(work, 'target-installed.json')
  writeJson(installedTarget, { ...target, executable })
  let update, differential, legacy, migration, freshInstallRecovery
  if (nativeUpdater) {
    await install(baselinePackage.installer, installed, 'install-baseline', join(work, 'baseline-installer-home'))
    assert.ok(existsSync(executable))
    const installedBaseline = join(work, 'baseline-installed.json')
    writeJson(installedBaseline, { ...baseline, executable })
    await node('acceptance.mjs', [installedBaseline, installedTarget, '--native-update'], 'native-updater')
    update = json(join(target.output, 'acceptance.json'))
    assert.equal(update.installerUpgrade, true)
    assert.equal(update.nativeUpdateMetrics.cancelledInstallerRetried, true)
    assert.equal(update.nativeUpdateMetrics.verifiedDownloadRetained, true)
    assert.equal(update.nativeUpdateMetrics.quitVetoHandled, true)
    assert.equal(update.nativeUpdateMetrics.unrelatedProcessPreserved, true)
    assert.ok(requests.includes('latest.yml') && requests.some(name => name === targetPackage.assets.find(asset => asset.name.endsWith('.exe')).name))
    if (signedTarget) assert.ok(requests.includes('agentrouter-update.json'), 'The installed native updater must request and verify the signed manifest')

    const installerAsset = targetPackage.assets.find(asset => asset.name.endsWith('.exe'))
    const installerTransfers = transfers.filter(entry => entry.name === installerAsset.name)
    const downloadedBytes = installerTransfers.reduce((sum, entry) => sum + entry.bytes, 0)
    assert.ok(installerTransfers.length > 0 && installerTransfers.every(entry => entry.range), 'Native updater must use differential ranges without full-download fallback')
    assert.ok(downloadedBytes < installerAsset.bytes * 0.2, 'A shell-only update must transfer less than 20% of the full installer')
    assert.equal(faults.length, 1, 'The acceptance feed must interrupt one installer transfer')
    differential = { fullBytes: installerAsset.bytes, downloadedBytes,
      ratio: downloadedBytes / installerAsset.bytes, requests: installerTransfers.length, fullFallback: false,
      interruptedTransfer: faults[0], resumedAfterInterruption: true }
    console.error(JSON.stringify({ differential }))
  } else {
    // A fresh installation of the target, independent of any native-update state.
    // The fresh-install scenario's first launch uses the Home the installer prepared.
    const home = acceptanceState ? join(acceptanceState, 'home') : join(work, 'target-installer-home')
    const { installerPrepare } = await install(targetPackage.installer, installed, 'install-target', home)
    assert.ok(existsSync(executable))
    if (acceptanceState) assert.equal(installerPrepare?.outcome, 'installed', 'The installer must materialize the runtime before the first launch')
  }

  if (selected.has('legacy-migration')) {
    legacy = json(join(directory, 'legacy-installer.json'))
    const legacyInstaller = join(work, legacy.filename)
    const response = await fetch(legacy.url)
    assert.equal(response.status, 200)
    await pipeline(Readable.fromWeb(response.body), createWriteStream(legacyInstaller))
    assert.equal(createHash('sha256').update(readFileSync(legacyInstaller)).digest('hex'), legacy.sha256)
    const legacyDirectory = join(work, 'previous-community')
    await install(legacyInstaller, legacyDirectory, 'install-legacy', join(work, 'legacy-installer-home'))
    await node('acceptance.mjs', [installedTarget, '--legacy-executable=' + join(legacyDirectory, 'DSH Desktop.exe')], 'legacy-migration')
    migration = json(join(target.output, 'acceptance.json'))
    assert.equal(migration.legacyProfileMigration, true)
  }

  if (selected.has('fresh-install-recovery')) {
    // The single-install path of signed installed acceptance: a fresh Profile,
    // interrupted runtime repair, then explicit credential-file recovery.
    await node('acceptance.mjs', [installedTarget], 'fresh-install-recovery', { AGENTROUTER_ACCEPTANCE_STATE: acceptanceState })
    freshInstallRecovery = json(join(target.output, 'acceptance.json'))
    assert.equal(freshInstallRecovery.productUpgrade, false)
    assert.equal(freshInstallRecovery.externalBrowserNavigation, true)
    assert.equal(freshInstallRecovery.runtimeRecovery?.passed, true)
    assert.equal(freshInstallRecovery.credentialRecovery?.existingSessionRetained, true)
    assert.equal(freshInstallRecovery.credentialRecovery?.signInAvailable, true)
  }
  const receipt = { schemaVersion: 1, passed: true, testOnly: true, signed: Boolean(signedTarget),
    productVersion: target.input.productVersion, plugin: target.input.plugin, patchSha256: target.patchSha256,
    targetInstaller: targetPackage, legacyInstaller: legacy,
    freshInstallerExecuted: true, nativeUpdaterExecuted: nativeUpdater, installerRestartedApp: nativeUpdater,
    legacyInstallerExecuted: selected.has('legacy-migration'), publicFeedChanged: false, update, migration,
    nativeSignatureVerificationExecuted: Boolean(signedTarget) && nativeUpdater, rootTrustInstalled: false,
    differential, feedRequests: [...new Set(requests)], installs }
  if (scenario) Object.assign(receipt, { scenario, freshInstallRecovery })
  writeJson(join(target.output, 'installer-acceptance.json'), receipt)
  console.log(JSON.stringify({ passed: true, receipt: join(target.output, 'installer-acceptance.json') }))
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
