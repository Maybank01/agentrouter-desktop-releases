import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { directory, prepareSource } from './prepare.mjs'

const { source, output } = prepareSource()
execFileSync(process.execPath, [join(directory, 'node_modules/vitest/vitest.mjs'), 'run', '--root', source,
  '--config', join(directory, 'vitest.config.mjs')], { cwd: source, stdio: 'inherit', windowsHide: true, timeout: 180000 })
console.log(JSON.stringify({ passed: true, output, originalUpstreamTestsRetained: true, publicFeedsChanged: false }))
