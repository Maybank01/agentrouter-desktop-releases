import { join } from 'node:path'
import { extractFile, uncache } from '@electron/asar'

/** NSIS replaces app.asar in place; discard the library's old header offsets. */
export function readInstalledProductVersion(installation) {
  const archive = join(installation, 'resources/app.asar')
  uncache(archive)
  return JSON.parse(extractFile(archive, 'package.json').toString()).version
}
