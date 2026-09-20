/** Sole publisher for the signed coordinated lane. Never promotes loopback test assets. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { root } from './lib.mjs'
import { verifyCoordinatedPublicRelease } from './coordinated-public.mjs'
import { loadSigningPolicy, inspectWindowsSignature } from './coordinated/windows-signing.mjs'
import { manifestName, verifyUpdateManifest, verifyUpdateFile } from './coordinated/update-signature.mjs'

const repo = 'Maybank01/agentrouter-desktop-releases'
const adapter = join(root, 'assembly/coordinated')
const require = createRequire(join(adapter, 'package.json'))
const { load } = require('js-yaml')
const json = path => JSON.parse(readFileSync(path, 'utf8'))
const writeJson = (path, data) => writeFileSync(path, JSON.stringify(data, null, 2) + '\n')
const hash = (body, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(body).digest(encoding)
const gh = args => execFileSync('gh', args, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] })
assert.equal(process.env.GITHUB_REPOSITORY, repo)
assert.equal(process.env.GITHUB_REF, 'refs/heads/main')
assert.equal(process.env.GITHUB_EVENT_NAME, 'workflow_dispatch')
const input = json(join(adapter, 'release.json'))
const policy = input.signing?.mode === 'self-signed' ? loadSigningPolicy() : undefined
if (policy) assert.equal(input.signing.certificateSha256, policy.certificateSha256)
assert.equal(input.candidateOnly, false, 'The reviewed product release is still candidate-only')
const tag = `v${input.productVersion}`
assert.match(tag, /^v\d+\.\d+\.\d+$/)
const source = json(join(adapter, 'adapter-source.json'))
const patchSha256 = hash(readFileSync(join(adapter, 'coordinated-delivery.patch')))
const phase = process.argv[2]
const path = resolve(process.argv[3])
const releaseSource = process.env.AGENTROUTER_STAGED_SOURCE_SHA ?? process.env.GITHUB_SHA
assert.match(releaseSource ?? '', /^[a-f0-9]{40}$/)
if (releaseSource !== process.env.GITHUB_SHA) {
  assert.notEqual(phase, 'stage', 'Recovery must not rebuild or replace staged assets')
  execFileSync('git', ['merge-base', '--is-ancestor', releaseSource, 'HEAD'], { cwd: root, windowsHide: true })
  execFileSync('git', ['diff', '--exit-code', releaseSource, 'HEAD', '--', 'assembly/coordinated'], { cwd: root, windowsHide: true })
}

function verifySignature(file) {
  return inspectWindowsSignature(file, policy)
}
async function verifySignedAssets(directory, receipt) {
  if (!policy) return undefined
  assert.deepEqual(receipt.signing, input.signing)
  assert.equal(receipt.assets.filter(file => file.name === manifestName).length, 1)
  const manifest = verifyUpdateManifest(json(join(directory, manifestName)), policy, input.productVersion)
  for (const file of receipt.assets.filter(file => file.name !== manifestName)) {
    const verified = await verifyUpdateFile(manifest, join(directory, file.name), file.name)
    assert.deepEqual(verified, file)
  }
  return manifest
}
if (phase === 'stage') {
  const installer = json(path)
  const accepted = JSON.parse(process.env.ACCEPTED_CANDIDATE_JSON)
  assert.equal(accepted.passed, true)
  assert.equal(accepted.nativeUpdaterExecuted, true)
  assert.equal(accepted.legacyInstallerExecuted, true)
  assert.equal(accepted.patchSha256, patchSha256)
  assert.deepEqual(accepted.plugin, input.plugin)
  assert.equal(installer.testOnly, false)
  assert.equal(installer.signed, true)
  if (!policy) {
    assert.equal(installer.signature.status, 'Valid')
    assert.equal(installer.runtimeSignature.status, 'Valid')
  }
  assert.equal(installer.productVersion, input.productVersion)
  assert.equal(installer.patchSha256, patchSha256)
  assert.deepEqual(installer.plugin, input.plugin)
  assert.equal(installer.feed, input.updateUrl)
  let installedSignedUpdate
  if (policy) {
    const upgrade = json(process.env.SIGNED_UPGRADE_RECEIPT)
    assert.equal(upgrade.passed, true); assert.equal(upgrade.signed, true)
    assert.equal(upgrade.nativeUpdaterExecuted, true)
    assert.equal(upgrade.nativeSignatureVerificationExecuted, true)
    assert.equal(upgrade.rootTrustInstalled, false)
    assert.equal(upgrade.productVersion, input.productVersion)
    assert.equal(upgrade.patchSha256, patchSha256)
    assert.deepEqual(upgrade.plugin, input.plugin)
    assert.equal(upgrade.targetInstaller.testOnly, false)
    assert.deepEqual(upgrade.targetInstaller.assets, installer.assets)
    installedSignedUpdate = { passed: true, nativeUpdaterExecuted: true, nativeSignatureVerificationExecuted: true,
      installerRestartedApp: upgrade.installerRestartedApp, rootTrustInstalled: false,
      signedInstallerSha256: installer.assets.find(file => file.name.endsWith('.exe')).sha256 }
  }
  const receipt = { schemaVersion: 1, sourceCommit: process.env.GITHUB_SHA, adapterSource: source,
    input, upstreamCommit: installer.upstreamCommit, patchSha256, signed: true, testOnly: false,
    signing: installer.signing, installedSignedUpdate,
    signature: installer.signature, runtimeSignature: installer.runtimeSignature, assets: installer.assets,
    installedCandidate: accepted }
  const output = installer.output
  const receiptPath = join(output, 'release-receipt.json')
  writeJson(receiptPath, receipt)
  const notes = join(output, 'RELEASE_NOTES.md')
  writeFileSync(notes, `AgentRouter ${input.productVersion}\n\nDSH ${input.dshVersion}; ${input.plugin.name}@${input.plugin.version}.\n\n一次产品升级同步更新客户端与插件。独立安装的 DSH 仍可单独更新同一个 npm 插件。\n${policy ? '\n安装包使用 AgentRouter 自签证书，Windows 首次安装可能显示未知发布者或 SmartScreen 提示。自动更新使用应用内固定公钥验证完整安装包，无需导入根证书。自签不代表 Windows 公共信任认证。\n' : ''}`)
  const checksums = join(output, 'SHA256SUMS.txt')
  writeFileSync(checksums, installer.assets.map(file => `${file.sha256}  ${file.name}\n`).join(''))
  for (const file of installer.assets) {
    assert.equal(basename(file.name), file.name)
    const bytes = readFileSync(join(output, file.name))
    assert.equal(bytes.length, file.bytes); assert.equal(hash(bytes), file.sha256)
  }
  await verifySignedAssets(output, installer)
  verifySignature(installer.installer)
  // Draft assets stay out of latest and the product feed until the second
  // disposable worker has installed and accepted these exact signed bytes.
  gh(['release', 'create', tag, ...installer.assets.map(file => join(output, file.name)), receiptPath, checksums,
    '--repo', repo, '--target', process.env.GITHUB_SHA, '--draft', '--title', `AgentRouter ${input.productVersion}`, '--notes-file', notes])
  console.log(JSON.stringify({ tag, staged: true, published: false }))
} else if (phase === 'accept') {
  assert.equal(process.env.GITHUB_ACTIONS, 'true')
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
  const receipt = json(join(path, 'release-receipt.json'))
  assert.equal(receipt.sourceCommit, releaseSource)
  assert.deepEqual(receipt.input, input)
  assert.equal(receipt.patchSha256, patchSha256)
  assert.equal(receipt.signed, true); assert.equal(receipt.testOnly, false)
  for (const file of receipt.assets) {
    assert.equal(basename(file.name), file.name)
    const bytes = readFileSync(join(path, file.name))
    assert.equal(bytes.length, file.bytes); assert.equal(hash(bytes), file.sha256)
  }
  const installer = receipt.assets.filter(file => file.name.endsWith('.exe'))
  assert.equal(installer.length, 1)
  const executable = join(path, installer[0].name)
  const signature = verifySignature(executable)
  assert.equal(signature.certificateSha256, receipt.signature.certificateSha256)
  const signedManifest = await verifySignedAssets(path, receipt)
  const feed = load(readFileSync(join(path, 'latest.yml'), 'utf8'))
  assert.equal(feed.version, input.productVersion)
  assert.equal(feed.files[0].url, installer[0].name)
  assert.equal(feed.files[0].sha512, hash(readFileSync(executable), 'sha512', 'base64'))
  const work = mkdtempSync(join(process.env.RUNNER_TEMP, 'agentrouter-signed-'))
  const installed = join(work, 'installed')
  const testEnv = { ...process.env, AGENTROUTER_TEST_INSTALLER: executable, AGENTROUTER_TEST_INSTALL_DIR: installed }
  delete testEnv.GH_TOKEN; delete testEnv.GITHUB_TOKEN
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$p = Start-Process -FilePath $env:AGENTROUTER_TEST_INSTALLER -ArgumentList "/S", "/currentuser", "/D=$env:AGENTROUTER_TEST_INSTALL_DIR" -WindowStyle Hidden -Wait -PassThru; if ($p.ExitCode -ne 0) { throw "NSIS failed: $($p.ExitCode)" }'],
  { env: testEnv, windowsHide: true, stdio: 'inherit', timeout: 300000 })
  const installedExe = join(installed, 'AgentRouter.exe')
  assert.equal(verifySignature(installedExe).certificateSha256, signature.certificateSha256)
  if (signedManifest) {
    await verifyUpdateFile(signedManifest, installedExe, 'AgentRouter.exe')
    const { extractFile } = require('@electron/asar')
    const embedded = JSON.parse(extractFile(join(installed, 'resources/app.asar'), 'update-signing.json').toString('utf8'))
    assert.deepEqual(embedded.policy, policy)
    assert.equal(embedded.testOnly, false)
    assert.equal(embedded.feed, input.updateUrl)
  }
  const output = join(work, 'evidence'); mkdirSync(output)
  const candidate = join(work, 'installed.json')
  writeJson(candidate, { input, executable: installedExe, output, pluginSha256: input.plugin.sha256, patchSha256 })
  const acceptedOutput = execFileSync(process.execPath, [join(adapter, 'acceptance.mjs'), candidate],
    { env: testEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true, timeout: 600000 })
  const acceptance = JSON.parse(acceptedOutput.trim().split(/\r?\n/).at(-1))
  assert.equal(acceptance.passed, true)
  writeJson(join(path, 'signed-installed-acceptance.json'), { ...acceptance,
    installerExecuted: true, signedInstallerSha256: installer[0].sha256,
    signature, signing: input.signing, installedSignedUpdate: receipt.installedSignedUpdate,
    sourceCommit: releaseSource, verifierCommit: process.env.GITHUB_SHA, input, patchSha256 })
  console.log(JSON.stringify({ tag, acceptedSignedInstaller: true }))
} else if (phase === 'publish') {
  const acceptance = json(join(path, 'signed-installed-acceptance.json'))
  const receipt = json(join(path, 'release-receipt.json'))
  await verifySignedAssets(path, receipt)
  assert.equal(acceptance.passed, true); assert.equal(acceptance.installerExecuted, true)
  assert.equal(acceptance.sourceCommit, releaseSource)
  assert.equal(receipt.sourceCommit, releaseSource)
  assert.deepEqual(acceptance.input, input)
  assert.equal(acceptance.patchSha256, patchSha256)
  const installer = receipt.assets.find(file => file.name.endsWith('.exe'))
  assert.equal(acceptance.signedInstallerSha256, installer.sha256)
  // The REST tag endpoint only resolves published releases. gh release view
  // resolves the draft as well; then inspect its immutable numeric identity.
  const identity = JSON.parse(gh(['release', 'view', tag, '--repo', repo, '--json', 'databaseId']))
  assert.ok(Number.isSafeInteger(identity.databaseId) && identity.databaseId > 0)
  const remote = JSON.parse(gh(['api', `repos/${repo}/releases/${identity.databaseId}`]))
  assert.equal(remote.tag_name, tag)
  assert.equal(remote.prerelease, false)
  for (const file of receipt.assets) {
    const asset = remote.assets.find(asset => asset.name === file.name)
    assert.ok(asset); assert.equal(asset.size, file.bytes); assert.equal(asset.digest, `sha256:${file.sha256}`)
  }
  if (remote.assets.some(asset => asset.name === 'signed-installed-acceptance.json')) {
    // A failed anonymous observation may be resumed after publication. Retain
    // the original installed receipt and feed; never overwrite accepted bytes.
    const prior = JSON.parse(gh(['release', 'download', tag, '--repo', repo, '--pattern', 'signed-installed-acceptance.json', '--output', '-']))
    assert.equal(prior.passed, true); assert.equal(prior.installerExecuted, true)
    assert.equal(prior.sourceCommit, releaseSource)
    assert.deepEqual(prior.input, input)
    assert.equal(prior.patchSha256, patchSha256)
    assert.equal(prior.signedInstallerSha256, installer.sha256)
  } else {
    assert.equal(remote.draft, true, 'A published release must already carry its installed receipt')
    gh(['release', 'upload', tag, join(path, 'signed-installed-acceptance.json'), '--repo', repo])
  }
  if (remote.draft) gh(['release', 'edit', tag, '--repo', repo, '--draft=false', '--latest'])
  const delivery = { ...await verifyCoordinatedPublicRelease(input, receipt), published: true,
    sourceCommit: releaseSource, verifierCommit: process.env.GITHUB_SHA, verifiedAt: new Date().toISOString() }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    '## Verified public delivery\n\n```json\n' + JSON.stringify(delivery, null, 2) + '\n```\n')
  console.log(JSON.stringify(delivery))
} else throw new Error('Expected stage, accept, or publish')
