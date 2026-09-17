/** Build an isolated, unsigned Windows directory candidate from exact public npm bytes. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'tsdown'
import { valid } from 'semver'
import { load as loadYaml } from 'js-yaml'
import { register } from 'tsx/esm/api'
import { directory, root, lock, prepareSource } from './prepare.mjs'
register()

const input = JSON.parse(readFileSync(resolve(process.argv[2] ?? join(directory, 'release.json')), 'utf8'))
assert.equal(process.platform, 'win32', 'Only the Windows candidate has been qualified.')
assert.equal(input.schemaVersion, 1)
assert.equal(valid(input.productVersion), input.productVersion)
assert.equal(input.dshVersion, lock.dshVersion)
assert.equal(input.plugin.name, '@agentrouter-top/dsh-codex')
assert.equal(valid(input.plugin.version), input.plugin.version)
assert.match(input.plugin.sha256, /^[0-9a-f]{64}$/)
assert.match(input.plugin.integrity, /^sha512-[A-Za-z0-9+/]+=*$/)
const feed = new URL(input.updateUrl)
assert.equal(feed.protocol, 'https:')
assert.equal(feed.username + feed.password + feed.search + feed.hash, '')
const { source, output } = prepareSource()
const json = path => JSON.parse(readFileSync(path, 'utf8'))
const writeJson = (path, data) => writeFileSync(path, JSON.stringify(data, null, 2) + '\n')
writeJson(join(source, 'apps/desktop/package.json'), { ...json(join(source, 'apps/desktop/package.json')), version: input.productVersion })
writeJson(join(source, 'apps/desktop/product-release.json'), { productVersion: input.productVersion,
  managedPlugins: [{ name: input.plugin.name, version: input.plugin.version }], updateUrl: input.updateUrl })
const digest = (bytes, type = 'sha256', format = 'hex') => createHash(type).update(bytes).digest(format)
const cache = join(root, '.local/coordinated/npm-cache')
mkdirSync(cache, { recursive: true })
async function download(url, integrity, max = 40000000) {
  assert.equal(new URL(url).origin, 'https://registry.npmjs.org')
  const cached = integrity ? join(cache, digest(Buffer.from(integrity)) + '.tgz') : undefined
  if (cached && existsSync(cached)) {
    const bytes = readFileSync(cached)
    assert.equal('sha512-' + digest(bytes, 'sha512', 'base64'), integrity)
    return bytes
  }
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60000) })
  assert.equal(response.status, 200, url)
  const chunks = []; let size = 0
  for await (const part of response.body) { size += part.length; assert.ok(size <= max); chunks.push(part) }
  const bytes = Buffer.concat(chunks)
  if (integrity) assert.equal('sha512-' + digest(bytes, 'sha512', 'base64'), integrity)
  if (cached) writeFileSync(cached, bytes)
  return bytes
}
const published = JSON.parse(await download(`https://registry.npmjs.org/${encodeURIComponent(input.plugin.name)}/${input.plugin.version}`))
assert.equal(published.dist.integrity, input.plugin.integrity)
const pluginBytes = await download(published.dist.tarball, input.plugin.integrity)
assert.equal(digest(pluginBytes), input.plugin.sha256)
writeFileSync(join(output, 'agentrouter-plugin.tgz'), pluginBytes)

const app = join(output, 'app')
const resources = join(output, 'resources')
const seed = join(resources, 'seed')
mkdirSync(seed, { recursive: true })
mkdirSync(app, { recursive: true })
const host = join(output, 'desktop-host')
mkdirSync(join(host, 'config'), { recursive: true })
const hostManifest = json(join(source, 'apps/desktop-host/package.json'))
hostManifest.dependencies = Object.fromEntries(Object.entries(hostManifest.dependencies).map(([name, version]) => [name,
  version.startsWith('workspace:') ? json(join(directory, 'node_modules', name, 'package.json')).version : version]))
hostManifest.version = lock.dshVersion
delete hostManifest.devDependencies
delete hostManifest.scripts
writeJson(join(host, 'package.json'), hostManifest)
await build({ config: false, cwd: source, entry: { index: join(source, 'apps/desktop-host/src/index.ts') },
  outDir: join(host, 'lib'), format: 'esm', platform: 'node', target: 'node24', fixedExtension: false, dts: false,
  deps: { neverBundle: [/^@deepseek-ai\//] }, logLevel: 'error' })
copyFileSync(join(source, 'apps/desktop-host/config/desktop.cordis.patch.yml'), join(host, 'config/desktop.cordis.patch.yml'))

const coreDir = join(seed, 'desktop-packages')
mkdirSync(coreDir)
const npmLock = json(join(directory, 'package-lock.json'))
const packages = []
const firstParty = Object.entries(npmLock.packages).filter(([path]) => /^node_modules\/@deepseek-ai\/[^/]+$/.test(path))
for (let offset = 0; offset < firstParty.length; offset += 6) {
  await Promise.all(firstParty.slice(offset, offset + 6).map(async ([path, pkg]) => {
    const name = path.slice('node_modules/'.length)
    assert.ok(!name.includes('/node_modules/'))
    const bytes = await download(pkg.resolved, pkg.integrity)
    const file = name.replace('@', '').replace('/', '-') + '-' + pkg.version + '.tgz'
    writeFileSync(join(coreDir, file), bytes)
    packages.push({ name, version: pkg.version, file, bytes: bytes.length, integrity: pkg.integrity })
  }))
}
// Only the official private host is compiled here; the AgentRouter plugin above
// must be byte-identical to its already published public registry artifact.
const { c } = await import('tar')
const hostFile = `deepseek-ai-dsh-desktop-host-${lock.dshVersion}.tgz`
await c({ cwd: host, file: join(coreDir, hostFile), gzip: true, prefix: 'package' }, ['package.json', 'lib', 'config'])
const hostBytes = readFileSync(join(coreDir, hostFile))
packages.push({ name: hostManifest.name, version: lock.dshVersion, file: hostFile, bytes: hostBytes.length,
  integrity: 'sha512-' + digest(hostBytes, 'sha512', 'base64') })
packages.sort((a, b) => a.name.localeCompare(b.name))
writeJson(join(seed, 'desktop-packages.json'), { schemaVersion: 1, packages })
const { createSeedMetadata } = await import(pathToFileURL(join(source, 'apps/desktop/src/project-manager.ts')).href)
createSeedMetadata(seed, { schemaVersion: 1, version: lock.dshVersion, productVersion: input.productVersion,
  managedPlugins: [{ name: input.plugin.name, version: input.plugin.version }], hostProtocolVersion: 3,
  nodeVersion: process.versions.node, pnpmVersion: json(join(directory, 'node_modules/pnpm/package.json')).version })
const store = join(output, 'store')
const env = { ...process.env, DSH_HOME: join(output, 'test-home'), DSH_TELEMETRY_DISABLED: '1' }
for (const key of Object.keys(env)) if (/API_KEY|CODEX_HOME|RELAY_CODEX|NODE_OPTIONS|NODE_AUTH_TOKEN|NPM_TOKEN|^(?:WIN_)?CSC_|^(?:GH_TOKEN|GITHUB_TOKEN|DSH_DESKTOP_WINDOWS_)/i.test(key)) delete env[key]
writeFileSync(join(output, 'npmrc'), 'registry=https://registry.npmjs.org/\n')
env.NPM_CONFIG_USERCONFIG = join(output, 'npmrc')
const pnpm = join(directory, 'node_modules/pnpm/bin/pnpm.mjs')
execFileSync(process.execPath, [pnpm, `--config.store-dir=${store}`, '--config.enable-global-virtual-store=false',
  'install', '--lockfile-only'], { cwd: seed, env, stdio: 'inherit', windowsHide: true, timeout: 480000 })
const seedLock = loadYaml(readFileSync(join(seed, 'pnpm-lock.yaml'), 'utf8'))
assert.equal(seedLock.packages[`${input.plugin.name}@${input.plugin.version}`].resolution.integrity, input.plugin.integrity,
  'The seed must resolve the same published plugin bytes verified before assembly.')
execFileSync(process.execPath, [pnpm, `--config.store-dir=${store}`, '--config.enable-global-virtual-store=false',
  'fetch', '--prod'], { cwd: seed, env, stdio: 'inherit', windowsHide: true, timeout: 480000 })
const fetchedModules = resolve(seed, 'node_modules')
assert.ok(fetchedModules.startsWith(resolve(output) + sep))
rmSync(fetchedModules, { recursive: true, force: true })
const { archivePnpmStore, removePnpmProjectRegistrations } = await import(pathToFileURL(join(source, 'apps/desktop/src/seed-store.ts')).href)
removePnpmProjectRegistrations(store)
archivePnpmStore(seed, store)
const inventory = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const path = join(dir, entry.name)
  if (entry.isDirectory()) return inventory(path)
  const bytes = readFileSync(path)
  return [{ path: relative(seed, path).replaceAll('\\', '/'), bytes: bytes.length, sha256: digest(bytes) }]
})
writeJson(join(seed, 'integrity.json'), { schemaVersion: 2, files: inventory(seed) })
await build({ config: false, cwd: source, entry: { main: join(source, 'apps/desktop/src/main.ts') },
  outDir: join(app, 'lib'), format: 'esm', platform: 'node', target: 'node24', fixedExtension: false, dts: false,
  deps: { alwaysBundle: [/.*/], neverBundle: ['electron'] }, logLevel: 'error' })
