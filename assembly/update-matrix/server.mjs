/**
 * Local stand-in for GitHub Releases and the agentrouter.top download mirror,
 * used only on a disposable hosted Windows worker whose hosts file maps these
 * names to 127.0.0.1 and which trusts a disposable test CA. Installed apps keep
 * their baked-in feed (GitHub releases/latest/download/) and their pinned update
 * key: only the network path is replaced, never the product or its verification.
 *
 * Every connection and request is recorded. Network modes decide which direct
 * connections are reset (by TLS SNI, like a blocking middlebox) and whether a
 * Windows system proxy is offered.
 */
import assert from 'node:assert/strict'
import { createReadStream } from 'node:fs'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect, createServer as createNetServer } from 'node:net'

export const releasePath = '/Maybank01/agentrouter-desktop-releases/releases/'
export const assetHost = 'release-assets.githubusercontent.com'
export const githubHosts = Object.freeze(['github.com', 'raw.githubusercontent.com', 'objects.githubusercontent.com', assetHost])
export const mirrorHosts = Object.freeze(['agentrouter.top'])
export const interceptedHosts = Object.freeze([...githubHosts, ...mirrorHosts])
export const isGithubHost = host => host === 'github.com' || host.endsWith('.github.com') || host.endsWith('.githubusercontent.com')
const assetPrefix = '/github-production-release-asset/update-matrix/'

/**
 * Parse the SNI of a TLS ClientHello. Returns { complete: false } until the
 * whole first record has arrived; non-TLS input is complete without a name.
 */
export function parseClientHelloSni(buffer) {
  if (buffer.length < 5) return { complete: false }
  if (buffer[0] !== 0x16) return { complete: true }
  const recordLength = buffer.readUInt16BE(3)
  if (buffer.length < 5 + recordLength) return { complete: false }
  const hello = buffer.subarray(5, 5 + recordLength)
  try {
    if (hello[0] !== 0x01) return { complete: true }
    let offset = 4 + 2 + 32
    offset += 1 + hello[offset]
    offset += 2 + hello.readUInt16BE(offset)
    offset += 1 + hello[offset]
    const end = offset + 2 + hello.readUInt16BE(offset)
    offset += 2
    while (offset + 4 <= end) {
      const type = hello.readUInt16BE(offset), length = hello.readUInt16BE(offset + 2)
      offset += 4
      if (type === 0) {
        let cursor = offset + 2
        while (cursor + 3 <= offset + length) {
          const kind = hello[cursor], size = hello.readUInt16BE(cursor + 1)
          if (kind === 0) return { complete: true, sni: hello.subarray(cursor + 3, cursor + 3 + size).toString('ascii').toLowerCase() }
          cursor += 3 + size
        }
      }
      offset += length
    }
  } catch { /* A truncated or odd hello simply has no usable name. */ }
  return { complete: true }
}

/** Whether a direct (not proxied) connection to this name is reset in a mode. */
export function directConnectionBlocked(mode, sni) {
  return (mode === 'github-blocked' || mode === 'system-proxy') && typeof sni === 'string' && isGithubHost(sni)
}

/**
 * Map one HTTPS request to what the real services answer for these releases.
 * `releases` maps a tag (vX.Y.Z) to a Map of asset name -> { path, bytes };
 * `latest` is the tag GitHub's releases/latest resolves to (the candidate).
 */
export function routeRequest({ host, path, releases, latest }) {
  const pathname = decodeURIComponent(new URL(path, 'https://' + host).pathname)
  const file = (tag, name) => releases.get(tag)?.get(name)
  if (host === 'github.com') {
    let match = new RegExp(`^${releasePath}latest/download/([^/]+)$`).exec(pathname)
    // GitHub resolves latest/download/<name> only for assets of the latest release.
    if (match) return file(latest, match[1]) ? { status: 302, location: `https://github.com${releasePath}download/${latest}/${match[1]}` } : { status: 404 }
    match = new RegExp(`^${releasePath}download/([^/]+)/([^/]+)$`).exec(pathname)
    if (match && file(match[1], match[2])) {
      const name = encodeURIComponent(match[2])
      return { status: 302, location: `https://${assetHost}${assetPrefix}${match[1]}/${name}?sp=r&response-content-disposition=attachment%3B%20filename%3D${name}&response-content-type=application%2Foctet-stream` }
    }
    return { status: 404 }
  }
  if (host === assetHost || host === 'objects.githubusercontent.com') {
    const match = new RegExp(`^${assetPrefix}([^/]+)/([^/]+)$`).exec(pathname)
    const served = match && file(match[1], match[2])
    return served ? { status: 200, file: served, name: match[2], contentType: 'application/octet-stream' } : { status: 404 }
  }
  if (host === 'agentrouter.top') {
    if (pathname === '/downloads/desktop/latest.yml') {
      const served = file(latest, 'latest.yml')
      return served ? { status: 200, file: served, name: 'latest.yml', contentType: 'text/yaml; charset=utf-8' } : { status: 404 }
    }
    const match = /^\/downloads\/desktop\/(v\d+\.\d+\.\d+)\/([^/]+)$/.exec(pathname)
    const served = match && file(match[1], match[2])
    return served ? { status: 200, file: served, name: match[2], contentType: match[2].endsWith('.yml') ? 'text/yaml; charset=utf-8' : 'application/octet-stream' } : { status: 404 }
  }
  return { status: 404 }
}

