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

import {
  getConfigPath,
  normalizeStoredPath,
  sanitizeFileSegment,
  storedPathExists,
  storedPathToFileUrl
} from '../assets'
import { notifyProjectFilesChanged } from '../projectFileWatchers'
import type {
  BpAction,
  BpSide,
  BpTargetType,
  SavedFileResult,
  VoiceTimelineClickPoint,
  VoiceTimelineConfig,
  VoiceTimelineListItem
} from '../../shared/types'

function voiceTimelinesDir(): string {
  return getConfigPath('audio')
}

function ensureVoiceTimelinesDir(): void {
  mkdirSync(voiceTimelinesDir(), { recursive: true })
}

function normalizeVoiceTimelineFileName(name: string): string {
  const baseName = basename(name).endsWith('.json') ? basename(name).slice(0, -5) : basename(name)
  return `${sanitizeFileSegment(baseName)}.json`
}

function resolveVoiceTimelinePath(fileName: string): string {
  return isAbsolute(fileName)
    ? fileName
    : join(voiceTimelinesDir(), normalizeVoiceTimelineFileName(fileName))
}

function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function numberOrFallback(value: unknown, fallback: number): number {
  const normalized = Number(value)
  return Number.isFinite(normalized) ? normalized : fallback
}

function normalizeSide(value: unknown): BpSide | null {
  return value === 'star' || value === 'rail' ? value : null
}

function normalizeAction(value: unknown): BpAction | null {
  if (
    value === 'pick' ||
    value === 'ban' ||
    value === 'change' ||
    value === 'protect' ||
    value === 'borrow'
  ) {
    return value
  }
  return null
}

function normalizeTargetType(value: unknown): BpTargetType | null {
  if (value === 'character' || value === 'lightCone' || value === 'none') {
    return value
  }
  return null
}

function normalizeClickPoint(value: unknown, index: number): VoiceTimelineClickPoint {
  const raw =
    value && typeof value === 'object' ? (value as Partial<VoiceTimelineClickPoint>) : undefined
  const type = raw?.type === 'delay_extra_click' ? 'delay_extra_click' : 'bp_step'
  const time = Math.max(0, numberOrFallback(raw?.time, 0))
  const stepIndex =
    raw?.stepIndex === null || raw?.stepIndex === undefined
      ? null
      : Math.max(1, Math.floor(numberOrFallback(raw.stepIndex, 1)))
  const targetId =
    raw?.targetId === null || raw?.targetId === undefined
      ? null
      : Math.max(0, Math.floor(numberOrFallback(raw.targetId, 0)))
  const id = stringOrEmpty(raw?.id) || `click-${index + 1}-${Math.floor(time * 1000)}`
  const iconPathRaw = stringOrEmpty(raw?.iconPath)

  return {
    id,
    time,
    type,
    stepIndex,
    stepName: stringOrEmpty(raw?.stepName) || null,
    side: normalizeSide(raw?.side),
    action: normalizeAction(raw?.action),
    targetType: normalizeTargetType(raw?.targetType),
    targetId,
    targetName: stringOrEmpty(raw?.targetName) || null,
    iconPath: iconPathRaw ? normalizeStoredPath(iconPathRaw) : null,
    relatedDelayChangeId: stringOrEmpty(raw?.relatedDelayChangeId) || null,
    relatedDelayChangeName: stringOrEmpty(raw?.relatedDelayChangeName) || null,
    label: stringOrEmpty(raw?.label) || null
  }
}

function normalizeVoiceTimeline(
  value: Partial<VoiceTimelineConfig>,
  fallbackName: string
): VoiceTimelineConfig {
  const now = new Date().toISOString()
  const name = stringOrEmpty(value.name) || fallbackName || '未命名配音轴'
  const createdAt = stringOrEmpty(value.createdAt) || now
  const audioPath = stringOrEmpty(value.audioPath)
  const clickPoints = (Array.isArray(value.clickPoints) ? value.clickPoints : [])
    .map((point, index) => normalizeClickPoint(point, index))
    .sort((left, right) => {
      if (left.time !== right.time) {
        return left.time - right.time
      }
      if (left.type === right.type) {
        return left.id.localeCompare(right.id)
      }
      return left.type === 'delay_extra_click' ? -1 : 1
    })

  return {
    id: stringOrEmpty(value.id) || `voice-timeline-${Date.now()}`,
    name,
    bpFlowConfigFile: stringOrEmpty(value.bpFlowConfigFile),
    bpFlowConfigName: stringOrEmpty(value.bpFlowConfigName),
    bpResultFile: stringOrEmpty(value.bpResultFile),
    bpResultName: stringOrEmpty(value.bpResultName),
    audioPath: audioPath ? normalizeStoredPath(audioPath) : '',
    audioUrl: audioPath ? storedPathToFileUrl(audioPath) : null,
    audioExists: audioPath ? storedPathExists(audioPath) : false,
    duration: Math.max(0, numberOrFallback(value.duration, 0)),
    playbackRate: Math.max(0.1, numberOrFallback(value.playbackRate, 1)),
    clickPoints,
    createdAt,
    updatedAt: stringOrEmpty(value.updatedAt) || now
  }
}