await build({ config: false, cwd: source, entry: { preload: join(source, 'apps/desktop/src/preload.ts'),
  'preload-app': join(source, 'apps/desktop/src/preload-app.ts') }, outDir: join(app, 'lib'), format: 'cjs',
  platform: 'node', target: 'node24', fixedExtension: false, dts: false, clean: false,
  deps: { alwaysBundle: [/.*/], neverBundle: ['electron'] }, logLevel: 'error' })
cpSync(join(source, 'apps/desktop/renderer'), join(app, 'renderer'), { recursive: true })
copyFileSync(join(source, 'LICENSE'), join(app, 'LICENSE'))
writeJson(join(app, 'package.json'), { name: '@agentrouter/desktop', productName: 'AgentRouter',
  version: input.productVersion, main: 'lib/main.js', type: 'module', private: true })
mkdirSync(join(resources, 'runtime/node'), { recursive: true })
copyFileSync(process.execPath, join(resources, 'runtime/node/node.exe'))
cpSync(join(directory, 'node_modules/pnpm'), join(resources, 'runtime/pnpm'), { recursive: true })
writeJson(join(resources, 'runtime/versions.json'), { node: process.versions.node,
  pnpm: json(join(directory, 'node_modules/pnpm/package.json')).version })
const electronRoot = join(directory, 'node_modules/electron')
if (!existsSync(join(electronRoot, 'dist/electron.exe'))) execFileSync(process.execPath, [join(electronRoot, 'install.js')], {
  cwd: directory, env, stdio: 'inherit', windowsHide: true, timeout: 300000 })
