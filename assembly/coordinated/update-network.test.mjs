/**
 * The update path is sacred: main-process network access must go through
 * Electron's session (net.fetch / electron-updater's ElectronHttpExecutor),
 * which honours the Windows system proxy and PAC. Node's global fetch/undici and
 * node:http(s) ignore them; <=3.0.19 fetched the signed update manifest with
 * Node fetch and could not update wherever GitHub is reachable only via a proxy.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const directory = fileURLToPath(new URL('.', import.meta.url))
// Every adapter module prepare.mjs copies into the Electron main process.
const mainModules = ['update-signature.mjs', 'update-recovery.mjs', 'update-exit.mjs', 'update-routes.mjs',
  'credential-recovery.mjs', 'external-navigation.mjs', 'runtime-recovery.mjs', 'update-runtime.mjs',
  'update-transport.mjs', 'update-rollout.mjs']

/** Remove comments and string/template contents so only code identifiers remain. */
function code(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(line => line
      .replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""')
      .replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')
}

const forbidden = [
  [/(?<![.\w$])fetch\b(?!\s*:)/, 'Node global fetch (use the injected Electron session fetcher)'],
  [/globalThis\s*\.\s*fetch\b/, 'Node global fetch'],
]
const forbiddenImports = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](?:node:)?(?:https?|http2|undici|net|tls)['"]/

function networkViolations(name, text) {
  const found = []
  const lines = code(text).split('\n')
  lines.forEach((line, index) => {
    for (const [pattern, reason] of forbidden) if (pattern.test(line)) found.push(`${name}:${index + 1}: ${reason}: ${line.trim()}`)
  })
  text.split('\n').forEach((line, index) => {
    if (forbiddenImports.test(line)) found.push(`${name}:${index + 1}: direct Node networking import: ${line.trim()}`)
  })
  return found
}

/** Added lines of main-process TypeScript in the adapter patch. */
function patchedMainLines(patch) {
  const files = new Map()
  let current
  for (const line of patch.split('\n')) {
    const header = /^\+\+\+ b\/(.+)$/.exec(line)
    if (header) { current = /^apps\/desktop\/src\/[^/]+\.ts$/.test(header[1]) ? header[1] : undefined; continue }
    if (current && line.startsWith('+')) files.set(current, (files.get(current) ?? '') + line.slice(1) + '\n')
  }
  return files
}

test('main-process adapter modules never use Node global fetch or node:http(s)', () => {
  const violations = mainModules.flatMap(name => networkViolations(name, readFileSync(join(directory, name), 'utf8')))
  assert.deepEqual(violations, [])
})

test('patched main-process sources never fall back to Node global fetch', () => {
  const files = patchedMainLines(readFileSync(join(directory, 'coordinated-delivery.patch'), 'utf8'))
  assert.ok(files.has('apps/desktop/src/update-coordinator.ts'), 'The update coordinator must remain in the patch')
  const violations = [...files].flatMap(([name, text]) => networkViolations(name, text))
  assert.deepEqual(violations, [])
  assert.match(files.get('apps/desktop/src/update-coordinator.ts'), /net\.fetch\(/, 'The updater must use Electron net.fetch')
})

test('the rule detects the <=3.0.19 regression and its variants', () => {
  assert.equal(networkViolations('x', 'export function f(a, fetcher = fetch) {}').length, 1)
  assert.equal(networkViolations('x', "const f = ok ? net.fetch : fetch").length, 1)
  assert.equal(networkViolations('x', 'await fetch(url)').length, 1)
  assert.equal(networkViolations('x', 'globalThis.fetch(url)').length, 1)
  assert.equal(networkViolations('x', "import https from 'node:https'").length, 1)
  assert.equal(networkViolations('x', "import { request } from 'undici'").length, 1)
  assert.deepEqual(networkViolations('x', "net.fetch(url); host.fetch(request); fetcher(url); fetchHost(r); x = { fetch: 1 }; // fetch(url)\nconst a = ['fetch', '--fetch-retries=1']"), [])
})
