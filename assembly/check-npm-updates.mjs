/**
 * Resolve the exact public npm artifacts used by the Desktop assembly.
 *
 * The registry dist-tag is only a selector.  A release is allowed to consume
 * it after the selected version, tarball bytes, SHA-256 and SRI are all
 * checked.  The script can write the reviewed lock file, but never rewrites a
 * package when an already published version has different bytes.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const defaultChannelPath = join(root, 'assembly/npm-channel.json')
const defaultLockPath = join(root, 'assembly/plugins.lock.json')
const HEX = /^[0-9a-f]{64}$/u
const VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u
const INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/u
const MAX_METADATA_BYTES = 4 * 1024 * 1024
const MAX_PACKAGE_BYTES = 8 * 1024 * 1024

const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const canonicalJson = value => JSON.stringify(value, null, 2) + '\n'

function exactObject(value, label) {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  return value
}

function validateChannel(channel) {
  exactObject(channel, 'npm channel')
  assert.equal(channel.schemaVersion, 1)
  assert.equal(channel.registry, 'https://registry.npmjs.org')
  assert.ok(Array.isArray(channel.packages) && channel.packages.length > 0)
  const names = new Set()
  for (const item of channel.packages) {
    exactObject(item, 'npm channel package')
    assert.match(item.name, /^(?:@[a-z0-9-]+\/)?[a-z0-9-]+$/u)
    assert.notEqual(Boolean(item.distTag), Boolean(item.fromPackage), `${item.name} needs one version selector`)
    if (item.distTag) assert.match(item.distTag, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u)
    if (item.fromPackage) assert.match(item.fromPackage, /^(?:@[a-z0-9-]+\/)?[a-z0-9-]+$/u)
    assert.equal(typeof item.direct, 'boolean')
    assert.equal(names.has(item.name), false, `Duplicate npm channel package: ${item.name}`)
    names.add(item.name)
    if (item.preinstallEntry !== undefined) {
      assert.equal(item.direct, true)
      assert.equal(item.name, '@agentrouter-top/dsh-codex')
      assert.equal(item.preinstallEntry, `${item.name}/desktop-preinstall`)
      assert.deepEqual(item.preinstallConfig, { productProfile: true })
    }
  }
  return channel
}

function validateLock(lock, channel) {
  exactObject(lock, 'plugin lock')
  assert.equal(lock.sourceRepository, 'Maybank01/agentrouter-dsh-plugins')
  assert.equal(lock.environment, 'v3-candidate')
  assert.ok(Number.isSafeInteger(lock.releaseSequence) && lock.releaseSequence >= 1)
  assert.ok(Array.isArray(lock.packages))
  const byName = new Map(lock.packages.map(pkg => [pkg.name, pkg]))
  assert.equal(byName.size, lock.packages.length)
  assert.equal(byName.size, channel.packages.length)
  for (const item of channel.packages) {
    const pkg = byName.get(item.name)
    assert.ok(pkg, `npm channel package is absent from plugins.lock.json: ${item.name}`)
    assert.equal(pkg.direct, item.direct, `${item.name} direct flag`)
    if (item.preinstallEntry !== undefined) {
      assert.equal(pkg.preinstallEntry, item.preinstallEntry)
      assert.deepEqual(pkg.preinstallConfig, item.preinstallConfig)
    }
    assert.match(pkg.version, VERSION)
    assert.match(pkg.sha256, HEX)
    assert.match(pkg.integrity, INTEGRITY)
    assert.ok(Number.isSafeInteger(pkg.bytes) && pkg.bytes > 0 && pkg.bytes <= MAX_PACKAGE_BYTES)
  }
  return byName
}

function versionParts(value) {
  assert.match(value, VERSION, `Invalid npm version: ${value}`)
  const [core, prerelease = ''] = value.split('-', 2)
  return {
    core: core.split('.').map(Number),
    prerelease: prerelease ? prerelease.split('.') : [],
  }
}

/** A small semver comparator; npm channel versions are strict x.y.z values. */
export function compareVersions(left, right) {
  const a = versionParts(left)
  const b = versionParts(right)
  for (let index = 0; index < 3; index++) {
    if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index++) {
    if (index >= a.prerelease.length) return -1
    if (index >= b.prerelease.length) return 1
    const av = a.prerelease[index]
    const bv = b.prerelease[index]
    if (av === bv) continue
    const an = /^[0-9]+$/u.test(av)
    const bn = /^[0-9]+$/u.test(bv)
    if (an && bn) return Number(av) > Number(bv) ? 1 : -1
    if (an !== bn) return an ? -1 : 1
    return av > bv ? 1 : -1
  }
  return 0
}

