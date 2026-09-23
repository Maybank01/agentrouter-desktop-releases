import { execFile } from 'node:child_process'
import { access, stat } from 'node:fs/promises'
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
      ? '请检查更新，或下载当前版本安装包覆盖安装。账号、配置和会话会保留。'
      : 'Check for an update, or download this version again and install it over the existing application. Accounts, settings and sessions are preserved.',
    buttons: chinese ? ['检查更新…', '下载修复安装包', '稍后'] : ['Check for updates…', 'Download repair installer', 'Later'],
    defaultId: 0, cancelId: 2,
  }
}

/** Recovery uses the existing immutable release, never a separate update feed. */
export function repairInstallerUrl(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid released product version')
  return `https://github.com/Maybank01/agentrouter-desktop-releases/releases/download/v${version}/AgentRouter-${version}-x64-Setup.exe`
}
