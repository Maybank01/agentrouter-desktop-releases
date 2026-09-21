import test from 'node:test'
import assert from 'node:assert/strict'
import { createProductUpdateRoutes, releaseHistory } from './update-routes.mjs'

const base = 'dsh-app://app/api/agentrouter/v1/updates/'
const request = (action, body = {}, headers = {}) => new Request(base + action, action === 'status' ? {} : {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
function fixture() {
  const calls = []
  const native = { phase: 'available', version: '3.0.9', canDownload: true, canInstall: false, enabled: true }
  const host = { owner: 'product', busy: false, currentVersion: '0.14.0', host: { version: '0.1.5-rc.2' }, profile: 'private/path' }
  let online = true
  const routes = createProductUpdateRoutes({ productVersion: '3.0.8',
    coordinator: { status: () => native, ...Object.fromEntries(['check', 'download', 'restart'].map(action => [action, async version => { calls.push([action, version]) }])) },
    fetchHost: async () => { if (!online) throw new Error('private path'); return Response.json(host) },
    history: [{ version: '3.0.8', changes: [{ kind: 'fixed', text: 'Known release' }] }] })
  return { routes, calls, native, host, offline: () => { online = false } }
}

test('public routes expose distinct installed identities and only their exact paths', async () => {
  const f = fixture()
  const response = await f.routes.handle(request('status'))
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const state = await response.json()
  assert.equal(state.currentVersion, '0.14.0')
  assert.deepEqual(state.product, { version: '3.0.8', latestVersion: '3.0.9' })
  assert.doesNotMatch(JSON.stringify(state), /private/)
  assert.equal(f.routes.matches(new Request(base + 'status/extra')), false)
  assert.equal(f.routes.matches(new Request(base.replace('dsh-app:', 'https:') + 'status')), false)
})

test('download needs an exact target and never invokes restart; busy or unknown work cannot restart', async () => {
  const f = fixture()
  assert.equal((await f.routes.handle(request('download', { version: '3.0.7' }))).status, 409)
  await f.routes.handle(request('download', { version: '3.0.9' }))
  assert.deepEqual(f.calls, [['download', '3.0.9']])
  Object.assign(f.native, { phase: 'ready', canDownload: false, canInstall: true })
  f.host.busy = true
  await f.routes.handle(request('install', { version: '3.0.9', interrupt: true }))
  assert.equal(f.calls.length, 1)
  f.host.busy = false
  await f.routes.handle(request('install', { version: '3.0.9' }))
  assert.deepEqual(f.calls.at(-1), ['restart', '3.0.9'])
  f.offline()
  const state = await (await f.routes.handle(request('install', { version: '3.0.9' }))).json()
  assert.equal(state.canInstall, false); assert.equal(state.busy, true)
  assert.equal(state.currentVersion, '0.14.0'); assert.equal(f.calls.length, 2)
})

test('cross-origin, wrong methods, oversized and malformed bodies cannot mutate', async () => {
  const f = fixture()
  for (const [req, code] of [
    [request('check', {}, { origin: 'https://untrusted.invalid' }), 403],
    [request('check', {}, { origin: 'null' }), 403],
    [request('check', {}, { 'sec-fetch-site': 'cross-site' }), 403],
    [new Request(base + 'download'), 405],
    [request('download', { x: 'a'.repeat(4096) }), 400],
    [request('check', [], {}), 400],
    [new Request(base + 'check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' }), 400],
  ]) assert.equal((await f.routes.handle(req)).status, code)
  assert.deepEqual(f.calls, [])
  await f.routes.handle(request('check', {}, { origin: 'dsh-app://app' }))
  assert.deepEqual(f.calls, [['check', undefined]])
})

test('history and product-bound plugin metadata are optional display data and survive offline status', async () => {
  const f = fixture()
  f.native.releaseInfo = { version: '3.0.9', agentrouter: { pluginVersion: '0.15.0', releaseNotes: [
    { version: '3.0.9', publishedAt: 'bad', changes: [{ kind: 'fixed', text: '<img src=x>' }] },
    { version: '99.0.0', changes: [{ text: 'Future' }] },
  ] } }
  const state = await (await f.routes.handle(request('status'))).json()
  assert.equal(state.product.latestPluginVersion, '0.15.0')
  assert.deepEqual(state.history.map(item => item.version), ['3.0.9', '3.0.8'])
  assert.equal(state.history[0].publishedAt, undefined)
  f.offline(); f.native.releaseInfo = undefined
  assert.equal((await (await f.routes.handle(request('status'))).json()).history.length, 2)
  assert.deepEqual(releaseHistory([{ version: 'bad', changes: [] }], '3.0.8'), [])
})