/** A single HTTP byte range. Multipart ranges are refused, as GitHub's asset storage does. */
export function parseRange(header, size) {
  if (header === undefined) return { kind: 'full' }
  if (header.includes(',')) return { kind: 'multipart' }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match || (match[1] === '' && match[2] === '')) return { kind: 'invalid' }
  let start, end
  if (match[1] === '') { start = Math.max(0, size - Number(match[2])); end = size - 1 }
  else { start = Number(match[1]); end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1) }
  if (start >= size || start > end) return { kind: 'unsatisfiable' }
  return { kind: 'range', start, end }
}

/**
 * Start the interceptor: an internal HTTPS server, a direct listener on 443
 * that peeks at the SNI and resets blocked names, and (system-proxy mode) an
 * HTTP CONNECT proxy through which every name is reachable.
 */
export async function startInterceptor({ mode, releases, latest, key, cert, directPort = 443, proxyPort = 0,
  dropInstallerTransferOnce = false, log = () => {} }) {
  const tags = new Map()
  const events = []
  const record = event => { const entry = { t: new Date().toISOString(), ...event }; events.push(entry); log(entry) }
  let dropPending = dropInstallerTransferOnce
  const https = createHttpsServer({ key, cert }, (req, res) => {
    const tag = tags.get(req.socket.remotePort) ?? {}
    const host = String(req.headers.host ?? tag.sni ?? '').replace(/:\d+$/, '').toLowerCase()
    const entry = { kind: 'request', via: tag.via, sni: tag.sni, host, method: req.method, path: req.url,
      range: req.headers.range, preflight: req.headers['x-update-matrix-preflight'] === '1' || undefined }
    const route = routeRequest({ host, path: req.url, releases, latest })
    if (route.status !== 200) {
      record({ ...entry, status: route.status, location: route.location })
      res.writeHead(route.status, route.location ? { location: route.location } : {}); res.end(); return
    }
    const size = route.file.bytes
    const range = parseRange(req.headers.range, size)
    const headers = { 'content-type': route.contentType, 'accept-ranges': 'bytes', 'cache-control': 'no-store' }
    if (range.kind === 'multipart' || range.kind === 'invalid') {
      record({ ...entry, status: 501 }); res.writeHead(501); res.end(); return
    }
    if (range.kind === 'unsatisfiable') {
      record({ ...entry, status: 416 }); res.writeHead(416, { 'content-range': `bytes */${size}` }); res.end(); return
    }
    const start = range.kind === 'range' ? range.start : 0, end = range.kind === 'range' ? range.end : size - 1
    const status = range.kind === 'range' ? 206 : 200
    res.writeHead(status, { ...headers, 'content-length': end - start + 1,
      ...(status === 206 ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}) })
    if (req.method === 'HEAD') { record({ ...entry, status, bytes: 0 }); res.end(); return }
    const length = end - start + 1
    if (dropPending && route.name.endsWith('.exe') && length > 64 * 1024) {
      // One dropped transfer midway, as an unstable connection would do.
      dropPending = false
      const sent = Math.floor(length / 2)
      record({ ...entry, status, bytes: sent, fault: 'connection-dropped' })
      const stream = createReadStream(route.file.path, { start, end: start + sent - 1 })
      stream.pipe(res, { end: false })
      stream.on('end', () => setTimeout(() => res.socket?.destroy(), 50))
      return
    }
    record({ ...entry, status, bytes: length })
    createReadStream(route.file.path, { start, end }).pipe(res)
  })
  await new Promise((resolve, reject) => { https.once('error', reject); https.listen(0, '127.0.0.1', resolve) })
  const internalPort = https.address().port

  const relay = (socket, via) => {
    let buffered = Buffer.alloc(0)
    const timer = setTimeout(() => { record({ kind: 'connection', via, action: 'no-client-hello' }); socket.destroy() }, 15000)
    socket.on('error', () => {})
    const onData = chunk => {
      buffered = Buffer.concat([buffered, chunk])
      const hello = parseClientHelloSni(buffered)
      if (!hello.complete) return
      clearTimeout(timer)
      socket.off('data', onData)
      socket.pause()
      if (via === 'direct' && directConnectionBlocked(mode, hello.sni)) {
        record({ kind: 'connection', via, sni: hello.sni, action: 'reset' })
        socket.resetAndDestroy()
        return
      }
      const upstream = connect(internalPort, '127.0.0.1', () => {
        tags.set(upstream.localPort, { via, sni: hello.sni })
        upstream.write(buffered)
        socket.pipe(upstream); upstream.pipe(socket); socket.resume()
      })
      upstream.on('error', () => socket.destroy())
      upstream.on('close', () => { socket.destroy(); setTimeout(() => tags.delete(upstream.localPort), 60000) })
      socket.on('close', () => upstream.destroy())
    }
    socket.on('data', onData)
  }

  const direct = createNetServer(socket => relay(socket, 'direct'))
  await new Promise((resolve, reject) => { direct.once('error', reject); direct.listen(directPort, '127.0.0.1', resolve) })

  let proxy
  if (mode === 'system-proxy') {
    proxy = createHttpServer((req, res) => {
      // Plain HTTP (certificate revocation, OS services) keeps its real destination.
      let target
      try { target = new URL(req.url) } catch { res.writeHead(400); res.end(); return }
      if (target.protocol !== 'http:' || interceptedHosts.includes(target.hostname)) {
        record({ kind: 'proxy', method: req.method, target: req.url, action: 'refused-plain-http' })
        res.writeHead(502); res.end(); return
      }
      const upstream = httpRequest(target, { method: req.method, headers: req.headers }, response => {
        res.writeHead(response.statusCode, response.headers); response.pipe(res)
      })
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
      req.pipe(upstream)
    })
    proxy.on('connect', (req, client, head) => {
      client.on('error', () => {})
      const [host, port = '443'] = String(req.url).toLowerCase().split(':')
      if (interceptedHosts.includes(host) && port === '443') {
        record({ kind: 'proxy', target: req.url, action: 'intercepted' })
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head?.length) client.unshift(head)
        relay(client, 'proxy')
        return
      }
      // Any other name keeps its real destination, as a corporate proxy would.
      record({ kind: 'proxy', target: req.url, action: 'tunnel' })
      const upstream = connect(Number(port), host, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head?.length) upstream.write(head)
        client.pipe(upstream); upstream.pipe(client)
      })
      upstream.on('error', () => { client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n') })
    })
    await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(proxyPort, '127.0.0.1', resolve) })
  }

  return {
    events, internalPort,
    directPort: direct.address().port,
    proxyPort: proxy?.address().port,
    async close() {
      for (const server of [direct, proxy, https].filter(Boolean)) {
        server.closeAllConnections?.()
        await new Promise(resolve => server.close(() => resolve()))
      }
    },
  }
}

