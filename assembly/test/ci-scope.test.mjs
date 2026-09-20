import assert from 'node:assert/strict'
import test from 'node:test'
import { changedPaths, requiresInstalledAcceptance } from '../ci-scope.mjs'

test('website observation, private-plugin execution and docs do not reinstall an unchanged Desktop', () => {
  for (const files of [['assembly/coordinated-website.mjs', 'assembly/test/coordinated-website.test.mjs'],
    ['assembly/plugin-ci/executor.mjs', '.github/workflows/plugin-validation.yml'], ['AGENTS.md', 'assembly/CI.md']]) {
    assert.equal(requiresInstalledAcceptance(files), false)
  }
})

test('all adapter inputs, build, signing and unknown code retain installed acceptance', () => {
  for (const path of ['assembly/coordinated/release.json', 'assembly/coordinated/coordinated-delivery.patch',
    'assembly/coordinated/package-lock.json', 'assembly/coordinated/adapter-source.json',
    'assembly/coordinated-candidate.mjs', 'assembly/coordinated-release.mjs', '.github/workflows/release.yml',
    '.github/workflows/ci.yml', 'assembly/new-code.mjs']) {
    assert.equal(requiresInstalledAcceptance(['README.md', path]), true, path)
  }
})

test('PR compares the tested merge tree to the merge base; manual runs require full validation', () => {
  const base = 'a'.repeat(40)
  assert.deepEqual(changedPaths({ pull_request: { base: { sha: base } } }, (...args) => {
    assert.deepEqual(args, ['diff', '--name-only', '--no-renames', `${base}...HEAD`])
    return 'assembly/coordinated/release.json\n'
  }), ['assembly/coordinated/release.json'])
  assert.equal(changedPaths({}, () => assert.fail()), null)
  assert.equal(changedPaths({ before: '0'.repeat(40) }, () => assert.fail()), null)
})
