import assert from 'node:assert/strict'
import test from 'node:test'
import { describeExit, runInstall } from './install-retry.mjs'

const quiet = () => {}

test('explains native Windows crashes that print no error', () => {
  assert.match(describeExit({ status: 3221226505 }), /0xC0000409 STATUS_STACK_BUFFER_OVERRUN/)
  assert.equal(describeExit({ status: 1 }), 'exit 1')
  assert.equal(describeExit({ status: null, signal: 'SIGTERM' }), 'terminated by SIGTERM')
  assert.match(describeExit({ error: Object.assign(new Error('x'), { code: 'ETIMEDOUT' }) }), /ETIMEDOUT/)
})

test('retries a failed install once with identical arguments', () => {
  const calls = []
  const results = [{ status: 3221226505, stdout: 'Progress: resolved 1\n', stderr: '' }, { status: 0, stdout: 'done\n', stderr: '' }]
  const result = runInstall('node', ['pnpm.mjs', 'install', '--lockfile-only'], { cwd: 'seed' },
    { label: 'seed lock', log: quiet, spawn: (...args) => { calls.push(args); return results.shift() } })
  assert.equal(result.status, 0)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0].slice(0, 2), calls[1].slice(0, 2))
  assert.equal(calls[0][2].cwd, 'seed')
  assert.deepEqual(calls[0][2].stdio, ['ignore', 'pipe', 'pipe'])
})

test('a repeated failure reports every reason with stderr and stdout', () => {
  let count = 0
  assert.throws(() => runInstall('node', ['pnpm.mjs', 'fetch'], {}, { label: 'seed fetch', log: quiet,
    spawn: () => ({ status: ++count === 1 ? 3221226505 : 1, stdout: 'Progress ' + count, stderr: count === 2 ? 'ERR_PNPM_FETCH_404' : '' }) }),
  error => /seed fetch failed after 2 attempts/.test(error.message) && /0xC0000409/.test(error.message)
    && /exit 1/.test(error.message) && /ERR_PNPM_FETCH_404/.test(error.message) && /Progress 1/.test(error.message))
  assert.equal(count, 2)
})

test('success on the first attempt does not repeat the command', () => {
  let count = 0
  runInstall('node', [], {}, { label: 'x', log: quiet, spawn: () => { count++; return { status: 0 } } })
  assert.equal(count, 1)
})
