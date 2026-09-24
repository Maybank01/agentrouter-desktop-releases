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
  assert.equal((ci.match(/persist-credentials: false/g) ?? []).length, 4)
  assert.equal((ci.match(/runs-on: windows-2025/g) ?? []).length, 2)
  for (const command of ['npm test', 'git diff --check',
    'npm ci --ignore-scripts --prefix assembly/coordinated',
    'node assembly/coordinated/test.mjs', 'node assembly/coordinated/store-migration-acceptance.mjs',
    'node assembly/coordinated-candidate.mjs --scenario=${{ matrix.scenario }}']) assert.ok(ci.includes(command), command)
  // Installed checks run as parallel scenarios, all gated by the change scope and
  // all required; none may be silently dropped from the matrix.
  assert.equal((ci.match(/if: needs\.bootstrap\.outputs\.installed == 'true'/g) ?? []).length, 3)
  // Installed scenarios start once npm serves the exact locked bytes, never before.
  assert.match(ci, /needs: \[bootstrap, plugin_bytes\]/)
  assert.match(ci, /run: node assembly\/wait-plugin\.mjs\r?\n/)
  // A failed installed acceptance on main (possibly after a hotfix published) opens an incident.
  assert.match(ci, /if: \$\{\{ failure\(\) && github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' \}\}/)
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
  const release = readFileSync(join(directory, 'release.yml'), 'utf8').split('\n  # Coordinated lane:')[0]
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
  // The unsigned release fallback keeps the full sequential native update +
  // legacy migration; signed checks run as single scenarios on the signed draft.
  const coordinatedRelease = readFileSync(join(directory, 'release.yml'), 'utf8')
  assert.match(coordinatedRelease, /run: node assembly\/coordinated-candidate\.mjs\r?\n/)
  assert.deepEqual(coordinatedRelease.match(/--scenario=[\w-]+/g), ['--scenario=native-updater', '--scenario=legacy-migration'])
  assert.equal((coordinatedRelease.match(/--scenario=[\w-]+ --signed-installer=\.local\/signed-installer\.json/g) ?? []).length, 2)
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

test('coordinated release reuses exact-input evidence and runs signed checks in parallel before publishing', () => {
  const workflow = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8')
  const lane = workflow.split('\n  # Coordinated lane:')[1]
  const jobs = Object.fromEntries(lane.split(/\n  (?=[a-z_]+:\r?\n)/).slice(1).map(body => [body.slice(0, body.indexOf(':')), body]))
  assert.deepEqual(Object.keys(jobs), ['coordinated_evidence', 'coordinated', 'coordinated_sign', 'coordinated_signed_update',
    'coordinated_signed_legacy', 'coordinated_signed_install', 'coordinated_publish', 'coordinated_outcome', 'coordinated_timeline'])
  // The hotfix profile defers only the unsigned pre-sign duplicate; signing and
  // every signed installed check still gate publication, and it is recorded.
  assert.match(workflow, /options: \[standard, hotfix\]/)
  assert.match(jobs.coordinated, /inputs\.profile != 'hotfix'/)
  assert.match(jobs.coordinated_sign, /inputs\.profile == 'hotfix' && needs\.coordinated\.result == 'skipped'/)
  assert.match(jobs.coordinated_sign, /RELEASE_PROFILE: \$\{\{ inputs\.profile \}\}/)
  assert.match(jobs.coordinated_evidence, /node assembly\/wait-plugin\.mjs --require-next/)
  assert.match(jobs.coordinated_timeline, /if: \$\{\{ always\(\) && [^\n]*inputs\.delivery == 'coordinated' \}\}/)
  assert.match(jobs.coordinated_timeline, /node assembly\/release-timeline\.mjs/)
  assert.doesNotMatch(jobs.coordinated_timeline, /secrets\.|contents: write|environment:/)
  delete jobs.coordinated_timeline
  // The outcome guard reads only job results: no checkout, no token scopes.
  assert.doesNotMatch(jobs.coordinated_outcome, /uses: |run: node /)
  assert.match(jobs.coordinated_outcome, /permissions: \{\}/)
  assert.match(jobs.coordinated_outcome, /if: \$\{\{ always\(\) && [^\n]*inputs\.publish \}\}/)
  assert.match(jobs.coordinated_outcome, /needs: \[[^\]]*coordinated_publish\]/)
  assert.match(jobs.coordinated_outcome, /PUBLISH_RESULT" != "success"/)
  delete jobs.coordinated_outcome
  for (const [name, body] of Object.entries(jobs)) {
    assert.equal((body.match(/uses: actions\/checkout@/g) ?? []).length, 1, name)
    assert.equal((body.match(/persist-credentials: false/g) ?? []).length, 1, name)
    assert.doesNotMatch(body, /upload-artifact|actions\/cache|self-hosted|pull_request_target|--clobber/, name)
  }
  // Evidence lookup reads Actions metadata only; it cannot write or sign.
  assert.match(jobs.coordinated_evidence, /runs-on: ubuntu-latest/)
  assert.match(jobs.coordinated_evidence, /permissions:\r?\n      contents: read\r?\n      actions: read\r?\n      pull-requests: read\r?\n    outputs:/)
  assert.match(jobs.coordinated_evidence, /node assembly\/coordinated-inputs\.mjs/)
  assert.match(jobs.coordinated_evidence, /node assembly\/coordinated-evidence\.mjs/)
  assert.match(jobs.coordinated, /needs\.coordinated_evidence\.outputs\.found != 'true'/)
  assert.match(jobs.coordinated_sign, /needs\.coordinated_evidence\.outputs\.found == 'true' \|\| needs\.coordinated\.result == 'success'/)
  assert.match(jobs.coordinated_sign, /ACCEPTANCE_EVIDENCE_JSON: \$\{\{ needs\.coordinated_evidence\.outputs\.evidence \}\}/)
  // Only signing and the signed-baseline update hold the signing environment.
  assert.deepEqual(Object.keys(jobs).filter(name => /environment: windows-signing/.test(jobs[name])), ['coordinated_sign', 'coordinated_signed_update'])
  for (const name of ['coordinated_signed_update', 'coordinated_signed_legacy', 'coordinated_signed_install']) {
    assert.match(jobs[name], /needs: coordinated_sign\r?\n/)
    // A skipped pre-sign candidate (reused evidence) must not skip signed checks.
    assert.match(jobs[name], /if: \$\{\{ !cancelled\(\) && needs\.coordinated_sign\.result == 'success' \}\}/)
    assert.match(jobs[name], /gh release download "\$env:RELEASE_TAG"/)
    assert.match(jobs[name], /node assembly\/coordinated-release\.mjs record \.local\/signed-release /)
  }
  assert.match(jobs.coordinated_publish, /needs: \[coordinated_sign, coordinated_signed_update, coordinated_signed_legacy, coordinated_signed_install\]/)
  for (const name of ['coordinated_sign', 'coordinated_signed_update', 'coordinated_signed_legacy', 'coordinated_signed_install']) {
    assert.match(jobs.coordinated_publish, new RegExp(`needs\\.${name}\\.result == 'success'`), name)
  }
  assert.match(jobs.coordinated_publish, /node assembly\/coordinated-recovery\.mjs/)
  assert.match(jobs.coordinated_publish, /node assembly\/coordinated-release\.mjs publish/)
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
