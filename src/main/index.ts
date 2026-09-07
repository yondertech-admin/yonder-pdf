import { app, BrowserWindow, ipcMain, Menu, nativeTheme, shell, session } from 'electron'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { AD_HOST, type MenuCommand, type OpenedFile } from '@shared/api'
import { buildMenu } from './menu'
import { allowWindow, isAllowedExternal, registerIpc } from './ipc'
import { isPdfPath, readPdf } from './documents'
import { addRecent } from './settings'
import { cleanupAll as cleanupPrintJobs } from './print'
import { checkForUpdates } from './updater'

const isMac = process.platform === 'darwin'
let mainWindow: BrowserWindow | null = null
let pendingOpen: string[] = []
let rendererReady = false
let closeConfirmed = false

// Single instance: a second launch forwards its file arguments to us.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    void openFilesFromArgs(argv)
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

app.setName('Yonder PDF')
app.setAboutPanelOptions({
  applicationName: 'Yonder PDF',
  applicationVersion: app.getVersion(),
  copyright: '© 2026 Yonder Tech · MIT License',
  website: 'https://github.com/yondertech/yonder-pdf'
})

function pdfArgs(argv: string[]): string[] {
  return argv.slice(1).filter((a) => !a.startsWith('-') && isPdfPath(a))
}

async function openFilesFromArgs(argv: string[]): Promise<void> {
  const paths = pdfArgs(argv)
  if (paths.length) await openPaths(paths)
}

async function openPaths(paths: string[]): Promise<void> {
  if (!mainWindow || !rendererReady) {
    pendingOpen.push(...paths)
    return
  }
  const files: OpenedFile[] = []
  for (const p of paths) {
    try {
      const f = await readPdf(p)
      await addRecent(p, f.name, f.location)
      files.push(f)
    } catch {
      /* ignored: renderer shows nothing for unreadable drops */
    }
  }
  if (files.length) mainWindow.webContents.send('open-files', files)
}

// macOS: Finder double-click / drag onto Dock icon.
app.on('open-file', (e, path) => {
  e.preventDefault()
  void openPaths([path])
})

function send(command: MenuCommand): void {
  mainWindow?.webContents.send('menu', command)
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 760,
    minHeight: 520,
    show: false,
    title: 'Yonder PDF',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: isMac ? { x: 14, y: 16 } : undefined,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1f22' : '#f3f4f6',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: true,
      additionalArguments: [`--yonder-version=${app.getVersion()}`]
    }
  })
  mainWindow = win
  allowWindow(win)

  // Popup/link bridge (design §12 / findings 23–24): the app never opens child
  // windows. Links from our own UI go to an allow-list; clicks originating in
  // the ad frame may open any https URL in the system browser.
  win.webContents.setWindowOpenHandler(({ url, referrer }) => {
    let fromAd = false
    try {
      fromAd = typeof referrer?.url === 'string' && new URL(referrer.url).origin === new URL(AD_HOST).origin
    } catch {
      fromAd = false
    }
    let ok = false
    try {
      // Ad clicks may go to any https advertiser; app links stay on the allow-list.
      ok = fromAd ? new URL(url).protocol === 'https:' : isAllowedExternal(url)
    } catch {
      ok = false
    }
    if (ok) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.on('will-frame-navigate', (e) => {
    if (e.isMainFrame) return e.preventDefault()
    try {
      if (new URL(e.url).protocol !== 'https:') e.preventDefault()
    } catch {
      e.preventDefault()
    }
  })
  win.webContents.on('will-attach-webview', (e) => e.preventDefault())

  win.on('ready-to-show', () => win.show())

  // Dev-only diagnostics: YONDER_DEBUG=1 mirrors renderer console output to the
  // terminal; YONDER_SCREENSHOT=/path.png captures the window after 4 s and quits.
  if (!app.isPackaged) {
    if (process.env['YONDER_DEBUG']) {
      win.webContents.on('console-message', (e) => console.log(`[renderer:${e.level}] ${e.message} (${e.sourceId}:${e.lineNumber})`))
    }
    const shot = process.env['YONDER_SCREENSHOT']
    if (shot) {
      setTimeout(async () => {
        try {
          const img = await win.webContents.capturePage()
          writeFileSync(shot, img.toPNG())
          console.log('screenshot written to', shot)
        } finally {
          closeConfirmed = true
          app.quit()
        }
      }, Number(process.env['YONDER_SCREENSHOT_DELAY'] ?? 4000))
    }
  }
  win.on('enter-full-screen', () => win.webContents.send('fullscreen', true))
  win.on('leave-full-screen', () => win.webContents.send('fullscreen', false))

  // Unsaved-changes guard: renderer decides, then calls window:closeConfirmed.
  win.on('close', (e) => {
    if (closeConfirmed || !rendererReady) return
    e.preventDefault()
    win.webContents.send('close-request')
  })
  win.on('closed', () => {
    mainWindow = null
    rendererReady = false
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  // Deny every permission request (camera, geolocation, notifications…).
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  // Nothing in this app downloads files through Chromium.
  session.defaultSession.on('will-download', (e) => e.preventDefault())

  Menu.setApplicationMenu(buildMenu(send))
  registerIpc()

  ipcMain.on('renderer:ready', (e) => {
    if (!mainWindow || e.sender.id !== mainWindow.webContents.id) return
    rendererReady = true
    const queued = pendingOpen
    pendingOpen = []
    if (queued.length) void openPaths(queued)
    setTimeout(() => void checkForUpdates(), 4000)
  })
  ipcMain.on('window:closeConfirmed', (e) => {
    if (!mainWindow || e.sender.id !== mainWindow.webContents.id) return
    closeConfirmed = true
    mainWindow.close()
  })

  createWindow()
  void openFilesFromArgs(process.argv)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      closeConfirmed = false
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (!isMac) app.quit()
})

app.on('before-quit', () => {
  void cleanupPrintJobs()
})
