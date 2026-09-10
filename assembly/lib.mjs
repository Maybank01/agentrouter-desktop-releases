/** Build-time helpers only. Source/byte validation follows the former Distribution
 * lane at 6fb9b8639b88ce4e4ae9cc5a0b715d69cfff707d; none of its runtime overlay is used. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const root = resolve(import.meta.dirname, '..')
export const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
export const canonicalJson = value => JSON.stringify(value, null, 2) + '\n'
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
export const upstream = readJson(join(root, 'assembly/upstream.lock.json'))
export const plugins = readJson(join(root, 'assembly/plugins.lock.json'))
export const npmChannel = readJson(join(root, 'assembly/npm-channel.json'))
export const allowedChanges = [`${upstream.application}/package.json`, `${upstream.application}/cordis.patch.yml`, 'yarn.lock', '.yarnrc.yml']

export function validateLocks() {
  assert.equal(upstream.repository, 'https://github.com/anywhere-labs/dsh-desktop.git')
  assert.match(upstream.commit, /^[0-9a-f]{40}$/)
  assert.match(upstream.tree, /^[0-9a-f]{40}$/)
  assert.match(upstream.tag, /^v\d+\.\d+\.\d+$/)
  assert.equal(upstream.nativeSourceChangesAllowed, false)
  assert.equal(upstream.updaterOwner, 'upstream')
  assert.equal(upstream.application, 'dsh-plugin-desktop')
  assert.equal(plugins.sourceRepository, 'Maybank01/agentrouter-dsh-plugins')
  assert.equal(plugins.environment, 'v3-candidate')
  assert.ok(Number.isSafeInteger(plugins.releaseSequence) && plugins.releaseSequence >= 1)
  assert.equal(npmChannel.schemaVersion, 1)
  assert.equal(npmChannel.registry, 'https://registry.npmjs.org')
  assert.equal(Array.isArray(npmChannel.packages), true)
  assert.equal(new Set(plugins.packages.map(pkg => pkg.name)).size, plugins.packages.length)
  assert.equal(new Set(npmChannel.packages.map(pkg => pkg.name)).size, npmChannel.packages.length)
  assert.deepEqual(npmChannel.packages.map(pkg => pkg.name), plugins.packages.map(pkg => pkg.name))
  for (const channelPackage of npmChannel.packages) {
    const locked = plugins.packages.find(pkg => pkg.name === channelPackage.name)
    assert.ok(locked)
    assert.equal(locked.direct, channelPackage.direct)
    assert.notEqual(Boolean(channelPackage.distTag), Boolean(channelPackage.fromPackage))
    if (channelPackage.distTag) assert.match(channelPackage.distTag, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
    if (channelPackage.fromPackage) assert.ok(npmChannel.packages.some(pkg => pkg.name === channelPackage.fromPackage))
    if (channelPackage.preinstallEntry) {
      assert.equal(channelPackage.preinstallEntry, `${channelPackage.name}/desktop-preinstall`)
      assert.deepEqual(channelPackage.preinstallConfig, { productProfile: true })
    }
  }
  for (const pkg of plugins.packages) {
    assert.match(pkg.name, /^(?:@[a-z0-9-]+\/)?[a-z0-9-]+$/)
    assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/)
    assert.match(pkg.sha256, /^[0-9a-f]{64}$/)
    assert.match(pkg.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/)
    assert.ok(Number.isSafeInteger(pkg.bytes) && pkg.bytes > 0 && pkg.bytes < 2_000_000)
    if (pkg.preinstallEntry) {
      assert.equal(pkg.direct, true)
      assert.equal(pkg.name, '@agentrouter-top/dsh-codex')
      assert.equal(pkg.preinstallEntry, `${pkg.name}/desktop-preinstall`)
      assert.deepEqual(pkg.preinstallConfig, { productProfile: true })
    } else assert.equal(pkg.preinstallConfig, undefined)
  }
}

export function buildEnvironment(output) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/API_KEY|CODEX_HOME|RELAY_CODEX|NODE_OPTIONS|NODE_AUTH_TOKEN|NPM_TOKEN|^(?:WIN_)?CSC_/i.test(key)) delete env[key]
    if (['dsh_home', 'npm_config_userconfig'].includes(key.toLowerCase())) delete env[key]
  }
  const npmrc = join(output, 'npmrc')
  writeFileSync(npmrc, 'registry=https://registry.npmjs.org/\n')
  return { ...env, DSH_HOME: join(output, 'test-dsh-home'), DSH_TELEMETRY_DISABLED: '1',
    NPM_CONFIG_USERCONFIG: npmrc, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
}

export function run(command, args, cwd, env = process.env) {
  execFileSync(command, args, { cwd, env, stdio: 'inherit', windowsHide: true, timeout: 900000 })
}
export function git(source, ...args) {
  return execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 20_000_000 }).trim()
}
export function yarn(source, env, ...args) {
  run(process.platform === 'win32' ? 'corepack.cmd' : 'corepack', ['yarn', ...args], source, env)
}

export function preinstalledManifest(original) {
  return { ...original, dependencies: { ...original.dependencies,
    ...Object.fromEntries(plugins.packages.filter(pkg => pkg.direct).map(pkg => [pkg.name, pkg.version])),
  } }
}
export function preinstallPatch() {
  return '\n# Additive preinstallation of public npm packages; no host policy overrides.\n- insert:\n' +
    plugins.packages.filter(pkg => pkg.preinstallEntry).map((pkg, i) =>
      `    - id: agentrouter-preinstall-${i}\n      name: '${pkg.preinstallEntry}'\n      config:\n        productProfile: true\n`).join('')
}
export function preapprovedYarnRc(original) {
  const marker = 'npmPreapprovedPackages:\n'
  assert.equal(original.split(marker).length, 2, 'Expected the upstream exact-version preapproval list')
  // Only the two byte-verified published artifacts bypass the fresh-package age
  // gate during assembly. This neither disables quarantine nor changes user config.
  return original.replace(marker, marker + plugins.packages.map(pkg => `  - "${pkg.name}@${pkg.version}"\n`).join(''))
}
export function verifySource(source, { prepared = false, built = false } = {}) {
  validateLocks()
  assert.equal(git(source, 'rev-parse', 'HEAD'), upstream.commit)
  assert.equal(git(source, 'rev-parse', 'HEAD^{tree}'), upstream.tree)
  assert.equal(git(source, 'rev-parse', `refs/tags/${upstream.tag}^{commit}`), upstream.commit)
  assert.equal(git(source, 'ls-tree', 'HEAD', 'deepseek-harness').split(/\s+/)[2], upstream.dshGitlink)
  assert.equal(git(source, 'diff', '--cached', '--name-only'), '', 'No staged source modifications are allowed')
  const changes = git(source, 'diff', '--name-only').split(/\r?\n/).filter(Boolean)
  const unknown = git(source, 'ls-files', '--others', '--exclude-standard')
  assert.equal(unknown, '', 'No additional runtime source files are allowed')
  const noticesPath = `${upstream.application}/THIRD_PARTY_NOTICES.md`
  assert.ok(changes.every(path => prepared &&
    (allowedChanges.includes(path) || (built && path === noticesPath))),
  `Unexpected upstream source changes: ${changes.join(', ')}`)
  if (built && changes.includes(noticesPath)) {
    // The original build regenerates this tracked license inventory for the
    // installed dependency graph/platform. Reproduce it separately and compare;
    // this is not permission to edit arbitrary documentation or native source.
    const evidence = join(source, '.build/assembly-notices')
    mkdirSync(evidence, { recursive: true })
    run(process.execPath, [join(source, upstream.application, 'scripts/verify-licenses.mjs'),
      '--notices', '../.build/assembly-notices/THIRD_PARTY_NOTICES.md'],
    join(source, upstream.application), buildEnvironment(dirname(source)))
    assert.equal(sha256(readFileSync(join(source, noticesPath))),
      sha256(readFileSync(join(evidence, 'THIRD_PARTY_NOTICES.md'))),
    'License notices must be the exact output of the unmodified upstream generator')
  }
  if (prepared) {
    const manifestPath = `${upstream.application}/package.json`
    const original = JSON.parse(git(source, 'show', `HEAD:${manifestPath}`))
    assert.deepEqual(readJson(join(source, manifestPath)), preinstalledManifest(original), 'Only exact npm dependencies may change')
    const patchPath = `${upstream.application}/cordis.patch.yml`
    const originalPatch = execFileSync('git', ['-C', source, 'show', `HEAD:${patchPath}`], { encoding: 'utf8' })
    assert.equal(readFileSync(join(source, patchPath), 'utf8'), originalPatch + preinstallPatch(), 'Only additive preinstall configuration may change')
    const originalYarnRc = execFileSync('git', ['-C', source, 'show', 'HEAD:.yarnrc.yml'], { encoding: 'utf8' })
    assert.equal(readFileSync(join(source, '.yarnrc.yml'), 'utf8'), preapprovedYarnRc(originalYarnRc), 'Only exact verified package preapprovals may change')
    assert.equal(sha256(readFileSync(join(source, 'yarn.lock'))), sha256(readFileSync(join(root, 'assembly/yarn.lock'))), 'Use the reviewed assembly dependency lock')
  }
  return { commit: upstream.commit, tree: upstream.tree, nativeSourceUnchanged: true, changedPaths: changes }
}

async function boundedBytes(url, limit) {
  assert.equal(new URL(url).origin, 'https://registry.npmjs.org')
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60000) })
  assert.equal(response.status, 200, `Public npm response: ${url}`)
  const chunks = []; let length = 0
  for await (const chunk of response.body) {
    length += chunk.length
    if (length > limit) throw new Error('Public npm response exceeded the declared bound')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
export async function fetchPublishedPackage(pkg, output) {
  const metadata = JSON.parse(await boundedBytes(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${pkg.version}`, 200000))
  assert.equal(metadata.name, pkg.name)
  assert.equal(metadata.version, pkg.version)
  assert.equal(metadata.dist.integrity, pkg.integrity)
  const bytes = await boundedBytes(metadata.dist.tarball, pkg.bytes)
  assert.equal(bytes.length, pkg.bytes)
  assert.equal(sha256(bytes), pkg.sha256)
  assert.equal(`sha512-${createHash('sha512').update(bytes).digest('base64')}`, pkg.integrity)
  const filename = `${pkg.name.replace(/^@/, '').replace('/', '-')}-${pkg.version}.tgz`
  writeFileSync(join(output, filename), bytes, { flag: 'wx' })
  return { ...pkg, filename }
}
