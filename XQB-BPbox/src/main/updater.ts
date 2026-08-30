import { app, BrowserWindow, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'

import type { UpdateProgress, UpdateState, UpdateStatus } from '../shared/updater'

const updaterEnabled = app.isPackaged && process.platform === 'win32'

let updaterInitialized = false
let updaterIpcRegistered = false
let checkingForUpdate = false
let downloadingUpdate = false
let updateState: UpdateState = {
  status: updaterEnabled ? 'idle' : 'disabled',
  currentVersion: app.getVersion(),
  message: updaterEnabled ? undefined : '开发环境不执行自动更新'
}

function cloneState(): UpdateState {
  return {
    ...updateState,
    progress: updateState.progress ? { ...updateState.progress } : undefined
  }
}

function broadcastState(): void {
  const state = cloneState()

  BrowserWindow.getAllWindows().forEach((window) => {
    if (!window.isDestroyed()) {
      window.webContents.send('updater:state', state)
    }
  })
}

function setState(
  status: UpdateStatus,
  details: Omit<UpdateState, 'status' | 'currentVersion'> = {}
): void {
  updateState = {
    status,
    currentVersion: app.getVersion(),
    ...details
  }
  broadcastState()
}

function errorMessage(error: unknown): string {
  const rawMessage = error instanceof Error ? error.message.trim() : String(error || '未知错误')

  if (/\b404\b/.test(rawMessage) && /github\.com/i.test(rawMessage)) {
    return 'GitHub 更新仓库不可公开访问（404）。请将更新仓库设为公开，并发布正式 Release。'
  }

  const firstLine = rawMessage.split(/\r?\n|\\n/, 1)[0].trim()
  return firstLine.length > 220 ? `${firstLine.slice(0, 220)}…` : firstLine
}

function setErrorState(error: unknown): void {
  const message = errorMessage(error)
  console.error('[Updater]', error)
  setState('error', {
    availableVersion: updateState.availableVersion,
    message: `更新失败：${message}`
  })
}

async function checkForUpdates(): Promise<UpdateState> {
  if (!updaterEnabled) {
    setState('disabled', { message: '开发环境不执行自动更新' })
    return cloneState()
  }

  if (checkingForUpdate || downloadingUpdate || updateState.status === 'downloaded') {
    return cloneState()
  }

  checkingForUpdate = true
  setState('checking', { message: '正在检查更新…' })

  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
    setErrorState(error)
  } finally {
    checkingForUpdate = false
  }

  return cloneState()
}

async function downloadUpdate(): Promise<UpdateState> {
  if (!updaterEnabled || downloadingUpdate || updateState.status !== 'available') {
    return cloneState()
  }

  downloadingUpdate = true
  const availableVersion = updateState.availableVersion
  setState('downloading', {
    availableVersion,
    message: availableVersion ? `正在下载 v${availableVersion}…` : '正在下载更新…'
  })

  try {
    await autoUpdater.downloadUpdate()
  } catch (error) {
    setErrorState(error)
  } finally {
    downloadingUpdate = false
  }

  return cloneState()
}

function installUpdate(): boolean {
  if (!updaterEnabled || updateState.status !== 'downloaded') {
    return false
  }

  setImmediate(() => autoUpdater.quitAndInstall(false, true))
  return true
}

export function registerUpdaterIpc(): void {
  if (updaterIpcRegistered) {
    return
  }

  updaterIpcRegistered = true
  ipcMain.handle('updater:get-state', () => cloneState())
  ipcMain.handle('updater:check', () => checkForUpdates())
  ipcMain.handle('updater:download', () => downloadUpdate())
  ipcMain.handle('updater:install', () => installUpdate())
}

export function initializeUpdater(): void {
  if (updaterInitialized || !updaterEnabled) {
    return
  }

  updaterInitialized = true
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = false
  autoUpdater.disableDifferentialDownload = false

  autoUpdater.on('checking-for-update', () => {
    setState('checking', { message: '正在检查更新…' })
  })

  autoUpdater.on('update-not-available', () => {
    setState('up-to-date', { message: '当前已是最新版本' })
  })

  autoUpdater.on('update-available', (info) => {
    setState('available', {
      availableVersion: info.version,
      releaseDate: info.releaseDate,
      message: `发现新版本 v${info.version}`
    })
  })

  autoUpdater.on('download-progress', (info) => {
    const progress: UpdateProgress = {
      percent: Math.min(100, Math.max(0, info.percent)),
      bytesPerSecond: info.bytesPerSecond,
      transferred: info.transferred,
      total: info.total
    }
    setState('downloading', {
      availableVersion: updateState.availableVersion,
      progress,
      message: `正在下载更新：${progress.percent.toFixed(1)}%`
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    setState('downloaded', {
      availableVersion: info.version,
      releaseDate: info.releaseDate,
      message: `v${info.version} 已下载完成`
    })
  })

  autoUpdater.on('error', (error) => {
    setErrorState(error)
  })

  const startupCheck = setTimeout(() => {
    void checkForUpdates()
  }, 3000)
  startupCheck.unref()
}
