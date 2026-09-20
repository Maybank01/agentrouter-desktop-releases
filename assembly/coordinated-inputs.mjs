/** Catch an omitted published plugin before building a new product release. */
import assert from 'node:assert/strict'
import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function checkPluginSelection(input, published, retainReason = '') {
  assert.equal(published.name, input.plugin.name)
  assert.match(published.version, /^\d+\.\d+\.\d+$/)
  const reason = retainReason.trim()
  const current = input.plugin.version === published.version
  assert.ok(current || reason.length > 0,
    `Desktop ${input.productVersion} still pins plugin ${input.plugin.version}; npm next is ${published.version}. Update the reviewed product input, or record why this release deliberately retains the older plugin.`)
  return { productVersion: input.productVersion, pluginVersion: input.plugin.version,
    pluginSha256: input.plugin.sha256, observedNext: published.version, current,
    ...(current ? {} : { retainReason: reason }) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const input = JSON.parse(readFileSync('assembly/coordinated/release.json', 'utf8'))
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(input.plugin.name)}/next`, { signal: AbortSignal.timeout(30_000) })
  assert.equal(response.status, 200, 'Unable to read the published plugin selection')
  const result = checkPluginSelection(input, await response.json(), process.env.RETAIN_PLUGIN_REASON ?? '')
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `selection=${JSON.stringify(result)}\n`)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    '## Product release contents\n\n```json\n' + JSON.stringify(result, null, 2) + '\n```\n')
  console.log(JSON.stringify(result))
}
