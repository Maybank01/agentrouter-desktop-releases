/** Choose installed checks from the actual changed paths; unknown inputs stay conservative. */
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function requiresInstalledAcceptance(paths) {
  return paths.some(path => {
    if (/\.(md|txt)$/.test(path) || /^(docs\/|\.github\/ISSUE_TEMPLATE\/)/.test(path)) return false
    if (/^assembly\/(test\/|plugin-ci\/|coordinated-(website|public|recovery)\.mjs$|ci-scope\.mjs$)/.test(path)) return false
    if (path === '.github/workflows/plugin-validation.yml') return false
    return true
  })
}

export function changedPaths(event, git) {
  if (event.pull_request) return git('diff', '--name-only', '--no-renames', `${event.pull_request.base.sha}...HEAD`).trim().split(/\r?\n/).filter(Boolean)
  if (/^[a-f0-9]{40}$/.test(event.before ?? '') && !/^0+$/.test(event.before)) {
    return git('diff', '--name-only', '--no-renames', event.before, 'HEAD').trim().split(/\r?\n/).filter(Boolean)
  }
  return null
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', windowsHide: true })
  const paths = changedPaths(event, git)
  const installed = paths === null || requiresInstalledAcceptance(paths)
  appendFileSync(process.env.GITHUB_OUTPUT, `installed=${installed}\n`)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Validation scope\n\nInstalled update/migration: **${installed ? 'required' : 'unchanged inputs; source checks only'}**.\n${paths === null ? 'Manual or unknown comparison: full validation.' : `${paths.length} changed paths examined.`}\n`)
}
