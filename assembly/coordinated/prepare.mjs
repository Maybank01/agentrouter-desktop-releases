/** Source assembly only. Never updates an installed application or a feed. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const directory = fileURLToPath(new URL('.', import.meta.url))
export const root = resolve(directory, '../..')
export const lock = JSON.parse(readFileSync(join(directory, 'upstream.lock.json'), 'utf8'))
export const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 120000 }).trim()

export function prepareSource() {
  const base = process.env.AGENTROUTER_COORDINATED_WORK_DIR
    ? resolve(process.env.AGENTROUTER_COORDINATED_WORK_DIR) : join(root, '.local/coordinated')
  mkdirSync(base, { recursive: true })
  const output = mkdtempSync(join(base, 'candidate-'))
  const source = join(output, 'source')
  const mirror = process.env.AGENTROUTER_UPSTREAM_SOURCE
  git(output, 'clone', ...(mirror ? ['--shared', resolve(mirror)] : ['--depth', '1', '--branch', lock.tag, lock.repository]), source)
  git(source, 'checkout', '--detach', lock.commit)
  assert.equal(git(source, 'rev-parse', 'HEAD'), lock.commit)
  assert.equal(git(source, 'rev-parse', 'HEAD^{tree}'), lock.tree)
  const patch = join(directory, lock.patch)
  git(source, 'apply', '--check', patch)
  git(source, 'apply', patch)
  // Regenerated patches must retain added shell assets. Git diff omits an
  // untracked startup.html, otherwise producing a valid but unbootable app.
  assert.match(readFileSync(join(source, 'apps/desktop/renderer/startup.html'), 'utf8'),
    /id="status"/, 'The patched startup page must include its progress element')
  // One shared verifier is bundled into the native main process and also used
  // by independent release acceptance. It is part of the exported adapter.
  copyFileSync(join(directory, 'update-signature.mjs'), join(source, 'apps/desktop/src/agentrouter-update-signature.mjs'))
  copyFileSync(join(directory, 'update-recovery.mjs'), join(source, 'apps/desktop/src/agentrouter-update-recovery.mjs'))
  copyFileSync(join(directory, 'update-exit.mjs'), join(source, 'apps/desktop/src/agentrouter-update-exit.mjs'))
  copyFileSync(join(directory, 'update-routes.mjs'), join(source, 'apps/desktop/src/agentrouter-update-routes.mjs'))
  copyFileSync(join(directory, 'credential-recovery.mjs'), join(source, 'apps/desktop/src/agentrouter-credential-recovery.mjs'))
  copyFileSync(join(directory, 'external-navigation.mjs'), join(source, 'apps/desktop/src/agentrouter-external-navigation.mjs'))
  copyFileSync(join(directory, 'runtime-recovery.mjs'), join(source, 'apps/desktop/src/agentrouter-runtime-recovery.mjs'))
  copyFileSync(join(directory, 'update-runtime.mjs'), join(source, 'apps/desktop/src/agentrouter-update-runtime.mjs'))
  copyFileSync(join(directory, 'update-transport.mjs'), join(source, 'apps/desktop/src/agentrouter-update-transport.mjs'))
  copyFileSync(join(directory, 'update-rollout.mjs'), join(source, 'apps/desktop/src/agentrouter-update-rollout.mjs'))
  copyFileSync(join(directory, 'release-history.json'), join(source, 'apps/desktop/src/agentrouter-release-history.json'))
  const changes = git(source, 'diff', '--name-only').split('\n')
  assert.ok(changes.length > 0 && changes.every(path => path.startsWith('apps/desktop/') || path === 'apps/desktop-host/src/index.ts'))
  symlinkSync(join(directory, 'node_modules'), join(source, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  writeFileSync(join(output, 'source.json'), JSON.stringify({ source, upstreamCommit: lock.commit, upstreamTree: lock.tree, changes }, null, 2) + '\n')
  return { source, output }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(prepareSource()))
