/** Prepare unmodified upstream plus published npm preinstalls. Never a runtime entry. */
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { root, upstream, plugins, readJson, canonicalJson, validateLocks, buildEnvironment,
  run, yarn, verifySource, preinstalledManifest, preinstallPatch, preapprovedYarnRc, fetchPublishedPackage } from './lib.mjs'

export async function prepare({ refreshLock = false } = {}) {
  validateLocks()
  const output = mkdtempSync(join(tmpdir(), 'ar-dsh-assembly-'))
  const source = join(output, 'source')
  const packages = join(output, 'packages')
  mkdirSync(packages)
  const env = buildEnvironment(output)
  // Preserve failure evidence; never recursively remove a user-provided path.
  console.log(`Assembly staging: ${output}`)
  run('git', ['-c', 'core.autocrlf=false', 'clone', '--depth', '1', '--branch', upstream.tag,
    '--', upstream.repository, source], output, env)
  verifySource(source)
  assert.equal(readJson(join(source, 'package.json')).packageManager, upstream.packageManager)
  const npmPackages = await Promise.all(plugins.packages.map(pkg => fetchPublishedPackage(pkg, packages)))
  const application = join(source, upstream.application)
  const manifest = join(application, 'package.json')
  writeFileSync(manifest, canonicalJson(preinstalledManifest(readJson(manifest))))
  const patch = join(application, 'cordis.patch.yml')
  writeFileSync(patch, readFileSync(patch, 'utf8') + preinstallPatch())
  const yarnrc = join(source, '.yarnrc.yml')
  writeFileSync(yarnrc, preapprovedYarnRc(readFileSync(yarnrc, 'utf8')))
  if (refreshLock) {
    yarn(source, { ...env, YARN_ENABLE_IMMUTABLE_INSTALLS: 'false' }, 'install', '--mode=skip-build')
    // Generated lock maintenance is explicit; normal builds cannot resolve a new graph.
    copyFileSync(join(source, 'yarn.lock'), join(root, 'assembly/yarn.lock'))
  } else copyFileSync(join(root, 'assembly/yarn.lock'), join(source, 'yarn.lock'))
  yarn(source, env, 'install', '--immutable', '--mode=skip-build')
  const verified = verifySource(source, { prepared: true })
  const receipt = { schemaVersion: 1, output, source, ...verified, npmPackages, environment: plugins.environment,
    installerBuilt: false, published: false }
  writeFileSync(join(output, 'prepared.json'), canonicalJson(receipt))
  console.log(`Prepared and verified: ${source}`)
  return receipt
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  assert.ok(process.argv.slice(2).every(arg => arg === '--refresh-lock'), 'Only --refresh-lock is supported')
  await prepare({ refreshLock: process.argv.includes('--refresh-lock') })
}
