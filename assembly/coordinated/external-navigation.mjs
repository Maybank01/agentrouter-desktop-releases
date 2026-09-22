/** Keep web navigation outside the privileged Desktop renderer. */
export function installExternalWebNavigation(webContents, openExternal, reportFailure) {
  const open = value => {
    let url
    try { url = new URL(value) } catch { return }
    if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) return
    // Pass the parsed URL to the OS and never include authorization URLs in errors.
    void Promise.resolve().then(() => openExternal(url.href)).catch(() => reportFailure())
  }
  webContents.setWindowOpenHandler(({ url }) => {
    open(url)
    return { action: 'deny' }
  })
  webContents.on('will-navigate', (event, url) => {
    try { if (new URL(url).protocol === 'dsh-app:') return } catch {}
    event.preventDefault()
    open(url)
  })
}
