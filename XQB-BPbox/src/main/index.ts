import { app } from 'electron'

import { ensureProjectDirectories } from './assets'
import { registerAssetIpc } from './ipc/assets'
import { registerBpIpc } from './ipc/bp'
import { registerCharacterIpc } from './ipc/characters'
import { registerDisplaySettingsIpc } from './ipc/displaySettings'
import { registerFlowIpc } from './ipc/flows'
import { registerLightConeIpc } from './ipc/lightCones'
import { registerRemoteBpIpc } from './ipc/remoteBp'
import { registerVoiceTimelineIpc } from './ipc/voiceTimelines'
import { startProjectFileWatchers } from './projectFileWatchers'
import { registerAssetProtocol, registerAssetProtocolScheme } from './protocols'
import { initializeUpdater, registerUpdaterIpc } from './updater'
import { createDisplayWindow, createMainWindow } from './windows'

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
app.setName('XQB-BPBox')
registerAssetProtocolScheme()

function registerIpcHandlers(): void {
  registerAssetIpc()
  registerCharacterIpc()
  registerLightConeIpc()
  registerFlowIpc()
  registerDisplaySettingsIpc()
  registerVoiceTimelineIpc()
  registerBpIpc()
  registerRemoteBpIpc()
  registerUpdaterIpc()
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  app.setAppUserModelId('com.xqb.bpbox')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    window.webContents.on('before-input-event', (event, input) => {
      if (!app.isPackaged && input.type === 'keyDown' && input.key === 'F12') {
        if (window.webContents.isDevToolsOpened()) {
          window.webContents.closeDevTools()
        } else {
          window.webContents.openDevTools()
        }

        event.preventDefault()
      }
    })
  })

  registerAssetProtocol()
  ensureProjectDirectories()
  startProjectFileWatchers()
  registerIpcHandlers()

  createMainWindow()
  createDisplayWindow()
  initializeUpdater()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (app.isReady()) {
      createMainWindow()
      createDisplayWindow()
    }
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
import './preview-audio-mute'
