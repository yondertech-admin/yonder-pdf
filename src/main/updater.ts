// Auto-update via GitHub Releases (electron-updater "github" provider).
// Unsigned macOS builds cannot self-install updates, so on macOS this is
// check-only until the app ships with a Developer ID signature.
import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateStatus } from '@shared/api'

/** Flip to true once macOS releases are signed + notarized in CI. */
const MAC_SIGNED = false
const RELEASES_URL = 'https://github.com/yondertech/yonder-pdf/releases'

let status: UpdateStatus = { state: 'idle' }
let wired = false

function canInstall(): boolean {
  if (!app.isPackaged) return false
  if (process.platform === 'darwin') return MAC_SIGNED
  if (process.platform === 'linux') return Boolean(process.env.APPIMAGE)
  return true
}

function broadcast(next: UpdateStatus): void {
  status = next
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('update-status', status)
  }
}

export function currentStatus(): UpdateStatus {
  return status
}

function wire(): void {
  if (wired) return
  wired = true
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = null
  autoUpdater.on('checking-for-update', () => broadcast({ state: 'checking' }))
  autoUpdater.on('update-available', (info) => {
    broadcast({
      state: 'available',
      version: info.version,
      releaseUrl: `${RELEASES_URL}/tag/v${info.version}`,
      canInstall: canInstall()
    })
    if (canInstall()) void autoUpdater.downloadUpdate().catch((e) => broadcast({ state: 'error', message: String(e) }))
  })
  autoUpdater.on('update-not-available', () => broadcast({ state: 'none' }))
  autoUpdater.on('download-progress', (p) => broadcast({ state: 'downloading', percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (info) => broadcast({ state: 'ready', version: info.version }))
  autoUpdater.on('error', (err) => broadcast({ state: 'error', message: err?.message ?? String(err) }))
}

export async function checkForUpdates(): Promise<void> {
  if (!app.isPackaged) {
    broadcast({ state: 'none' })
    return
  }
  wire()
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    broadcast({ state: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}

export function installUpdate(): void {
  if (status.state !== 'ready') return
  autoUpdater.quitAndInstall()
}
