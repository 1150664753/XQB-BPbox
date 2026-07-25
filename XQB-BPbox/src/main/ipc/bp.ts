import { ipcMain, shell } from 'electron'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'

import { getResultsPath, sanitizeFileSegment } from '../assets'
import { notifyProjectFilesChanged } from '../projectFileWatchers'
import {
  createDisplayWindow,
  createPreviewWindow,
  getDisplayWindowStatus,
  getPreviewWindowStatus,
  sendToDisplay,
  sendToPreview
} from '../windows'
import {
  beginVoiceTimelineDisplayAudioMute,
  endVoiceTimelineDisplayAudioMute
} from '../preview-audio-mute'
import { applyLiveDisplaySettings } from './displaySettings'
import type {
  BpResult,
  BpResultListItem,
  BpDisplayReplayClickType,
  BpRuntimeState,
  DisplaySettings,
  SavedFileResult,
  VoiceTimelinePlayback
} from '../../shared/types'
import { normalizePvEndTime, normalizePvStartTime } from '../../shared/pvPlayback'

let latestRuntimeState: BpRuntimeState | null = null
let latestPreviewState: BpRuntimeState | null = null
let latestVoiceTimelinePlayback: VoiceTimelinePlayback | null = null

function resultsDir(): string {
  return getResultsPath('bp')
}

function ensureResultsDir(): void {
  mkdirSync(resultsDir(), { recursive: true })
}

function normalizeResultFileName(name: string): string {
  const baseName = basename(name).endsWith('.json') ? basename(name).slice(0, -5) : basename(name)
  return `${sanitizeFileSegment(baseName)}.json`
}

