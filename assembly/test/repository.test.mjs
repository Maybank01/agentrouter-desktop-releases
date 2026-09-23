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

test('optional Desktop publication is manually dispatched on main and never follows npm automatically', () => {
  const directory = join(root, '.github/workflows')
  assert.deepEqual(readdirSync(directory).sort(), ['ci.yml', 'plugin-validation.yml', 'release.yml'])
  const ci = readFileSync(join(directory, 'ci.yml'), 'utf8')
  assert.match(ci, /contents: read/)
  assert.match(ci, /workflow_dispatch:/)
  assert.match(ci, /runs-on: ubuntu-latest/)
  assert.match(ci, /runs-on: windows-2025/)
  assert.equal((ci.match(/persist-credentials: false/g) ?? []).length, 3)
  assert.equal((ci.match(/runs-on: windows-2025/g) ?? []).length, 2)
  for (const command of ['npm test', 'git diff --check',
    'npm ci --ignore-scripts --prefix assembly/coordinated',
    'node assembly/coordinated/test.mjs', 'node assembly/coordinated/store-migration-acceptance.mjs',
    'node assembly/coordinated-candidate.mjs --scenario=${{ matrix.scenario }}']) assert.ok(ci.includes(command), command)
  // Installed checks run as parallel scenarios, all gated by the change scope and
  // all required; none may be silently dropped from the matrix.
  assert.equal((ci.match(/if: needs\.bootstrap\.outputs\.installed == 'true'/g) ?? []).length, 2)
  assert.match(ci, /fail-fast: false/)
  for (const scenario of ['native-updater', 'legacy-migration', 'fresh-install-recovery']) {
    assert.match(ci, new RegExp(`- scenario: ${scenario}\\r?\\n`), scenario)
  }
  assert.doesNotMatch(ci, /continue-on-error/)
  // Every npm ci step goes through the single frozen-install retry wrapper.
  for (const workflow of [ci, readFileSync(join(directory, 'release.yml'), 'utf8')]) {
    const installs = workflow.match(/^.*npm ci .*$/gm) ?? []
    assert.ok(installs.length > 0)
    for (const line of installs) assert.match(line, /run: node assembly\/retry-install\.mjs npm ci --ignore-scripts --prefix assembly\/coordinated\r?$/)
  }
  assert.match(ci, /github\.workflow_sha/)
  assert.match(ci, /adapter-source\.json/)
  assert.doesNotMatch(ci, /npm publish|PUBLIC_RELEASE_APP|secrets\.|contents: write|workflow_call:|pull_request_target:|upload-artifact|actions\/cache|self-hosted|repository:\s*Maybank01\//u)

  // Preserve the historical community lane's contract; the new product lane
  // below is separately bound to the exported source and installed acceptance.
  const release = readFileSync(join(directory, 'release.yml'), 'utf8').split('\n  coordinated:')[0]
  assert.doesNotMatch(release, /schedule:|cron:|repository_dispatch:|workflow_run:/)
  assert.match(release, /workflow_dispatch:/)
  assert.match(release, /github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main'/)
  assert.equal((release.match(/corepack@0\.36\.0/g) ?? []).length, 2)
  assert.equal((release.match(/npm install --prefix [^\r\n]+ corepack@0\.36\.0/g) ?? []).length, 2)
  assert.doesNotMatch(release, /npm install --global corepack/)
  assert.equal((release.match(/AGENTROUTER_COREPACK=/g) ?? []).length, 2)
  assert.match(release, /check-npm-updates\.mjs --write/)
  assert.match(release, /npm run assembly:refresh-lock/)
  assert.match(release, /npm run build:win/)
  assert.match(release, /contents: write/)
  // Release acceptance keeps the full sequential native update + legacy migration.
  const coordinatedRelease = readFileSync(join(directory, 'release.yml'), 'utf8')
  assert.match(coordinatedRelease, /run: node assembly\/coordinated-candidate\.mjs\r?\n/)
  assert.doesNotMatch(coordinatedRelease, /--scenario/)
  assert.equal((release.match(/GH_TOKEN: \$\{\{ github\.token \}\}/g) ?? []).length, 2)
  assert.equal((release.match(/persist-credentials: false/g) ?? []).length, 2)
  assert.match(release, /GITHUB_REPOSITORY/)
  assert.match(release, /gh release create/)
  assert.match(release, /--latest/)
  assert.match(release, /release\.prerelease/)
  assert.match(release, /Anonymous Release download mismatch/)
  assert.match(release, /Stage build evidence in the workspace/)
  assert.match(release, /path: artifacts\//)
  assert.doesNotMatch(release, /path: \|\r?\n\s+\$\{\{ steps\.installer\.outputs\.path/)
  assert.match(release, /git push origin HEAD:main/)
  assert.match(release, /http\.https:\/\/github\.com\/\.extraheader/)
  assert.match(release, /x-access-token:\$env:GH_TOKEN/)
  assert.match(release, /AUTHORIZATION: basic \$basicCredential/)
  assert.doesNotMatch(release, /AUTHORIZATION: bearer/)
  assert.doesNotMatch(release, /create-github-app-token|PUBLIC_RELEASE_APP|secrets\./u)
  assert.doesNotMatch(release, /npm publish|NODE_AUTH_TOKEN|NPM_TOKEN|pull-request|channels\/|latest\/download/u)
})

test('native smoke clears only the expected bilingual first-run dialogs', () => {
  const smoke = readFileSync(join(root, 'assembly/smoke-desktop.mjs'), 'utf8')
  assert.match(smoke, /Internal Testing Notice\|内测声明/)
  assert.match(smoke, /Add an API key to get started\|添加一个 API Key 开始使用/)
  assert.match(smoke, /Configure later\|稍后配置/)
  assert.match(smoke, /Connect AgentRouter\|连接 AgentRouter/)
  assert.match(smoke, /dialog\.waitFor\(\{ state: 'detached'/)
  assert.doesNotMatch(smoke, /\.click\(\{ force: true \}\)/)
})
