/**
 * Resilient transport for the pinned electron-updater: the AgentRouter mirror is
 * tried first for each release file with a per-file GitHub fallback, full installer
 * downloads resume with HTTP Range across interruptions and restarts, and transient
 * failures are retried with backoff before an error reaches the user. Integrity is
 * unchanged: every completed file must match the feed's SHA-512, and the pinned
 * signed manifest and Authenticode checks still run on the result.
 */
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { open, readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'

export const MIRROR_BASE = 'https://agentrouter.top/downloads/desktop/'
const RELEASES = 'https://github.com/Maybank01/agentrouter-desktop-releases/releases/'
const ASSET = /^https:\/\/github\.com\/Maybank01\/agentrouter-desktop-releases\/releases\/(?:latest\/download|download\/v(\d+\.\d+\.\d+))\/([A-Za-z0-9._-]+)$/
const VERSIONED_FILE = /^AgentRouter-(\d+\.\d+\.\d+)-x64-Setup\.exe(?:\.blockmap)?$/
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000]
const PROGRESS_BYTES = 1024 * 1024

/**
 * Candidate URLs for one release file: the mirror's immutable version directory
 * first, then the same file on its immutable GitHub tag. Other URLs (the loopback
 * test feed, the moving latest.yml) are used unchanged.
 */
export function downloadSources(value) {
  const url = String(value)
  // The moving feed: the mirror's copy may lag GitHub briefly, never the reverse.
  if (url === `${RELEASES}latest/download/latest.yml`) return [`${MIRROR_BASE}latest.yml`, url]
  const match = ASSET.exec(url)
  if (!match) return [url]
  const file = match[2]
  const version = match[1] ?? VERSIONED_FILE.exec(file)?.[1]
  if (!version) return [url]
  return [`${MIRROR_BASE}v${version}/${file}`, `${RELEASES}download/v${version}/${file}`]
}

const sleep = milliseconds => new Promise(resolve => { setTimeout(resolve, milliseconds) })

function interrupted(cause, transferred) {
  return Object.assign(new Error('The update download was interrupted', { cause }),
    { code: 'UPDATE_DOWNLOAD_INTERRUPTED', transferred })
}

async function sha512Of(path) {
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('base64')
}

/**
 * Download one file to `destination`, resuming a retained partial file.
 * @param options.sources - URLs tried in order; a failing source yields to the next.
 * @param options.sha512 - expected base64 SHA-512 from the verified feed.
 * @param options.size - expected size in bytes, when the feed provides it.
 * @param options.partialDir - persistent directory for partial files (kept across restarts).
 */
export async function resumableDownload({ sources, destination, sha512, size, partialDir, fetcher = fetch,
  onProgress, isCancelled = () => false, delays = RETRY_DELAYS_MS, now = Date.now, wait = sleep }) {
  if (typeof sha512 !== 'string' || !/^[A-Za-z0-9+/]+=*$/.test(sha512)) throw new Error('A resumable download requires the expected SHA-512')
  mkdirSync(partialDir, { recursive: true })
  const partial = join(partialDir, createHash('sha256').update(sha512).digest('hex').slice(0, 32) + '.part')
  // Partials of other releases are obsolete once a new download starts.
  for (const name of await readdir(partialDir)) if (name.endsWith('.part') && join(partialDir, name) !== partial) await rm(join(partialDir, name), { force: true })
  let offset = existsSync(partial) ? statSync(partial).size : 0
  if (Number.isSafeInteger(size) && offset > size) { await rm(partial, { force: true }); offset = 0 }
  let source = 0, failures = 0, restartedAfterMismatch = false
  const started = now(), startOffset = offset
  for (;;) {
    if (isCancelled()) throw Object.assign(new Error('cancelled'), { name: 'CancellationError' })
    if (Number.isSafeInteger(size) && offset === size) {
      if (await sha512Of(partial) === sha512) break
      await rm(partial, { force: true }); offset = 0
      if (restartedAfterMismatch) throw Object.assign(new Error('Downloaded update does not match its checksum'), { code: 'UPDATE_FILE_INVALID' })
      restartedAfterMismatch = true
    }
    const url = sources[source % sources.length]
    let progressed = 0
    try {
      const controller = new AbortController()
      const response = await fetcher(url, { headers: offset > 0 ? { Range: `bytes=${offset}-` } : {},
        redirect: 'follow', signal: controller.signal })
      if (response.status === 416 && offset > 0) {
        // The retained bytes already cover the file; verify them.
        response.body?.cancel?.().catch?.(() => {})
        if (await sha512Of(partial) === sha512) break
        await rm(partial, { force: true }); offset = 0
        throw new Error('Retained partial download is invalid')
      }
      const resumed = response.status === 206
      if (!resumed && response.status !== 200) throw new Error(`HTTP ${response.status}`)
      if (resumed) {
        const range = /^bytes (\d+)-\d+\/(\d+|\*)$/.exec(response.headers.get('content-range') ?? '')
        if (!range || Number(range[1]) !== offset) throw new Error('The server resumed at another offset')
      } else if (offset > 0) offset = 0 // The server ignored Range: start over.
      const total = Number.isSafeInteger(size) ? size
        : resumed ? Number(/\/(\d+)$/.exec(response.headers.get('content-range') ?? '')?.[1]) || undefined
          : Number(response.headers.get('content-length')) || undefined
      const file = await open(partial, resumed ? 'a' : 'w')
      try {
        let reported = 0
        for await (const chunk of response.body) {
          if (isCancelled()) { controller.abort(); throw Object.assign(new Error('cancelled'), { name: 'CancellationError' }) }
          await file.write(chunk)
          offset += chunk.length; progressed += chunk.length; reported += chunk.length
          if (onProgress && (reported >= PROGRESS_BYTES || (total && offset === total))) {
            const elapsed = Math.max(1, now() - started) / 1000
            onProgress({ total: total ?? offset, delta: reported, transferred: offset,
              percent: total ? offset / total * 100 : 0, bytesPerSecond: Math.round((offset - startOffset) / elapsed) })
            reported = 0
          }
        }
      } finally { await file.close() }
      // A connection that ends early keeps its bytes for the next attempt.
      if (total !== undefined && offset < total) throw new Error('The connection closed before the file was complete')
      if (await sha512Of(partial) === sha512) break
      await rm(partial, { force: true }); offset = 0
      if (restartedAfterMismatch) throw Object.assign(new Error('Downloaded update does not match its checksum'), { code: 'UPDATE_FILE_INVALID' })
      restartedAfterMismatch = true
    } catch (error) {
      if (error?.name === 'CancellationError' || error?.code === 'UPDATE_FILE_INVALID') throw error
      // Progress resets the budget: a slow connection that keeps dropping still completes.
      failures = progressed > 0 ? 1 : failures + 1
      if (failures > delays.length) throw interrupted(error, offset)
      // Alternate sources after a failure without progress.
      if (progressed === 0) source += 1
      await wait(delays[failures - 1])
    }
  }
  await rename(partial, destination)
  return destination
}

