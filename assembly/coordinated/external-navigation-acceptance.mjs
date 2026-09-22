import assert from 'node:assert/strict'
import { expect } from '@playwright/test'

/** Exercise the packaged Electron navigation handlers without opening test URLs on the worker. */
export async function assertExternalWebNavigation(app, page) {
  const originalUrl = page.url()
  const originalWindows = app.windows().length
  const authorization = 'https://login.example.invalid/device?user_code=desktop-link-check&return=%2Fconsole'
  const popup = 'https://example.invalid/register'
  const navigation = 'http://example.invalid/help'
  await app.evaluate(({ shell }) => {
    globalThis.__agentrouterExternalNavigationAcceptance = { original: shell.openExternal, opened: [] }
    shell.openExternal = async url => { globalThis.__agentrouterExternalNavigationAcceptance.opened.push(url) }
  })
  const opened = () => app.evaluate(() => globalThis.__agentrouterExternalNavigationAcceptance.opened)
  try {
    await page.evaluate(url => {
      const link = document.createElement('a')
      link.id = 'agentrouter-external-navigation-acceptance'
      link.href = url
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      link.textContent = 'External navigation acceptance'
      link.style.cssText = 'position:fixed;top:0;left:0;z-index:2147483647;background:white;padding:12px'
      document.body.append(link)
    }, authorization)
    await page.locator('#agentrouter-external-navigation-acceptance').click()
    await expect.poll(opened).toEqual([authorization])
    await page.evaluate(url => { window.open(url, '_blank', 'noopener,noreferrer') }, popup)
    await expect.poll(opened).toEqual([authorization, popup])
    await page.evaluate(url => { window.location.assign(url) }, navigation)
    await expect.poll(opened).toEqual([authorization, popup, navigation])
    assert.equal(page.url(), originalUrl)
    assert.equal(app.windows().length, originalWindows)
  } finally {
    await page.evaluate(() => document.getElementById('agentrouter-external-navigation-acceptance')?.remove())
    await app.evaluate(({ shell }) => {
      shell.openExternal = globalThis.__agentrouterExternalNavigationAcceptance.original
      delete globalThis.__agentrouterExternalNavigationAcceptance
    })
  }
  // Electron cancels the external navigation, but CDP can retain its pending
  // navigation marker. Finish on a fresh internal document before more UI checks.
  await page.reload({ waitUntil: 'domcontentloaded' })
}
