/** Download release assets with gh and verify each against GitHub's recorded SHA-256 digest. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { repository } from './plan.mjs'

const gh = args => execFileSync('gh', args, { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] })

/** Resolve a release by tag, including drafts (the REST tag endpoint only resolves published releases). */
export function releaseByTag(tag) {
  const { databaseId } = JSON.parse(gh(['release', 'view', tag, '--repo', repository, '--json', 'databaseId']))
  assert.ok(Number.isSafeInteger(databaseId) && databaseId > 0)
  const release = JSON.parse(gh(['api', `repos/${repository}/releases/${databaseId}`]))
  assert.equal(release.tag_name, tag)
  return release
}

export async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/** Updater files of a product release; the installer must match GitHub's digest. */
export const updateFiles = version => [`AgentRouter-${version}-x64-Setup.exe`, `AgentRouter-${version}-x64-Setup.exe.blockmap`, 'latest.yml', 'agentrouter-update.json']

export async function downloadVerified(release, names, directory) {
  mkdirSync(directory, { recursive: true })
  const files = new Map()
  for (const name of names) {
    const asset = release.assets.find(item => item.name === name)
    assert.ok(asset, `${release.tag_name} has no asset ${name}`)
    assert.match(asset.digest ?? '', /^sha256:[a-f0-9]{64}$/, `${release.tag_name}/${name} has no recorded digest`)
    gh(['release', 'download', release.tag_name, '--repo', repository, '--pattern', name, '--dir', directory, '--clobber'])
    const path = join(directory, name)
    assert.equal(statSync(path).size, asset.size, `${name} size differs from the release record`)
    assert.equal(`sha256:${await sha256File(path)}`, asset.digest, `${name} digest differs from the release record`)
    files.set(name, { path, bytes: asset.size, sha256: asset.digest.slice(7) })
  }
  return files
}
