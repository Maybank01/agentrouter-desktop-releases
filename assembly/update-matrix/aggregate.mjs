/**
 * Combine update-matrix cells into update-matrix.json and a baseline x mode
 * table. Any cell that failed its gate, or produced no record, fails the matrix.
 *
 *   PLAN='<plan json>' node assembly/update-matrix/aggregate.mjs <results-dir> <output.json>
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { releaseByTag } from './assets.mjs'
import { repository } from './plan.mjs'

export const outcomeLabel = cell => {
  if (!cell.record) return '**FAIL** (no record)'
  const { outcome, failedStep } = cell.record
  if (outcome === 'pass') return 'pass'
  if (outcome === 'known-failure') return `known failure (${failedStep})`
  if (outcome === 'unexpected-pass') return 'pass (known failure expected)'
  return `**FAIL** (${failedStep ?? 'unknown step'})`
}

/** Pair every planned cell with its record; unplanned or mismatched records are rejected. */
export function combine(plan, records) {
  const byId = new Map()
  for (const record of records) {
    const id = `${record.baseline}-${record.mode}`
    assert.ok(!byId.has(id), `Duplicate record ${id}`)
    byId.set(id, record)
  }
  const cells = plan.cells.map(cell => {
    const record = byId.get(cell.id)
    if (record) {
      assert.equal(record.candidate, plan.candidate, `${cell.id} tested another candidate`)
      assert.equal(record.expected, cell.expected, `${cell.id} used another expectation`)
    }
    const gatePassed = Boolean(record?.gatePassed) && ['pass', 'known-failure', 'unexpected-pass'].includes(record.outcome)
    return { ...cell, record, gatePassed, label: outcomeLabel({ record }) }
  })
  for (const id of byId.keys()) assert.ok(plan.cells.some(cell => cell.id === id), `Unplanned record ${id}`)
  return { schemaVersion: 1, kind: 'update-matrix', candidate: plan.candidate, candidateTag: plan.candidateTag,
    passed: cells.every(cell => cell.gatePassed), cells: cells.map(({ record, ...cell }) => ({ ...cell,
      outcome: record?.outcome ?? 'missing', failedStep: record?.failedStep, error: record?.error,
      durations: record?.durations, knownFailure: record?.knownFailure, interruption: record?.interruption,
      interruptionRetry: record?.interruptionRetry, rollback: record?.rollback, retention: record?.retention,
      installers: record?.installers, networkPreflight: record?.networkPreflight, requestLog: record?.requestLog })) }
}

export function renderTable(matrix) {
  const modes = [...new Set(matrix.cells.map(cell => cell.mode))]
  const baselines = [...new Set(matrix.cells.map(cell => cell.baseline))]
  const minutes = ms => ms === undefined ? '' : ` ${Math.round(ms / 6000) / 10} min`
  const rows = baselines.map(baseline => `| ${baseline} | ${modes.map(mode => {
    const cell = matrix.cells.find(item => item.baseline === baseline && item.mode === mode)
    return cell ? `${cell.label}${minutes(cell.durations?.totalMs)}` : '-'
  }).join(' | ')} |`)
  return [`## Update path matrix: candidate ${matrix.candidate}`, '',
    `| Baseline | ${modes.join(' | ')} |`, `| --- | ${modes.map(() => '---').join(' | ')} |`, ...rows, '',
    matrix.passed ? 'Every cell passed its gate (known failures are documented limits of that baseline).'
      : '**The update path is broken for at least one published baseline; publication is blocked.**', ''].join('\n')
}

function readRecords(directory) {
  const records = []
  const visit = path => {
    for (const name of readdirSync(path)) {
      const full = join(path, name)
      if (statSync(full).isDirectory()) visit(full)
      else if (/^update-matrix-\d+\.\d+\.\d+-[a-z-]+\.json$/.test(name)) records.push(JSON.parse(readFileSync(full, 'utf8')))
    }
  }
  if (existsSync(directory)) visit(directory)
  return records
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const plan = JSON.parse(process.env.PLAN)
  const matrix = combine(plan, readRecords(resolve(process.argv[2])))
  Object.assign(matrix, { run: { id: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT, sha: process.env.GITHUB_SHA,
    url: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` }, generatedAt: new Date().toISOString() })
  writeFileSync(resolve(process.argv[3]), JSON.stringify(matrix, null, 2) + '\n')
  if (process.env.RECORD_TAG) {
    // Release runs attach the result to their own never-published draft, like the signed records.
    const release = releaseByTag(process.env.RECORD_TAG)
    assert.equal(release.draft, true, 'The update matrix is recorded only on a never-published draft')
    assert.equal(release.published_at, null)
    execFileSync('gh', ['release', 'upload', process.env.RECORD_TAG, resolve(process.argv[3]), '--repo', repository, '--clobber'],
      { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true })
  }
  const table = renderTable(matrix)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, table)
  console.log(table)
  if (!matrix.passed) process.exitCode = 1
}