const unpacked = join(output, 'win-unpacked')
cpSync(join(electronRoot, 'dist'), unpacked, { recursive: true })
const executable = join(unpacked, 'AgentRouter.exe')
renameSync(join(unpacked, 'electron.exe'), executable)
cpSync(resources, join(unpacked, 'resources'), { recursive: true })
cpSync(app, join(unpacked, 'resources/app'), { recursive: true })
writeFileSync(join(output, 'Inspect-AgentRouter.cmd'), '@echo off\r\nsetlocal\r\nset "DSH_HOME=%~dp0inspection-home"\r\nset "DSH_TELEMETRY_DISABLED=1"\r\n"%~dp0win-unpacked\\AgentRouter.exe" "--user-data-dir=%~dp0inspection-electron"\r\n')
// No app-update.yml: an unsigned local candidate must not consume the public feed.
writeJson(join(output, 'candidate.json'), { schemaVersion: 1, source, output, unpacked, executable, input,
  upstreamCommit: lock.commit, patchSha256: digest(readFileSync(join(directory, lock.patch))),
  pluginSha256: digest(pluginBytes), signed: false, installer: false, publicFeedsChanged: false, acceptancePassed: false })
console.log(JSON.stringify({ output, unpacked, candidate: join(output, 'candidate.json') }))
