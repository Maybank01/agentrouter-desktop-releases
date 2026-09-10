import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { root, upstream, plugins, validateLocks, allowedChanges,
  npmChannel, preinstalledManifest, preinstallPatch, preapprovedYarnRc } from '../lib.mjs'

test('only the locked upstream and public npm packages are assembly inputs', () => {
  validateLocks()
  assert.equal(upstream.packageManager, 'yarn@4.18.0')
  assert.equal(plugins.packages.filter(pkg => pkg.direct).length, 2)
  assert.equal(plugins.packages.filter(pkg => pkg.preinstallEntry).length, 1)
  assert.ok(Number.isSafeInteger(plugins.releaseSequence) && plugins.releaseSequence >= 2)
  assert.deepEqual(npmChannel.packages.map(pkg => pkg.distTag ?? pkg.fromPackage),
    ['next', '@agentrouter-top/dsh-codex', 'beta'])
  assert.deepEqual(allowedChanges, ['dsh-plugin-desktop/package.json',
    'dsh-plugin-desktop/cordis.patch.yml', 'yarn.lock', '.yarnrc.yml'])
})

test('composition changes dependencies without replacing app identity or Electron entry', () => {
  const original = { name: 'dsh-plugin-desktop', main: 'lib/main.js', version: '2.0.5',
    dependencies: { original: '1.0.0' }, build: { appId: 'ai.deepseek.dsh.desktop' } }
  const actual = preinstalledManifest(original)
  const direct = Object.fromEntries(plugins.packages.filter(pkg => pkg.direct).map(pkg => [pkg.name, pkg.version]))
  assert.deepEqual(actual, { ...original,
    dependencies: { original: '1.0.0', ...direct } })
  assert.deepEqual(original.dependencies, { original: '1.0.0' })
  assert.doesNotMatch(JSON.stringify(actual), /workspace:|file:|desktop-product|electron-updater/)
})

test('preinstallation is additive and does not disable the native updater or other providers', () => {
  const patch = preinstallPatch()
  assert.match(patch, /@agentrouter-top\/dsh-codex\/desktop-preinstall/)
  assert.match(patch, /productProfile: true/)
  assert.doesNotMatch(patch, /disabled:|desktop-updates|deepseek|CODEX_HOME|desktopRuntime|relay-codex-host/)
  assert.equal((patch.match(/- insert:/g) ?? []).length, 1)
})

test('fresh-package exceptions are exact, preserve upstream settings and never disable quarantine', () => {
  const original = 'enableScripts: false\nnpmPreapprovedPackages:\n  - "original@1.0.0"\nnodeLinker: node-modules\n'
  const actual = preapprovedYarnRc(original)
  for (const pkg of plugins.packages) assert.ok(actual.includes(`"${pkg.name}@${pkg.version}"`))
  assert.ok(actual.includes('"original@1.0.0"'))
  assert.doesNotMatch(actual, /npmMinimalAgeGate|npmAuditExcludePackages|enableScripts: true|\*/)
  assert.throws(() => preapprovedYarnRc('nodeLinker: node-modules\n'))
})

test('builder retains upstream preflight and records unaccepted lifecycle gates honestly', () => {
  const source = readFileSync(join(root, 'assembly/build.mjs'), 'utf8')
  const helpers = readFileSync(join(root, 'assembly/lib.mjs'), 'utf8')
  assert.match(source, /'dist:win'/)
  assert.doesNotMatch(source, /DSH_PACKAGE_CHECK_ALREADY_RAN|desktop-product\/main|components-release|\.\.\/packages\//)
  assert.match(source, /freshInstalledPreinstall: false/)
  assert.match(source, /pluginUpdateAndRemoval: false/)
  assert.match(source, /publicPromotionEligible: false/)
  assert.match(helpers, /AGENTROUTER_COREPACK/)
  assert.match(helpers, /process\.execPath/)
})
