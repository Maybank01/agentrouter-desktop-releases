import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { compareVersions, inspectNpmChannel } from '../check-npm-updates.mjs'

const packageName = '@example/desktop-plugin'
const channel = {
  schemaVersion: 1,
  registry: 'https://registry.npmjs.org',
  packages: [{ name: packageName, distTag: 'next', direct: true }],
}

function fixture(version, bytes) {
  const data = Buffer.from(bytes)
  const integrity = `sha512-${createHash('sha512').update(data).digest('base64')}`
  const tarball = `https://registry.npmjs.org/example-desktop-plugin/-/example-desktop-plugin-${version}.tgz`
  return {
    [`https://registry.npmjs.org/${encodeURIComponent(packageName)}`]: new Response(JSON.stringify({
      name: packageName,
      'dist-tags': { next: version },
      versions: { [version]: { name: packageName, version, dist: { tarball, integrity } } },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
    [tarball]: new Response(data, { status: 200, headers: { 'content-length': String(data.length) } }),
  }
}

function lock(version, bytes) {
  const data = Buffer.from(bytes)
  return {
    schemaVersion: 1,
    releaseSequence: 2,
    sourceRepository: 'Maybank01/agentrouter-dsh-plugins',
    sourceCommit: 'a'.repeat(40),
    publicationEvidence: 'test',
    environment: 'v3-candidate',
    packages: [{ name: packageName, version, direct: true, bytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
      integrity: `sha512-${createHash('sha512').update(data).digest('base64')}` }],
  }
}

function fetchFrom(map) {
  return async url => {
    const response = map[url]
    if (!response) throw new Error(`unexpected URL ${url}`)
    return response.clone()
  }
}

test('compares npm versions using semver precedence', () => {
  assert.equal(compareVersions('1.0.0', '1.0.0-beta.2'), 1)
  assert.equal(compareVersions('1.0.0-beta.10', '1.0.0-beta.2'), 1)
  assert.equal(compareVersions('0.2.2-agentrouter.9', '0.2.2-agentrouter.9'), 0)
  assert.equal(compareVersions('0.1.0-beta.1', '0.1.0-beta.2'), -1)
})

test('returns an exact byte-verified lock update for a newer dist-tag', async () => {
  const map = fixture('1.0.1', 'new package bytes')
  const result = await inspectNpmChannel({ channel, lock: lock('1.0.0', 'old package bytes'), fetchImpl: fetchFrom(map) })
  assert.equal(result.changed, true)
  assert.equal(result.nextLock.packages[0].version, '1.0.1')
  assert.equal(result.nextLock.releaseSequence, 3)
  assert.equal(result.nextLock.sourceCommit, undefined)
  assert.equal(result.nextLock.packages[0].bytes, 'new package bytes'.length)
  assert.equal(result.reports[0].changed, true)
})

test('fails closed on a downgrade or a mutated already-published version', async () => {
  await assert.rejects(
    inspectNpmChannel({ channel, lock: lock('1.0.1', 'old package bytes'), fetchImpl: fetchFrom(fixture('1.0.0', 'older')) }),
    /downgrade/u,
  )
  const map = fixture('1.0.0', 'different bytes')
  await assert.rejects(
    inspectNpmChannel({ channel, lock: lock('1.0.0', 'old package bytes'), fetchImpl: fetchFrom(map) }),
    /bytes changed after publication/u,
  )
})