async function boundedBytes(response, url, limit) {
  assert.equal(response.status, 200, `npm response ${response.status}: ${url}`)
  const declared = Number(response.headers?.get?.('content-length') ?? 0)
  assert.ok(!declared || declared <= limit, `npm response exceeded bound: ${url}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  assert.ok(bytes.length <= limit, `npm response exceeded bound: ${url}`)
  return bytes
}

async function getJson(url, fetchImpl, limit = MAX_METADATA_BYTES) {
  const parsed = new URL(url)
  assert.equal(parsed.origin, 'https://registry.npmjs.org')
  const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(60_000) })
  return JSON.parse((await boundedBytes(response, url, limit)).toString('utf8'))
}

function packageUrl(registry, name) {
  return `${registry}/${encodeURIComponent(name)}`
}

function metadataUrl(registry, name, version) {
  return `${packageUrl(registry, name)}/${encodeURIComponent(version)}`
}

function sri(bytes) {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`
}

async function inspectPackage(item, current, channel, fetchImpl, selectedMetadata) {
  const packumentUrl = packageUrl(channel.registry, item.name)
  const packument = await getJson(packumentUrl, fetchImpl)
  let version
  if (item.distTag) {
    const distTags = exactObject(packument['dist-tags'], `${item.name} dist-tags`)
    version = distTags[item.distTag]
    assert.equal(typeof version, 'string', `${item.name} is missing dist-tag ${item.distTag}`)
  } else {
    const parent = exactObject(selectedMetadata.get(item.fromPackage), `${item.fromPackage} metadata`)
    const dependencies = exactObject(parent.dependencies, `${item.fromPackage} dependencies`)
    version = dependencies[item.name]
    assert.equal(typeof version, 'string', `${item.fromPackage} does not depend on ${item.name}`)
  }
  assert.match(version, VERSION, `${item.name} selected version`)
  const relation = compareVersions(version, current.version)
  assert.ok(relation >= 0, `${item.name}@${version} would downgrade the locked ${current.version}`)

  const metadata = exactObject(packument.versions?.[version], `${item.name}@${version} metadata`)
  assert.equal(metadata.name, item.name)
  assert.equal(metadata.version, version)
  const dist = exactObject(metadata.dist, `${item.name}@${version} dist metadata`)
  assert.match(dist.tarball, /^https:\/\/registry\.npmjs\.org\//u)
  assert.match(dist.integrity, INTEGRITY)
  const bytes = await boundedBytes(
    await fetchImpl(dist.tarball, { redirect: 'error', signal: AbortSignal.timeout(60_000) }),
    dist.tarball,
    MAX_PACKAGE_BYTES,
  )
  const observed = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), integrity: sri(bytes) }
  assert.equal(observed.integrity, dist.integrity, `${item.name}@${version} SRI`)
  if (typeof dist.shasum === 'string') {
    assert.equal(dist.shasum, createHash('sha1').update(bytes).digest('hex'), `${item.name}@${version} shasum`)
  }
  if (relation === 0) {
    assert.equal(observed.bytes, current.bytes, `${item.name}@${version} bytes changed after publication`)
    assert.equal(observed.sha256, current.sha256, `${item.name}@${version} SHA-256 changed after publication`)
    assert.equal(observed.integrity, current.integrity, `${item.name}@${version} integrity changed after publication`)
  }
  const next = relation > 0
    ? { ...current, version, bytes: observed.bytes, sha256: observed.sha256, integrity: observed.integrity }
    : current
  return {
    package: next,
    report: {
      name: item.name,
      selector: item.distTag ?? `dependency:${item.fromPackage}`,
      currentVersion: current.version,
      selectedVersion: version,
      changed: relation > 0,
      metadataUrl: metadataUrl(channel.registry, item.name, version),
      tarballUrl: dist.tarball,
      bytes: observed.bytes,
      sha256: observed.sha256,
      integrity: observed.integrity,
    },
    metadata,
  }
}

export async function inspectNpmChannel({ channel, lock, fetchImpl = globalThis.fetch } = {}) {
  const selectedChannel = validateChannel(channel ?? readJson(defaultChannelPath))
  const selectedLock = lock ?? readJson(defaultLockPath)
  const byName = validateLock(selectedLock, selectedChannel)
  assert.equal(typeof fetchImpl, 'function', 'A fetch implementation is required')
  const reports = []
  const nextByName = new Map()
  const selectedMetadata = new Map()
  for (const item of selectedChannel.packages) {
    const result = await inspectPackage(item, byName.get(item.name), selectedChannel, fetchImpl, selectedMetadata)
    reports.push(result.report)
    nextByName.set(item.name, result.package)
    selectedMetadata.set(item.name, result.metadata)
  }
  const changed = reports.some(report => report.changed)
  const nextLock = changed ? {
    schemaVersion: selectedLock.schemaVersion,
    releaseSequence: selectedLock.releaseSequence + 1,
    sourceRepository: selectedLock.sourceRepository,
    environment: selectedLock.environment,
    packages: selectedLock.packages.map(pkg => nextByName.get(pkg.name) ?? pkg),
  } : selectedLock
  return Object.freeze({
    changed,
    channel: selectedChannel,
    currentLock: selectedLock,
    nextLock,
    reports,
  })
}

function parseArgs(argv) {
  const result = { write: false, report: null, lock: defaultLockPath, channel: defaultChannelPath }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--write') result.write = true
    else if (arg === '--report') result.report = resolve(argv[++index] ?? '')
    else if (arg === '--lock') result.lock = resolve(argv[++index] ?? '')
    else if (arg === '--channel') result.channel = resolve(argv[++index] ?? '')
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return result
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const args = parseArgs(process.argv.slice(2))
  const result = await inspectNpmChannel({ channel: readJson(args.channel), lock: readJson(args.lock) })
  if (args.write && result.changed) writeFileSync(args.lock, canonicalJson(result.nextLock), { encoding: 'utf8' })
  const report = { schemaVersion: 1, changed: result.changed, packages: result.reports }
  if (args.report) writeFileSync(args.report, canonicalJson(report), { encoding: 'utf8' })
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `changed=${result.changed ? 'true' : 'false'}\n`)
    appendFileSync(process.env.GITHUB_OUTPUT, `updated_packages=${result.reports.filter(item => item.changed).map(item => item.name).join(',')}\n`)
  }
  console.log(JSON.stringify(report))
}
