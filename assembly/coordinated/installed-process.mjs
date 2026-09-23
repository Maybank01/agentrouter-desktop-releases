import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** Watch the actual Windows process; a restarted descendant can keep stdio open. */
export async function observeInstalledProcessExit(pid, executable, timeoutMs = 45000) {
  assert.equal(process.platform, 'win32')
  assert.ok(Number.isSafeInteger(pid) && pid > 0)
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 300000)
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    fileURLToPath(new URL('./installed-process.ps1', import.meta.url)),
    '-ClientProcessId', String(pid), '-ExpectedExecutable', executable, '-TimeoutMs', String(timeoutMs)],
  { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', errors = '', ready, failReady
  const watching = new Promise((resolve, reject) => { ready = resolve; failReady = reject })
  const timer = setTimeout(() => {
    failReady(new Error('The installed-process observer did not become ready'))
    child.kill()
  }, 15000)
  child.stdout.on('data', bytes => {
    output += bytes
    if (output.startsWith('ready\r\n') || output.startsWith('ready\n')) { clearTimeout(timer); ready() }
  })
  child.stderr.on('data', bytes => { errors = (errors + bytes).slice(-2000) })
  const exited = new Promise((resolve, reject) => {
    child.once('error', error => { clearTimeout(timer); failReady(error); reject(error) })
    child.once('close', code => {
      clearTimeout(timer)
      const lines = output.trim().split(/\r?\n/)
      if (code !== 0 || lines[0] !== 'ready' || !/^-?\d+$/.test(lines[1] ?? '')) {
        const error = new Error(`Installed-process exit observation failed (${code}): ${errors}`)
        failReady(error); reject(error)
      } else resolve({ pid, exitCode: Number(lines[1]) })
    })
  })
  // An observation can fail while the caller is still issuing the update request.
  // Retain that rejection for its await without an unhandled-rejection race.
  exited.catch(() => {})
  await watching
  return { exited, cancel: () => child.kill() }
}
