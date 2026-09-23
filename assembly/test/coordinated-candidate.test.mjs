import assert from 'node:assert/strict'
import test from 'node:test'
import { assertInstalledReceipt, installedScenarios, parseScenario } from '../coordinated-candidate.mjs'

const full = () => ({ passed: true, nativeUpdaterExecuted: true, installerRestartedApp: true, legacyInstallerExecuted: true,
  freshInstallerExecuted: true, update: { installerUpgrade: true }, migration: { legacyProfileMigration: true } })
const scenarioReceipts = {
  'native-updater': () => ({ ...full(), scenario: 'native-updater', legacyInstallerExecuted: false, migration: undefined }),
  'legacy-migration': () => ({ ...full(), scenario: 'legacy-migration', nativeUpdaterExecuted: false, installerRestartedApp: false, update: undefined }),
  'fresh-install-recovery': () => ({ passed: true, scenario: 'fresh-install-recovery', freshInstallerExecuted: true,
    nativeUpdaterExecuted: false, legacyInstallerExecuted: false,
    freshInstallRecovery: { externalBrowserNavigation: true, runtimeRecovery: { passed: true }, credentialRecovery: { existingSessionRetained: true } } }),
}

test('PR CI scenarios are the three installed acceptance paths; release passes none', () => {
  assert.deepEqual(installedScenarios, Object.keys(scenarioReceipts))
  assert.equal(parseScenario(['node', 'coordinated-candidate.mjs']), undefined)
  for (const name of installedScenarios) assert.equal(parseScenario(['node', 'x', '--scenario=' + name]), name)
  assert.throws(() => parseScenario(['node', 'x', '--scenario=signed']))
})

test('the release default still requires native update and legacy migration in one receipt', () => {
  assert.ok(assertInstalledReceipt(full(), undefined))
  for (const change of [r => { r.passed = false }, r => { r.nativeUpdaterExecuted = false },
    r => { r.legacyInstallerExecuted = false }, r => { r.scenario = 'native-updater' }]) {
    const receipt = full(); change(receipt); assert.throws(() => assertInstalledReceipt(receipt, undefined))
  }
  // A single-scenario receipt can never stand in for the full release acceptance.
  for (const name of installedScenarios) assert.throws(() => assertInstalledReceipt(scenarioReceipts[name](), undefined))
})

test('each scenario receipt must name and complete its own scenario', () => {
  for (const name of installedScenarios) {
    assert.ok(assertInstalledReceipt(scenarioReceipts[name](), name))
    for (const other of installedScenarios.filter(value => value !== name)) {
      assert.throws(() => assertInstalledReceipt(scenarioReceipts[other](), name))
    }
  }
  const runtime = scenarioReceipts['fresh-install-recovery']()
  runtime.freshInstallRecovery.runtimeRecovery.passed = false
  assert.throws(() => assertInstalledReceipt(runtime, 'fresh-install-recovery'))
  const navigation = scenarioReceipts['fresh-install-recovery']()
  navigation.freshInstallRecovery.externalBrowserNavigation = false
  assert.throws(() => assertInstalledReceipt(navigation, 'fresh-install-recovery'))
  const migration = scenarioReceipts['legacy-migration']()
  migration.migration.legacyProfileMigration = false
  assert.throws(() => assertInstalledReceipt(migration, 'legacy-migration'))
})
