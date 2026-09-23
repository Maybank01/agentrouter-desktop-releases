import assert from 'node:assert/strict'
import test from 'node:test'
import { describeExit, parseInstall, runInstall } from '../retry-install.mjs'

const quiet = () => {}

test('only a frozen npm ci with plain arguments may be repeated', () => {
  assert.equal(parseInstall(['npm', 'ci', '--ignore-scripts', '--prefix', 'assembly/coordinated']),
    'npm ci --ignore-scripts --prefix assembly/coordinated')
  for (const argv of [['npm', 'install'], ['npm', 'publish'], ['yarn', 'install'], ['npm', 'ci', '&&', 'x'], ['npm', 'ci', '$(x)']]) {
    assert.throws(() => parseInstall(argv))
  }
})

test('a failed install is retried once and a success is not repeated', () => {
  const results = [{ status: 3221226505 }, { status: 0 }]
  const commands = []
  const outcome = runInstall('npm ci', { log: quiet, spawn: command => { commands.push(command); return results.shift() } })
  assert.deepEqual(commands, ['npm ci', 'npm ci'])
  assert.equal(outcome.attempts, 2)
  assert.match(outcome.reasons[0], /0xC0000409/)
  let count = 0
  runInstall('npm ci', { log: quiet, spawn: () => { count++; return { status: 0 } } })
  assert.equal(count, 1)
})

test('two failures fail the step with both reasons', () => {
  const results = [{ status: 1 }, { status: null, signal: 'SIGTERM' }]
  assert.throws(() => runInstall('npm ci', { log: quiet, spawn: () => results.shift() }),
    /npm ci failed after 2 attempts: exit 1; terminated by SIGTERM/)
  assert.match(describeExit({ error: Object.assign(new Error('x'), { code: 'ETIMEDOUT' }) }), /ETIMEDOUT/)
})
