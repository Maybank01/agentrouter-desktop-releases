import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { root } from './lib.mjs'

const logs = join(root, '.local/coordinated-delivery')
mkdirSync(logs, { recursive: true })
function run(script, args, name) {
  const output = execFileSync(process.execPath, [join(root, 'assembly/coordinated', script), ...args],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true,
      maxBuffer: 32 * 1024 * 1024, timeout: 2400000 })
  writeFileSync(join(logs, name + '.log'), output)
  return JSON.parse(output.trim().split(/\r?\n/).at(-1))
}
const { candidate } = run('build.mjs', [], 'build')
const { receipt } = run('installer-acceptance.mjs', [candidate], 'installed')
const accepted = JSON.parse(readFileSync(receipt, 'utf8'))
if (!accepted.passed || !accepted.nativeUpdaterExecuted || !accepted.legacyInstallerExecuted) throw new Error('Installed acceptance is incomplete')
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `receipt=${JSON.stringify(accepted)}\n`)
console.log(JSON.stringify(accepted))
