/** Bounded cache recovery for the pinned electron-updater 6.8.9 implementation. */
import assert from 'node:assert/strict'
import { lstat, readdir, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export function updateFailureMessage(error) {
  switch (error?.code) {
    case 'UPDATE_METADATA_UNAVAILABLE': return '暂时无法获取更新验证信息，请检查网络后重试。已下载的文件会保留。'
    case 'UPDATE_METADATA_INVALID': return '更新验证信息不匹配，请重新检查更新后重试。'
    case 'UPDATE_CACHE_UNAVAILABLE': return '更新文件暂时被占用，请关闭尚未结束的安装窗口后重试。'
    case 'ERR_UPDATER_INVALID_SIGNATURE':
    case 'UPDATE_FILE_INVALID': return '更新文件校验失败，请重新下载。'
    case 'UPDATE_DOWNLOAD_INTERRUPTED': {
      const kept = Number.isSafeInteger(error.transferred) && error.transferred > 0
        ? `已下载的 ${(error.transferred / 1048576).toFixed(1)} MB 已保留，` : ''
      return `网络连接中断，下载已暂停。${kept}点击“继续下载”会从断点继续。`
    }
    default: return '更新下载未完成，请检查网络后重试。'
  }
}

async function realDirectory(path) {
  const stat = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error })
  assert.ok(!stat || stat.isDirectory() && !stat.isSymbolicLink(), 'Updater cache must be a real directory')
}

export function configureUpdateRecovery(updater) {
  return {
    async beforeDownload() {
      // 6.8.9 copies the target blockmap over current.blockmap at download time,
      // before NSIS replaces installer.exe. Cancellation can leave that pair out
      // of sync. Keep installer.exe; retrieve its small map from its immutable tag.
      if (!updater.previousBlockmapBaseUrlOverride || typeof updater.getOrCreateDownloadHelper !== 'function') return
      const helper = await updater.getOrCreateDownloadHelper()
      await realDirectory(helper.cacheDir)
      await unlink(join(helper.cacheDir, 'current.blockmap')).catch(error => { if (error.code !== 'ENOENT') throw error })
    },
    async discardInvalidDownload() {
      const helper = updater.downloadedUpdateHelper
      if (!helper) return
      const root = resolve(helper.cacheDir)
      const pending = resolve(helper.cacheDirForPendingUpdate)
      assert.equal(pending, join(root, 'pending'), 'Recovery is confined to the updater pending directory')
      await realDirectory(root)
      await realDirectory(pending)
      // Reuse upstream cleanup so its same-process shortcut cannot keep returning
      // a file rejected by the product signature check. Leave the diff base alone.
      await helper.clear()
      assert.equal(helper.file, null)
      // Upstream deliberately swallows filesystem errors. A locked pending file
      // must remain a retryable cache error, not a claim that cleanup succeeded.
      const remaining = await readdir(pending).catch(error => {
        if (error.code === 'ENOENT') return []
        throw error
      })
      if (remaining.length) throw Object.assign(new Error('Update cache is still in use'), { code: 'UPDATE_CACHE_UNAVAILABLE' })
    },
  }
}
