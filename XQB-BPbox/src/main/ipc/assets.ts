import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { basename } from 'node:path'

import {
  type AssetCategory,
  getAssetsPath,
  getConfigPath,
  importAssetFile,
  scanLocalAssets,
  storedPathExists,
  storedPathToFileUrl
} from '../assets'
import type { ImportedAssetResult, LocalAssetKind, SelectFileResult } from '../../shared/types'
import { notifyProjectFilesChanged } from '../projectFileWatchers'

async function selectFile(
  senderWindow: BrowserWindow | null,
  fileType: 'image' | 'video' | 'audio'
): Promise<SelectFileResult> {
  const options: Electron.OpenDialogOptions = {
    title: fileType === 'image' ? '选择图片资源' : '选择视频资源',
    properties: ['openFile'],
    filters:
      fileType === 'image'
        ? [
            { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
            { name: '所有文件', extensions: ['*'] }
          ]
        : [
            { name: '视频', extensions: ['mp4', 'webm', 'mov', 'mkv'] },
            { name: '所有文件', extensions: ['*'] }
          ]
  }
  if (fileType === 'audio') {
    options.title = 'Select audio asset'
    options.filters = [
      { name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'] },
      { name: 'All files', extensions: ['*'] }
    ]
  }

  const result = senderWindow
    ? await dialog.showOpenDialog(senderWindow, options)
    : await dialog.showOpenDialog(options)

  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true }
  }

  const selectedPath = result.filePaths[0]
  return {
    canceled: false,
    path: selectedPath,
    fileName: basename(selectedPath)
  }
}

export function registerAssetIpc(): void {
  ipcMain.handle('files:select-image', (event) =>
    selectFile(BrowserWindow.fromWebContents(event.sender), 'image')
  )
  ipcMain.handle('files:select-video', (event) =>
    selectFile(BrowserWindow.fromWebContents(event.sender), 'video')
  )
  ipcMain.handle('files:select-audio', (event) =>
    selectFile(BrowserWindow.fromWebContents(event.sender), 'audio')
  )
  ipcMain.handle(
    'files:import-asset',
    (
      _event,
      sourcePath: string,
      category: AssetCategory,
      ownerName: string,
      assetKey: string
    ): ImportedAssetResult => {
      const imported = importAssetFile(sourcePath, category, ownerName, assetKey)
      notifyProjectFilesChanged(
        category === 'characters'
          ? ['assets', 'characters', 'characterResourceTable']
          : category === 'light_cones'
            ? ['assets', 'lightCones', 'characterResourceTable']
            : ['assets']
      )
      return imported
    }
  )
  ipcMain.handle('files:to-file-url', (_event, storedPath?: string | null) =>
    storedPathToFileUrl(storedPath)
  )
  ipcMain.handle('files:exists', (_event, storedPath?: string | null) =>
    storedPathExists(storedPath)
  )
  ipcMain.handle('files:scan-assets', (_event, kind?: LocalAssetKind) => scanLocalAssets(kind))
  ipcMain.handle('files:open-config-folder', async () => {
    const errorMessage = await shell.openPath(getConfigPath())
    if (errorMessage) {
      throw new Error(errorMessage)
    }

    return true
  })
  ipcMain.handle('files:open-assets-folder', async () => {
    const errorMessage = await shell.openPath(getAssetsPath())
    if (errorMessage) {
      throw new Error(errorMessage)
    }

    return true
  })
}
