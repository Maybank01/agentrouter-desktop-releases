/** Finish an accepted installer handoff after the Host has already stopped. */
export function installUpdateExitHandler({ app, autoUpdater, BrowserWindow }) {
  const finish = () => {
    // Startup recovery windows deliberately disable Close. Renderer unload hooks
    // can also veto app.quit(). Neither may leave NSIS waiting on this process.
    for (const window of BrowserWindow.getAllWindows()) window.setClosable(true)
    app.exit(0)
  }
  autoUpdater.on('before-quit-for-update', finish)
  return () => autoUpdater.off('before-quit-for-update', finish)
}
