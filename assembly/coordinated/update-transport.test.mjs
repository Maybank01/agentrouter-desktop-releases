import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { downloadSources, installResilientTransport, mirroredFetch, resumableDownload, withSources } from './update-transport.mjs'

const noWait = async () => {}
const body = randomBytes(3 * 1024 * 1024 + 123)
const sha512 = createHash('sha512').update(body).digest('base64')

/** A real HTTP server whose first responses drop the connection mid-body. */
async function flakyServer({ drops = 1, dropAfter = 1024 * 1024, status } = {}) {
  const requests = []
  let remainingDrops = drops
  const server = createServer((req, res) => {
    const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? '')
    requests.push({ url: req.url, range: req.headers.range })
    if (status) { res.writeHead(status); res.end(); return }
    const start = range ? Number(range[1]) : 0
    const slice = body.subarray(start)
    res.writeHead(range ? 206 : 200, { 'content-length': slice.length, 'accept-ranges': 'bytes',
      ...(range ? { 'content-range': `bytes ${start}-${body.length - 1}/${body.length}` } : {}) })
    if (remainingDrops-- > 0) {
      res.write(slice.subarray(0, dropAfter), () => { res.socket.destroy() })
      return
    }
    res.end(slice)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${server.address().port}/AgentRouter-3.0.20-x64-Setup.exe`, requests,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }) }
}

const temporary = () => mkdtempSync(join(tmpdir(), 'agentrouter-transport-'))

test('maps release files to the mirror first and their immutable GitHub tag second', () => {
  assert.deepEqual(downloadSources('https://github.com/Maybank01/agentrouter-desktop-releases/releases/latest/download/AgentRouter-3.0.20-x64-Setup.exe'), [
    'https://agentrouter.top/downloads/desktop/v3.0.20/AgentRouter-3.0.20-x64-Setup.exe',
    'https://github.com/Maybank01/agentrouter-desktop-releases/releases/download/v3.0.20/AgentRouter-3.0.20-x64-Setup.exe'])
  assert.deepEqual(downloadSources('https://github.com/Maybank01/agentrouter-desktop-releases/releases/download/v3.0.19/agentrouter-update.json'), [
    'https://agentrouter.top/downloads/desktop/v3.0.19/agentrouter-update.json',
    'https://github.com/Maybank01/agentrouter-desktop-releases/releases/download/v3.0.19/agentrouter-update.json'])
  assert.deepEqual(downloadSources('https://github.com/Maybank01/agentrouter-desktop-releases/releases/latest/download/latest.yml'), [
    'https://agentrouter.top/downloads/desktop/latest.yml',
    'https://github.com/Maybank01/agentrouter-desktop-releases/releases/latest/download/latest.yml'])
  // Test feeds and other hosts are never redirected.
  assert.deepEqual(downloadSources('http://127.0.0.1:4000/AgentRouter-3.0.20-x64-Setup.exe'), ['http://127.0.0.1:4000/AgentRouter-3.0.20-x64-Setup.exe'])
  assert.deepEqual(downloadSources('https://github.com/other/repo/releases/download/v1.0.0/x.exe'), ['https://github.com/other/repo/releases/download/v1.0.0/x.exe'])
})

test('resumes with HTTP Range after connection drops and verifies SHA-512', async () => {
  const server = await flakyServer({ drops: 2 })
  const root = temporary()
  try {
    const progress = []
    const destination = join(root, 'installer.exe')
    await resumableDownload({ sources: [server.url], destination, sha512, partialDir: join(root, 'partial'), wait: noWait,
      onProgress: value => progress.push(value) })
    assert.deepEqual(readFileSync(destination), body)
    assert.equal(server.requests[0].range, undefined)
    const offsets = server.requests.slice(1).map(request => Number(/^bytes=(\d+)-$/.exec(request.range)[1]))
    assert.equal(server.requests.length, 3)
    assert.ok(offsets[0] > 0 && offsets[1] > offsets[0], 'Each attempt continues after the retained bytes')
    assert.ok(progress.at(-1).transferred === body.length && progress.every(value => Number.isFinite(value.bytesPerSecond)))
    assert.deepEqual(readdirSync(join(root, 'partial')), [])
  } finally { await server.close(); rmSync(root, { recursive: true, force: true }) }
})

test('keeps a partial download across restarts and continues from it', async () => {
  const root = temporary()
  const first = await flakyServer({ drops: 99 })
  try {
    // The application quits after the first interruption.
    let quit = false
    await assert.rejects(resumableDownload({ sources: [first.url], destination: join(root, 'a.exe'), sha512,
      partialDir: join(root, 'partial'), wait: async () => { quit = true }, isCancelled: () => quit }), error => error.name === 'CancellationError')
  } finally { await first.close() }
  const retained = readdirSync(join(root, 'partial'))
  assert.equal(retained.length, 1)
  const second = await flakyServer({ drops: 0 })
  try {
    await resumableDownload({ sources: [second.url], destination: join(root, 'b.exe'), sha512, partialDir: join(root, 'partial'), wait: noWait })
    assert.match(second.requests[0].range, /^bytes=\d+-$/)
    assert.deepEqual(readFileSync(join(root, 'b.exe')), body)
  } finally { await second.close(); rmSync(root, { recursive: true, force: true }) }
})

test('reports an interruption only after retries without progress', async () => {
  const root = temporary()
  const down = await flakyServer({ status: 503 })
  try {
    await assert.rejects(resumableDownload({ sources: [down.url], destination: join(root, 'a.exe'), sha512,
      partialDir: join(root, 'partial'), wait: noWait, delays: [0, 0, 0] }), error => error.code === 'UPDATE_DOWNLOAD_INTERRUPTED')
    assert.equal(down.requests.length, 4)
  } finally { await down.close(); rmSync(root, { recursive: true, force: true }) }
})

test('falls back to the next source per file and rejects corrupted bytes', async () => {
  const missing = await flakyServer({ status: 404 })
  const good = await flakyServer({ drops: 0 })
  const root = temporary()
  try {
    await resumableDownload({ sources: [missing.url, good.url], destination: join(root, 'x.exe'), sha512, partialDir: join(root, 'p'), wait: noWait })
    assert.equal(missing.requests.length, 1)
    assert.deepEqual(readFileSync(join(root, 'x.exe')), body)
    const wrong = createHash('sha512').update('other').digest('base64')
    await assert.rejects(resumableDownload({ sources: [good.url], destination: join(root, 'y.exe'), sha512: wrong, partialDir: join(root, 'p'), wait: noWait }),
      error => error.code === 'UPDATE_FILE_INVALID')
    assert.equal(existsSync(join(root, 'y.exe')), false)
  } finally { await missing.close(); await good.close(); rmSync(root, { recursive: true, force: true }) }
})

test('small files and signed metadata try every source before failing', async () => {
  const seen = []
  assert.equal(await withSources(['a', 'b'], async url => { seen.push(url); if (url === 'a') throw new Error('mirror down'); return 'ok' }, { wait: noWait }), 'ok')
  assert.deepEqual(seen, ['a', 'b'])
  const fetched = []
  const fetcher = mirroredFetch(async url => { fetched.push(url); return { status: url.includes('agentrouter.top') ? 404 : 200 } })
  const response = await fetcher(new URL('https://github.com/Maybank01/agentrouter-desktop-releases/releases/download/v3.0.20/agentrouter-update.json'))
  assert.equal(response.status, 200)
  assert.deepEqual(fetched, ['https://agentrouter.top/downloads/desktop/v3.0.20/agentrouter-update.json',
    'https://github.com/Maybank01/agentrouter-desktop-releases/releases/download/v3.0.20/agentrouter-update.json'])
})

test('installs on the updater: resumable installers, mirrored ranges and differential retries', async () => {
  const root = temporary()
  const calls = []
  let differentialRuns = 0
  const executor = {
    download: async () => { throw new Error('upstream full download must not run') },
    downloadToBuffer: async url => { calls.push(['buffer', url.href]); if (url.hostname === 'agentrouter.top') throw new Error('404'); return Buffer.from('map') },
    createRequest: (options, callback) => { calls.push(['range', `${options.protocol}//${options.hostname}${options.path}`]); return {} },
    request: async options => { calls.push(['request', `${options.protocol}//${options.hostname}${options.path}`]); return 'yaml' },
  }
  const updater = { httpExecutor: executor, getOrCreateDownloadHelper: async () => ({ cacheDir: root }),
    differentialDownloadInstaller: async () => (++differentialRuns < 2) }
  const server = await flakyServer({ drops: 1 })
  try {
    const state = installResilientTransport(updater, { fetcher: fetch, wait: noWait })
    assert.equal(await executor.downloadToBuffer(new URL('https://github.com/Maybank01/agentrouter-desktop-releases/releases/download/v3.0.20/AgentRouter-3.0.20-x64-Setup.exe.blockmap')).then(String), 'map')
    executor.createRequest({ protocol: 'https:', hostname: 'github.com', path: '/Maybank01/agentrouter-desktop-releases/releases/latest/download/AgentRouter-3.0.20-x64-Setup.exe' }, () => {})
    assert.equal(calls.at(-1)[1], 'https://agentrouter.top/downloads/desktop/v3.0.20/AgentRouter-3.0.20-x64-Setup.exe')
    assert.equal(await executor.request({ protocol: 'https:', hostname: 'github.com', path: '/Maybank01/agentrouter-desktop-releases/releases/latest/download/latest.yml' }), 'yaml')
    assert.equal(calls.at(-1)[1], 'https://agentrouter.top/downloads/desktop/latest.yml')
    // The first differential attempt fails; the retry succeeds without a full download.
    assert.equal(await updater.differentialDownloadInstaller({}, {}), false)
    assert.equal(differentialRuns, 2)
    assert.equal(state.mirrorRanges, false, 'After a failed differential attempt, ranges use GitHub')
    executor.createRequest({ protocol: 'https:', hostname: 'github.com', path: '/Maybank01/agentrouter-desktop-releases/releases/latest/download/AgentRouter-3.0.20-x64-Setup.exe' }, () => {})
    assert.equal(calls.at(-1)[1], 'https://github.com/Maybank01/agentrouter-desktop-releases/releases/latest/download/AgentRouter-3.0.20-x64-Setup.exe')
    const destination = join(root, 'pending', 'temp-AgentRouter.exe')
    mkdirSync(join(root, 'pending'))
    await executor.download(new URL(server.url), destination, { sha512 })
    assert.deepEqual(readFileSync(destination), body)
    assert.equal(server.requests.length, 2)
  } finally { await server.close(); rmSync(root, { recursive: true, force: true }) }
})
