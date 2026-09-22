import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { _electron, expect } from '@playwright/test'

/** Actual cancel, backup and automatic relaunch in an already accepted synthetic Home. */
export async function assertCredentialRecovery({ executablePath, state, home, electronHome, env }) {
  assert.ok(realpathSync(home).startsWith(realpathSync(state) + sep), 'Use only the synthetic acceptance Home')
  const filename = join(home, '.credentials.yaml')
  if (existsSync(filename)) renameSync(filename, join(state, 'credentials-before-recovery.yaml'))
  const invalid = 'synthetic-invalid-credential-document\r\n'
  writeFileSync(filename, invalid, { flag: 'wx', mode: 0o600 })
  const before = new Set(readdirSync(home).filter(name => name.startsWith('.credentials.yaml.backup-')))
  let recoveryStartedAt = 0
  for (const selection of [2, 0]) {
    if (selection === 0) recoveryStartedAt = Date.now()
    const app = await _electron.launch({ executablePath, args: ['--lang=zh-CN', `--user-data-dir=${electronHome}`],
      cwd: state, env, timeout: 60000 })
    try {
      const closed = app.waitForEvent('close', { timeout: 60000 })
      await app.evaluate(({ dialog }, input) => {
        const fs = process.getBuiltinModule('fs')
        const original = dialog.showMessageBox.bind(dialog)
        dialog.showMessageBox = async (...args) => {
          const options = args.at(-1)
          if (options.type !== 'error') return original(...args)
          fs.writeFileSync(input.receipt, JSON.stringify({ message: options.message, buttons: options.buttons }))
          return { response: input.selection, checkboxChecked: false }
        }
      }, { selection, receipt: join(state, `credential-recovery-dialog-${selection}.json`) })
      await closed
      const dialog = JSON.parse(readFileSync(join(state, `credential-recovery-dialog-${selection}.json`), 'utf8'))
      assert.equal(dialog.message, '登录凭据文件格式异常')
      assert.equal(dialog.buttons[0], '备份凭据并重新登录')
      if (selection === 2) assert.equal(readFileSync(filename, 'utf8'), invalid)
    } finally { await app.close().catch(() => {}) }
  }
  await expect.poll(() => {
    try {
      const startup = JSON.parse(readFileSync(join(home, 'desktop/startup.json'), 'utf8'))
      return startup.ready === true && Date.parse(startup.startedAt) > recoveryStartedAt
    } catch { return false }
  }, { timeout: 90000 }).toBe(true)
  const backups = readdirSync(home).filter(name => name.startsWith('.credentials.yaml.backup-') && !before.has(name))
  assert.equal(backups.length, 1)
  assert.equal(readFileSync(join(home, backups[0]), 'utf8'), invalid)
  if (existsSync(filename)) assert.notEqual(readFileSync(filename, 'utf8'), invalid)
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop"; $items=@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:AR_CREDENTIAL_TEST_EXE -and $_.CommandLine.Contains($env:AR_CREDENTIAL_TEST_DATA) } | ForEach-Object { Get-Process -Id $_.ProcessId } | Where-Object { $_.MainWindowHandle -ne 0 }); if($items.Count -ne 1){throw "Expected exactly one isolated recovery window"}; foreach($item in $items){if(!$item.CloseMainWindow() -or !$item.WaitForExit(15000)){throw "Recovery window did not close cleanly"}}'],
  { env: { ...env, AR_CREDENTIAL_TEST_EXE: resolve(executablePath), AR_CREDENTIAL_TEST_DATA: resolve(electronHome) },
    windowsHide: true, timeout: 20000 })
  return { passed: true, cancelRetainedOriginal: true, exactBackupRetained: true, automaticRelaunch: true }
}
