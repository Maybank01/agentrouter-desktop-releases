/** Real pnpm 10 -> 11 transactions. Fixture core, exact public third-party plugin, disposable Homes. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { load, dump } from 'js-yaml'
import { c } from 'tar'
import { register } from 'tsx/esm/api'
import { directory, prepareSource } from './prepare.mjs'
register()

const { source, output } = prepareSource()
const { DesktopProjectManager, createSeedMetadata } = await import(pathToFileURL(join(source, 'apps/desktop/src/project-manager.ts')))
const { resolveDesktopPaths } = await import(pathToFileURL(join(source, 'apps/desktop/src/paths.ts')))
const { archivePnpmStore, removePnpmProjectRegistrations } = await import(pathToFileURL(join(source, 'apps/desktop/src/seed-store.ts')))
const json = path => JSON.parse(readFileSync(path, 'utf8'))
const writeJson = (path, data) => writeFileSync(path, JSON.stringify(data, null, 2) + '\n')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const pnpm10 = join(directory, 'node_modules/pnpm10/bin/pnpm.cjs')
const pnpm11 = join(directory, 'node_modules/pnpm/bin/pnpm.mjs')
const versions = { from: json(join(dirname(dirname(pnpm10)), 'package.json')).version,
  to: json(join(dirname(dirname(pnpm11)), 'package.json')).version }
assert.equal(versions.from, '10.27.0')
assert.equal(versions.to, '11.7.0')
const thirdParty = { name: 'dsh-image-viewer', version: '0.1.0-beta.11',
  integrity: 'sha512-Ea0u5MKSNYvyazirUM8i+o8B4fz9Uv6B+Cl4o39QJFXVe/FT/Dphv1kwzNr6u5mp8Do2GviV0isKuTQ17Z2WiQ==' }
const base = join(output, 'store-acceptance')
mkdirSync(base)
const npmrc = join(base, 'npmrc')
writeFileSync(npmrc, 'registry=https://registry.npmjs.org/\n')
const env = { ...process.env }
for (const name of Object.keys(env)) if (/^(?:npm|pnpm|corepack)_/i.test(name)
  || /API_KEY|CODEX_HOME|RELAY_CODEX|NODE_OPTIONS|NODE_PATH|NODE_AUTH_TOKEN|NPM_TOKEN|ELECTRON_RUN_AS_NODE/i.test(name)) delete env[name]
Object.assign(env, { DSH_HOME: join(base, 'seed-home'), DSH_TELEMETRY_DISABLED: '1', CI: '1', NPM_CONFIG_USERCONFIG: npmrc })
const execute = (bin, project, store, args) => execFileSync(process.execPath, [bin,
  `--config.store-dir=${store}`, '--config.enable-global-virtual-store=false', `--config.userconfig=${npmrc}`,
  ...args], { cwd: project, env, encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 4 * 1024 * 1024 })
const snapshot = root => {
  const files = {}
  const visit = dir => { for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) visit(path)
    else { assert.ok(entry.isFile(), 'Fixture must not traverse links'); files[relative(root, path)] = digest(readFileSync(path)) }
  } }
  visit(root)
  return files
}

const core = join(base, 'core')
mkdirSync(core)
const records = []
for (const name of ['@deepseek-ai/dsh', '@deepseek-ai/dsh-desktop-host']) {
  const fixture = join(base, name.split('/')[1])
  mkdirSync(fixture)
  writeJson(join(fixture, 'package.json'), { name, version: '0.1.5-rc.2' })
  const file = name.replace('@', '').replace('/', '-') + '.tgz'
  await c({ cwd: fixture, file: join(core, file), gzip: true, prefix: 'package' }, ['package.json'])
  const bytes = readFileSync(join(core, file))
  records.push({ name, version: '0.1.5-rc.2', file, bytes: bytes.length,
    integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') })
}
records.sort((a, b) => a.name.localeCompare(b.name))
const release = productVersion => ({ schemaVersion: 1, version: '0.1.5-rc.2', productVersion, managedPlugins: [],
  hostProtocolVersion: 3, nodeVersion: process.versions.node, pnpmVersion: versions.to })
const metadata = (dir, productVersion) => {
  mkdirSync(dir, { recursive: true })
  cpSync(core, join(dir, 'desktop-packages'), { recursive: true })
  writeJson(join(dir, 'desktop-packages.json'), { schemaVersion: 1, packages: records })
  createSeedMetadata(dir, release(productVersion))
}
const seed = join(base, 'seed')
metadata(seed, '3.0.2')
const seedStore = join(base, 'seed-store')
execute(pnpm11, seed, seedStore, ['install', '--lockfile-only', '--ignore-scripts'])
execute(pnpm11, seed, seedStore, ['fetch', '--ignore-scripts'])
removePnpmProjectRegistrations(seedStore)
archivePnpmStore(seed, seedStore)
// Only transport metadata and archives are part of the seed, never fetched node_modules.
const fetchedModules = resolve(seed, 'node_modules')
assert.ok(fetchedModules.startsWith(resolve(output) + sep))
rmSync(fetchedModules, { recursive: true, force: true })
const inventory = Object.entries(snapshot(seed))
  .map(([path, sha256]) => ({ path: path.replaceAll('\\', '/'), bytes: readFileSync(join(seed, path)).length, sha256 }))
writeJson(join(seed, 'integrity.json'), { schemaVersion: 2, files: inventory })

const trace = join(base, 'pnpm-trace.jsonl')
const recordingPnpm = join(base, 'recording-pnpm.mjs')
writeFileSync(recordingPnpm, `
import { spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
const result = spawnSync(process.execPath, [${JSON.stringify(pnpm11)}, ...args], { env: process.env,
  cwd: process.cwd(), encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 4 * 1024 * 1024 })
appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ args, status: result.status,
  codes: (String(result.stdout) + String(result.stderr)).match(/ERR_PNPM_[A-Z_]+/g) ?? [] }) + '\\n')
process.stdout.write(result.stdout ?? '')
process.stderr.write(result.stderr ?? '')
process.exit(result.status ?? 1)
`)
const oldProfile = name => {
  const home = join(base, name)
  const paths = resolveDesktopPaths(home)
  metadata(paths.profile, '3.0.2')
  execute(pnpm10, paths.profile, paths.pnpm.store, ['add', `${thirdParty.name}@${thirdParty.version}`, '--save-exact', '--ignore-scripts'])
  const manifest = json(join(paths.profile, 'package.json'))
  manifest.dsh.profile.bundles.push(thirdParty.name)
  writeJson(join(paths.profile, 'package.json'), manifest)
  assert.equal(load(readFileSync(join(paths.profile, 'pnpm-lock.yaml'), 'utf8')).packages[
    `${thirdParty.name}@${thirdParty.version}`].resolution.integrity, thirdParty.integrity)
  writeFileSync(join(paths.profile, 'cordis.patch.yml'), '# user settings\n[]\n')
  const protectedRoot = join(home, 'data-fixture')
  mkdirSync(protectedRoot)
  writeFileSync(join(protectedRoot, 'credentials.json'), '{"syntheticCredential":"test-only"}\n')
  writeFileSync(join(protectedRoot, 'session.json'), '{"messages":["keep this conversation"]}\n')
  writeFileSync(join(protectedRoot, 'attachment.txt'), 'keep this attachment\n')
  const modules = load(readFileSync(join(paths.profile, 'node_modules/.modules.yaml'), 'utf8'))
  assert.match(modules.packageManager, /^pnpm@10\./)
  return { paths, protectedRoot, protectedBefore: snapshot(protectedRoot), oldModules: modules,
    manager: new DesktopProjectManager(paths, { node: process.execPath, pnpm: recordingPnpm }) }
}
const hooks = () => ({ healthCheck: async project => {
  assert.equal(json(join(project, 'node_modules', thirdParty.name, 'package.json')).version, thirdParty.version)
  assert.match(load(readFileSync(join(project, 'node_modules/.modules.yaml'), 'utf8')).packageManager, /^pnpm@11\./)
}, beforeActivate: async () => {}, afterActivate: async () => {} })
const verify = fixture => {
  assert.deepEqual(fixture.manager.listPlugins(), [{ name: thirdParty.name, version: thirdParty.version }])
  assert.equal(readFileSync(join(fixture.paths.profile, 'cordis.patch.yml'), 'utf8'), '# user settings\n[]\n')
  assert.deepEqual(snapshot(fixture.protectedRoot), fixture.protectedBefore)
}

const same = oldProfile('same-release')
assert.equal(await same.manager.applyRelease(seed, '3.0.2', hooks(same)), true)
verify(same)
const after = snapshot(same.paths.profile)
assert.equal(await same.manager.applyRelease(seed, '3.0.2', hooks(same)), false)
assert.deepEqual(snapshot(same.paths.profile), after)
assert.notEqual(load(readFileSync(join(same.paths.profile, 'node_modules/.modules.yaml'), 'utf8')).storeDir, same.oldModules.storeDir)

const upgrade = oldProfile('product-upgrade')
// Same immutable target, distinct installed product identity: exercise seed + user-plugin reconciliation.
writeJson(join(upgrade.paths.profile, 'desktop-release.json'), release('3.0.1'))
assert.equal(await upgrade.manager.applyRelease(seed, '3.0.2', hooks(upgrade)), true)
verify(upgrade)

// pnpm's offline resolver reports an absent version in an existing registry
// index as NO_MATCHING_VERSION, not NO_OFFLINE_META. Exercise the real resolver
// with an old index and require one online refresh of the same exact version.
const stale = oldProfile('stale-registry-index')
writeJson(join(stale.paths.profile, 'desktop-release.json'), release('3.0.1'))
const staleIndex = join(stale.paths.pnpm.cache, 'pnpm/v11/metadata/registry.npmjs.org', `${thirdParty.name}.jsonl`)
mkdirSync(dirname(staleIndex), { recursive: true })
writeFileSync(staleIndex, '{}\n' + JSON.stringify({ name: thirdParty.name,
  'dist-tags': { latest: '0.1.0-beta.10' },
  versions: { '0.1.0-beta.10': { name: thirdParty.name, version: '0.1.0-beta.10' } } }) + '\n')
const traceOffset = readFileSync(trace, 'utf8').length
assert.equal(await stale.manager.applyRelease(seed, '3.0.2', hooks(stale)), true)
verify(stale)
assert.equal(json(join(stale.paths.profile, 'package.json')).dependencies[thirdParty.name], thirdParty.version)
const staleCommands = readFileSync(trace, 'utf8').slice(traceOffset).trim().split('\n').map(line => JSON.parse(line))
assert.equal(staleCommands.filter(entry => entry.codes.includes('ERR_PNPM_NO_MATCHING_VERSION')).length, 1)
assert.equal(staleCommands.filter(entry => entry.args.includes('--prefer-offline=false') && entry.status === 0).length, 1)
assert.equal(await stale.manager.applyRelease(seed, '3.0.2', hooks(stale)), false)

const failed = oldProfile('failed-prepare')
const lockPath = join(failed.paths.profile, 'pnpm-lock.yaml')
const originalLock = readFileSync(lockPath, 'utf8')
const badLock = load(originalLock)
badLock.packages[`${thirdParty.name}@${thirdParty.version}`].resolution.tarball = 'http://127.0.0.1:9/unavailable.tgz'
writeFileSync(lockPath, dump(badLock))
const beforeFailure = snapshot(failed.paths.profile)
await assert.rejects(failed.manager.applyRelease(seed, '3.0.2', hooks(failed)))
assert.deepEqual(snapshot(failed.paths.profile), beforeFailure)
verify(failed)
writeFileSync(lockPath, originalLock)
const beforeHealth = snapshot(failed.paths.profile)
await assert.rejects(failed.manager.applyRelease(seed, '3.0.2', { ...hooks(failed),
  healthCheck: async () => { throw new Error('acceptance: staged host rejected') } }), /staged host rejected/)
assert.deepEqual(snapshot(failed.paths.profile), beforeHealth)
let starts = 0
await assert.rejects(failed.manager.applyRelease(seed, '3.0.2', { ...hooks(failed),
  afterActivate: async () => { if (++starts === 1) throw new Error('acceptance: replacement host rejected') } }), /replacement host rejected/)
assert.equal(starts, 2)
assert.deepEqual(snapshot(failed.paths.profile), beforeHealth)
assert.equal(await failed.manager.applyRelease(seed, '3.0.2', hooks(failed)), true)
verify(failed)
assert.equal(await failed.manager.applyRelease(seed, '3.0.2', hooks(failed)), false)
const commands = readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line))
assert.ok(commands.some(entry => entry.codes.some(code => /^ERR_PNPM_NO_OFFLINE_(?:META|TARBALL)$/.test(code))))
assert.ok(commands.some(entry => entry.args.includes('--prefer-offline') && entry.status === 0))
const receipt = { passed: true, verifiedAt: new Date().toISOString(), platform: process.platform, node: process.versions.node,
  upstreamCommit: json(join(output, 'source.json')).upstreamCommit,
  patchSha256: digest(readFileSync(join(directory, 'coordinated-delivery.patch'))), pnpm: versions, thirdParty,
  actualPnpmExecutables: true, fixtureCore: true, electronGui: false, sameReleaseRepair: true, productUpgrade: true,
  staleRegistryMetadataRefreshed: true, exactUserVersionPreserved: true,
  missingOldStorePackagesFetched: true, repeatedStartupDoesNotRebuild: true,
  preparationFailurePreservesActive: true, healthFailurePreservesActive: true, activationFailureRestoresActive: true,
  thirdPartyAndConfigurationPreserved: true, syntheticDataPreserved: true, retrySucceeds: true,
  personalHomeUsed: false, publicFeedsChanged: false }
writeJson(join(base, 'acceptance.json'), receipt)
console.log(JSON.stringify({ ...receipt, output: base }))
