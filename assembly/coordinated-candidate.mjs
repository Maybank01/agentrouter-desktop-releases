import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { root } from './lib.mjs'

// PR CI runs one installed scenario per disposable worker. release.yml passes
// none and keeps the full sequence: native update, then legacy migration.
const scenarioComplete = {
  'native-updater': receipt => receipt.nativeUpdaterExecuted === true && receipt.installerRestartedApp === true
    && receipt.update?.installerUpgrade === true,
  'legacy-migration': receipt => receipt.legacyInstallerExecuted === true && receipt.migration?.legacyProfileMigration === true,
  'fresh-install-recovery': receipt => receipt.freshInstallerExecuted === true
    && receipt.freshInstallRecovery?.runtimeRecovery?.passed === true
    && receipt.freshInstallRecovery?.credentialRecovery?.existingSessionRetained === true
    && receipt.freshInstallRecovery?.externalBrowserNavigation === true,
}
export const installedScenarios = Object.keys(scenarioComplete)

export function parseScenario(argv) {
  const scenario = argv.find(value => value.startsWith('--scenario='))?.slice('--scenario='.length)
  if (scenario !== undefined && !Object.hasOwn(scenarioComplete, scenario)) throw new Error(`Unknown installed scenario: ${scenario}`)
  return scenario
}

export function assertInstalledReceipt(receipt, scenario) {
  if (receipt.passed !== true) throw new Error('Installed acceptance did not pass')
  if (scenario === undefined) {
    if (receipt.scenario !== undefined || !receipt.nativeUpdaterExecuted || !receipt.legacyInstallerExecuted) throw new Error('Installed acceptance is incomplete')
  } else if (receipt.scenario !== scenario || !scenarioComplete[scenario](receipt)) {
    throw new Error(`Installed ${scenario} acceptance is incomplete`)
  }
  return receipt
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const scenario = parseScenario(process.argv)
  const logs = join(root, '.local/coordinated-delivery')
  mkdirSync(logs, { recursive: true })
  const run = (script, args, name) => {
    const output = execFileSync(process.execPath, [join(root, 'assembly/coordinated', script), ...args],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true,
        maxBuffer: 32 * 1024 * 1024, timeout: 2400000 })
    writeFileSync(join(logs, name + '.log'), output)
    return JSON.parse(output.trim().split(/\r?\n/).at(-1))
  }
  const { candidate } = run('build.mjs', [], 'build')
  const { receipt } = run('installer-acceptance.mjs', [candidate, ...(scenario ? ['--scenario=' + scenario] : [])], 'installed')
  const accepted = assertInstalledReceipt(JSON.parse(readFileSync(receipt, 'utf8')), scenario)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `receipt=${JSON.stringify(accepted)}\n`)
  console.log(JSON.stringify(accepted))
}
