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

import {
  getConfigPath,
  isExternalFilePath,
  prepareAssetValue,
  sanitizeFileSegment,
  storedPathToFileUrl
} from '../assets'
import { notifyProjectFilesChanged } from '../projectFileWatchers'
import { sendToAllWindows } from '../windows'
import { normalizeDisplayAudioVolumePercent } from '../../shared/displayAudioVolume'
import type {
  DisplayBackgroundLayer,
  DisplayPageChange,
  DisplaySecondaryBanCounts,
  DisplaySecondaryPickCounts,
  DisplaySettings,
  DisplaySettingsListItem,
  DisplaySlotEffectConfig,
  DisplaySlotEffects,
  DisplaySlotGroup,
  DisplaySlotGroupKey,
  DisplaySlotGroups,
  DisplaySlotLayout,
  DisplaySlotLayouts,
  DisplayVideoSlotLayout,
  SavedFileResult
} from '../../shared/types'
import { ipcMain, shell } from 'electron'

const currentStageWidth = 1920
const currentStageHeight = 1080

type MigratedSlotLayouts = {
  [Key in keyof DisplaySlotLayouts]?: Partial<DisplaySlotLayout>
}

type MigratedSlotEffects = {
  [Key in keyof DisplaySlotEffects]?: Partial<DisplaySlotEffectConfig>
}

type MigratedSlotGroups = {
  [Key in DisplaySlotGroupKey]?: Array<Partial<DisplaySlotGroup>>
}

type MigratedDisplaySettings = Omit<
  Partial<DisplaySettings>,
  'chantVideoSlot' | 'slotEffects' | 'slotGroups' | 'slotLayouts'
> & {
  chantVideoSlot?: Partial<DisplayVideoSlotLayout>
  slotEffects?: MigratedSlotEffects
  slotGroups?: MigratedSlotGroups
  slotLayouts?: MigratedSlotLayouts
}

const defaultSlotLayouts: DisplaySlotLayouts = {
  starPick: {
    x: 60,
    y: 180,
    width: 330,
    height: 138,
    gap: 15,
    layer: 10,
    direction: 'vertical',
    frameImage: '',
    frameImageUrl: null,
    effectVideo: '',
    effectVideoUrl: null
  },
  starPickSecond: {
    x: 420,
    y: 180,
    width: 330,
    height: 138,
    gap: 15,
    layer: 10,
    direction: 'vertical',
    frameImage: '',
    frameImageUrl: null,
    effectVideo: '',
    effectVideoUrl: null
  },
  starBan: {
    x: 60,
    y: 915,
    width: 180,
    height: 78,
    gap: 12,
    layer: 10,
    direction: 'horizontal',
    frameImage: '',
    frameImageUrl: null,
    effectVideo: '',
    effectVideoUrl: null
  },
  starBanSecond: {
    x: 60,
    y: 1005,
    width: 180,
    height: 78,
    gap: 12,
    layer: 10,
    direction: 'horizontal',
    frameImage: '',
    frameImageUrl: null,
    effectVideo: '',
    effectVideoUrl: null
  },
  railPick: {
    x: 1530,
    y: 180,
    width: 330,
    height: 138,
    gap: 15,
    layer: 10,
    direction: 'vertical',
    frameImage: '',
    frameImageUrl: null,
    effectVideo: '',
    effectVideoUrl: null
  },
  railPickSecond: {
    x: 1170,
    y: 180,
    width: 330,
    height: 138,
    gap: 15,
    layer: 10,
    direction: 'vertical',
    frameImage: '',
    frameImageUrl: null,
    effectVideo: '',
    effectVideoUrl: null
  },
  railBan: {
    x: 1680,
    y: 915,
    width: 180,
    height: 78,
    gap: 12,
    layer: 10,
    direction: 'horizontal',
    frameImage: '',
    frameImageUrl: null,
    effectVideo: '',
    effectVideoUrl: null
  },
  railBanSecond: {
    x: 1680,
    y: 1005,
    width: 180,
    height: 78,
    gap: 12,
    layer: 10,
    direction: 'horizontal',
    frameImage: '',
    frameImageUrl: null,
    effectVideo: '',
    effectVideoUrl: null
  }
}

const defaultSlotGroups: DisplaySlotGroups = {
  starPick: [
    { ...defaultSlotLayouts.starPick, slotCount: 0 },
    { ...defaultSlotLayouts.starPickSecond, slotCount: 0 }
  ],
  starBan: [
    { ...defaultSlotLayouts.starBan, slotCount: 0 },
    { ...defaultSlotLayouts.starBanSecond, slotCount: 0 }
  ],
  railPick: [
    { ...defaultSlotLayouts.railPick, slotCount: 0 },
    { ...defaultSlotLayouts.railPickSecond, slotCount: 0 }
  ],
  railBan: [
    { ...defaultSlotLayouts.railBan, slotCount: 0 },
    { ...defaultSlotLayouts.railBanSecond, slotCount: 0 }
  ]
}