/** Compact evidence for the result record; the full log is a separate artifact. */
export function summarizeEvents(events) {
  const requests = events.filter(event => event.kind === 'request' && !event.preflight)
  const count = (list, keyOf) => list.reduce((map, item) => { const key = keyOf(item); map[key] = (map[key] ?? 0) + 1; return map }, {})
  const served = requests.filter(event => event.status === 200 || event.status === 206)
  return {
    requests: requests.length,
    byHostStatus: count(requests, event => `${event.via ?? '?'} ${event.host} ${event.status}`),
    resets: count(events.filter(event => event.action === 'reset'), event => event.sni ?? '?'),
    proxied: count(events.filter(event => event.kind === 'proxy'), event => `${event.action} ${event.target ?? ''}`),
    bytesByFile: served.reduce((map, event) => {
      const name = decodeURIComponent(event.path.split('?')[0].split('/').at(-1))
      map[name] = (map[name] ?? 0) + (event.bytes ?? 0); return map
    }, {}),
    rangeRequests: served.filter(event => event.range).length,
    faults: events.filter(event => event.fault).map(event => ({ host: event.host, path: event.path, range: event.range, bytes: event.bytes, fault: event.fault })),
    manifestRequests: requests.filter(event => event.path.includes('agentrouter-update.json')).map(event => ({ via: event.via, host: event.host, status: event.status })),
  }
}

export function assertServedRelease(releases, tag, names) {
  const files = releases.get(tag)
  assert.ok(files, `No local files for ${tag}`)
  for (const name of names) assert.ok(files.has(name), `${tag} lacks ${name}`)
}
