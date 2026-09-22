import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { installExternalWebNavigation } from './external-navigation.mjs'

function fixture(openExternal) {
  const opened = [], failures = []
  let popup, navigate
  installExternalWebNavigation({
    setWindowOpenHandler(handler) { popup = handler },
    on(name, handler) { assert.equal(name, 'will-navigate'); navigate = handler },
  }, openExternal ?? (async url => { opened.push(url) }), (...args) => { failures.push(args) })
  return { opened, failures, popup: url => popup({ url }), navigate(url) {
    let prevented = false
    navigate({ preventDefault() { prevented = true } }, url)
    return prevented
  } }
}

test('authorization popups go to the browser with their full query, without an Electron child window', async () => {
  const state = fixture()
  const url = 'https://login.example.invalid/device?user_code=ABCD-EFGH&return=%2Fconsole#confirm'
  assert.deepEqual(state.popup(url), { action: 'deny' })
  await setImmediate()
  assert.deepEqual(state.opened, [url])
})

test('ordinary web links leave the desktop page in place and use a normalized browser URL', async () => {
  const state = fixture()
  assert.equal(state.navigate('HTTP://Example.invalid:80/help'), true)
  await setImmediate()
  assert.deepEqual(state.opened, ['http://example.invalid/help'])
})

test('internal desktop navigation stays in its renderer', async () => {
  const state = fixture()
  assert.equal(state.navigate('dsh-app://app/index.html'), false)
  assert.deepEqual(state.popup('dsh-app://shell/plugin-manager.html'), { action: 'deny' })
  await setImmediate()
  assert.deepEqual(state.opened, [])
})

test('local files, commands, scripts, malformed URLs and embedded credentials never reach the OS', async () => {
  const state = fixture()
  for (const url of ['file:///C:/Windows/notepad.exe', 'javascript:void(0)', 'data:text/html,hello',
    'about:blank', 'ms-settings:display', 'not a URL', 'https://user:secret@example.invalid/']) {
    assert.deepEqual(state.popup(url), { action: 'deny' })
    assert.equal(state.navigate(url), true)
  }
  await setImmediate()
  assert.deepEqual(state.opened, [])
})

test('browser launch failure is reported without exposing its URL or error payload', async () => {
  const state = fixture(async () => { throw new Error('sensitive browser command') })
  state.popup('https://login.example.invalid/device?user_code=secret')
  await setImmediate()
  assert.deepEqual(state.failures, [[]])
})
