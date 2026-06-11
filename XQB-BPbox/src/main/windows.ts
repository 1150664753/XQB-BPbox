import { app, BrowserWindow, screen, shell } from 'electron'
import { join } from 'node:path'
import icon from '../../assets/icons/icon.png?asset'

let mainWindow: BrowserWindow | null = null
let displayWindow: BrowserWindow | null = null
let previewWindow: BrowserWindow | null = null

const displayContentWidth = 1920
const displayContentHeight = 1080
const displayMinContentWidth = 640
const displayMinContentHeight = 360

function rendererEntry(hash?: string): string {
  const rendererUrl = process.env['ELECTRON_RENDERER_URL']

  if (!app.isPackaged && rendererUrl) {
    return hash ? `${rendererUrl}#${hash}` : rendererUrl
  }

  return join(__dirname, '../renderer/index.html')
}

function loadRendererRoute(window: BrowserWindow, hash: string): void {
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(rendererEntry(hash))
    return
  }

  window.loadFile(rendererEntry(), { hash })
}

function windowIsOnRoute(window: BrowserWindow, hash: string): boolean {
  return window.webContents.getURL().includes(`#${hash}`)
}

function configureWindow(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })
}

function physicalPixelsToDip(value: number, scaleFactor: number): number {
  return Math.max(1, Math.round(value / Math.max(1, scaleFactor)))
}

function targetDisplayScaleFactor(window?: BrowserWindow): number {
  if (window && !window.isDestroyed()) {
    return screen.getDisplayMatching(window.getBounds()).scaleFactor
  }

  return screen.getPrimaryDisplay().scaleFactor
}

function displayContentDipSize(window?: BrowserWindow): {
  width: number
  height: number
  minWidth: number
  minHeight: number
} {
  const scaleFactor = targetDisplayScaleFactor(window)

  return {
    width: physicalPixelsToDip(displayContentWidth, scaleFactor),
    height: physicalPixelsToDip(displayContentHeight, scaleFactor),
    minWidth: physicalPixelsToDip(displayMinContentWidth, scaleFactor),
    minHeight: physicalPixelsToDip(displayMinContentHeight, scaleFactor)
  }
}

function setDisplayContentSize(window: BrowserWindow): void {
  const size = displayContentDipSize(window)

  window.setMinimumSize(size.minWidth, size.minHeight)
  window.setContentSize(size.width, size.height)
}

function setDisplayWindowContentSize(window: BrowserWindow): void {
  setDisplayContentSize(window)
}

function correctDisplayWindowContentSize(window: BrowserWindow): void {
  if (window.isDestroyed()) {
    return
  }

  const bounds = window.getContentBounds()
  const size = displayContentDipSize(window)
  const widthDelta = size.width - bounds.width
  const heightDelta = size.height - bounds.height

  if (widthDelta === 0 && heightDelta === 0) {
    return
  }

  window.setContentSize(bounds.width + widthDelta, bounds.height + heightDelta)
}

export function createMainWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus()
    return mainWindow
  }

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    title: 'XQB-BPBox 控制台',
    icon,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  })

  configureWindow(mainWindow)

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(rendererEntry())
  } else {
    mainWindow.loadFile(rendererEntry())
  }

  return mainWindow
}

export function createDisplayWindow(): BrowserWindow {
  if (displayWindow && !displayWindow.isDestroyed()) {
    if (!windowIsOnRoute(displayWindow, '/display')) {
      loadRendererRoute(displayWindow, '/display')
    }
    setDisplayWindowContentSize(displayWindow)
    correctDisplayWindowContentSize(displayWindow)
    if (displayWindow.isMinimized()) {
      displayWindow.restore()
    }
    if (!displayWindow.isVisible()) {
      displayWindow.show()
    }
    displayWindow.focus()
    return displayWindow
  }

  const size = displayContentDipSize()

  displayWindow = new BrowserWindow({
    width: size.width,
    height: size.height,
    minWidth: size.minWidth,
    minHeight: size.minHeight,
    useContentSize: true,
    show: false,
    title: 'XQB-BPBox 展示页',
    icon,
    autoHideMenuBar: true,
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false
    }
  })

  configureWindow(displayWindow)

  displayWindow.on('ready-to-show', () => {
    if (displayWindow && !displayWindow.isDestroyed()) {
      setDisplayWindowContentSize(displayWindow)
      correctDisplayWindowContentSize(displayWindow)
    }
    displayWindow?.show()
  })

  displayWindow.on('closed', () => {
    displayWindow = null
  })

  loadRendererRoute(displayWindow, '/display')

  return displayWindow
}

export function createPreviewWindow(): BrowserWindow {
  if (previewWindow && !previewWindow.isDestroyed()) {
    setDisplayContentSize(previewWindow)
    previewWindow.focus()
    return previewWindow
  }

  const size = displayContentDipSize()

  previewWindow = new BrowserWindow({
    width: size.width,
    height: size.height,
    minWidth: size.minWidth,
    minHeight: size.minHeight,
    useContentSize: true,
    show: false,
    title: 'XQB-BPBox 预览页',
    icon,
    autoHideMenuBar: true,
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  })

  configureWindow(previewWindow)

  previewWindow.on('ready-to-show', () => {
    if (previewWindow && !previewWindow.isDestroyed()) {
      setDisplayContentSize(previewWindow)
    }
    previewWindow?.show()
  })

  previewWindow.on('closed', () => {
    previewWindow = null
  })

  loadRendererRoute(previewWindow, '/preview')

  return previewWindow
}

export function getDisplayWindowStatus(): boolean {
  return Boolean(displayWindow && !displayWindow.isDestroyed())
}

export function getPreviewWindowStatus(): boolean {
  return Boolean(previewWindow && !previewWindow.isDestroyed())
}

export function sendToDisplay(channel: string, payload: unknown): boolean {
  if (!displayWindow || displayWindow.isDestroyed()) {
    return false
  }

  displayWindow.webContents.send(channel, payload)
  return true
}

export function sendToPreview(channel: string, payload: unknown): boolean {
  if (!previewWindow || previewWindow.isDestroyed()) {
    return false
  }

  previewWindow.webContents.send(channel, payload)
  return true
}

export function sendToAllWindows(channel: string, payload: unknown): void {
  BrowserWindow.getAllWindows().forEach((window) => {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, payload)
    }
  })
}
