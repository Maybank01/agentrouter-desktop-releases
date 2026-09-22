import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, readdir, stat, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { inspectCredentialStartupFailure, backupInvalidCredentials, credentialRecoveryDialog } from './credential-recovery.mjs'

async function fixture(t, content = 'synthetic-invalid-document\n') {
  const root = await mkdtemp(join(tmpdir(), 'ar-credential-recovery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const filename = join(root, '.credentials.yaml')
  await writeFile(filename, content, { mode: 0o600 })
  const error = new Error(`dsh desktop: plugin tree failed to load: credentials-local: ${filename} must be a mapping`)
  return { root, filename, error, content }
}

test('identifies the exact startup failure without changing or exposing credentials', async t => {
  const f = await fixture(t)
  const snapshot = await inspectCredentialStartupFailure(f.error, f.root)
  assert.equal(snapshot.filename, f.filename)
  assert.equal(JSON.stringify(snapshot).includes(f.content.trim()), false)
  assert.equal(await readFile(f.filename, 'utf8'), f.content)
  assert.deepEqual(await readdir(f.root), ['.credentials.yaml'])
  const dialog = credentialRecoveryDialog(snapshot, true)
  assert.match(dialog.buttons[0], /备份/)
  assert.match(dialog.detail, /重新登录/)
  assert.match(dialog.detail, /聊天记录/)
  assert.equal(dialog.cancelId, 2)
  assert.equal(dialog.detail.includes(f.content.trim()), false)
})

test('backs up exact bytes and permissions while retaining conversations and settings', async t => {
  const f = await fixture(t, '- synthetic-a\r\n- synthetic-b\r\n')
  await mkdir(join(f.root, 'sessions'))
  await writeFile(join(f.root, 'sessions', 'retained.json'), '{"session":"retained"}')
  await writeFile(join(f.root, 'settings.yaml'), 'keep: true\n')
  const before = await stat(f.filename)
  const snapshot = await inspectCredentialStartupFailure(f.error, f.root)
  const backup = await backupInvalidCredentials(snapshot, f.root)
  assert.ok(backup.startsWith(f.filename + '.backup-'))
  assert.equal(await readFile(backup, 'utf8'), f.content)
  assert.equal((await stat(backup)).mode, before.mode)
  await assert.rejects(readFile(f.filename), { code: 'ENOENT' })
  assert.equal(await readFile(join(f.root, 'sessions', 'retained.json'), 'utf8'), '{"session":"retained"}')
  assert.equal(await readFile(join(f.root, 'settings.yaml'), 'utf8'), 'keep: true\n')
})

test('does not offer recovery for valid, future, empty or syntactically invalid documents', async t => {
  const f = await fixture(t)
  for (const content of ['', '# empty\n', 'null\n', '{}\n', 'version: 1\nrefs: {}\n', 'version: 2\n', 'bad: [\n']) {
    await writeFile(f.filename, content)
    assert.equal(await inspectCredentialStartupFailure(f.error, f.root), undefined)
    assert.equal(await readFile(f.filename, 'utf8'), content)
  }
})

test('does not act on unrelated errors, other paths, directories or removed files', async t => {
  const f = await fixture(t)
  assert.equal(await inspectCredentialStartupFailure(new Error('network offline'), f.root), undefined)
  assert.equal(await inspectCredentialStartupFailure(f.error, join(f.root, 'other')), undefined)
  await rm(f.filename)
  assert.equal(await inspectCredentialStartupFailure(f.error, f.root), undefined)
  await mkdir(f.filename)
  assert.equal(await inspectCredentialStartupFailure(f.error, f.root), undefined)
})

test('refuses a changed file or a recovery request for a different Home', async t => {
  const f = await fixture(t)
  const snapshot = await inspectCredentialStartupFailure(f.error, f.root)
  await assert.rejects(backupInvalidCredentials(snapshot, join(f.root, 'other')), /not reset/)
  for (const content of ['another-invalid-document\n', 'version: 1\nrefs: {}\n']) {
    await writeFile(f.filename, content)
    await assert.rejects(backupInvalidCredentials(snapshot, f.root), /not reset/)
    assert.equal(await readFile(f.filename, 'utf8'), content)
  }
  assert.deepEqual(await readdir(f.root), ['.credentials.yaml'])
})

test('respects the upstream writer lock and preserves the original on lock failure', async t => {
  const f = await fixture(t)
  const snapshot = await inspectCredentialStartupFailure(f.error, f.root)
  await withFileLock(f.filename, async () => {
    await assert.rejects(backupInvalidCredentials(snapshot, f.root), /lock|timed|wait/i)
    assert.equal(await readFile(f.filename, 'utf8'), f.content)
  })
  assert.deepEqual(await readdir(f.root), ['.credentials.yaml'])
})
