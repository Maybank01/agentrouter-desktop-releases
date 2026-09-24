import { execFile } from 'node:child_process'
import { access, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)

/** Record startup stalls without collecting account, session or request data. */
export function monitorStartupResponsiveness() {
  let previous = performance.now(), maximum = 0, stopped = false
  const sample = () => {
    const now = performance.now()
    maximum = Math.max(maximum, now - previous - 100)
    previous = now
  }
  const timer = setInterval(sample, 100)
  timer.unref()
  return () => {
    if (!stopped) { sample(); clearInterval(timer); stopped = true }
    return Math.ceil(maximum)
  }
}

/** Probe the bundled executable before preparing or changing a user profile. */
export async function verifyRuntimeExecutables(runtime) {
  try {
    const node = await stat(runtime.node)
    const pnpm = await stat(runtime.pnpm)
    if (!node.isFile() || node.size === 0 || !pnpm.isFile() || pnpm.size === 0) {
      throw Object.assign(new Error('Missing runtime file'), { code: 'ENOENT' })
    }
    await access(runtime.pnpm)
    // A shell preload or the developer's Node flags must not turn the probe of
    // a valid application binary into an installation-corruption diagnosis.
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
      !/^(?:NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE)$/i.test(name)))
    const { stdout } = await execute(runtime.node, ['--version'], {
      env, windowsHide: true, timeout: 10000, encoding: 'utf8', maxBuffer: 4096,
    })
    if (!/^v\d+\.\d+\.\d+(?:-[\w.-]+)?\s*$/.test(stdout)) {
      throw Object.assign(new Error('Unexpected runtime output'), { code: 'INVALID_RUNTIME' })
    }
  } catch (cause) {
    const error = new Error('The bundled application runtime could not start.', { cause })
    error.code = 'AGENTROUTER_RUNTIME_UNAVAILABLE'
    throw error
  }
}

export function isRuntimeStartupFailure(error) {
  return error?.code === 'AGENTROUTER_RUNTIME_UNAVAILABLE'
}

export function runtimeRecoveryDialog(chinese) {
  return {
    type: 'error', title: chinese ? 'AgentRouter 无法启动' : 'AgentRouter could not start',
    message: chinese ? '客户端运行文件不完整或无法执行。' : 'Application runtime files are incomplete or cannot run.',
    detail: chinese
      ? '“自动修复”会从国内镜像下载当前版本、校验签名后原地重新安装，无需手动重新下载。账号、配置和会话会保留。'
      : 'Repair downloads this version from the mirror, verifies its signature and reinstalls it in place. Accounts, settings and sessions are preserved.',
    buttons: chinese ? ['自动修复', '检查更新…', '稍后'] : ['Repair automatically', 'Check for updates…', 'Later'],
    // Windows otherwise renders unrecognised labels as TaskDialog command links,
    // which drops the ordinary cancel button that users and UI Automation expect.
    defaultId: 0, cancelId: 2, noLink: true,
  }
}

const MIRROR = 'https://agentrouter.top/downloads/desktop/'
const RELEASES = 'https://github.com/Maybank01/agentrouter-desktop-releases/releases/download/'
const releaseVersion = version => {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid released product version')
  return version
}

/** Manual fallback: the exact existing release on the domestic mirror, never a separate feed. */
export function repairInstallerUrl(version) {
  releaseVersion(version)
  return `${MIRROR}v${version}/AgentRouter-${version}-x64-Setup.exe`
}

/**
 * Download and verify this exact release's installer for an in-place repair
 * (mirror first, GitHub per-file fallback). Trust comes only from the pinned
 * signed manifest; the transfer resumes across interruptions.
 * @param deps.fetcher - Electron's session fetch (system proxy aware); required.
 * @param deps.verifyManifest / deps.verifyFile - update-signature.mjs verifiers.
 * @param deps.download - update-transport.mjs resumableDownload.
 */
export async function prepareRepairInstaller({ version, policy, fetcher, directory, verifyManifest, verifyFile, download, onProgress,
  bases = [MIRROR, RELEASES] }) {
  releaseVersion(version)
  if (typeof fetcher !== 'function') throw new Error('Repair requires an explicit (Electron session) fetcher')
  const name = `AgentRouter-${version}-x64-Setup.exe`
  let manifest, last
  for (const base of bases) {
    try {
      const response = await fetcher(`${base}v${version}/agentrouter-update.json`, { redirect: 'follow', cache: 'no-store', signal: AbortSignal.timeout(30000) })
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`)
      const text = await response.text()
      if (text.length > 64 * 1024) throw new Error('Signed metadata exceeds its limit')
      manifest = verifyManifest(JSON.parse(text), policy, version)
      break
    } catch (error) { last = error }
  }
  if (!manifest) throw Object.assign(new Error('Repair metadata is unavailable', { cause: last }), { code: 'UPDATE_METADATA_UNAVAILABLE' })
  const entry = manifest.assets.find(file => file.name === name)
  if (!entry) throw new Error('The signed manifest lacks this release installer')
  const destination = join(directory, name)
  await download({ sources: bases.map(base => `${base}v${version}/${name}`), destination, sha256: entry.sha256, size: entry.bytes,
    partialDir: join(directory, 'partial'), fetcher, onProgress })
  await verifyFile(manifest, destination, name)
  return destination
}
