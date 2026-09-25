import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { root } from '../lib.mjs'

test('the coordinated adapter export matches its single source owner byte for byte', () => {
  const dir = join(root, 'assembly/coordinated')
  const manifest = JSON.parse(readFileSync(join(dir, 'adapter-source.json'), 'utf8'))
  // Unified client source since 2026-09-25 (agentrouter-desktop archived).
  assert.equal(manifest.repository, 'Maybank01/agentrouter-dsh-plugins')
  assert.equal(manifest.sourceDirectory, 'desktop/coordinated')
  assert.equal(manifest.developmentOwner, 'Maybank01/agentrouter-dsh-plugins/desktop/coordinated')
  assert.match(manifest.commit, /^[a-f0-9]{40}$/)
  assert.deepEqual(readdirSync(dir).filter(name => name !== 'adapter-source.json' && name !== 'node_modules').sort(), manifest.files.map(file => file.path).sort())
  for (const entry of manifest.files) {
    assert.match(entry.path, /^[a-z0-9.-]+$/)
    const body = readFileSync(join(dir, entry.path))
    assert.equal(body.length, entry.bytes, entry.path)
    assert.equal(createHash('sha256').update(body).digest('hex'), entry.sha256, entry.path)
  }
})