function readVoiceTimelineFile(filePath: string): VoiceTimelineConfig {
  const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as Partial<VoiceTimelineConfig>
  const fallbackName = basename(filePath, '.json')
  return normalizeVoiceTimeline(parsed, fallbackName)
}

export function registerVoiceTimelineIpc(): void {
  ipcMain.handle('voice-timelines:list', (): VoiceTimelineListItem[] => {
    ensureVoiceTimelinesDir()

    if (!existsSync(voiceTimelinesDir())) {
      return []
    }

    return readdirSync(voiceTimelinesDir())
      .filter((fileName) => fileName.endsWith('.json'))
      .map((fileName) => {
        const filePath = join(voiceTimelinesDir(), fileName)
        const stat = statSync(filePath)

        try {
          const timeline = readVoiceTimelineFile(filePath)
          return {
            fileName,
            name: timeline.name,
            bpFlowConfigName: timeline.bpFlowConfigName,
            bpResultName: timeline.bpResultName,
            duration: timeline.duration,
            clickPointCount: timeline.clickPoints.length,
            updatedAt: stat.mtime.toISOString()
          }
        } catch {
          return {
            fileName,
            name: fileName.replace(/\.json$/i, ''),
            bpFlowConfigName: '',
            bpResultName: '',
            duration: 0,
            clickPointCount: 0,
            updatedAt: stat.mtime.toISOString()
          }
        }
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  })

  ipcMain.handle('voice-timelines:load', (_event, fileName: string): VoiceTimelineConfig => {
    if (!fileName) {
      throw new Error('缺少配音轴文件名')
    }

    return readVoiceTimelineFile(resolveVoiceTimelinePath(fileName))
  })

  ipcMain.handle(
    'voice-timelines:save',
    (_event, config: VoiceTimelineConfig, fileName?: string): SavedFileResult => {
      ensureVoiceTimelinesDir()
      const normalized = normalizeVoiceTimeline(config, config?.name || '未命名配音轴')
      const targetFileName = fileName
        ? normalizeVoiceTimelineFileName(fileName)
        : normalizeVoiceTimelineFileName(normalized.name)
      const filePath = join(voiceTimelinesDir(), targetFileName)
      const saved: VoiceTimelineConfig = {
        ...normalized,
        updatedAt: new Date().toISOString()
      }

      writeFileSync(filePath, `${JSON.stringify(saved, null, 2)}\n`, 'utf-8')
      notifyProjectFilesChanged(['voiceTimelines'])

      return {
        fileName: targetFileName,
        path: filePath
      }
    }
  )

  ipcMain.handle('voice-timelines:delete', (_event, fileName: string): boolean => {
    if (!fileName) {
      return false
    }

    ensureVoiceTimelinesDir()
    const filePath = join(voiceTimelinesDir(), normalizeVoiceTimelineFileName(fileName))
    if (!existsSync(filePath)) {
      return false
    }

    unlinkSync(filePath)
    notifyProjectFilesChanged(['voiceTimelines'])
    return true
  })

  ipcMain.handle(
    'voice-timelines:rename',
    (_event, fileName: string, nextName: string): SavedFileResult => {
      const trimmedName = nextName.trim()
      if (!fileName || !trimmedName) {
        throw new Error('配音轴名称不能为空')
      }

      ensureVoiceTimelinesDir()
      const oldPath = resolveVoiceTimelinePath(fileName)
      if (!existsSync(oldPath)) {
        throw new Error('要重命名的配音轴文件不存在')
      }

      const timeline = readVoiceTimelineFile(oldPath)
      const nextFileName = normalizeVoiceTimelineFileName(trimmedName)
      const nextPath = join(voiceTimelinesDir(), nextFileName)
      if (oldPath !== nextPath && existsSync(nextPath)) {
        throw new Error(`已存在同名配音轴文件：${nextFileName}`)
      }

      const renamed: VoiceTimelineConfig = {
        ...timeline,
        name: trimmedName,
        updatedAt: new Date().toISOString()
      }
      writeFileSync(nextPath, `${JSON.stringify(renamed, null, 2)}\n`, 'utf-8')

      if (oldPath !== nextPath) {
        unlinkSync(oldPath)
      }
      notifyProjectFilesChanged(['voiceTimelines'])

      return {
        fileName: nextFileName,
        path: nextPath
      }
    }
  )

  ipcMain.handle('voice-timelines:open-folder', async () => {
    ensureVoiceTimelinesDir()
    const errorMessage = await shell.openPath(voiceTimelinesDir())
    if (errorMessage) {
      throw new Error(errorMessage)
    }

    return true
  })
}
