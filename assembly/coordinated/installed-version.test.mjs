import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createPackage, extractFile } from '@electron/asar'
import { readInstalledProductVersion } from './installed-version.mjs'

test('observes an installer replacing an archive after the Cancel check cached its old header', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentrouter-installed-version-'))
  try {
    const input = join(root, 'input'), installation = join(root, 'installed'), resources = join(installation, 'resources')
    await mkdir(input); await mkdir(resources, { recursive: true })
    const archive = join(resources, 'app.asar')
    for (const version of ['3.0.14', '3.0.15']) {
      await writeFile(join(input, 'main.js'), 'x'.repeat(version === '3.0.14' ? 100 : 3000))
      await writeFile(join(input, 'package.json'), JSON.stringify({ version }))
      await createPackage(input, join(root, `${version}.asar`))
    }
    await copyFile(join(root, '3.0.14.asar'), archive)
    assert.equal(JSON.parse(extractFile(archive, 'package.json').toString()).version, '3.0.14')
    await copyFile(join(root, '3.0.15.asar'), archive)
    // This is the previous verifier's actual failure, independent of NSIS.
    assert.throws(() => JSON.parse(extractFile(archive, 'package.json').toString()))
    assert.equal(readInstalledProductVersion(installation), '3.0.15')
  } finally { await rm(root, { recursive: true, force: true }) }
})
