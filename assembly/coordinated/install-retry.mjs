/** Run an idempotent dependency command with one retry and a diagnosable failure. */
import { spawnSync } from 'node:child_process'

// Windows reports native process failures as NTSTATUS exit codes, which Node
// prints as large unsigned integers without any explanatory stderr.
const windowsStatus = {
  0xC0000005: 'STATUS_ACCESS_VIOLATION (native crash)',
  0xC00000FD: 'STATUS_STACK_OVERFLOW (native crash)',
  0xC0000409: 'STATUS_STACK_BUFFER_OVERRUN / fail-fast (native crash)',
  0xC000013A: 'STATUS_CONTROL_C_EXIT (terminated)',
  0xC0000142: 'STATUS_DLL_INIT_FAILED',
}

export function describeExit({ status, signal, error }) {
  if (error) return `could not run (${error.code ?? error.message})`
  if (signal) return `terminated by ${signal}`
  const code = status >>> 0
  if (code > 0xffff) return `exit ${status} (0x${code.toString(16).toUpperCase()} ${windowsStatus[code] ?? 'Windows NTSTATUS'})`
  return `exit ${status}`
}

const tail = (text, max = 4000) => (text ?? '').length > max ? '…' + text.slice(-max) : text ?? ''

/**
 * Output is relayed to this process's stderr, so a caller's stdout stays a
 * single JSON result. Only commands safe to repeat with identical inputs
 * (frozen/offline installs, lockfile-only resolution, store fetches) may use it.
 */
export function runInstall(file, args, options, { label, attempts = 2, spawn = spawnSync, log = text => process.stderr.write(text) } = {}) {
  const failures = []
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = spawn(file, args, { ...options, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
    if (result.stdout) log(result.stdout)
    if (result.stderr) log(result.stderr)
    if (!result.error && result.status === 0 && !result.signal) return result
    const reason = describeExit(result)
    failures.push({ attempt, reason, stdout: tail(result.stdout), stderr: tail(result.stderr) })
    log(`${label}: attempt ${attempt}/${attempts} failed: ${reason}\n`)
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${failures.map(f => f.reason).join('; ')}\n`
    + failures.map(f => `--- attempt ${f.attempt} stderr ---\n${f.stderr || '(empty)'}\n--- attempt ${f.attempt} stdout ---\n${f.stdout || '(empty)'}`).join('\n'))
}
