/** Explicit recovery for the upstream credentials root-shape startup failure.
 * Never runs on a healthy store or changes a file before the user selects recovery.
 */
import { createHash, randomUUID } from 'node:crypto'
import { lstat, open, rename } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { parseDocument } from 'yaml'

const limit = 4 * 1024 * 1024
const changed = () => new Error('The credentials file changed or is unavailable. It was not reset; reopen AgentRouter to check it again.')

async function invalidRootSnapshot(filename) {
  const before = await lstat(filename)
  if (!before.isFile() || before.isSymbolicLink() || before.size > limit) return undefined
  const file = await open(filename, 'r')
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev || stat.size > limit) return undefined
    const bytes = Buffer.alloc(stat.size + 1)
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    if (bytesRead !== stat.size) return undefined
    const contents = bytes.subarray(0, bytesRead)
    const document = parseDocument(contents.toString('utf8'), { prettyErrors: false, uniqueKeys: true })
    if (document.errors.length) return undefined
    const value = document.toJS()
    // Empty stores, maps (including future layouts) and syntax errors keep
    // upstream handling. This action is only for its non-mapping-root error.
    if (value == null || (typeof value === 'object' && !Array.isArray(value))) return undefined
    return { filename, sha256: createHash('sha256').update(contents).digest('hex'), size: bytesRead }
  } finally { await file.close() }
}

export async function inspectCredentialStartupFailure(error, dshHome) {
  const filename = join(resolve(dshHome), '.credentials.yaml')
  const message = error instanceof Error ? error.message : String(error)
  if (!message.includes(`credentials-local: ${filename} must be a mapping`)) return undefined
  try { return await invalidRootSnapshot(filename) } catch { return undefined }
}

/** Call only after the user's explicit backup-and-sign-in selection. */
export async function backupInvalidCredentials(snapshot, dshHome) {
  const filename = join(resolve(dshHome), '.credentials.yaml')
  if (snapshot?.filename !== filename) throw changed()
  return withFileLock(filename, async () => {
    let current
    try { current = await invalidRootSnapshot(filename) } catch { throw changed() }
    if (!current || current.sha256 !== snapshot.sha256 || current.size !== snapshot.size) throw changed()
    // Same-directory rename preserves every byte and the existing permissions.
    // An absent store is supported upstream and is recreated on the next login.
    const backup = `${filename}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`
    await rename(filename, backup)
    return backup
  }, { waitMs: 1500 })
}

export function credentialRecoveryDialog(snapshot, chinese) {
  return {
    type: 'error',
    title: chinese ? 'AgentRouter 无法启动' : 'AgentRouter could not start',
    message: chinese ? '登录凭据文件格式异常' : 'The saved credentials file has an invalid format',
    detail: chinese
      ? `恢复时会将原文件完整保留为同目录备份，然后重启客户端。你需要重新登录；项目、聊天记录和其他配置会保留。\n\n${snapshot.filename}`
      : `Recovery keeps the original file as a backup in the same folder, then restarts AgentRouter. You will need to sign in again. Projects, conversations and other settings are retained.\n\n${snapshot.filename}`,
    buttons: chinese ? ['备份凭据并重新登录', '检查更新…', '退出'] : ['Back up credentials and sign in again', 'Check for updates…', 'Quit'],
    defaultId: 0,
    cancelId: 2,
  }
}
