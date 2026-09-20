import assert from 'node:assert/strict'
import test from 'node:test'
import { checkPluginSelection } from '../coordinated-inputs.mjs'

test('an omitted published UI fails before installer acceptance; deliberate maintenance retains a reason', () => {
  const input = { productVersion: '3.0.8', plugin: { name: '@agentrouter-top/dsh-codex', version: '0.12.2', sha256: 'a'.repeat(64) } }
  const next = { name: input.plugin.name, version: '0.13.0' }
  assert.throws(() => checkPluginSelection(input, next), /still pins plugin 0.12.2/)
  assert.throws(() => checkPluginSelection(input, next, '   '), /still pins/)
  assert.equal(checkPluginSelection(input, next, 'Legacy-profile repair release; UI remains in the next batch').current, false)
  assert.equal(checkPluginSelection({ ...input, plugin: { ...input.plugin, version: '0.13.0' } }, next).current, true)
  assert.throws(() => checkPluginSelection(input, { ...next, name: 'other-package' }))
})
