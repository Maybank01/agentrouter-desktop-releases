import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { installUpdateExitHandler } from './update-exit.mjs'

test('only an accepted updater handoff bypasses unclosable windows and unload vetoes', () => {
  const events = []
  const autoUpdater = new EventEmitter()
  const app = new EventEmitter()
  app.exit = code => events.push(['exit', code])
  const remove = installUpdateExitHandler({ app, autoUpdater, BrowserWindow: {
    getAllWindows: () => [1, 2].map(id => ({ setClosable: value => events.push(['closable', id, value]) })),
  } })
  app.emit('before-quit', { preventDefault() {} })
  assert.deepEqual(events, [])
  autoUpdater.emit('before-quit-for-update')
  assert.deepEqual(events, [['closable', 1, true], ['closable', 2, true], ['exit', 0]])
  remove()
  assert.equal(autoUpdater.listenerCount('before-quit-for-update'), 0)
})
