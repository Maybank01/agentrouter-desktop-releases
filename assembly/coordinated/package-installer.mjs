/** Package the accepted directory through upstream electron-builder/NSIS.
 * Unsigned test packages are confined to a loopback feed and cannot be promoted.
 */
import assert from 'node:assert/strict'
import { createHash, X509Certificate } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build, Platform, Arch } from 'electron-builder'
import { directory } from './prepare.mjs'

const candidateFile = resolve(process.argv[2])
const candidate = JSON.parse(readFileSync(candidateFile, 'utf8'))
const testFeed = process.argv.find(value => value.startsWith('--test-feed='))?.slice('--test-feed='.length)
const testOnly = testFeed !== undefined
assert.equal(process.platform, 'win32')
assert.equal(candidate.input.schemaVersion, 1)
assert.ok(existsSync(join(candidate.output, 'app/package.json')), 'Build the directory candidate before packaging it.')
if (testOnly) {
  const feed = new URL(testFeed)
  assert.equal(feed.protocol, 'http:')
  assert.equal(feed.hostname, '127.0.0.1')
  assert.ok(feed.port)
  assert.equal(feed.username + feed.password + feed.search + feed.hash, '')
} else {
  for (const name of ['DSH_DESKTOP_WINDOWS_CER_FILE', 'DSH_DESKTOP_WINDOWS_SIGNTOOL', 'DSH_DESKTOP_WINDOWS_TOKEN_PIN', 'DSH_DESKTOP_WINDOWS_KEY_CONTAINER']) {
    assert.ok(process.env[name], `Formal installer signing is not configured: ${name}`)
  }
}
process.env.DSH_DESKTOP_APP_ID = 'top.agentrouter.desktop'
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
// The module's default export also resolves its environment during import.
if (testOnly) delete process.env.DSH_DESKTOP_TARGET_PLATFORM
else process.env.DSH_DESKTOP_TARGET_PLATFORM = 'win32'
const { createElectronBuilderConfig } = await import(pathToFileURL(join(candidate.source, 'apps/desktop/electron-builder.config.mjs')).href)
const config = createElectronBuilderConfig(process.env, 'win32', 'x64')
const output = join(candidate.output, testOnly ? 'test-installer' : 'installer')
Object.assign(config, {
  // The main/preload code is already bundled; the verified runtime graph lives
  // in the seed archive. Packaging must not resolve a second dependency graph.
  npmRebuild: false,
  files: [...config.files, 'LICENSE'],
  directories: { app: join(candidate.output, 'app'), output },
  electronVersion: JSON.parse(readFileSync(join(directory, 'node_modules/electron/package.json'), 'utf8')).version,
  electronDist: join(directory, 'node_modules/electron/dist'),
  extraResources: ['runtime', 'seed'].map(name => ({ from: join(candidate.output, 'resources', name), to: name })),
})
if (testOnly) {
  config.win = { ...config.win, forceCodeSigning: false, signtoolOptions: { signingHashAlgorithms: ['sha256'] } }
  config.publish = [{ provider: 'generic', url: testFeed }]
} else {
  const publisher = new X509Certificate(readFileSync(process.env.DSH_DESKTOP_WINDOWS_CER_FILE)).toLegacyObject().subject.CN
  assert.equal(typeof publisher, 'string')
  assert.ok(publisher.length > 0)
  config.win.verifyUpdateCodeSignature = true
  config.win.signtoolOptions.publisherName = publisher
}
await build({ projectDir: join(candidate.output, 'app'), config, targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64), publish: 'never' })
const paths = readdirSync(output).filter(name => /(?:\.exe|\.blockmap|latest\.yml)$/.test(name))
const installer = paths.find(name => name.endsWith('.exe'))
assert.ok(installer && paths.includes('latest.yml'))
let signature, runtimeSignature
if (!testOnly) {
  // The script reads the path from the environment, never interpolates it into code.
  const inspect = path => JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$s = Get-AuthenticodeSignature -LiteralPath $env:AGENTROUTER_SIGNED_INSTALLER; @{ status = [string]$s.Status; subject = $s.SignerCertificate.Subject; timestamp = $s.TimeStamperCertificate.Subject } | ConvertTo-Json -Compress'],
  { env: { ...process.env, AGENTROUTER_SIGNED_INSTALLER: path }, windowsHide: true, encoding: 'utf8' }))
  signature = inspect(join(output, installer))
  runtimeSignature = inspect(join(output, 'win-unpacked/AgentRouter.exe'))
  for (const checked of [signature, runtimeSignature]) {
    assert.equal(checked.status, 'Valid')
    assert.ok(checked.timestamp, 'A release signature must carry a trusted timestamp.')
  }
  assert.equal(signature.subject, runtimeSignature.subject)
}
const assets = paths.map(name => {
  const bytes = readFileSync(join(output, name))
  return { name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
})
const receipt = { schemaVersion: 1, candidate: candidateFile, output, installer: join(output, installer),
  productVersion: candidate.input.productVersion, dshVersion: candidate.input.dshVersion,
  plugin: candidate.input.plugin, upstreamCommit: candidate.upstreamCommit, patchSha256: candidate.patchSha256,
  testOnly, signed: !testOnly, signature, runtimeSignature, feed: testOnly ? testFeed : candidate.input.updateUrl, assets,
  installedAcceptance: false, feedUpgradeAcceptance: false, publicPromotion: false }
writeFileSync(join(output, 'installer.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({ installerReceipt: join(output, 'installer.json') }))