/** Retry a small request across sources before reporting it unavailable. */
export async function withSources(sources, operation, { delays = RETRY_DELAYS_MS.slice(0, 3), wait = sleep } = {}) {
  let last
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    for (const url of sources) {
      try { return await operation(url) } catch (error) { last = error }
    }
    if (attempt < delays.length) await wait(delays[attempt])
  }
  throw last
}

/**
 * Install the transport on one electron-updater instance.
 * @param options.fetcher - Electron's session fetch, which honours the system proxy.
 * @param options.differentialAttempts - differential download attempts before a full download.
 */
export function installResilientTransport(updater, { fetcher, differentialAttempts = 3, wait = sleep } = {}) {
  const executor = updater.httpExecutor
  if (!executor || typeof executor.download !== 'function') throw new Error('The installed updater lacks its HTTP executor')
  const download = executor.download.bind(executor)
  const downloadToBuffer = executor.downloadToBuffer.bind(executor)
  const createRequest = executor.createRequest.bind(executor)
  const request = executor.request.bind(executor)
  const optionsUrl = options => options?.protocol && options.hostname
    ? `${options.protocol}//${options.hostname}${options.path ?? ''}` : undefined
  const onSource = (options, source) => {
    const target = new URL(source)
    return { ...options, protocol: target.protocol, hostname: target.hostname, host: target.host, port: undefined,
      path: target.pathname + target.search }
  }
  // Feed metadata (latest.yml) goes through the same mirror-first order.
  executor.request = (options, cancellationToken, data) => {
    const url = optionsUrl(options)
    const sources = url ? downloadSources(url) : []
    if (sources.length < 2) return request(options, cancellationToken, data)
    return withSources(sources, source => request(onSource(options, source), cancellationToken, data), { wait })
  }
  const state = { mirrorRanges: true, lastSource: undefined }
  executor.download = async (url, destination, options) => {
    const sources = downloadSources(url.href ?? url)
    if (!/\.exe$/i.test(new URL(url.href ?? url).pathname) || typeof options?.sha512 !== 'string') return download(url, destination, options)
    const helper = await updater.getOrCreateDownloadHelper()
    return resumableDownload({ sources, destination, sha512: options.sha512, partialDir: join(helper.cacheDir, 'partial'),
      fetcher, onProgress: options.onProgress, isCancelled: () => options.cancellationToken?.cancelled === true, wait })
  }
  executor.downloadToBuffer = (url, options) => withSources(downloadSources(url.href ?? url),
    source => downloadToBuffer(new URL(source), options), { wait })
  // Differential range requests follow the installer's URL. Use the mirror while
  // it is healthy; after a failed differential attempt, use GitHub instead.
  executor.createRequest = (options, callback) => {
    const url = optionsUrl(options)
    const sources = url ? downloadSources(url) : []
    if (state.mirrorRanges && sources.length === 2 && /\.exe$/i.test(url) && url.startsWith(RELEASES)) {
      return createRequest(onSource(options, sources[0]), callback)
    }
    return createRequest(options, callback)
  }
  const differential = updater.differentialDownloadInstaller?.bind(updater)
  if (differential) {
    // Upstream returns true ("fall back to a full download") on any differential
    // error. Retry the small differential transfer before downloading everything.
    updater.differentialDownloadInstaller = async (...args) => {
      for (let attempt = 1; attempt <= differentialAttempts; attempt++) {
        if (!await differential(...args)) return false
        if (args[1]?.cancellationToken?.cancelled) return true
        state.mirrorRanges = false
        if (attempt < differentialAttempts) await wait(RETRY_DELAYS_MS[attempt])
      }
      return true
    }
  }
  return state
}

/** Signed-manifest fetches follow the same order; the manifest's own signature decides trust. */
export function mirroredFetch(fetcher) {
  return (url, init) => withSources(downloadSources(url.href ?? url), async source => {
    const response = await fetcher(source, init)
    if (response.status !== 200) throw new Error(`HTTP ${response.status}`)
    return response
  }, { delays: [1000, 3000] })
}
