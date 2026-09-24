/**
 * Prepare a downloaded product release's runtime while the current release keeps
 * running (the second slot of an A/B switch). The verified installer extracts its
 * own application into a stage directory without installing anything; that staged
 * release then builds its runtime from its own seed. The restart only activates it.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

const STAGE_TIMEOUT_MS = 10 * 60 * 1000
const PREPARE_TIMEOUT_MS = 20 * 60 * 1000

/**
 * Whether the downloaded release needs another runtime. The feed carries the
 * target's runtime identity as display metadata; without it, prepare to be safe.
 */
export function runtimeChanged(current, releaseInfo, version) {
  const runtime = releaseInfo?.agentrouter?.runtime
  if (!runtime || typeof runtime !== 'object' || releaseInfo?.version !== version) return true
  return typeof current?.runtimeFingerprint !== 'string'
    || runtime.fingerprint !== current.runtimeFingerprint
    || runtime.dshVersion !== current.version
    || JSON.stringify(runtime.managedPlugins ?? []) !== JSON.stringify(current.managedPlugins ?? [])
}

function childEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) =>
    !/^(?:ELECTRON_RUN_AS_NODE|NODE_OPTIONS|AGENTROUTER_STAGE_DIR)$/i.test(name)))
}

/** Run one hidden process to completion; a hung child is terminated at the deadline. */
export function runProcess(file, args, { env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, windowsHide: true, stdio: 'ignore' })
    const timer = setTimeout(() => {
      child.kill()
      reject(Object.assign(new Error(`${file} did not finish within ${timeoutMs} ms`), { code: 'ETIMEDOUT' }))
    }, timeoutMs)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); resolve(code ?? 1) })
  })
}

/**
 * @param options.installer - the downloaded installer, already verified by the updater.
 * @param options.version - the product version the installer must contain.
 * @param options.root - Desktop's private state directory under the shared Home.
 * @param options.executableName - the product executable's file name.
 */
export async function prepareDownloadedRelease({ installer, version, root, executableName,
  env = process.env, platform = process.platform, run = runProcess }) {
  if (platform !== 'win32') return { outcome: 'unsupported' }
  if (typeof installer !== 'string' || !existsSync(installer)) throw new Error('The downloaded installer is unavailable')
  const started = Date.now()
  const stage = join(root, 'update-stage')
  const application = join(stage, 'app')
  const clean = childEnvironment(env)
  await rm(stage, { recursive: true, force: true, maxRetries: 3 })
  mkdirSync(stage, { recursive: true })
  try {
    // The flag and the directory must both be present; the installer then only
    // extracts its application and quits before any install, registry or shortcut step.
    const staged = await run(installer, ['/S', '--agentrouter-stage'],
      { env: { ...clean, AGENTROUTER_STAGE_DIR: application }, timeoutMs: STAGE_TIMEOUT_MS })
    if (staged !== 0) throw new Error(`The downloaded installer could not stage its runtime (${staged})`)
    const release = JSON.parse(readFileSync(join(application, 'resources', 'seed', 'desktop-release.json'), 'utf8'))
    if ((release.productVersion ?? release.version) !== version) throw new Error('The staged release does not match the download')
    const stagedMs = Date.now() - started
    const receipt = join(root, 'prepared-update.json')
    await rm(receipt, { force: true })
    const code = await run(join(application, executableName),
      ['--agentrouter-prepare-update', `--user-data-dir=${join(stage, 'electron')}`],
      { env: clean, timeoutMs: PREPARE_TIMEOUT_MS })
    let result
    try { result = JSON.parse(readFileSync(receipt, 'utf8')) } catch { result = undefined }
    // The receipt written by the staged release decides the outcome; Electron can
    // report a non-zero code while tearing down after completed work.
    if (result?.productVersion !== version || !['prepared', 'current', 'unsupported'].includes(result?.outcome)) {
      throw new Error(result?.message ?? `The staged release could not prepare its runtime (${code})`)
    }
    return { outcome: result.outcome, stagedMs, durationMs: Date.now() - started }
  } finally {
    // The staged application is only a build tool for the prepared runtime.
    void rm(stage, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  }
}