const defaultChantVideoSlot: DisplayVideoSlotLayout = {
  x: 645,
  y: 255,
  width: 630,
  height: 390,
  visible: true,
  layer: 20
}

const defaultSlotEffectConfig: DisplaySlotEffectConfig = {
  effectMode: 'trigger',
  triggerEvent: '',
  startEvent: '',
  endEvent: '',
  pendingVideo: '',
  pendingVideoUrl: null,
  selectedVideo: '',
  selectedVideoUrl: null,
  selectedSound: '',
  selectedSoundUrl: null,
  delayActivateAfterEvents: [],
  keepLoop: false,
  pendingLayout: {
    x: 0,
    y: 0,
    scale: 1
  }
}

const defaultSlotEffects: DisplaySlotEffects = {
  pick: {
    ...defaultSlotEffectConfig,
    delayActivateAfterEvents: ['hire_end'],
    pendingLayout: { ...defaultSlotEffectConfig.pendingLayout }
  },
  ban: {
    ...defaultSlotEffectConfig,
    delayActivateAfterEvents: ['start'],
    pendingLayout: { ...defaultSlotEffectConfig.pendingLayout }
  },
  protect: {
    ...defaultSlotEffectConfig,
    effectMode: 'continuous',
    pendingLayout: { ...defaultSlotEffectConfig.pendingLayout }
  },
  borrow: {
    ...defaultSlotEffectConfig,
    effectMode: 'continuous',
    pendingLayout: { ...defaultSlotEffectConfig.pendingLayout }
  }
}

const defaultDisplaySettings: DisplaySettings = {
  stageWidth: currentStageWidth,
  stageHeight: currentStageHeight,
  triggerFlowFile: '',
  backgroundImage: '',
  backgroundX: 0,
  backgroundY: 0,
  backgroundScale: 1,
  backgroundOpacity: 1,
  backgroundImageUrl: null,
  bpSoundVolume: 100,
  characterVoiceVolume: 100,
  characterEffectVolume: 100,
  backgroundLayers: [],
  pageChanges: [],
  slotLayouts: defaultSlotLayouts,
  slotGroups: defaultSlotGroups,
  secondaryPickCounts: {
    star: 0,
    rail: 0
  },
  secondaryBanCounts: {
    star: 0,
    rail: 0
  },
  chantVideoSlot: defaultChantVideoSlot,
  slotEffects: defaultSlotEffects
}

const defaultDisplaySettingsFileName = 'display-settings.json'
let activeSettingsFileName = defaultDisplaySettingsFileName

function displaySettingsDir(): string {
  return getConfigPath('display')
}

function normalizeDisplaySettingsFileName(name: string): string {
  const baseName = basename(name).endsWith('.json') ? basename(name).slice(0, -5) : basename(name)
  return `${sanitizeFileSegment(baseName)}.json`
}

function ensureDisplaySettingsDir(): void {
  const dir = displaySettingsDir()
  mkdirSync(dir, { recursive: true })
}

function resolveSettingsPath(fileName?: string): string {
  ensureDisplaySettingsDir()

  if (fileName) {
    return isAbsolute(fileName)
      ? fileName
      : join(displaySettingsDir(), normalizeDisplaySettingsFileName(fileName))
  }

  return join(displaySettingsDir(), activeSettingsFileName)
}

function activateSettingsFile(fileName?: string): void {
  if (!fileName || isAbsolute(fileName)) {
    return
  }

  activeSettingsFileName = normalizeDisplaySettingsFileName(fileName)
}

function numberOrFallback(value: unknown, fallback: number): number {
  const normalized = Number(value)
  return Number.isFinite(normalized) ? normalized : fallback
}

