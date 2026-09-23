/** Run `npm ci` once more if it fails, and name the exit reason; used by every workflow npm ci step. */
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const windowsStatus = {
  0xC0000005: 'STATUS_ACCESS_VIOLATION (native crash)',
  0xC00000FD: 'STATUS_STACK_OVERFLOW (native crash)',
  0xC0000409: 'STATUS_STACK_BUFFER_OVERRUN / fail-fast (native crash)',
  0xC000013A: 'STATUS_CONTROL_C_EXIT (terminated)',
}

export function describeExit({ status, signal, error }) {
  if (error) return `could not run (${error.code ?? error.message})`
  if (signal) return `terminated by ${signal}`
  const code = status >>> 0
  if (code > 0xffff) return `exit ${status} (0x${code.toString(16).toUpperCase()} ${windowsStatus[code] ?? 'Windows NTSTATUS'})`
  return `exit ${status}`
}

// Only a frozen lockfile install is repeated: identical inputs, no lock changes.
export function parseInstall(argv) {
  if (argv[0] !== 'npm' || argv[1] !== 'ci') throw new Error('retry-install only repeats `npm ci`')
  for (const arg of argv) if (!/^[\w@./=:-]+$/.test(arg)) throw new Error(`Unsupported argument: ${arg}`)
  return argv.join(' ')
}

// npm can exit 1 without printing anything; its debug log still names the cause.
export function latestNpmLog(env = process.env) {
  const cache = env.npm_config_cache ?? env.NPM_CONFIG_CACHE
    ?? (process.platform === 'win32' ? join(env.LOCALAPPDATA ?? homedir(), 'npm-cache') : join(homedir(), '.npm'))
  try {
    const dir = join(cache, '_logs')
    const newest = readdirSync(dir).filter(name => name.endsWith('.log'))
      .map(name => ({ path: join(dir, name), mtime: statSync(join(dir, name)).mtimeMs })).sort((a, b) => b.mtime - a.mtime)[0]
    return newest && { path: newest.path, tail: readFileSync(newest.path, 'utf8').split(/\r?\n/).slice(-80).join('\n') }
  } catch { return undefined }
}

export function runInstall(command, { attempts = 2, spawn = spawnSync, log = text => process.stderr.write(text), npmLog = latestNpmLog } = {}) {
  const reasons = []
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = spawn(command, { stdio: 'inherit', shell: true, windowsHide: true, timeout: 900000 })
    if (!result.error && result.status === 0 && !result.signal) return { attempts: attempt, reasons }
    reasons.push(describeExit(result))
    const debug = npmLog()
    if (debug) log(`::group::npm debug log ${debug.path}\n${debug.tail}\n::endgroup::\n`)
    log(`::warning::${command}: attempt ${attempt}/${attempts} failed: ${reasons.at(-1)}\n`)
  }
  throw new Error(`${command} failed after ${attempts} attempts: ${reasons.join('; ')}. Its npm output and log path are above.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { runInstall(parseInstall(process.argv.slice(2))) } catch (error) { console.error(`::error::${error.message}`); process.exit(1) }
}
