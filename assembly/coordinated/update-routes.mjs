/** Optional public Connection Fetch contract; no renderer IPC or install paths. */
import { randomUUID } from 'node:crypto'
import { valid, lte, rcompare } from 'semver'

const base = '/api/agentrouter/v1/updates/'
const actions = new Set(['status', 'check', 'download', 'install'])
const reply = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
const version = value => typeof value === 'string' && value.length < 100 && valid(value) === value

export function releaseHistory(items, ceiling) {
  if (!Array.isArray(items) || !version(ceiling)) return []
  const records = new Map()
  for (const item of items.slice(0, 30)) {
    if (!item || !version(item.version) || !lte(item.version, ceiling) || !Array.isArray(item.changes)) continue
    const changes = item.changes.slice(0, 30).flatMap(change => {
      if (!change || typeof change.text !== 'string' || !change.text.trim() || change.text.length > 2000) return []
      return [{ kind: ['new', 'improved', 'fixed'].includes(change.kind) ? change.kind : 'other', text: change.text.trim() }]
    })
    if (!changes.length) continue
    const publishedAt = typeof item.publishedAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(item.publishedAt)
      && Number.isFinite(Date.parse(item.publishedAt)) ? item.publishedAt : undefined
    if (!records.has(item.version)) records.set(item.version, { version: item.version, ...(publishedAt ? { publishedAt } : {}), changes })
  }
  return [...records.values()].sort((a, b) => rcompare(a.version, b.version))
}

async function boundedJson(request, max) {
  if (!request.body) return {}
  const reader = request.body.getReader()
  const parts = []; let size = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.length
      if (size > max) throw new Error('body limit')
      parts.push(chunk.value)
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8'))
  } finally { await reader.cancel().catch(() => {}) }
}

export function createProductUpdateRoutes({ coordinator, productVersion, fetchHost, history = [], bootId = randomUUID() }) {
  let knownPlugin, knownHost
  let knownHistory = releaseHistory(history, productVersion)
  async function snapshot() {
    let busy = true, activityKnown = false
    try {
      const response = await fetchHost(new Request('dsh-app://app' + base + 'status', { signal: AbortSignal.timeout(3000) }))
      if (!response?.ok) throw new Error('host unavailable')
      const host = await boundedJson(response, 65536)
      if (host.owner !== 'product' || typeof host.busy !== 'boolean' || !version(host.currentVersion)) throw new Error('unknown activity')
      busy = host.busy; activityKnown = true; knownPlugin = host.currentVersion
      if (version(host.host?.version)) knownHost = host.host.version
    } catch { /* Unknown activity cannot authorize a restart. */ }
    const state = coordinator.status()
    const latest = version(state.version) ? state.version : undefined
    const ceiling = latest && !lte(latest, productVersion) ? latest : productVersion
    // Feed metadata is display data; it cannot change updater targets or signature policy.
    const supplied = state.releaseInfo?.agentrouter?.releaseNotes
    const targetPlugin = state.releaseInfo?.version === latest && version(state.releaseInfo?.agentrouter?.pluginVersion)
      ? state.releaseInfo.agentrouter.pluginVersion : undefined
    knownHistory = releaseHistory([...releaseHistory(supplied, ceiling), ...knownHistory], ceiling)
    return { owner: 'product', phase: state.phase, bootId, currentVersion: knownPlugin ?? '未知', channel: 'latest',
      product: { version: productVersion, ...(latest ? { latestVersion: latest } : {}), ...(targetPlugin ? { latestPluginVersion: targetPlugin } : {}) },
      host: { version: knownHost, channel: 'next', phase: 'unknown' },
      busy, canDownload: state.canDownload, canInstall: state.canInstall && activityKnown && !busy,
      checkedAt: state.checkedAt, progress: state.progress, error: state.error, history: knownHistory,
      ...(!state.enabled ? { unavailableReason: '当前运行方式未配置客户端更新。' }
        : !activityKnown ? { unavailableReason: '正在等待客户端就绪，恢复连接后可以重启更新。' } : {}) }
  }
  return {
    matches(request) {
      const url = new URL(request.url)
      return url.protocol === 'dsh-app:' && url.hostname === 'app' && url.pathname.startsWith(base) && actions.has(url.pathname.slice(base.length))
    },
    async handle(request) {
      if (!this.matches(request)) return reply({ error: 'Not found' }, 404)
      const action = new URL(request.url).pathname.slice(base.length)
      const origin = request.headers.get('origin')
      if (origin && origin !== 'dsh-app://app' || request.headers.get('sec-fetch-site') === 'cross-site') return reply({ error: 'Forbidden' }, 403)
      if (request.method !== (action === 'status' ? 'GET' : 'POST')) return reply({ error: 'Method not allowed' }, 405)
      if (action === 'status') return reply(await snapshot())
      if (!request.headers.get('content-type')?.startsWith('application/json')) return reply({ error: 'JSON required' }, 415)
      let body
      try { body = await boundedJson(request, 4096) }
      catch { return reply({ error: 'Invalid request' }, 400) }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return reply({ error: 'Invalid request' }, 400)
      if (action === 'check') {
        void coordinator.check().catch(() => {})
      } else {
        const state = await snapshot()
        if (!version(body.version) || body.version !== state.product.latestVersion) return reply({ error: 'Version changed' }, 409)
        if (action === 'download') {
          if (!state.canDownload) return reply(state)
          void coordinator.download(body.version).catch(() => {})
        } else {
          if (!state.canInstall || body.interrupt === true) return reply(state)
          void coordinator.restart(body.version).catch(() => {})
        }
      }
      await Promise.resolve()
      return reply(await snapshot())
    },
  }
}
