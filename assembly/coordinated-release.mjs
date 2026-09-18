/** Sole publisher for the signed coordinated lane. Never promotes loopback test assets. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { root } from './lib.mjs'
import { verifyCoordinatedPublicRelease } from './coordinated-public.mjs'

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
assert.equal(input.candidateOnly, false, 'The reviewed product release is still candidate-only')
const tag = `v${input.productVersion}`
assert.match(tag, /^v\d+\.\d+\.\d+$/)
const source = json(join(adapter, 'adapter-source.json'))
const patchSha256 = hash(readFileSync(join(adapter, 'coordinated-delivery.patch')))
const phase = process.argv[2]
const path = resolve(process.argv[3])

function verifySignature(file) {
  const signature = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$s = Get-AuthenticodeSignature -LiteralPath $env:AGENTROUTER_VERIFY_FILE; @{ status = [string]$s.Status; subject = $s.SignerCertificate.Subject; timestamp = $s.TimeStamperCertificate.Subject } | ConvertTo-Json -Compress'],
  { env: { ...process.env, AGENTROUTER_VERIFY_FILE: file }, encoding: 'utf8', windowsHide: true }))
  assert.equal(signature.status, 'Valid')
  assert.ok(signature.timestamp)
  return signature
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
  assert.equal(installer.signature.status, 'Valid')
  assert.equal(installer.runtimeSignature.status, 'Valid')
  assert.equal(installer.productVersion, input.productVersion)
  assert.equal(installer.patchSha256, patchSha256)
  assert.deepEqual(installer.plugin, input.plugin)
  assert.equal(installer.feed, input.updateUrl)
  const receipt = { schemaVersion: 1, sourceCommit: process.env.GITHUB_SHA, adapterSource: source,
    input, upstreamCommit: installer.upstreamCommit, patchSha256, signed: true, testOnly: false,
    signature: installer.signature, runtimeSignature: installer.runtimeSignature, assets: installer.assets,
    installedCandidate: accepted }
  const output = installer.output
  const receiptPath = join(output, 'release-receipt.json')
  writeJson(receiptPath, receipt)
  const notes = join(output, 'RELEASE_NOTES.md')
  writeFileSync(notes, `AgentRouter ${input.productVersion}\n\nDSH ${input.dshVersion}; ${input.plugin.name}@${input.plugin.version}.\n\nOne product update installs the verified client and plugin together. Independent DSH installations continue to update the plugin separately.\n`)
  const checksums = join(output, 'SHA256SUMS.txt')
  writeFileSync(checksums, installer.assets.map(file => `${file.sha256}  ${file.name}\n`).join(''))
  for (const file of installer.assets) {
    assert.equal(basename(file.name), file.name)
    const bytes = readFileSync(join(output, file.name))
    assert.equal(bytes.length, file.bytes); assert.equal(hash(bytes), file.sha256)
  }
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
  assert.equal(receipt.sourceCommit, process.env.GITHUB_SHA)
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
  assert.equal(signature.subject, receipt.signature.subject)
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
  assert.equal(verifySignature(installedExe).subject, signature.subject)
  const output = join(work, 'evidence'); mkdirSync(output)
  const candidate = join(work, 'installed.json')
  writeJson(candidate, { input, executable: installedExe, output, pluginSha256: input.plugin.sha256, patchSha256 })
  const acceptedOutput = execFileSync(process.execPath, [join(adapter, 'acceptance.mjs'), candidate],
    { env: testEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true, timeout: 600000 })
  const acceptance = JSON.parse(acceptedOutput.trim().split(/\r?\n/).at(-1))
  assert.equal(acceptance.passed, true)
  writeJson(join(path, 'signed-installed-acceptance.json'), { ...acceptance,
    installerExecuted: true, signedInstallerSha256: installer[0].sha256,
    signature, sourceCommit: process.env.GITHUB_SHA, input, patchSha256 })
  console.log(JSON.stringify({ tag, acceptedSignedInstaller: true }))
} else if (phase === 'publish') {
  const acceptance = json(join(path, 'signed-installed-acceptance.json'))
  const receipt = json(join(path, 'release-receipt.json'))
  assert.equal(acceptance.passed, true); assert.equal(acceptance.installerExecuted, true)
  assert.equal(acceptance.sourceCommit, process.env.GITHUB_SHA)
  assert.deepEqual(acceptance.input, input)
  assert.equal(acceptance.patchSha256, patchSha256)
  const installer = receipt.assets.find(file => file.name.endsWith('.exe'))
  assert.equal(acceptance.signedInstallerSha256, installer.sha256)
  const remote = JSON.parse(gh(['api', `repos/${repo}/releases/tags/${tag}`]))
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
    assert.equal(prior.sourceCommit, process.env.GITHUB_SHA)
    assert.deepEqual(prior.input, input)
    assert.equal(prior.patchSha256, patchSha256)
    assert.equal(prior.signedInstallerSha256, installer.sha256)
  } else {
    assert.equal(remote.draft, true, 'A published release must already carry its installed receipt')
    gh(['release', 'upload', tag, join(path, 'signed-installed-acceptance.json'), '--repo', repo])
  }
  if (remote.draft) gh(['release', 'edit', tag, '--repo', repo, '--draft=false', '--latest'])
  console.log(JSON.stringify({ ...await verifyCoordinatedPublicRelease(input, receipt), published: true }))
} else throw new Error('Expected stage, accept, or publish')