function resolveResultPath(fileName: string): string {
  return isAbsolute(fileName) ? fileName : join(resultsDir(), normalizeResultFileName(fileName))
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizeResult(result: Partial<BpResult>, fallbackName: string): BpResult {
  const createdAt = result.createdAt || new Date().toISOString()
  const flowName = result.flowName || result.flowConfig?.name || '未命名 BP 流程'

  return {
    name: result.name || fallbackName || flowName,
    flowName,
    flowConfig: result.flowConfig,
    createdAt,
    ...(optionalString(result.upCharacterPvPath)
      ? { upCharacterPvPath: optionalString(result.upCharacterPvPath) }
      : {}),
    upCharacterPvStartTime: normalizePvStartTime(result.upCharacterPvStartTime),
    upCharacterPvEndTime: normalizePvEndTime(result.upCharacterPvEndTime),
    starTeam: result.starTeam ?? {
      name: '左侧队',
      picks: [],
      bans: []
    },
    railTeam: result.railTeam ?? {
      name: '右侧队',
      picks: [],
      bans: []
    },
    actions: Array.isArray(result.actions) ? result.actions : []
  }
}

function readResultFile(filePath: string): BpResult {
  const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as Partial<BpResult>
  const fallbackName = basename(filePath, '.json')
  return normalizeResult(parsed, fallbackName)
}

export function registerBpIpc(): void {
  ipcMain.handle('bp:send-state-to-display', (_event, state: BpRuntimeState) => {
    latestRuntimeState = state
    latestPreviewState = state
    // Regular BP state pushes should exit voice-timeline linked mode.
    latestVoiceTimelinePlayback = null
    endVoiceTimelineDisplayAudioMute()
    const displaySent = sendToDisplay('bp:state', state)
    sendToDisplay('bp:voice-timeline-playback', null)
    sendToPreview('bp:state', state)
    return displaySent
  })
  ipcMain.handle(
    'bp:set-voice-timeline-playback',
    (_event, playback: VoiceTimelinePlayback | null): boolean => {
      latestVoiceTimelinePlayback = playback
      if (!playback) {
        endVoiceTimelineDisplayAudioMute()
      }
      sendToDisplay('bp:voice-timeline-playback', latestVoiceTimelinePlayback)
      return true
    }
  )
  ipcMain.handle('bp:get-voice-timeline-playback', () => latestVoiceTimelinePlayback)
  ipcMain.handle('bp:get-current-state', () => latestRuntimeState)
  ipcMain.handle('bp:get-preview-state', () => latestPreviewState ?? latestRuntimeState)
  ipcMain.handle(
    'bp:send-display-replay-click',
    (_event, clickType: BpDisplayReplayClickType): boolean =>
      sendToDisplay('bp:display-replay-click', clickType)
  )

  ipcMain.handle(
    'bp:open-display-window-linked',
    (
      _event,
      state: BpRuntimeState,
      playback: VoiceTimelinePlayback,
      settings?: DisplaySettings | null
    ): boolean => {
      latestRuntimeState = state
      latestPreviewState = state
      latestVoiceTimelinePlayback = playback
      const liveSettings = settings ? applyLiveDisplaySettings(settings) : null
      beginVoiceTimelineDisplayAudioMute()
      const window = (() => {
        try {
          return createDisplayWindow()
        } catch (error) {
          endVoiceTimelineDisplayAudioMute()
          throw error
        }
      })()
      beginVoiceTimelineDisplayAudioMute(window)
      const sendLinkedState = (): void => {
        if (window.isDestroyed()) {
          return
        }

        if (liveSettings) {
          window.webContents.send('display-settings:updated', liveSettings)
        }
        window.webContents.send('bp:state', latestRuntimeState)
        window.webContents.send('bp:voice-timeline-playback', latestVoiceTimelinePlayback)
      }
      const sendAfterRendererMount = (): void => {
        const resendDelays = [0, 80, 240, 500]
        resendDelays.forEach((delay) => {
          setTimeout(sendLinkedState, delay)
        })
      }

      if (window.webContents.isLoading()) {
        window.webContents.once('did-finish-load', sendAfterRendererMount)
      } else {
        sendAfterRendererMount()
      }
      window.webContents.once('dom-ready', sendAfterRendererMount)

      return getDisplayWindowStatus()
    }
  )

  ipcMain.handle('bp:list-results', (): BpResultListItem[] => {
    ensureResultsDir()

    if (!existsSync(resultsDir())) {
      return []
    }

    return readdirSync(resultsDir())
      .filter((fileName) => fileName.endsWith('.json'))
      .map((fileName) => {
        const filePath = join(resultsDir(), fileName)
        const stat = statSync(filePath)

        try {
          const result = readResultFile(filePath)
          return {
            fileName,
            name: result.name,
            flowName: result.flowName,
            createdAt: result.createdAt,
            updatedAt: stat.mtime.toISOString(),
            actionCount: result.actions.length
          }
        } catch {
          return {
            fileName,
            name: fileName.replace(/\.json$/i, ''),
            flowName: '读取失败',
            createdAt: stat.mtime.toISOString(),
            updatedAt: stat.mtime.toISOString(),
            actionCount: 0
          }
        }
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  })

  ipcMain.handle(
    'bp:load-result',
    (_event, fileName: string): BpResult => readResultFile(resolveResultPath(fileName))
  )

  ipcMain.handle(
    'bp:save-result',
    (_event, result: BpResult, targetFileName?: string): SavedFileResult => {
      ensureResultsDir()
      const createdAt = result.createdAt || new Date().toISOString()
      const name = result.name?.trim() || result.flowName || 'BP 结果'
      const filePath = targetFileName
        ? resolveResultPath(targetFileName)
        : join(resultsDir(), `${sanitizeFileSegment(name)}-${createdAt.replace(/[:.]/g, '-')}.json`)
      const normalizedResult = normalizeResult({ ...result, name, createdAt }, name)

      writeFileSync(filePath, `${JSON.stringify(normalizedResult, null, 2)}\n`, 'utf-8')
      notifyProjectFilesChanged(['bpResults'])

      return {
        fileName: basename(filePath),
        path: filePath
      }
    }
  )

  ipcMain.handle('bp:delete-result', (_event, fileName: string): boolean => {
    if (!fileName) {
      return false
    }

    ensureResultsDir()
    const filePath = join(resultsDir(), normalizeResultFileName(fileName))
    if (!existsSync(filePath)) {
      return false
    }

    unlinkSync(filePath)
    notifyProjectFilesChanged(['bpResults'])
    return true
  })

  ipcMain.handle(
    'bp:rename-result',
    (_event, fileName: string, nextName: string): SavedFileResult => {
      const name = nextName.trim()
      if (!fileName || !name) {
        throw new Error('BP 结果名称不能为空')
      }

      ensureResultsDir()
      const oldPath = resolveResultPath(fileName)
      if (!existsSync(oldPath)) {
        throw new Error('要重命名的 BP 结果不存在')
      }

      const result = readResultFile(oldPath)
      const renamedResult: BpResult = { ...result, name }
      const createdAt = renamedResult.createdAt || new Date().toISOString()
      const nextFileName = `${sanitizeFileSegment(name)}-${createdAt.replace(/[:.]/g, '-')}.json`
      const nextPath = join(resultsDir(), nextFileName)

      if (oldPath !== nextPath && existsSync(nextPath)) {
        throw new Error(`已存在同名 BP 结果：${nextFileName}`)
      }

      writeFileSync(nextPath, `${JSON.stringify(renamedResult, null, 2)}\n`, 'utf-8')
      if (oldPath !== nextPath) {
        unlinkSync(oldPath)
      }
      notifyProjectFilesChanged(['bpResults'])

      return {
        fileName: nextFileName,
        path: nextPath
      }
    }
  )

  ipcMain.handle('bp:get-display-status', () => getDisplayWindowStatus())
  ipcMain.handle('bp:open-results-folder', async () => {
    ensureResultsDir()
    const errorMessage = await shell.openPath(resultsDir())
    if (errorMessage) {
      throw new Error(errorMessage)
    }

    return true
  })
  ipcMain.handle('bp:open-display-window', () => {
    const window = createDisplayWindow()
    const sendLatestState = (): void => {
      if (window.isDestroyed()) {
        return
      }
      if (latestRuntimeState) {
        window.webContents.send('bp:state', latestRuntimeState)
      }
      window.webContents.send('bp:voice-timeline-playback', latestVoiceTimelinePlayback)
    }

    if (window.webContents.isLoading()) {
      window.webContents.once('did-finish-load', sendLatestState)
    } else {
      sendLatestState()
    }
    return getDisplayWindowStatus()
  })
  ipcMain.handle('bp:open-preview-window', (_event, state?: BpRuntimeState) => {
    const window = createPreviewWindow()
    latestPreviewState = state ?? latestPreviewState ?? latestRuntimeState
    if (latestPreviewState) {
      const sendLatestState = (): void => {
        if (latestPreviewState && !window.isDestroyed()) {
          window.webContents.send('bp:state', latestPreviewState)
        }
      }

      if (window.webContents.isLoading()) {
        window.webContents.once('did-finish-load', sendLatestState)
      } else {
        sendLatestState()
      }
    }
    return getPreviewWindowStatus()
  })
}
