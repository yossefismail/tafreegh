import { app, BrowserWindow, dialog, protocol, session, shell } from 'electron'
import { existsSync, promises as fsp } from 'node:fs'
import { extname, join, normalize, sep } from 'node:path'
import { IPC } from '../shared/ipc'
import { isAudioPath } from '../shared/languages'
import { registerIpc } from './ipc'
import { HistoryStore } from './services/history'
import { JobService } from './services/jobs'
import { ensureDirs, getPaths, jobDir, MOCK } from './services/paths'
import { ProvidersService } from './services/providers'
import { SettingsStore } from './services/settings'
import { SetupService } from './services/setup'

app.setName('Tafreegh')
app.setAppUserModelId('com.tafreegh.app')
// The Q4_K_M GGUF ASR model leaves little headroom on 6 GB cards. Chromium's
// GPU process would take a few hundred MB of VRAM that the model needs, and
// this interface is simple enough to composite in software.
app.disableHardwareAcceleration()

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'tafreegh',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }
])

let mainWindow: BrowserWindow | null = null
let pendingOpen: string | null = null

const gotLock =
  process.env.TAFREEGH_SINGLE_INSTANCE === '0' ? true : app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

function findAudioArg(argv: string[]): string | null {
  const direct = argv.filter((arg) => isAudioPath(arg) && existsSync(arg))
  return direct.length ? direct[direct.length - 1] : null
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }
}

function contentSecurityPolicy(): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    "frame-src tafreegh:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'"
  ].join('; ')
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.css': 'text/css; charset=utf-8'
}

function registerJobProtocol(): void {
  protocol.handle('tafreegh', async (request) => {
    try {
      const url = new URL(request.url)
      if (url.hostname !== 'job') return new Response('Not found', { status: 404 })
      const parts = url.pathname.split('/').filter(Boolean)
      const id = parts.shift()
      if (!id) return new Response('Not found', { status: 404 })
      const root = jobDir(id)
      const relative = parts.map((part) => decodeURIComponent(part)).join(sep)
      const target = normalize(join(root, relative))
      if (!target.startsWith(normalize(root) + sep)) {
        return new Response('Forbidden', { status: 403 })
      }
      const data = await fsp.readFile(target)
      const ext = extname(target).toLowerCase()
      const headers: Record<string, string> = {
        'content-type': MIME[ext] ?? 'application/octet-stream',
        'cache-control': 'no-store'
      }
      if (ext === '.html') {
        headers['content-security-policy'] = [
          "default-src 'none'",
          "style-src 'unsafe-inline'",
          "script-src 'unsafe-inline'",
          "img-src data:",
          "media-src data:",
          "font-src data:",
          "base-uri 'none'"
        ].join('; ')
      }
      return new Response(data, { headers })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    backgroundColor: '#eceae4',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false
    }
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL() ?? ''
    if (url !== current) event.preventDefault()
  })

  mainWindow.webContents.on('did-finish-load', () => {
    if (pendingOpen) {
      mainWindow?.webContents.send(IPC.appOpenFile, pendingOpen)
      pendingOpen = null
    }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function openFromArgv(argv: string[]): void {
  const file = findAudioArg(argv)
  if (!file) return
  if (mainWindow) {
    if (mainWindow.webContents.isLoading()) pendingOpen = file
    else mainWindow.webContents.send(IPC.appOpenFile, file)
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  } else {
    pendingOpen = file
  }
}

app.on('second-instance', (_event, argv) => {
  openFromArgv(argv)
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.on('open-file', (event, path) => {
  event.preventDefault()
  pendingOpen = path
  if (mainWindow) {
    mainWindow.webContents.send(IPC.appOpenFile, path)
    pendingOpen = null
  }
})

app.whenReady().then(() => {
  ensureDirs()
  // Crashpad writes debug.log into the app directory by default, which leaves an
  // orphan file next to the executable that uninstall does not remove.
  try {
    app.setPath('crashDumps', join(getPaths().root, 'crash'))
  } catch {
    // not fatal: keep the default location
  }
  registerJobProtocol()

  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
  session.defaultSession.setPermissionCheckHandler(() => false)

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (!app.isPackaged || details.url.startsWith('tafreegh://')) {
      callback({ responseHeaders: details.responseHeaders })
      return
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [contentSecurityPolicy()]
      }
    })
  })

  const history = new HistoryStore()
  const settings = new SettingsStore()
  const providers = new ProvidersService(settings)
  const setup = new SetupService(
    (progress) => broadcast(IPC.setupEvent, progress),
    () => settings.getHfToken()
  )
  const jobs = new JobService(history, settings, providers, (event) =>
    broadcast(IPC.jobsEvent, event)
  )

  registerIpc({ history, settings, providers, setup, jobs, broadcast })

  // Reclaim the PyTorch + Resemble Enhance bytes that 0.9.x betas installed.
  // One-shot, silent, and safe to fail (the next launch retries).
  void setup.cleanupLegacyTorch().catch((error: unknown) => {
    console.warn('[Tafreegh] legacy torch cleanup skipped:', error)
  })

  pendingOpen = findAudioArg(process.argv.slice(1))
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}).catch((error: unknown) => {
  // A failure here used to leave an invisible, window-less process running.
  console.error('[Tafreegh] startup failed:', error)
  dialog.showErrorBox(
    'تعذّر تشغيل التطبيق',
    error instanceof Error ? error.message : String(error)
  )
  app.quit()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

if (MOCK) {
  // Make it obvious in logs that no models are being touched.
  console.log('[Tafreegh] mock mode enabled')
}
