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
import { localInputs, verifyRecordedEvidence } from './coordinated-evidence.mjs'
import { currentRun, evaluateJobs } from './release-timeline.mjs'
import { assertLatestForward, composeFinalReceipt, finalReceiptName, planDraftStaging, readReleaseReceipt, releaseProfileRecord,
  signedRecords, stagedReceiptName, validateSignedRecord, validateStagedReceipt } from './coordinated-signed.mjs'

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
// Recovery resumes the draft staged by its original run; other phases require this run.
const releaseRun = process.env.AGENTROUTER_STAGED_RUN_ID ?? process.env.GITHUB_RUN_ID
assert.match(releaseSource ?? '', /^[a-f0-9]{40}$/)
assert.match(releaseRun ?? '', /^[1-9][0-9]*$/)
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
const workflowRun = () => ({ id: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT, commit: process.env.GITHUB_SHA })
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
function listReleases() {
  const all = []
  for (let page = 1; ; page++) {
    const batch = JSON.parse(gh(['api', `repos/${repo}/releases?per_page=100&page=${page}`]))
    all.push(...batch)
    if (batch.length < 100) return all
  }
}
function remoteRelease() {
  // The REST tag endpoint only resolves published releases. gh release view
  // resolves the draft as well; then inspect its immutable numeric identity.
  const identity = JSON.parse(gh(['release', 'view', tag, '--repo', repo, '--json', 'databaseId']))
  assert.ok(Number.isSafeInteger(identity.databaseId) && identity.databaseId > 0)
  const remote = JSON.parse(gh(['api', `repos/${repo}/releases/${identity.databaseId}`]))
  assert.equal(remote.tag_name, tag)
  assert.equal(remote.prerelease, false)
  return remote
}
/** Verify downloaded draft bytes against the staged receipt before any post-sign check. */
async function loadSignedRelease(directory) {
  const { name, receipt } = readReleaseReceipt(directory)
  validateStagedReceipt(receipt, { sourceCommit: releaseSource, runId: releaseRun })
  assert.deepEqual(receipt.input, input)
  assert.equal(receipt.patchSha256, patchSha256)
  if (receipt.schemaVersion >= 2) assert.deepEqual(receipt.adapterSource, source)
  if (receipt.acceptanceEvidence) verifyRecordedEvidence({ evidence: receipt.acceptanceEvidence, release: localInputs(releaseSource, git) })
  for (const file of receipt.assets) {
    assert.equal(basename(file.name), file.name)
    const bytes = readFileSync(join(directory, file.name))
    assert.equal(bytes.length, file.bytes); assert.equal(hash(bytes), file.sha256)
  }
  const installers = receipt.assets.filter(file => file.name.endsWith('.exe'))
  assert.equal(installers.length, 1)
  const executable = join(directory, installers[0].name)
  const signature = verifySignature(executable)
  assert.equal(signature.certificateSha256, receipt.signature.certificateSha256)
  const signedManifest = await verifySignedAssets(directory, receipt)
  const feed = load(readFileSync(join(directory, 'latest.yml'), 'utf8'))
  assert.equal(feed.version, input.productVersion)
  assert.equal(feed.files[0].url, installers[0].name)
  assert.equal(feed.files[0].sha512, hash(readFileSync(executable), 'sha512', 'base64'))
  return { name, receipt, installer: installers[0], executable, signature, signedManifest }
}
if (phase === 'stage') {
  const installer = json(path)
  const selection = JSON.parse(process.env.RELEASE_SELECTION_JSON)
  assert.equal(selection.productVersion, input.productVersion)
  assert.equal(selection.pluginVersion, input.plugin.version)
  assert.equal(selection.pluginSha256, input.plugin.sha256)
  assert.ok(selection.current || selection.retainReason?.trim())
  // Pre-sign acceptance is either this run's candidate job or reused ci.yml
  // evidence for identical installed-acceptance inputs, never both or neither.
  const acceptedJson = process.env.ACCEPTED_CANDIDATE_JSON?.trim(), evidenceJson = process.env.ACCEPTANCE_EVIDENCE_JSON?.trim()
  const releaseProfile = releaseProfileRecord(process.env.RELEASE_PROFILE || 'standard', Boolean(acceptedJson || evidenceJson))
  assert.ok(!(acceptedJson && evidenceJson), 'Expected exactly one installed acceptance source')
  let preSign = {}
  if (acceptedJson) {
    const accepted = JSON.parse(acceptedJson)
    assert.equal(accepted.passed, true)
    assert.equal(accepted.nativeUpdaterExecuted, true)
    assert.equal(accepted.legacyInstallerExecuted, true)
    assert.equal(accepted.patchSha256, patchSha256)
    assert.deepEqual(accepted.plugin, input.plugin)
    preSign = { installedCandidate: accepted }
  } else if (evidenceJson) {
    const evidence = verifyRecordedEvidence({ evidence: JSON.parse(evidenceJson), release: localInputs(process.env.GITHUB_SHA, git) })
    preSign = { acceptanceEvidence: evidence }
  }
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
  // Signed native update, signed legacy migration and the clean-worker install
  // run next, in parallel, against the draft; publish adds their results.
  const receipt = { schemaVersion: 2, sourceCommit: process.env.GITHUB_SHA,
    workflowRun: { workflow: '.github/workflows/release.yml', id: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT },
    adapterSource: source, input, selection, upstreamCommit: installer.upstreamCommit, patchSha256, signed: true, testOnly: false,
    signing: installer.signing, signature: installer.signature, runtimeSignature: installer.runtimeSignature,
    assets: installer.assets, releaseProfile, ...preSign }
  validateStagedReceipt(receipt, { sourceCommit: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID })
  const output = installer.output
  const receiptPath = join(output, stagedReceiptName)
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
  const tagRefs = JSON.parse(gh(['api', `repos/${repo}/git/matching-refs/tags/${tag}`]))
  const plan = planDraftStaging({ tag, releases: listReleases(), tagRefExists: tagRefs.some(ref => ref.ref === `refs/tags/${tag}`) })
  for (const id of plan.replaceDraftIds) {
    // Only a never-published draft of this version; recheck immediately before deletion.
    const draft = JSON.parse(gh(['api', `repos/${repo}/releases/${id}`]))
    assert.equal(draft.tag_name, tag); assert.equal(draft.draft, true); assert.equal(draft.published_at, null)
    gh(['api', '--method', 'DELETE', `repos/${repo}/releases/${id}`])
    console.error(JSON.stringify({ replacedUnpublishedDraft: id, tag }))
  }
  // Draft assets stay out of latest and the product feed until separate
  // disposable workers have installed and accepted these exact signed bytes.
  gh(['release', 'create', tag, ...installer.assets.map(file => join(output, file.name)), receiptPath, checksums,
    '--repo', repo, '--target', process.env.GITHUB_SHA, '--draft', '--title', `AgentRouter ${input.productVersion}`, '--notes-file', notes])
  console.log(JSON.stringify({ tag, staged: true, published: false, replacedDrafts: plan.replaceDraftIds }))
} else if (phase === 'signed-target') {
  // A receipt for installer-acceptance.mjs --signed-installer, built from verified draft bytes.
  const { receipt, executable } = await loadSignedRelease(path)
  assert.equal(receipt.sourceCommit, process.env.GITHUB_SHA)
  const target = resolve(process.argv[4])
  writeJson(target, { schemaVersion: 1, output: path, installer: executable, productVersion: input.productVersion,
    dshVersion: input.dshVersion, plugin: input.plugin, upstreamCommit: receipt.upstreamCommit, patchSha256,
    testOnly: false, signed: true, signing: receipt.signing, signature: receipt.signature,
    runtimeSignature: receipt.runtimeSignature, feed: input.updateUrl, assets: receipt.assets })
  console.log(JSON.stringify({ signedInstaller: target }))
} else if (phase === 'record') {
  // Attach one post-sign result to this run's never-published draft.
  const kind = process.argv[4]
  assert.ok(Object.hasOwn(signedRecords, kind), `Unknown signed record ${kind}`)
  const { receipt, installer } = await loadSignedRelease(path)
  assert.equal(receipt.sourceCommit, process.env.GITHUB_SHA)
  const file = join(path, signedRecords[kind])
  const record = kind === 'fresh-install' ? json(file) : { schemaVersion: 1, kind, sourceCommit: releaseSource,
    workflowRun: { id: releaseRun }, verifierRun: workflowRun(), signedInstallerSha256: installer.sha256,
    acceptance: json(resolve(process.argv[5])) }
  validateSignedRecord(kind, record, { receipt, runId: releaseRun })
  writeJson(file, record)
  const remote = remoteRelease()
  assert.equal(remote.draft, true); assert.equal(remote.published_at, null)
  gh(['release', 'upload', tag, file, '--repo', repo, '--clobber'])
  console.log(JSON.stringify({ tag, recorded: kind }))
} else if (phase === 'accept') {
  assert.equal(process.env.GITHUB_ACTIONS, 'true')
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
  const { receipt, installer, executable, signature, signedManifest } = await loadSignedRelease(path)
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
  const record = { ...acceptance, kind: 'fresh-install', installerExecuted: true, signedInstallerSha256: installer.sha256,
    signature, signing: input.signing, sourceCommit: releaseSource, workflowRun: { id: releaseRun },
    verifierRun: workflowRun(), verifierCommit: process.env.GITHUB_SHA, input, patchSha256 }
  validateSignedRecord('fresh-install', record, { receipt, runId: releaseRun })
  writeJson(join(path, signedRecords['fresh-install']), record)
  console.log(JSON.stringify({ tag, acceptedSignedInstaller: true }))
} else if (phase === 'publish') {
  const { name, receipt: downloaded, installer } = await loadSignedRelease(path)
  const remote = remoteRelease()
  for (const file of downloaded.assets) {
    const asset = remote.assets.find(asset => asset.name === file.name)
    assert.ok(asset); assert.equal(asset.size, file.bytes); assert.equal(asset.digest, `sha256:${file.sha256}`)
  }
  if (remote.draft) {
    assert.equal(remote.published_at, null, 'A version that was published is never republished')
    assertLatestForward(tag, listReleases())
  }
  let receipt = downloaded
  if (name === stagedReceiptName) {
    // Every post-sign job recorded its result on this draft; bind them into the
    // published receipt as a new asset without touching the signed bytes.
    assert.equal(remote.draft, true, 'A published release must already carry its final receipt')
    const records = Object.fromEntries(['native-updater', 'legacy-migration'].map(kind =>
      [kind, validateSignedRecord(kind, json(join(path, signedRecords[kind])), { receipt: downloaded, runId: releaseRun })]))
    receipt = composeFinalReceipt(downloaded, records['native-updater'], records['legacy-migration'])
    try {
      // Measured job timeline up to publication; observation only, never a gate.
      const { run, jobs } = currentRun()
      receipt.releaseTimeline = evaluateJobs(jobs.filter(job => job.completed_at), { profile: receipt.releaseProfile?.name ?? 'standard', dispatchedAt: run.created_at })
    } catch (error) { receipt.releaseTimeline = { unavailable: String(error?.message ?? error).slice(0, 200) } }
    writeJson(join(path, finalReceiptName), receipt)
    gh(['release', 'upload', tag, join(path, finalReceiptName), '--repo', repo])
  }
  if (policy) {
    assert.equal(receipt.installedSignedUpdate?.passed, true)
    assert.equal(receipt.installedSignedUpdate.signedInstallerSha256, installer.sha256)
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
    const fresh = validateSignedRecord('fresh-install', json(join(path, signedRecords['fresh-install'])), { receipt, runId: releaseRun })
    writeJson(join(path, 'signed-installed-acceptance.json'), { ...fresh, installedSignedUpdate: receipt.installedSignedUpdate })
    gh(['release', 'upload', tag, join(path, 'signed-installed-acceptance.json'), '--repo', repo])
  }
  if (remote.draft) gh(['release', 'edit', tag, '--repo', repo, '--draft=false', '--latest'])
  const delivery = { ...await verifyCoordinatedPublicRelease(input, receipt), published: true,
    sourceCommit: releaseSource, verifierCommit: process.env.GITHUB_SHA, verifiedAt: new Date().toISOString() }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    '## Verified public delivery\n\n```json\n' + JSON.stringify(delivery, null, 2) + '\n```\n')
  console.log(JSON.stringify(delivery))
} else throw new Error('Expected stage, signed-target, record, accept, or publish')
