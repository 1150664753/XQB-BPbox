import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'

import { getConfigPath, sanitizeFileSegment } from '../assets'
import { notifyProjectFilesChanged } from '../projectFileWatchers'
import type { FlowConfig, FlowListItem, SavedFileResult } from '../../shared/types'

function flowsDir(): string {
  return getConfigPath('bp')
}

function ensureFlowsDir(): void {
  mkdirSync(flowsDir(), { recursive: true })
}

function normalizeFlowFileName(name: string): string {
  const baseName = name.endsWith('.json') ? name.slice(0, -5) : name
  return `${sanitizeFileSegment(baseName)}.json`
}

function resolveFlowPath(fileName: string): string {
  return isAbsolute(fileName) ? fileName : join(flowsDir(), normalizeFlowFileName(fileName))
}

function readFlowFile(filePath: string): FlowConfig {
  const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as FlowConfig

  if (!parsed.name || !Array.isArray(parsed.steps)) {
    throw new Error('BP 流程 JSON 格式不正确')
  }

  return parsed
}

export function registerFlowIpc(): void {
  ipcMain.handle('flows:list', (): FlowListItem[] => {
    ensureFlowsDir()

    if (!existsSync(flowsDir())) {
      return []
    }

    return readdirSync(flowsDir())
      .filter((fileName) => fileName.endsWith('.json'))
      .map((fileName) => {
        const filePath = join(flowsDir(), fileName)
        const stat = statSync(filePath)
        let name = fileName.replace(/\.json$/i, '')

        try {
          name = readFlowFile(filePath).name
        } catch {
          name = fileName
        }

        return {
          fileName,
          name,
          updatedAt: stat.mtime.toISOString()
        }
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  })

  ipcMain.handle('flows:save', (_event, config: FlowConfig): SavedFileResult => {
    if (!config.name.trim()) {
      throw new Error('流程名称不能为空')
    }

    ensureFlowsDir()
    const fileName = normalizeFlowFileName(config.name)
    const filePath = join(flowsDir(), fileName)
    writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8')
    notifyProjectFilesChanged(['flows'])

    return {
      fileName,
      path: filePath
    }
  })

  ipcMain.handle('flows:load', async (event, fileName?: string): Promise<FlowConfig | null> => {
    if (fileName) {
      return readFlowFile(resolveFlowPath(fileName))
    }

    const senderWindow = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: '选择 BP 流程 JSON',
      properties: ['openFile'],
      filters: [
        { name: 'JSON', extensions: ['json'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    }
    const result = senderWindow
      ? await dialog.showOpenDialog(senderWindow, options)
      : await dialog.showOpenDialog(options)

    if (result.canceled || result.filePaths.length === 0) {
      return null
    }

    return readFlowFile(result.filePaths[0])
  })

  ipcMain.handle('flows:delete', (_event, fileName: string): boolean => {
    if (!fileName) {
      return false
    }

    ensureFlowsDir()
    const filePath = join(flowsDir(), normalizeFlowFileName(fileName))
    if (!existsSync(filePath)) {
      return false
    }

    unlinkSync(filePath)
    notifyProjectFilesChanged(['flows'])
    return true
  })

  ipcMain.handle('flows:rename', (_event, fileName: string, nextName: string): SavedFileResult => {
    const name = nextName.trim()
    if (!fileName || !name) {
      throw new Error('流程名称不能为空')
    }

    ensureFlowsDir()
    const oldPath = resolveFlowPath(fileName)
    if (!existsSync(oldPath)) {
      throw new Error('要重命名的流程文件不存在')
    }

    const flow = readFlowFile(oldPath)
    const nextFileName = normalizeFlowFileName(name)
    const nextPath = join(flowsDir(), nextFileName)
    if (oldPath !== nextPath && existsSync(nextPath)) {
      throw new Error(`已存在同名流程文件：${nextFileName}`)
    }

    const renamedFlow: FlowConfig = { ...flow, name }
    if (oldPath !== nextPath) {
      renameSync(oldPath, nextPath)
    }
    writeFileSync(nextPath, `${JSON.stringify(renamedFlow, null, 2)}\n`, 'utf-8')
    notifyProjectFilesChanged(['flows'])

    return {
      fileName: nextFileName,
      path: nextPath
    }
  })

  ipcMain.handle('flows:open-folder', async () => {
    ensureFlowsDir()
    const errorMessage = await shell.openPath(flowsDir())
    if (errorMessage) {
      throw new Error(errorMessage)
    }

    return true
  })

  ipcMain.handle('flows:basename', (_event, filePath: string) => basename(filePath))
}
