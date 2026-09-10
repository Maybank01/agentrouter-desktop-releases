/** Build-time orchestration only; application entry, identity and updater are upstream's. */
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { prepare } from './prepare.mjs'
import { upstream, plugins, readJson, canonicalJson, sha256, buildEnvironment, run, yarn, verifySource } from './lib.mjs'

const args = process.argv.slice(2)
assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--source'), 'Usage: build.mjs [--source <prepared checkout>]')
assert.equal(process.platform, 'win32', 'The accepted candidate platform is Windows x64')
assert.equal(process.arch, 'x64')
const source = args.length ? resolve(args[1]) : (await prepare()).source
const output = dirname(source)
verifySource(source, { prepared: true, built: true })
const env = buildEnvironment(output)
// Use the upstream's own checks and unsigned packaging entry without bypass flags.
yarn(source, env, 'workspace', 'dsh-community-market', 'build')
yarn(source, env, 'workspace', upstream.application, 'build')
yarn(source, env, 'workspace', upstream.application, 'verify:profile')
yarn(source, env, 'workspace', upstream.application, 'verify:notices')
const application = join(source, upstream.application)
const require = createRequire(join(application, 'package.json'))
// Lifecycle builds were deliberately disabled by the upstream Yarn policy.
// Electron's explicit upstream downloader prepares the pinned packaging binary.
if (!existsSync(join(dirname(require.resolve('electron/package.json')), 'dist/electron.exe'))) {
  run(process.execPath, [require.resolve('electron/install.js')], source, env)
}
yarn(source, env, 'workspace', upstream.application, 'dist:win')
const verified = verifySource(source, { prepared: true, built: true })
const distribution = join(application, 'dist')
const assets = readdirSync(distribution).filter(name => /\.(?:exe|blockmap)$/.test(name)).map(name => {
  const bytes = readFileSync(join(distribution, name))
  return { name, bytes: bytes.length, sha256: sha256(bytes) }
})
assert.ok(assets.some(asset => asset.name.endsWith('-Setup.exe')), 'Upstream installer missing')
const packaged = join(distribution, 'win-unpacked/resources/app.asar.unpacked')
const metadata = readJson(join(packaged, 'package.json'))
assert.equal(metadata.main, 'lib/main.js', 'No custom Electron entry is permitted')
assert.equal(metadata.name, upstream.application)
for (const pkg of plugins.packages) {
  assert.equal(readJson(join(packaged, 'node_modules', pkg.name, 'package.json')).version, pkg.version)
}
const record = { schemaVersion: 1, ...verified, upstreamVersion: upstream.tag,
  environment: plugins.environment, packages: plugins.packages, assets,
  acceptance: { upstreamPackageChecks: true, upstreamProfileBoot: true, installerBuilt: true,
    freshInstalledPreinstall: false, pluginUpdateAndRemoval: false, legacyDataHandoff: false },
  publicPromotionEligible: false, published: false }
writeFileSync(join(output, 'candidate.json'), canonicalJson(record))
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT,
    `directory=${distribution}\nreceipt=${join(output, 'candidate.json')}\n`)
}
console.log(`Upstream preinstalled candidate built: ${output}; fresh-install and plugin lifecycle acceptance are still required.`)
