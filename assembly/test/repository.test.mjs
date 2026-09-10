import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { root, readJson } from '../lib.mjs'

test('the public release repository contains assembly inputs, not product source', () => {
  const manifest = readJson(join(root, 'package.json'))
  assert.equal(manifest.name, 'agentrouter-desktop-releases')
  assert.equal(manifest.private, true)
  for (const field of ['workspaces', 'dependencies', 'devDependencies', 'resolutions']) {
    assert.equal(manifest[field], undefined)
  }
  for (const name of ['packages', 'dsh-plugin-desktop', 'scripts', 'yarn.lock']) {
    assert.equal(existsSync(join(root, name)), false, `Unexpected product source path at repository root: ${name}`)
  }
  assert.doesNotMatch(JSON.stringify(manifest.scripts), /workspace|components:|promote|plugins:/)
})

test('one scheduled workflow checks npm and publishes this repository formal release', () => {
  const directory = join(root, '.github/workflows')
  assert.deepEqual(readdirSync(directory).sort(), ['ci.yml', 'release.yml'])
  const ci = readFileSync(join(directory, 'ci.yml'), 'utf8')
  assert.match(ci, /contents: read/)
  assert.doesNotMatch(ci, /npm publish|PUBLIC_RELEASE_APP/u)

  const release = readFileSync(join(directory, 'release.yml'), 'utf8')
  assert.match(release, /schedule:/)
  assert.match(release, /workflow_dispatch:/)
  assert.equal((release.match(/corepack@0\.36\.0/g) ?? []).length, 2)
  assert.equal((release.match(/npm install --prefix [^\r\n]+ corepack@0\.36\.0/g) ?? []).length, 2)
  assert.doesNotMatch(release, /npm install --global corepack/)
  assert.match(release, /check-npm-updates\.mjs --write/)
  assert.match(release, /npm run assembly:refresh-lock/)
  assert.match(release, /npm run build:win/)
  assert.match(release, /contents: write/)
  assert.equal((release.match(/GH_TOKEN: \$\{\{ github\.token \}\}/g) ?? []).length, 2)
  assert.equal((release.match(/persist-credentials: false/g) ?? []).length, 2)
  assert.match(release, /GITHUB_REPOSITORY/)
  assert.match(release, /gh release create/)
  assert.match(release, /--latest/)
  assert.match(release, /release\.prerelease/)
  assert.match(release, /Anonymous Release download mismatch/)
  assert.match(release, /git push origin HEAD:main/)
  assert.doesNotMatch(release, /create-github-app-token|PUBLIC_RELEASE_APP|secrets\./u)
  assert.doesNotMatch(release, /npm publish|NODE_AUTH_TOKEN|NPM_TOKEN|pull-request|channels\/|latest\/download/u)
})