function normalizeEventName(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function shouldMigrateLegacyStage(settings: {
  stageWidth?: number
  stageHeight?: number
}): boolean {
  return settings.stageWidth !== currentStageWidth || settings.stageHeight !== currentStageHeight
}

function migrateLegacyStageSettings(settings: MigratedDisplaySettings): MigratedDisplaySettings {
  if (!shouldMigrateLegacyStage(settings)) {
    return settings
  }

  return {
    ...settings,
    stageWidth: currentStageWidth,
    stageHeight: currentStageHeight
  }
}

function normalizeVideoSlotLayout(
  slot: Partial<DisplayVideoSlotLayout> | undefined
): DisplayVideoSlotLayout {
  return {
    x: numberOrFallback(slot?.x, defaultChantVideoSlot.x),
    y: numberOrFallback(slot?.y, defaultChantVideoSlot.y),
    width: Math.max(1, numberOrFallback(slot?.width, defaultChantVideoSlot.width)),
    height: Math.max(1, numberOrFallback(slot?.height, defaultChantVideoSlot.height)),
    visible: slot?.visible !== false,
    layer: numberOrFallback(slot?.layer, defaultChantVideoSlot.layer)
  }
}

function normalizeSlotEffectConfig(
  key: keyof DisplaySlotEffects,
  value: Partial<DisplaySlotEffectConfig> | undefined,
  copyExternalFile: boolean
): DisplaySlotEffectConfig {
  const defaults = defaultSlotEffects[key]
  const pendingVideo =
    copyExternalFile && isExternalFilePath(value?.pendingVideo)
      ? (prepareAssetValue(value?.pendingVideo, 'display', 'slot-effects', `${key}-pending`) ?? '')
      : (value?.pendingVideo ?? defaults.pendingVideo)
  const selectedVideo =
    copyExternalFile && isExternalFilePath(value?.selectedVideo)
      ? (prepareAssetValue(value?.selectedVideo, 'display', 'slot-effects', `${key}-selected`) ??
        '')
      : (value?.selectedVideo ?? defaults.selectedVideo)
  const selectedSound =
    copyExternalFile && isExternalFilePath(value?.selectedSound)
      ? (prepareAssetValue(value?.selectedSound, 'display', 'slot-effects', `${key}-sound`) ?? '')
      : (value?.selectedSound ?? defaults.selectedSound)
  const effectMode = key === 'protect' || key === 'borrow' ? 'continuous' : 'trigger'
  const rawDelayActivateAfterEventsValue =
    (value as { delayActivateAfterEvents?: unknown } | undefined)?.delayActivateAfterEvents ??
    defaults.delayActivateAfterEvents
  const rawDelayActivateAfterEvents = Array.isArray(rawDelayActivateAfterEventsValue)
    ? rawDelayActivateAfterEventsValue
    : typeof rawDelayActivateAfterEventsValue === 'string'
      ? rawDelayActivateAfterEventsValue.split(/[,，\s]+/)
      : []
  const delayActivateAfterEvents = rawDelayActivateAfterEvents
    .map(normalizeEventName)
    .filter((eventName): eventName is string => Boolean(eventName))

  return {
    effectMode,
    triggerEvent: normalizeEventName(value?.triggerEvent),
    startEvent: normalizeEventName(value?.startEvent),
    endEvent: normalizeEventName(value?.endEvent),
    pendingVideo,
    pendingVideoUrl: storedPathToFileUrl(pendingVideo),
    selectedVideo,
    selectedVideoUrl: storedPathToFileUrl(selectedVideo),
    selectedSound,
    selectedSoundUrl: storedPathToFileUrl(selectedSound),
    delayActivateAfterEvents,
    keepLoop: value?.keepLoop === true,
    pendingLayout: {
      x: numberOrFallback(value?.pendingLayout?.x, defaults.pendingLayout.x),
      y: numberOrFallback(value?.pendingLayout?.y, defaults.pendingLayout.y),
      scale: Math.max(
        0.01,
        numberOrFallback(value?.pendingLayout?.scale, defaults.pendingLayout.scale)
      )
    }
  }
}

function normalizeSlotEffects(
  slotEffects: Partial<DisplaySlotEffects> | undefined,
  copyExternalFile: boolean
): DisplaySlotEffects {
  return {
    pick: normalizeSlotEffectConfig('pick', slotEffects?.pick, copyExternalFile),
    ban: normalizeSlotEffectConfig('ban', slotEffects?.ban, copyExternalFile),
    protect: normalizeSlotEffectConfig('protect', slotEffects?.protect, copyExternalFile),
    borrow: normalizeSlotEffectConfig('borrow', slotEffects?.borrow, copyExternalFile)
  }
}

function normalizeSlotLayout(
  key: keyof DisplaySlotLayouts,
  value: Partial<DisplaySlotLayout> | undefined,
  copyExternalFile: boolean,
  assetOwnerKey: string = key
): DisplaySlotLayout {
  const defaults = defaultSlotLayouts[key]
  const frameImage =
    copyExternalFile && isExternalFilePath(value?.frameImage)
      ? (prepareAssetValue(value?.frameImage, 'display', assetOwnerKey, `${assetOwnerKey}-frame`) ??
        '')
      : (value?.frameImage ?? defaults.frameImage)
  const effectVideo =
    copyExternalFile && isExternalFilePath(value?.effectVideo)
      ? (prepareAssetValue(
          value?.effectVideo,
          'display',
          assetOwnerKey,
          `${assetOwnerKey}-effect`
        ) ?? '')
      : (value?.effectVideo ?? defaults.effectVideo)

  return {
    x: numberOrFallback(value?.x, defaults.x),
    y: numberOrFallback(value?.y, defaults.y),
    width: Math.max(1, numberOrFallback(value?.width, defaults.width)),
    height: Math.max(1, numberOrFallback(value?.height, defaults.height)),
    gap: Math.max(0, numberOrFallback(value?.gap, defaults.gap)),
    gaps: Array.isArray(value?.gaps)
      ? value.gaps.map((gap) => Math.max(0, numberOrFallback(gap, defaults.gap)))
      : [],
    layer: numberOrFallback(value?.layer, defaults.layer),
    direction: value?.direction === 'horizontal' ? 'horizontal' : 'vertical',
    frameImage,
    frameImageUrl: storedPathToFileUrl(frameImage),
    effectVideo,
    effectVideoUrl: storedPathToFileUrl(effectVideo)
  }
}

const maxSlotGroupCount = 8
const slotGroupLegacyLayoutKeys: Record<
  DisplaySlotGroupKey,
  [keyof DisplaySlotLayouts, keyof DisplaySlotLayouts]
> = {
  starPick: ['starPick', 'starPickSecond'],
  starBan: ['starBan', 'starBanSecond'],
  railPick: ['railPick', 'railPickSecond'],
  railBan: ['railBan', 'railBanSecond']
}

function legacySecondarySlotCount(
  key: DisplaySlotGroupKey,
  pickCounts: Partial<DisplaySecondaryPickCounts> | undefined,
  banCounts: Partial<DisplaySecondaryBanCounts> | undefined
): number {
  switch (key) {
    case 'starPick':
      return Math.max(0, Math.floor(numberOrFallback(pickCounts?.star, 0)))
    case 'railPick':
      return Math.max(0, Math.floor(numberOrFallback(pickCounts?.rail, 0)))
    case 'starBan':
      return Math.max(0, Math.floor(numberOrFallback(banCounts?.star, 0)))
    case 'railBan':
      return Math.max(0, Math.floor(numberOrFallback(banCounts?.rail, 0)))
  }
}

function normalizeSlotGroupSet(
  key: DisplaySlotGroupKey,
  values: Array<Partial<DisplaySlotGroup>> | undefined,
  legacyLayouts: Partial<DisplaySlotLayouts> | undefined,
  pickCounts: Partial<DisplaySecondaryPickCounts> | undefined,
  banCounts: Partial<DisplaySecondaryBanCounts> | undefined,
  copyExternalFile: boolean
): DisplaySlotGroup[] {
  const [firstLegacyKey, secondLegacyKey] = slotGroupLegacyLayoutKeys[key]
  const legacyGroups: Array<Partial<DisplaySlotGroup>> = [
    { ...(legacyLayouts?.[firstLegacyKey] ?? defaultSlotLayouts[firstLegacyKey]), slotCount: 0 },
    {
      ...(legacyLayouts?.[secondLegacyKey] ?? defaultSlotLayouts[secondLegacyKey]),
      slotCount: legacySecondarySlotCount(key, pickCounts, banCounts)
    }
  ]
  const source = Array.isArray(values) && values.length > 0 ? values : legacyGroups

  return source.slice(0, maxSlotGroupCount).map((value, index) => {
    const fallbackGroup = defaultSlotGroups[key][Math.min(index, defaultSlotGroups[key].length - 1)]
    const layoutKey = index === 0 ? firstLegacyKey : secondLegacyKey
    const layout = normalizeSlotLayout(
      layoutKey,
      { ...fallbackGroup, ...value },
      copyExternalFile,
      `${key}-group-${index + 1}`
    )

    return {
      ...layout,
      slotCount: Math.max(0, Math.floor(numberOrFallback(value.slotCount, 0)))
    }
  })
}

function normalizeSlotGroups(
  slotGroups: MigratedSlotGroups | undefined,
  legacyLayouts: Partial<DisplaySlotLayouts> | undefined,
  pickCounts: Partial<DisplaySecondaryPickCounts> | undefined,
  banCounts: Partial<DisplaySecondaryBanCounts> | undefined,
  copyExternalFile: boolean
): DisplaySlotGroups {
  return {
    starPick: normalizeSlotGroupSet(
      'starPick',
      slotGroups?.starPick,
      legacyLayouts,
      pickCounts,
      banCounts,
      copyExternalFile
    ),
    starBan: normalizeSlotGroupSet(
      'starBan',
      slotGroups?.starBan,
      legacyLayouts,
      pickCounts,
      banCounts,
      copyExternalFile
    ),
    railPick: normalizeSlotGroupSet(
      'railPick',
      slotGroups?.railPick,
      legacyLayouts,
      pickCounts,
      banCounts,
      copyExternalFile
    ),
    railBan: normalizeSlotGroupSet(
      'railBan',
      slotGroups?.railBan,
      legacyLayouts,
      pickCounts,
      banCounts,
      copyExternalFile
    )
  }
}

function groupLayoutOrFallback(
  groups: DisplaySlotGroups,
  key: DisplaySlotGroupKey,
  index: number,
  fallbackKey: keyof DisplaySlotLayouts
): DisplaySlotLayout {
  const source = groups[key][index] ?? defaultSlotLayouts[fallbackKey]
  const layout: DisplaySlotLayout & { slotCount?: number } = { ...source }
  delete layout.slotCount
  return layout
}

function legacySlotLayoutsFromGroups(groups: DisplaySlotGroups): DisplaySlotLayouts {
  return {
    starPick: groupLayoutOrFallback(groups, 'starPick', 0, 'starPick'),
    starPickSecond: groupLayoutOrFallback(groups, 'starPick', 1, 'starPickSecond'),
    starBan: groupLayoutOrFallback(groups, 'starBan', 0, 'starBan'),
    starBanSecond: groupLayoutOrFallback(groups, 'starBan', 1, 'starBanSecond'),
    railPick: groupLayoutOrFallback(groups, 'railPick', 0, 'railPick'),
    railPickSecond: groupLayoutOrFallback(groups, 'railPick', 1, 'railPickSecond'),
    railBan: groupLayoutOrFallback(groups, 'railBan', 0, 'railBan'),
    railBanSecond: groupLayoutOrFallback(groups, 'railBan', 1, 'railBanSecond')
  }
}

function normalizeBackgroundLayer(
  layer: Partial<DisplayBackgroundLayer>,
  index: number,
  fallbackLayer: number,
  copyExternalFile: boolean
): DisplayBackgroundLayer {
  const image =
    copyExternalFile && isExternalFilePath(layer.image)
      ? (prepareAssetValue(layer.image, 'display', 'background', `background-${index + 1}`) ?? '')
      : (layer.image ?? '')

  return {
    id: layer.id || `background-${index + 1}`,
    name: layer.name || `背景 ${index + 1}`,
    image,
    imageUrl: storedPathToFileUrl(image),
    x: numberOrFallback(layer.x, 0),
    y: numberOrFallback(layer.y, 0),
    scale: numberOrFallback(layer.scale, 1) || 1,
    opacity: Math.max(0, Math.min(1, numberOrFallback(layer.opacity, 1))),
    visible: layer.visible !== false,
    layer: numberOrFallback(layer.layer, fallbackLayer)
  }
}

function normalizePageChange(
  pageChange: Partial<DisplayPageChange>,
  index: number
): DisplayPageChange {
  const target =
    pageChange.target === 'chantVideoSlot' || pageChange.mode === 'resizeVideo'
      ? 'chantVideoSlot'
      : 'backgroundLayer'
  const mode = pageChange.mode
  const direction = pageChange.direction
  const backgroundMode =
    mode === 'disappear' ||
    mode === 'flyIn' ||
    mode === 'flyOut' ||
    mode === 'expand' ||
    mode === 'collapse'
      ? mode
      : 'appear'

  const name = pageChange.name || `页面变化 ${index + 1}`
  const triggerEvent =
    normalizeEventName(pageChange.triggerEvent) ||
    normalizeEventName(pageChange.triggerName) ||
    name
  const emitEvent =
    normalizeEventName(pageChange.emitEvent) ||
    normalizeEventName(pageChange.emitEventAfterComplete)

  return {
    id: pageChange.id || `page-change-${Date.now()}-${index}`,
    index: Math.max(1, Math.floor(numberOrFallback(pageChange.index, index + 1))),
    name,
    triggerEvent,
    emitEvent,
    triggerName: triggerEvent,
    delayTriggerEnabled: pageChange.delayTriggerEnabled === true,
    delayClickCount: Math.max(1, Math.floor(numberOrFallback(pageChange.delayClickCount, 1))),
    target,
    layerId: pageChange.layerId || '',
    mode: target === 'chantVideoSlot' ? 'resizeVideo' : backgroundMode,
    startX: numberOrFallback(pageChange.startX, 0),
    startY: numberOrFallback(pageChange.startY, 0),
    speed: Math.max(1, numberOrFallback(pageChange.speed, 800)),
    direction:
      direction === 'right' ||
      direction === 'top' ||
      direction === 'bottom' ||
      direction === 'custom'
        ? direction
        : 'left',
    videoX: numberOrFallback(pageChange.videoX, defaultChantVideoSlot.x),
    videoY: numberOrFallback(pageChange.videoY, defaultChantVideoSlot.y),
    videoWidth: Math.max(1, numberOrFallback(pageChange.videoWidth, defaultChantVideoSlot.width)),
    videoHeight: Math.max(1, numberOrFallback(pageChange.videoHeight, defaultChantVideoSlot.height))
  }
}

function normalizePageChanges(
  pageChanges: Partial<DisplayPageChange>[] | undefined
): DisplayPageChange[] {
  return Array.isArray(pageChanges)
    ? pageChanges
        .map((pageChange, index) => normalizePageChange(pageChange, index))
        .sort((a, b) => a.index - b.index)
    : []
}

function normalizeBackgroundLayers(
  settings: DisplaySettings,
  backgroundImage: string,
  copyExternalFile: boolean
): DisplayBackgroundLayer[] {
  const rawLayers =
    Array.isArray(settings.backgroundLayers) && settings.backgroundLayers.length > 0
      ? settings.backgroundLayers
      : backgroundImage
        ? [
            {
              id: 'background-1',
              image: backgroundImage,
              x: settings.backgroundX,
              y: settings.backgroundY,
              scale: settings.backgroundScale,
              opacity: settings.backgroundOpacity,
              visible: true,
              layer: 1
            }
          ]
        : []

  return rawLayers.map((layer, index) =>
    normalizeBackgroundLayer(layer, index, rawLayers.length - index, copyExternalFile)
  )
}

function withDisplayAsset(settings: DisplaySettings, copyExternalFile: boolean): DisplaySettings {
  const hasBackgroundLayers =
    Array.isArray(settings.backgroundLayers) && settings.backgroundLayers.length > 0
  const backgroundImage =
    !hasBackgroundLayers && copyExternalFile && isExternalFilePath(settings.backgroundImage)
      ? (prepareAssetValue(settings.backgroundImage, 'display', 'background', 'background') ?? '')
      : settings.backgroundImage
  const backgroundLayers = normalizeBackgroundLayers(settings, backgroundImage, copyExternalFile)
  const firstLayer = backgroundLayers[0]
  const slotGroups = normalizeSlotGroups(
    settings.slotGroups,
    settings.slotLayouts,
    settings.secondaryPickCounts,
    settings.secondaryBanCounts,
    copyExternalFile
  )

  return {
    stageWidth: currentStageWidth,
    stageHeight: currentStageHeight,
    triggerFlowFile: typeof settings.triggerFlowFile === 'string' ? settings.triggerFlowFile : '',
    backgroundImage: firstLayer?.image ?? backgroundImage,
    backgroundX: firstLayer?.x ?? numberOrFallback(settings.backgroundX, 0),
    backgroundY: firstLayer?.y ?? numberOrFallback(settings.backgroundY, 0),
    backgroundScale: firstLayer?.scale ?? numberOrFallback(settings.backgroundScale, 1),
    backgroundOpacity:
      firstLayer?.opacity ?? Math.max(0, Math.min(1, Number(settings.backgroundOpacity) || 0)),
    backgroundImageUrl: firstLayer?.imageUrl ?? storedPathToFileUrl(backgroundImage),
    bpSoundVolume: normalizeDisplayAudioVolumePercent(settings.bpSoundVolume),
    characterVoiceVolume: normalizeDisplayAudioVolumePercent(settings.characterVoiceVolume),
    characterEffectVolume: normalizeDisplayAudioVolumePercent(settings.characterEffectVolume),
    backgroundLayers,
    pageChanges: normalizePageChanges(settings.pageChanges),
    slotLayouts: legacySlotLayoutsFromGroups(slotGroups),
    slotGroups,
    secondaryPickCounts: {
      star: slotGroups.starPick[1]?.slotCount ?? 0,
      rail: slotGroups.railPick[1]?.slotCount ?? 0
    },
    secondaryBanCounts: {
      star: slotGroups.starBan[1]?.slotCount ?? 0,
      rail: slotGroups.railBan[1]?.slotCount ?? 0
    },
    chantVideoSlot: normalizeVideoSlotLayout(settings.chantVideoSlot),
    slotEffects: normalizeSlotEffects(settings.slotEffects, copyExternalFile)
  }
}

function readSettings(fileName?: string): DisplaySettings {
  activateSettingsFile(fileName)
  const filePath = resolveSettingsPath(fileName)

  if (!existsSync(filePath)) {
    return defaultDisplaySettings
  }

  const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as MigratedDisplaySettings
  const migrated = migrateLegacyStageSettings(parsed)
  const merged = { ...defaultDisplaySettings, ...migrated } as DisplaySettings
  if (!migrated.slotGroups) {
    delete merged.slotGroups
  }
  return withDisplayAsset(merged, false)
}

function writeSettings(settings: DisplaySettings, fileName?: string): DisplaySettings {
  activateSettingsFile(fileName)
  const filePath = resolveSettingsPath(fileName)
  const normalized = withDisplayAsset(settings, true)
  const storedSettings = {
    stageWidth: normalized.stageWidth,
    stageHeight: normalized.stageHeight,
    triggerFlowFile: normalized.triggerFlowFile,
    backgroundImage: normalized.backgroundImage,
    backgroundX: normalized.backgroundX,
    backgroundY: normalized.backgroundY,
    backgroundScale: normalized.backgroundScale,
    backgroundOpacity: normalized.backgroundOpacity,
    bpSoundVolume: normalized.bpSoundVolume,
    characterVoiceVolume: normalized.characterVoiceVolume,
    characterEffectVolume: normalized.characterEffectVolume,
    backgroundLayers: normalized.backgroundLayers.map(stripBackgroundLayerUrls),
    pageChanges: normalized.pageChanges.map(stripPageChangeForSave),
    slotLayouts: {
      starPick: stripSlotLayoutUrls(normalized.slotLayouts.starPick),
      starPickSecond: stripSlotLayoutUrls(normalized.slotLayouts.starPickSecond),
      starBan: stripSlotLayoutUrls(normalized.slotLayouts.starBan),
      starBanSecond: stripSlotLayoutUrls(normalized.slotLayouts.starBanSecond),
      railPick: stripSlotLayoutUrls(normalized.slotLayouts.railPick),
      railPickSecond: stripSlotLayoutUrls(normalized.slotLayouts.railPickSecond),
      railBan: stripSlotLayoutUrls(normalized.slotLayouts.railBan),
      railBanSecond: stripSlotLayoutUrls(normalized.slotLayouts.railBanSecond)
    },
    slotGroups: {
      starPick: (normalized.slotGroups ?? defaultSlotGroups).starPick.map(stripSlotGroupUrls),
      starBan: (normalized.slotGroups ?? defaultSlotGroups).starBan.map(stripSlotGroupUrls),
      railPick: (normalized.slotGroups ?? defaultSlotGroups).railPick.map(stripSlotGroupUrls),
      railBan: (normalized.slotGroups ?? defaultSlotGroups).railBan.map(stripSlotGroupUrls)
    },
    secondaryPickCounts: normalized.secondaryPickCounts,
    secondaryBanCounts: normalized.secondaryBanCounts,
    chantVideoSlot: normalized.chantVideoSlot,
    slotEffects: {
      pick: stripSlotEffectUrls(normalized.slotEffects.pick),
      ban: stripSlotEffectUrls(normalized.slotEffects.ban),
      protect: stripSlotEffectUrls(normalized.slotEffects.protect),
      borrow: stripSlotEffectUrls(normalized.slotEffects.borrow)
    }
  }

  writeFileSync(filePath, `${JSON.stringify(storedSettings, null, 2)}\n`, 'utf-8')
  return normalized
}

function listSettings(): DisplaySettingsListItem[] {
  ensureDisplaySettingsDir()

  return readdirSync(displaySettingsDir())
    .filter((fileName) => fileName.endsWith('.json'))
    .map((fileName) => {
      const filePath = join(displaySettingsDir(), fileName)
      const stat = statSync(filePath)

      return {
        fileName,
        name: fileName.replace(/\.json$/i, ''),
        updatedAt: stat.mtime.toISOString()
      }
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

function deleteSettings(fileName: string): boolean {
  if (!fileName) {
    return false
  }

  ensureDisplaySettingsDir()
  const normalizedFileName = normalizeDisplaySettingsFileName(fileName)
  const filePath = join(displaySettingsDir(), normalizedFileName)
  if (!existsSync(filePath)) {
    return false
  }

  unlinkSync(filePath)
  if (activeSettingsFileName === normalizedFileName) {
    activeSettingsFileName = defaultDisplaySettingsFileName
  }

  notifyProjectFilesChanged(['displaySettings'])
  return true
}

function renameSettings(fileName: string, nextName: string): SavedFileResult {
  const name = nextName.trim()
  if (!fileName || !name) {
    throw new Error('展示页配置名称不能为空')
  }

  ensureDisplaySettingsDir()
  const oldFileName = normalizeDisplaySettingsFileName(fileName)
  const nextFileName = normalizeDisplaySettingsFileName(name)
  const oldPath = join(displaySettingsDir(), oldFileName)
  const nextPath = join(displaySettingsDir(), nextFileName)

  if (!existsSync(oldPath)) {
    throw new Error('要重命名的展示页配置文件不存在')
  }

  if (oldPath !== nextPath && existsSync(nextPath)) {
    throw new Error(`已存在同名展示页配置：${nextFileName}`)
  }

  if (oldPath !== nextPath) {
    renameSync(oldPath, nextPath)
  }

  if (activeSettingsFileName === oldFileName) {
    activeSettingsFileName = nextFileName
  }

  notifyProjectFilesChanged(['displaySettings'])
  return {
    fileName: nextFileName,
    path: nextPath
  }
}

function stripBackgroundLayerUrls(
  layer: DisplayBackgroundLayer
): Omit<DisplayBackgroundLayer, 'imageUrl'> {
  return {
    id: layer.id,
    name: layer.name,
    image: layer.image,
    x: layer.x,
    y: layer.y,
    scale: layer.scale,
    opacity: layer.opacity,
    visible: layer.visible,
    layer: layer.layer
  }
}

function broadcastSettings(settings: DisplaySettings): void {
  sendToAllWindows('display-settings:updated', settings)
}

export function applyLiveDisplaySettings(settings: DisplaySettings): DisplaySettings {
  const liveSettings = withDisplayAsset(settings, false)
  broadcastSettings(liveSettings)
  return liveSettings
}

function stripSlotLayoutUrls(
  layout: DisplaySlotLayout
): Omit<DisplaySlotLayout, 'frameImageUrl' | 'effectVideoUrl'> {
  return {
    x: layout.x,
    y: layout.y,
    width: layout.width,
    height: layout.height,
    gap: layout.gap,
    gaps: Array.isArray(layout.gaps) ? layout.gaps : [],
    layer: layout.layer,
    direction: layout.direction,
    frameImage: layout.frameImage,
    effectVideo: layout.effectVideo
  }
}

function stripSlotGroupUrls(
  group: DisplaySlotGroup
): Omit<DisplaySlotGroup, 'frameImageUrl' | 'effectVideoUrl'> {
  return {
    ...stripSlotLayoutUrls(group),
    slotCount: group.slotCount
  }
}

function stripPageChangeForSave(
  pageChange: DisplayPageChange
): Omit<DisplayPageChange, 'emitEventAfterComplete'> {
  const storedPageChange = { ...pageChange }
  delete storedPageChange.emitEventAfterComplete
  return storedPageChange
}

function stripSlotEffectUrls(
  effect: DisplaySlotEffectConfig
): Omit<DisplaySlotEffectConfig, 'pendingVideoUrl' | 'selectedVideoUrl' | 'selectedSoundUrl'> {
  return {
    effectMode: effect.effectMode,
    triggerEvent: effect.triggerEvent,
    startEvent: effect.startEvent,
    endEvent: effect.endEvent,
    pendingVideo: effect.pendingVideo,
    selectedVideo: effect.selectedVideo,
    selectedSound: effect.selectedSound,
    delayActivateAfterEvents: effect.delayActivateAfterEvents ?? [],
    keepLoop: effect.keepLoop === true,
    pendingLayout: effect.pendingLayout
  }
}

export function registerDisplaySettingsIpc(): void {
  ipcMain.handle('display-settings:list', () => listSettings())
  ipcMain.handle('display-settings:get', (_event, fileName?: string) => readSettings(fileName))
  ipcMain.handle(
    'display-settings:save',
    (_event, settings: DisplaySettings, fileName?: string) => {
      const savedSettings = writeSettings(settings, fileName)
      broadcastSettings(savedSettings)
      notifyProjectFilesChanged(['displaySettings'])
      return savedSettings
    }
  )
  ipcMain.handle('display-settings:delete', (_event, fileName: string) => deleteSettings(fileName))
  ipcMain.handle('display-settings:rename', (_event, fileName: string, nextName: string) =>
    renameSettings(fileName, nextName)
  )
  ipcMain.handle('display-settings:update-live', (_event, settings: DisplaySettings) => {
    return applyLiveDisplaySettings(settings)
  })
  ipcMain.handle('display-settings:open-folder', async () => {
    ensureDisplaySettingsDir()
    const errorMessage = await shell.openPath(displaySettingsDir())
    if (errorMessage) {
      throw new Error(errorMessage)
    }

    return true
  })
}
