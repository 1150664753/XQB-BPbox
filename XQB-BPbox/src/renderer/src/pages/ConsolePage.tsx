import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'

import type {
  BpAction,
  BpActionRecord,
  BpResult,
  BpResultListItem,
  BpPlaybackMode,
  BpRuntimeState,
  BpSide,
  BpSlotCounts,
  BpTeamTarget,
  DisplayBackgroundLayer,
  DisplayPageChange,
  DisplaySettings,
  DisplaySettingsListItem,
  DisplaySlotEffectConfig,
  DisplaySlotEffects,
  DisplaySlotEffectLayout,
  DisplaySlotLayout,
  DisplaySlotLayouts,
  DisplayVideoSlotLayout,
  FlowConfig,
  FlowListItem,
  FlowStep,
  ProjectFileChangeArea,
  ProjectFileChangeEvent,
  VoiceTimelineConfig,
  VoiceTimelineListItem
} from '../types/bp'
import type {
  Character,
  CharacterAssetField,
  CharacterPayload,
  CharacterResourceStatus,
  CharacterResourceTableAssetField,
  CharacterResourceTableLoadResult,
  CharacterResourceTableRow,
  CharacterRarity
} from '../types/character'
import type { LightCone, LightConePayload, LightConeRarity } from '../types/lightCone'
import DisplayCanvas from '../components/display/DisplayCanvas'
import UpdateStatusBar from '../components/UpdateStatusBar'
import VoiceTimelinePanel from './VoiceTimelinePanel'
import {
  normalizeDisplayAudioVolumePercent,
  type DisplayAudioVolumeField
} from '../../../shared/displayAudioVolume'
import {
  DEFAULT_PV_END_TIME,
  DEFAULT_PV_START_TIME,
  normalizePvEndTime,
  normalizePvStartTime
} from '../../../shared/pvPlayback'

type ConsoleView =
  | 'characters'
  | 'lightCones'
  | 'flows'
  | 'displaySettings'
  | 'bp'
  | 'voiceTimeline'
type DisplaySettingsSection = 'base' | 'changes' | 'effects'
type MessageType = 'info' | 'success' | 'error'
type SlotLayoutKey = keyof DisplaySlotLayouts
type SlotLayoutNumberKey = 'x' | 'y' | 'width' | 'height' | 'gap' | 'layer'
type SlotEffectKey = keyof DisplaySlotEffects
type SlotEffectVideoField = 'pendingVideo' | 'selectedVideo'
type SlotEffectLayoutNumberKey = keyof DisplaySlotEffectLayout
type VideoSlotNumberKey = 'x' | 'y' | 'width' | 'height' | 'layer'
type PageChangeNumberKey = 'startX' | 'startY' | 'speed'
type VideoChangeNumberKey = 'videoX' | 'videoY' | 'videoWidth' | 'videoHeight' | 'speed'
type SecondaryPickCountKey = 'star' | 'rail'
type SecondaryBanCountKey = 'star' | 'rail'

function fileChangeIncludes(
  event: ProjectFileChangeEvent,
  ...areas: ProjectFileChangeArea[]
): boolean {
  return areas.some((area) => event.areas.includes(area))
}

const displayStageWidth = 1920
const displayStageHeight = 1080
const roleIcon = new URL('../../../../assets/icons/icon-role.png', import.meta.url).href
const lightConeIcon = new URL('../../../../assets/icons/icon-lightcone.png', import.meta.url).href
const flowIcon = new URL('../../../../assets/icons/icon-flow.png', import.meta.url).href
const uiIcon = new URL('../../../../assets/icons/icon-ui.png', import.meta.url).href
const bpIcon = new URL('../../../../assets/icons/icon-bp.png', import.meta.url).href
const voiceTimelineIcon = new URL('../../../../assets/icons/icon-timeline.png', import.meta.url)
  .href

const navItems: Array<{ key: ConsoleView; label: string; icon: string }> = [
  { key: 'characters', label: '角色管理', icon: roleIcon },
  { key: 'lightCones', label: '光锥管理', icon: lightConeIcon },
  { key: 'flows', label: 'BP流程配置', icon: flowIcon },
  { key: 'displaySettings', label: '展示页设置', icon: uiIcon },
  { key: 'bp', label: '开始BP', icon: bpIcon },
  { key: 'voiceTimeline', label: '配音轴', icon: voiceTimelineIcon }
]

const displaySettingsSidebarItems: Array<{ key: DisplaySettingsSection; label: string }> = [
  { key: 'base', label: '基础设置' },
  { key: 'changes', label: '变化设置' },
  { key: 'effects', label: '特效设置' }
]

const defaultDisplaySettingsFileName = 'display-settings.json'

const elements = ['物理', '火', '冰', '雷', '风', '量子', '虚数']
const paths = ['毁灭', '巡猎', '智识', '同谐', '虚无', '存护', '丰饶', '记忆', '欢愉']

const defaultFlow: FlowConfig = {
  name: '默认BP流程',
  steps: [
    { index: 1, side: 'star', action: 'ban', targetType: 'character' },
    { index: 2, side: 'rail', action: 'ban', targetType: 'character' },
    { index: 3, side: 'star', action: 'pick', targetType: 'character' },
    { index: 4, side: 'rail', action: 'pick', targetType: 'character' }
  ]
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

const slotLayoutLabels: Array<{ key: SlotLayoutKey; label: string }> = [
  { key: 'starPick', label: '左侧 Pick 槽1' },
  { key: 'starPickSecond', label: '左侧 Pick 槽2' },
  { key: 'starBan', label: '左侧 Ban 槽' },
  { key: 'starBanSecond', label: '左侧 Ban 槽2' },
  { key: 'railPick', label: '右侧 Pick 槽1' },
  { key: 'railPickSecond', label: '右侧 Pick 槽2' },
  { key: 'railBan', label: '右侧 Ban 槽' },
  { key: 'railBanSecond', label: '右侧 Ban 槽 2' }
]

function uniqueTextValues(values: Array<string | null | undefined>): string[] {
  return [
    ...new Set(
      values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))
    )
  ]
}

function normalizeEventName(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function legacyStepEventName(
  step: Pick<FlowStep, 'pageChangeName' | 'pageChangeIndex'>
): string | null {
  return (
    normalizeEventName(step.pageChangeName) ??
    (step.pageChangeIndex ? String(step.pageChangeIndex) : null)
  )
}

function pageChangeEmitEventName(pageChange: DisplayPageChange): string | null {
  return (
    normalizeEventName(pageChange.emitEvent) ??
    normalizeEventName(pageChange.emitEventAfterComplete)
  )
}

function collectAvailableEvents(flow: FlowConfig, settings: DisplaySettings): string[] {
  return uniqueTextValues([
    'start',
    'end',
    ...flow.steps.map((step) => step.eventName || legacyStepEventName(step)),
    ...settings.pageChanges.flatMap((pageChange) => [
      pageChangeEmitEventName(pageChange),
      pageChange.triggerEvent,
      pageChange.triggerName
    ]),
    ...Object.values(settings.slotEffects ?? defaultSlotEffects).flatMap(
      (effect) => effect.delayActivateAfterEvents ?? []
    )
  ])
}

function formatListTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }

  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
}

function uniqueListName(baseName: string, names: string[]): string {
  const usedNames = new Set(names)
  if (!usedNames.has(baseName)) {
    return baseName
  }

  let index = 2
  while (usedNames.has(`${baseName}${index}`)) {
    index += 1
  }

  return `${baseName}${index}`
}

function normalizeRenameName(nextName: string, currentName: string): string | null {
  const normalizedName = nextName.trim()
  if (!normalizedName || normalizedName === currentName.trim()) {
    return null
  }

  return normalizedName
}

function normalizeBpAction(action: unknown): BpAction {
  if (
    action === 'pick' ||
    action === 'ban' ||
    action === 'change' ||
    action === 'protect' ||
    action === 'borrow'
  ) {
    return action
  }

  return 'ban'
}

function isPairedAction(action: BpAction): action is 'protect' | 'borrow' {
  return action === 'protect' || action === 'borrow'
}

function isRosterAction(action: BpAction): boolean {
  return action === 'pick' || action === 'ban'
}

function oppositeSide(side: BpSide): BpSide {
  return side === 'star' ? 'rail' : 'star'
}

function normalizeFlowSteps(steps: FlowStep[]): FlowStep[] {
  return steps.reduce<FlowStep[]>((normalizedSteps, step) => {
    const action = normalizeBpAction(step.action)
    if (action === 'change') {
      return normalizedSteps
    }

    const pageChangeName =
      typeof step.pageChangeName === 'string' && step.pageChangeName.trim()
        ? step.pageChangeName.trim()
        : null
    const pageChangeIndex =
      step.pageChangeIndex === null ||
      step.pageChangeIndex === undefined ||
      !Number.isFinite(Number(step.pageChangeIndex))
        ? null
        : Math.max(1, Math.floor(Number(step.pageChangeIndex)))

    normalizedSteps.push({
      index: normalizedSteps.length + 1,
      side: step.side === 'rail' ? 'rail' : 'star',
      action,
      targetType: isPairedAction(action)
        ? 'character'
        : step.targetType === 'lightCone'
          ? 'lightCone'
          : 'character',
      eventName:
        normalizeEventName(step.eventName) ??
        pageChangeName ??
        (pageChangeIndex ? String(pageChangeIndex) : null),
      pageChangeName,
      pageChangeIndex
    })

    return normalizedSteps
  }, [])
}

function normalizeFlowConfig(flow: FlowConfig): FlowConfig {
  return {
    name: flow.name.trim() || '未命名BP流程',
    steps: normalizeFlowSteps(Array.isArray(flow.steps) ? flow.steps : [])
  }
}

function countFlowSlots(flow: FlowConfig): BpSlotCounts {
  return normalizeFlowSteps(flow.steps).reduce<BpSlotCounts>(
    (counts, step) => {
      const sideCounts = counts[step.side]
      if (step.action === 'pick') {
        sideCounts.picks += 1
      } else if (step.action === 'ban') {
        sideCounts.bans += 1
      }

      return counts
    },
    {
      star: { picks: 0, bans: 0 },
      rail: { picks: 0, bans: 0 }
    }
  )
}

const emptyDisplaySettings: DisplaySettings = {
  stageWidth: displayStageWidth,
  stageHeight: displayStageHeight,
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

function emptyCharacterForm(): CharacterPayload {
  return {
    code: '',
    english_name: '',
    chinese_name: '',
    rarity: 5,
    element: '',
    path: '',
    left_head_image: '',
    right_head_image: '',
    chant_video: '',
    pv: '',
    pv_start_time: DEFAULT_PV_START_TIME,
    pv_end_time: DEFAULT_PV_END_TIME,
    avatar_small_image: '',
    full_body_image: '',
    ban_voice: '',
    pick_voice: '',
    pick_sound: ''
  }
}

function characterToFormPayload(character: Character): CharacterPayload {
  return {
    code: character.code,
    english_name: character.english_name,
    chinese_name: character.chinese_name,
    rarity: character.rarity,
    element: character.element,
    path: character.path,
    left_head_image: character.left_head_image,
    right_head_image: character.right_head_image,
    chant_video: character.chant_video,
    pv: character.pv,
    pv_start_time: character.pv_start_time,
    pv_end_time: character.pv_end_time,
    avatar_small_image: character.avatar_small_image,
    full_body_image: character.full_body_image,
    ban_voice: character.ban_voice,
    pick_voice: character.pick_voice,
    pick_sound: character.pick_sound
  }
}

function emptyLightConeForm(): LightConePayload {
  return {
    name: '',
    path: '',
    rarity: 5,
    small_image: '',
    large_image: ''
  }
}

function createRuntime(flow: FlowConfig): BpRuntimeState {
  const normalizedFlow = normalizeFlowConfig(flow)

  return {
    flowName: normalizedFlow.name,
    createdAt: new Date().toISOString(),
    stepCursor: 0,
    status: normalizedFlow.steps.length > 0 ? 'running' : 'complete',
    currentStep: normalizedFlow.steps[0] ?? null,
    followingStep: normalizedFlow.steps[1] ?? null,
    slotCounts: countFlowSlots(normalizedFlow),
    starTeam: {
      name: '左侧队',
      picks: [],
      bans: []
    },
    railTeam: {
      name: '右侧队',
      picks: [],
      bans: []
    },
    upCharacterPvPath: null,
    upCharacterPvUrl: null,
    upCharacterPvStartTime: DEFAULT_PV_START_TIME,
    upCharacterPvEndTime: DEFAULT_PV_END_TIME,
    actions: [],
    playbackMode: 'manual',
    eventHistory: [],
    currentEvents: [],
    executedPageChangeIds: [],
    currentPageChangeIds: []
  }
}

function fileName(value: string | null | undefined): string {
  if (!value) {
    return '未选择'
  }

  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? value
}

function cleanOptionalPath(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function stepLabel(step: FlowStep | null): string {
  if (!step) {
    return 'BP 已完成或未开始'
  }

  if (step.action === 'protect') {
    return `第 ${step.index} 步：双方保护已 Pick 角色`
  }

  if (step.action === 'borrow') {
    return `第 ${step.index} 步：双方租借对方已 Pick 角色`
  }

  const side = step.side === 'star' ? '左侧队' : '右侧队'
  const action = step.action === 'pick' ? 'Pick' : 'Ban'
  const target = step.targetType === 'character' ? '角色' : '光锥'
  return `第 ${step.index} 步：${side} ${action} ${target}`
}

function characterImage(character: Character, side: 'star' | 'rail' = 'star'): string | null {
  return side === 'star'
    ? character.left_head_image_url || character.avatar_small_image_url || null
    : character.right_head_image_url || character.avatar_small_image_url || null
}

function bpCharacterImage(character: Character): string | null {
  return character.full_body_image_url || character.avatar_small_image_url || null
}

function lightConeImage(lightCone: LightCone): string | null {
  return lightCone.large_image_url || lightCone.small_image_url || null
}

function isLightConeTarget(target: BpTeamTarget): target is LightCone {
  return 'name' in target
}

function bpPickSlotImage(target: BpTeamTarget, side: BpSide): string | null {
  return isLightConeTarget(target)
    ? target.small_image_url || lightConeImage(target)
    : characterImage(target, side)
}

function bpBanSlotImage(target: BpTeamTarget): string | null {
  return isLightConeTarget(target)
    ? target.small_image_url || lightConeImage(target)
    : target.avatar_small_image_url || characterImage(target, 'star')
}

function bpTargetName(target: BpTeamTarget): string {
  return isLightConeTarget(target) ? target.name : target.chinese_name
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildLightConeCopyName(lightCone: LightCone, existingLightCones: LightCone[]): string {
  const currentName = lightCone.name.trim()
  const trailingNumberMatch = currentName.match(/^(.*?)(\d+)$/)
  const baseName =
    trailingNumberMatch &&
    trailingNumberMatch[1] &&
    existingLightCones.some((item) => item.name === trailingNumberMatch[1])
      ? trailingNumberMatch[1]
      : currentName
  const copyPattern = new RegExp(`^${escapeRegExp(baseName)}(\\d+)$`)
  const copyIndex = existingLightCones.reduce((maxIndex, item) => {
    const match = item.name.match(copyPattern)
    return match ? Math.max(maxIndex, Number(match[1])) : maxIndex
  }, 0)

  return `${baseName}${copyIndex + 1}`
}

function buildCharacterCopyName(character: Character, existingCharacters: Character[]): string {
  const currentName = character.chinese_name.trim()
  const trailingNumberMatch = currentName.match(/^(.*?)(\d+)$/)
  const baseName =
    trailingNumberMatch &&
    trailingNumberMatch[1] &&
    existingCharacters.some((item) => item.chinese_name === trailingNumberMatch[1])
      ? trailingNumberMatch[1]
      : currentName
  const copyPattern = new RegExp(`^${escapeRegExp(baseName)}(\\d+)$`)
  const copyIndex = existingCharacters.reduce((maxIndex, item) => {
    const match = item.chinese_name.match(copyPattern)
    return match ? Math.max(maxIndex, Number(match[1])) : maxIndex
  }, 0)

  return `${baseName}${copyIndex + 1}`
}

type CharacterNumberImportRow = CharacterResourceTableRow

interface CharacterNumberImportSummary {
  created: number
  updated: number
  skipped: number
  missingResources: number
}

const characterNumberImportResourceKeys: readonly CharacterAssetField[] = [
  'ban_voice',
  'pick_voice',
  'full_body_image',
  'avatar_small_image',
  'right_head_image',
  'left_head_image',
  'pick_sound',
  'chant_video',
  'pv'
] as const

const characterNumberResourceStatusFields: Array<{
  key: CharacterResourceTableAssetField
  label: string
}> = [
  { key: 'full_body_image', label: '大图' },
  { key: 'avatar_small_image', label: '小图' },
  { key: 'left_head_image', label: '左图' },
  { key: 'right_head_image', label: '右图' },
  { key: 'chant_video', label: '唱名' },
  { key: 'pv', label: 'PV' },
  { key: 'ban_voice', label: 'Ban' },
  { key: 'pick_voice', label: 'Pick' },
  { key: 'pick_sound', label: '音效' }
]

const resourceStatusLabels: Record<CharacterResourceStatus, string> = {
  found: '已找到',
  missing: '缺失',
  notConfigured: '未配置'
}

function createCharacterNumberImportRow(
  patch: Partial<CharacterNumberImportRow> = {}
): CharacterNumberImportRow {
  const timestamp = new Date().toISOString()
  return {
    row_id: `number-row-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    code: '',
    chinese_name: '',
    english_name: '',
    element: '',
    path: '',
    rarity: null,
    pv_start_time: DEFAULT_PV_START_TIME,
    pv_end_time: DEFAULT_PV_END_TIME,
    left_head_image: null,
    right_head_image: null,
    chant_video: null,
    pv: null,
    avatar_small_image: null,
    full_body_image: null,
    ban_voice: null,
    pick_voice: null,
    pick_sound: null,
    light_cone_small_image: null,
    light_cone_large_image: null,
    resource_status: {},
    status: '',
    created_at: timestamp,
    updated_at: timestamp,
    ...patch
  }
}

function formatCharacterCode(value: string): string {
  const code = value.trim().replace(/\s+/g, '')
  return /^\d+$/.test(code) ? code.padStart(5, '0') : code
}

function numberImportResourcePaths(
  code: string
): Pick<
  CharacterPayload,
  | 'ban_voice'
  | 'pick_voice'
  | 'pick_sound'
  | 'full_body_image'
  | 'avatar_small_image'
  | 'right_head_image'
  | 'left_head_image'
  | 'chant_video'
  | 'pv'
> {
  return {
    ban_voice: `assets/audios/ban/ban_${code}.wav`,
    pick_voice: `assets/audios/pick/pick_${code}.wav`,
    pick_sound: `assets/audios/pick_sound/pick_sound_${code}.wav`,
    full_body_image: `assets/characters/big/pick_${code}.png`,
    avatar_small_image: `assets/characters/small/ban_${code}.png`,
    right_head_image: `assets/characters/right/right_${code}.png`,
    left_head_image: `assets/characters/left/left_${code}.png`,
    chant_video: `assets/videos/chant/chant_${code}.mp4`,
    pv: `assets/videos/PV/PV_${code}.mp4`
  }
}

function characterAssetValues(character: Character): Array<string | null | undefined> {
  return [
    character.left_head_image,
    character.right_head_image,
    character.chant_video,
    character.pv,
    character.avatar_small_image,
    character.full_body_image,
    character.ban_voice,
    character.pick_voice,
    character.pick_sound
  ]
}

function characterMatchesCode(character: Character, code: string): boolean {
  const characterCode = formatCharacterCode(character.code ?? '')
  return (
    characterCode === code || characterAssetValues(character).some((value) => value?.includes(code))
  )
}

function normalizeImportRarity(
  value: CharacterRarity | null | undefined,
  fallback: CharacterRarity
): CharacterRarity {
  return value === 4 || value === 5 ? value : fallback
}

function tableRowAssetValue(row: CharacterNumberImportRow, field: CharacterAssetField): string {
  const value = row[field]
  return typeof value === 'string' ? value.trim() : ''
}

function buildNumberImportPayload(
  row: CharacterNumberImportRow,
  code: string,
  existing?: Character
): CharacterPayload {
  const resources = numberImportResourcePaths(code)
  const resolvedResources = characterNumberImportResourceKeys.reduce(
    (next, field) => {
      next[field] = tableRowAssetValue(row, field) || existing?.[field] || resources[field] || null
      return next
    },
    {} as Record<CharacterAssetField, string | null>
  )

  return {
    code,
    english_name: row.english_name.trim() || existing?.english_name || code,
    chinese_name: row.chinese_name.trim() || existing?.chinese_name || code,
    rarity: normalizeImportRarity(row.rarity, existing?.rarity ?? 5),
    element: row.element.trim() || existing?.element || '',
    path: row.path.trim() || existing?.path || '',
    ...resolvedResources,
    pv_start_time: normalizePvStartTime(row.pv_start_time ?? existing?.pv_start_time),
    pv_end_time: normalizePvEndTime(row.pv_end_time ?? existing?.pv_end_time)
  }
}

function emptyRowsForDisplay(rows: CharacterNumberImportRow[]): CharacterNumberImportRow[] {
  return rows.length > 0 ? rows : [createCharacterNumberImportRow()]
}

function countRowMissingResources(row: CharacterNumberImportRow): number {
  return Object.values(row.resource_status ?? {}).filter((status) => status === 'missing').length
}

function statusForResource(
  row: CharacterNumberImportRow,
  field: CharacterResourceTableAssetField
): CharacterResourceStatus {
  const storedStatus = row.resource_status?.[field]
  if (storedStatus) {
    return storedStatus
  }

  return row[field] ? 'missing' : 'notConfigured'
}

function buildRuntimeFromActions(
  flow: FlowConfig,
  actions: BpActionRecord[],
  createdAt?: string
): BpRuntimeState {
  const runtime = createRuntime(flow)
  const normalizedFlow = normalizeFlowConfig(flow)
  runtime.createdAt = createdAt || runtime.createdAt

  actions.forEach((record) => {
    if (!isRosterAction(record.action) || !record.target) {
      return
    }

    const teamKey = record.side === 'star' ? 'starTeam' : 'railTeam'
    const slotKey = record.action === 'pick' ? 'picks' : 'bans'
    runtime[teamKey][slotKey].push(record.target as BpTeamTarget)
  })

  runtime.actions = actions
  runtime.stepCursor = Math.min(actions.length, normalizedFlow.steps.length)
  runtime.currentStep = normalizedFlow.steps[runtime.stepCursor] ?? null
  runtime.followingStep = normalizedFlow.steps[runtime.stepCursor + 1] ?? null
  runtime.status = runtime.stepCursor >= normalizedFlow.steps.length ? 'complete' : 'running'

  return runtime
}

function withFollowingStep(runtime: BpRuntimeState, flow: FlowConfig): BpRuntimeState {
  const normalizedFlow = normalizeFlowConfig(flow)

  return {
    ...runtime,
    currentStep: normalizedFlow.steps[runtime.stepCursor] ?? runtime.currentStep ?? null,
    followingStep: normalizedFlow.steps[runtime.stepCursor + 1] ?? null
  }
}

function withUpCharacterPv(
  runtime: BpRuntimeState,
  source: Pick<
    BpRuntimeState,
    'upCharacterPvPath' | 'upCharacterPvUrl' | 'upCharacterPvStartTime' | 'upCharacterPvEndTime'
  >
): BpRuntimeState {
  return {
    ...runtime,
    upCharacterPvPath: cleanOptionalPath(source.upCharacterPvPath),
    upCharacterPvUrl: cleanOptionalPath(source.upCharacterPvUrl),
    upCharacterPvStartTime: normalizePvStartTime(source.upCharacterPvStartTime),
    upCharacterPvEndTime: normalizePvEndTime(source.upCharacterPvEndTime)
  }
}

const liveMaxEventChainDepth = 8

type LiveDelayProgress = Record<string, number>

interface LiveEventRecord {
  name: string
  sourceActionIndex: number | null
  depth: number
}

interface LivePendingDelayedChange {
  key: string
  pageChangeId: string
  pageChangeName: string
  requiredClicks: number
  remainingClicks: number
}

interface LiveEventSeed {
  name: string
  sourceActionIndex: number | null
}

function pageChangeTriggerEventName(pageChange: DisplayPageChange): string | null {
  return (
    normalizeEventName(pageChange.triggerEvent) ??
    normalizeEventName(pageChange.triggerName) ??
    normalizeEventName(pageChange.name) ??
    (pageChange.index ? String(pageChange.index) : null)
  )
}

function actionRecordEventName(action: BpActionRecord): string | null {
  return (
    normalizeEventName(action.eventName) ??
    normalizeEventName(action.pageChangeName) ??
    (action.pageChangeIndex ? String(action.pageChangeIndex) : null)
  )
}

function pageChangeDelayClickCount(pageChange: DisplayPageChange): number {
  return Math.max(1, Math.floor(Number(pageChange.delayClickCount) || 1))
}

function liveDelayedPageChangeKey(
  pageChange: DisplayPageChange,
  eventRecord: LiveEventRecord
): string {
  return [
    eventRecord.sourceActionIndex ?? 'none',
    eventRecord.depth,
    eventRecord.name,
    pageChange.id
  ].join(':')
}

function runtimeLiveEventSeeds(state: BpRuntimeState): LiveEventSeed[] {
  const seeds: LiveEventSeed[] = []
  if (state.status !== 'idle') {
    seeds.push({ name: 'start', sourceActionIndex: null })
  }

  state.actions.forEach((action) => {
    const seedEvent = actionRecordEventName(action)
    if (seedEvent) {
      seeds.push({ name: seedEvent, sourceActionIndex: action.stepIndex })
    }
  })

  if (state.status === 'complete') {
    seeds.push({ name: 'end', sourceActionIndex: null })
  }

  return seeds
}

function expandLiveEventChain(
  seedEvent: string,
  sourceActionIndex: number | null,
  pageChanges: DisplayPageChange[],
  completedDelayedChangeKeys: Set<string>,
  delayClickProgress: LiveDelayProgress
): LivePendingDelayedChange[] {
  const queue: LiveEventRecord[] = [{ name: seedEvent, sourceActionIndex, depth: 0 }]
  const seen = new Set<string>()

  while (queue.length > 0) {
    const current = queue.shift()
    const name = normalizeEventName(current?.name)
    if (!current || !name || current.depth > liveMaxEventChainDepth) {
      continue
    }

    const key = `${name}:${current.sourceActionIndex ?? 'none'}:${current.depth}`
    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    if (current.depth >= liveMaxEventChainDepth) {
      continue
    }

    const pendingDelayedChanges: LivePendingDelayedChange[] = []
    for (const pageChange of pageChanges) {
      if (pageChangeTriggerEventName(pageChange) !== name) {
        continue
      }

      const delayKey = liveDelayedPageChangeKey(pageChange, {
        name,
        sourceActionIndex: current.sourceActionIndex ?? null,
        depth: current.depth
      })
      if (pageChange.delayTriggerEnabled === true && !completedDelayedChangeKeys.has(delayKey)) {
        const requiredClicks = pageChangeDelayClickCount(pageChange)
        const completedClicks = Math.max(0, Math.floor(delayClickProgress[delayKey] ?? 0))
        pendingDelayedChanges.push({
          key: delayKey,
          pageChangeId: pageChange.id,
          pageChangeName: pageChange.name || '未命名变化',
          requiredClicks,
          remainingClicks: Math.max(1, requiredClicks - completedClicks)
        })
        continue
      }

      const emitEvent = pageChangeEmitEventName(pageChange)
      if (emitEvent) {
        queue.push({
          name: emitEvent,
          sourceActionIndex: current.sourceActionIndex ?? null,
          depth: current.depth + 1
        })
      }
    }

    if (pendingDelayedChanges.length > 0) {
      return pendingDelayedChanges
    }
  }

  return []
}

function resolveLivePendingDelayedChanges(
  state: BpRuntimeState,
  settings: DisplaySettings,
  completedDelayedChangeKeys: Set<string>,
  delayClickProgress: LiveDelayProgress
): LivePendingDelayedChange[] {
  const pageChanges = Array.isArray(settings.pageChanges) ? settings.pageChanges : []
  const seeds = runtimeLiveEventSeeds(state)

  for (const seed of seeds) {
    const pendingDelayedChanges = expandLiveEventChain(
      seed.name,
      seed.sourceActionIndex,
      pageChanges,
      completedDelayedChangeKeys,
      delayClickProgress
    )

    if (pendingDelayedChanges.length > 0) {
      return pendingDelayedChanges
    }
  }

  return []
}

function applyLivePendingDelayedClicks(
  pendingDelayedChanges: LivePendingDelayedChange[],
  completedDelayedChangeKeys: Set<string>,
  delayClickProgress: LiveDelayProgress
): {
  completedDelayedChangeKeys: Set<string>
  delayClickProgress: LiveDelayProgress
} {
  const nextProgress = { ...delayClickProgress }
  const nextCompletedKeys = new Set(completedDelayedChangeKeys)

  pendingDelayedChanges.forEach((pendingDelayedChange) => {
    const completedClicks = (nextProgress[pendingDelayedChange.key] ?? 0) + 1
    if (completedClicks >= pendingDelayedChange.requiredClicks) {
      delete nextProgress[pendingDelayedChange.key]
      nextCompletedKeys.add(pendingDelayedChange.key)
      return
    }
    nextProgress[pendingDelayedChange.key] = completedClicks
  })

  return {
    completedDelayedChangeKeys: nextCompletedKeys,
    delayClickProgress: nextProgress
  }
}

function defaultResultName(flowName: string): string {
  return `${flowName} ${new Date().toLocaleString('zh-CN', { hour12: false })}`
}

function buildBpResultPayload(runtime: BpRuntimeState, flow: FlowConfig, name: string): BpResult {
  const result: BpResult = {
    name,
    flowName: runtime.flowName,
    flowConfig: flow,
    createdAt: runtime.createdAt,
    starTeam: runtime.starTeam,
    railTeam: runtime.railTeam,
    actions: runtime.actions
  }
  const upCharacterPvPath = cleanOptionalPath(runtime.upCharacterPvPath)

  result.upCharacterPvStartTime = normalizePvStartTime(runtime.upCharacterPvStartTime)
  result.upCharacterPvEndTime = normalizePvEndTime(runtime.upCharacterPvEndTime)

  if (upCharacterPvPath) {
    result.upCharacterPvPath = upCharacterPvPath
  }

  return result
}

function emptyVoiceTimelineConfig(name: string): VoiceTimelineConfig {
  const now = new Date().toISOString()
  return {
    id: `voice-timeline-${Date.now()}`,
    name,
    bpFlowConfigFile: '',
    bpFlowConfigName: '',
    bpResultFile: '',
    bpResultName: '',
    audioPath: '',
    audioUrl: null,
    audioExists: false,
    duration: 0,
    playbackRate: 1,
    clickPoints: [],
    createdAt: now,
    updatedAt: now
  }
}

function createRuntimeFromResult(
  result: BpResult,
  fallbackFlow: FlowConfig
): { flow: FlowConfig; runtime: BpRuntimeState } {
  const flow = normalizeFlowConfig(
    result.flowConfig ??
      (result.flowName === fallbackFlow.name
        ? fallbackFlow
        : {
            name: result.flowName || '已保存 BP 流程',
            steps: []
          })
  )
  const runtime = buildRuntimeFromActions(flow, result.actions)

  runtime.flowName = result.flowName || flow.name
  runtime.createdAt = result.createdAt
  runtime.starTeam = result.starTeam
  runtime.railTeam = result.railTeam
  runtime.actions = result.actions
  runtime.upCharacterPvPath = cleanOptionalPath(result.upCharacterPvPath)
  runtime.upCharacterPvUrl = null
  runtime.upCharacterPvStartTime = normalizePvStartTime(result.upCharacterPvStartTime)
  runtime.upCharacterPvEndTime = normalizePvEndTime(result.upCharacterPvEndTime)

  return { flow, runtime }
}

interface SideFileListItem {
  fileName: string
  name: string
  updatedAt: string
}

function SideFileList<T extends SideFileListItem>({
  title,
  items,
  selectedFileName,
  emptyText,
  getMeta,
  onSelect,
  onCreate,
  onOpenFolder,
  onRename,
  onDelete
}: {
  title: string
  items: T[]
  selectedFileName: string
  emptyText: string
  getMeta: (item: T) => string
  onSelect: (fileName: string) => void
  onCreate?: () => void
  onOpenFolder: () => void
  onRename?: (fileName: string, nextName: string) => void | Promise<void>
  onDelete: (fileName: string) => void
}): React.JSX.Element {
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    fileName: string | null
    itemName: string | null
  } | null>(null)
  const [renamingItem, setRenamingItem] = useState<{
    fileName: string
    originalName: string
    draft: string
  } | null>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const skipRenameBlurRef = useRef(false)

  useEffect(() => {
    if (!contextMenu) {
      return undefined
    }

    const closeMenu = (): void => setContextMenu(null)
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        closeMenu()
      }
    }

    window.addEventListener('click', closeMenu)
    window.addEventListener('keydown', closeOnEscape)

    return () => {
      window.removeEventListener('click', closeMenu)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [contextMenu])

  useEffect(() => {
    if (!renamingItem) {
      return
    }

    renameInputRef.current?.focus()
    renameInputRef.current?.select()
  }, [renamingItem])

  const openContextMenu = (
    event: ReactMouseEvent<HTMLElement>,
    fileName: string | null = null,
    itemName: string | null = null
  ): void => {
    event.preventDefault()
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      fileName,
      itemName
    })
  }

  const startRename = (fileName: string, itemName: string): void => {
    setContextMenu(null)
    skipRenameBlurRef.current = false
    setRenamingItem({
      fileName,
      originalName: itemName,
      draft: itemName
    })
  }

  const cancelRename = (): void => {
    skipRenameBlurRef.current = true
    setRenamingItem(null)
  }

  const commitRename = (): void => {
    if (!renamingItem || !onRename) {
      setRenamingItem(null)
      return
    }

    const target = renamingItem
    setRenamingItem(null)
    const nextName = normalizeRenameName(target.draft, target.originalName)
    if (nextName) {
      void onRename(target.fileName, nextName)
    }
  }

  return (
    <section className="side-list-panel" onContextMenu={(event) => openContextMenu(event)}>
      <div className="side-list-header">
        <h2 className="side-section-title">{title}</h2>
        {onCreate ? (
          <button type="button" className="side-list-tool" onClick={onCreate}>
            新建
          </button>
        ) : null}
      </div>
      <div className="side-file-list" onContextMenu={(event) => openContextMenu(event)}>
        {items.length > 0 ? (
          items.map((item) => {
            const isActive = selectedFileName === item.fileName
            const isRenaming = renamingItem?.fileName === item.fileName

            return isRenaming ? (
              <div
                key={item.fileName}
                className={`side-file-item side-file-item-editing ${isActive ? 'active' : ''}`}
                title={item.fileName}
                onContextMenu={(event) => {
                  event.stopPropagation()
                  openContextMenu(event, item.fileName, item.name)
                }}
              >
                <input
                  ref={renameInputRef}
                  className="side-file-rename-input"
                  value={renamingItem.draft}
                  onChange={(event) =>
                    setRenamingItem((current) =>
                      current ? { ...current, draft: event.target.value } : current
                    )
                  }
                  onBlur={() => {
                    if (skipRenameBlurRef.current) {
                      skipRenameBlurRef.current = false
                      return
                    }
                    commitRename()
                  }}
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      skipRenameBlurRef.current = true
                      commitRename()
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      cancelRename()
                    }
                  }}
                />
                <span className="side-file-meta">{getMeta(item)}</span>
              </div>
            ) : (
              <button
                type="button"
                key={item.fileName}
                className={`side-file-item ${isActive ? 'active' : ''}`}
                title={item.fileName}
                aria-pressed={isActive}
                onClick={() => onSelect(item.fileName)}
                onContextMenu={(event) => {
                  event.stopPropagation()
                  openContextMenu(event, item.fileName, item.name)
                }}
              >
                <span className="side-file-name">{item.name}</span>
                <span className="side-file-meta">{getMeta(item)}</span>
              </button>
            )
          })
        ) : (
          <div className="side-empty">{emptyText}</div>
        )}
      </div>
      {contextMenu ? (
        <div
          className="side-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          role="menu"
          onClick={(event) => event.stopPropagation()}
        >
          {onCreate ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setContextMenu(null)
                onCreate()
              }}
            >
              新建
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setContextMenu(null)
              onOpenFolder()
            }}
          >
            打开本地文件夹
          </button>
          {contextMenu.fileName && onRename ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const fileName = contextMenu.fileName
                const itemName = contextMenu.itemName
                if (fileName && itemName) {
                  startRename(fileName, itemName)
                }
              }}
            >
              重命名
            </button>
          ) : null}
          {contextMenu.fileName ? (
            <button
              type="button"
              role="menuitem"
              className="danger"
              onClick={() => {
                const fileName = contextMenu.fileName
                setContextMenu(null)
                if (fileName) {
                  onDelete(fileName)
                }
              }}
            >
              删除
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

function CharacterNumberManager({
  open,
  onClose,
  onImported,
  onMessage
}: {
  open: boolean
  onClose: () => void
  onImported: () => Promise<void>
  onMessage: (type: MessageType, text: string) => void
}): React.JSX.Element | null {
  const [rows, setRows] = useState<CharacterNumberImportRow[]>([])
  const [loadingTable, setLoadingTable] = useState(false)
  const [saving, setSaving] = useState(false)
  const [importing, setImporting] = useState(false)
  const busy = loadingTable || saving || importing

  const applyResourceTable = useCallback(
    (result: CharacterResourceTableLoadResult): CharacterNumberImportRow[] => {
      const nextRows = emptyRowsForDisplay(result.rows)
      setRows(nextRows)

      result.warnings.forEach((warning) => {
        onMessage(warning.includes('损坏') ? 'error' : 'info', warning)
      })

      return nextRows
    },
    [onMessage]
  )

  const loadResourceTable = useCallback(
    async (scanAssets = false, notifyScan = true): Promise<void> => {
      setLoadingTable(true)

      try {
        const result = scanAssets
          ? await window.bpAPI.characters.scanResourceTable()
          : await window.bpAPI.characters.loadResourceTable()
        applyResourceTable(result)

        if (scanAssets && notifyScan) {
          onMessage('success', `资源扫描完成：${result.rows.length} 行`)
        }
      } catch (error) {
        onMessage('error', error instanceof Error ? error.message : String(error))
        setRows([createCharacterNumberImportRow()])
      } finally {
        setLoadingTable(false)
      }
    },
    [applyResourceTable, onMessage]
  )

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void loadResourceTable(true, false)
    }
  }, [loadResourceTable, open])

  useEffect(() => {
    if (!open) {
      return undefined
    }

    return window.bpAPI.files.onChanged((event) => {
      if (fileChangeIncludes(event, 'assets')) {
        void loadResourceTable(true, false)
        return
      }

      if (fileChangeIncludes(event, 'characterResourceTable', 'characters', 'lightCones')) {
        void loadResourceTable(false)
      }
    })
  }, [loadResourceTable, open])

  const updateRow = <K extends keyof CharacterNumberImportRow>(
    rowId: string,
    key: K,
    value: CharacterNumberImportRow[K]
  ): void => {
    setRows((current) =>
      current.map((row) =>
        row.row_id === rowId ? { ...row, [key]: value, updated_at: new Date().toISOString() } : row
      )
    )
  }

  const saveRows = async (
    candidateRows: CharacterNumberImportRow[] = rows,
    notify = true
  ): Promise<CharacterNumberImportRow[]> => {
    setSaving(true)

    try {
      const result = await window.bpAPI.characters.saveResourceTable(candidateRows)
      const savedRows = applyResourceTable(result)

      if (notify) {
        await onImported()
        onMessage(
          'success',
          `已保存批量管理表：${result.rows.length} 行，同步 ${result.synced_characters ?? 0} 个角色`
        )
      }

      return savedRows
    } catch (error) {
      onMessage('error', error instanceof Error ? error.message : String(error))
      throw error
    } finally {
      setSaving(false)
    }
  }

  const resolveResourceStatuses = async (
    payload: CharacterPayload
  ): Promise<{
    resourceStatus: Partial<Record<CharacterResourceTableAssetField, CharacterResourceStatus>>
    missingCount: number
  }> => {
    const entries = await Promise.all(
      characterNumberImportResourceKeys.map(async (key) => {
        const storedPath = payload[key]
        const status: CharacterResourceStatus = storedPath
          ? (await window.bpAPI.files.exists(storedPath))
            ? 'found'
            : 'missing'
          : 'notConfigured'
        return [key, status] as const
      })
    )
    const resourceStatus = entries.reduce(
      (next, [key, status]) => {
        next[key] = status
        return next
      },
      {} as Partial<Record<CharacterResourceTableAssetField, CharacterResourceStatus>>
    )

    return {
      resourceStatus,
      missingCount: entries.filter(([, status]) => status === 'missing').length
    }
  }

  const importRows = async (targetRows: CharacterNumberImportRow[]): Promise<void> => {
    setImporting(true)

    try {
      const targetRowIds = new Set(targetRows.map((row) => row.row_id))
      const savedRows = await saveRows(rows, false)
      const rowsToImport =
        targetRows.length === rows.length
          ? savedRows
          : savedRows.filter((row) => targetRowIds.has(row.row_id))
      const rowUpdates = new Map<string, Partial<CharacterNumberImportRow>>()
      const summary: CharacterNumberImportSummary = {
        created: 0,
        updated: 0,
        skipped: 0,
        missingResources: 0
      }
      const workingCharacters = await window.bpAPI.characters.list()

      for (const row of rowsToImport) {
        const code = formatCharacterCode(row.code)
        if (!code) {
          summary.skipped += 1
          rowUpdates.set(row.row_id, {
            status: '已跳过：缺少编号',
            updated_at: new Date().toISOString()
          })
          continue
        }

        try {
          const existingIndex = workingCharacters.findIndex((character) =>
            characterMatchesCode(character, code)
          )
          const existing = existingIndex >= 0 ? workingCharacters[existingIndex] : undefined
          const payload = buildNumberImportPayload(row, code, existing)
          const { resourceStatus, missingCount } = await resolveResourceStatuses(payload)
          summary.missingResources += missingCount
          let savedCharacter: Character

          if (existing) {
            savedCharacter = await window.bpAPI.characters.update(existing.id, payload)
            workingCharacters[existingIndex] = savedCharacter
            summary.updated += 1
          } else {
            savedCharacter = await window.bpAPI.characters.create(payload)
            workingCharacters.push(savedCharacter)
            summary.created += 1
          }

          rowUpdates.set(row.row_id, {
            code: savedCharacter.code || code,
            english_name: savedCharacter.english_name,
            chinese_name: savedCharacter.chinese_name,
            rarity: savedCharacter.rarity,
            element: savedCharacter.element,
            path: savedCharacter.path,
            left_head_image: savedCharacter.left_head_image,
            right_head_image: savedCharacter.right_head_image,
            chant_video: savedCharacter.chant_video,
            pv: savedCharacter.pv,
            pv_start_time: savedCharacter.pv_start_time,
            pv_end_time: savedCharacter.pv_end_time,
            avatar_small_image: savedCharacter.avatar_small_image,
            full_body_image: savedCharacter.full_body_image,
            ban_voice: savedCharacter.ban_voice,
            pick_voice: savedCharacter.pick_voice,
            pick_sound: savedCharacter.pick_sound,
            resource_status: {
              ...(row.resource_status ?? {}),
              ...resourceStatus
            },
            status: `${existing ? '已更新' : '已新增'}，缺失 ${missingCount} 个资源`,
            updated_at: new Date().toISOString()
          })
        } catch (error) {
          summary.skipped += 1
          rowUpdates.set(row.row_id, {
            code,
            status: `失败：${error instanceof Error ? error.message : String(error)}`,
            updated_at: new Date().toISOString()
          })
        }
      }

      const result = await window.bpAPI.characters.saveResourceTable(
        savedRows.map((row) => ({
          ...row,
          ...(rowUpdates.get(row.row_id) ?? {})
        }))
      )
      applyResourceTable(result)
      await onImported()
      onMessage(
        'success',
        `批量导入完成：新增 ${summary.created} 个，更新 ${summary.updated} 个，跳过 ${summary.skipped} 行，缺失资源 ${summary.missingResources} 个`
      )
    } catch (error) {
      onMessage('error', error instanceof Error ? error.message : String(error))
    } finally {
      setImporting(false)
    }
  }

  if (!open) {
    return null
  }

  return (
    <div className="number-manager-backdrop" role="dialog" aria-modal="true">
      <section className="number-manager">
        <div className="number-manager-header">
          <div>
            <h2>批量管理</h2>
          </div>
          <div className="header-actions">
            <button
              type="button"
              onClick={() => setRows((current) => [...current, createCharacterNumberImportRow()])}
              disabled={busy}
            >
              新增行
            </button>
            <button type="button" onClick={() => void saveRows()} disabled={busy}>
              保存表格
            </button>
            <button type="button" onClick={() => void loadResourceTable(true)} disabled={busy}>
              扫描资源
            </button>
            <button type="button" onClick={() => importRows(rows)} disabled={busy}>
              批量导入全部
            </button>
            <button type="button" onClick={onClose} disabled={busy}>
              关闭
            </button>
          </div>
        </div>

        <div className="number-manager-table-wrap">
          <table className="number-manager-table">
            <thead>
              <tr>
                <th>编号</th>
                <th>中文名</th>
                <th>英文名</th>
                <th>属性</th>
                <th>命途</th>
                <th>星级</th>
                <th>PV开始时间</th>
                <th>PV结束时间</th>
                <th>资源状态</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {loadingTable ? (
                <tr>
                  <td colSpan={11}>正在加载批量管理表</td>
                </tr>
              ) : null}
              {!loadingTable &&
                rows.map((row) => {
                  const normalizedCode = formatCharacterCode(row.code)
                  const missingCount = countRowMissingResources(row)
                  const statusClass =
                    missingCount > 0 || row.status?.startsWith('失败') ? 'missing' : 'ok'
                  return (
                    <tr key={row.row_id}>
                      <td>
                        <input
                          value={row.code}
                          inputMode="numeric"
                          onChange={(event) => updateRow(row.row_id, 'code', event.target.value)}
                          onBlur={() => updateRow(row.row_id, 'code', normalizedCode)}
                          placeholder="00001"
                        />
                      </td>
                      <td>
                        <input
                          value={row.chinese_name}
                          onChange={(event) =>
                            updateRow(row.row_id, 'chinese_name', event.target.value)
                          }
                        />
                      </td>
                      <td>
                        <input
                          value={row.english_name}
                          onChange={(event) =>
                            updateRow(row.row_id, 'english_name', event.target.value)
                          }
                        />
                      </td>
                      <td>
                        <select
                          value={row.element}
                          onChange={(event) => updateRow(row.row_id, 'element', event.target.value)}
                        >
                          <option value="">未设置</option>
                          {elements.map((element) => (
                            <option key={element} value={element}>
                              {element}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <select
                          value={row.path}
                          onChange={(event) => updateRow(row.row_id, 'path', event.target.value)}
                        >
                          <option value="">未设置</option>
                          {paths.map((path) => (
                            <option key={path} value={path}>
                              {path}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <select
                          value={row.rarity ?? ''}
                          onChange={(event) =>
                            updateRow(
                              row.row_id,
                              'rarity',
                              event.target.value
                                ? (Number(event.target.value) as CharacterRarity)
                                : null
                            )
                          }
                        >
                          <option value="">未设置</option>
                          <option value="5">五星</option>
                          <option value="4">四星</option>
                        </select>
                      </td>
                      <td>
                        <input
                          type="number"
                          min={0}
                          step="0.1"
                          value={row.pv_start_time ?? DEFAULT_PV_START_TIME}
                          onChange={(event) =>
                            updateRow(
                              row.row_id,
                              'pv_start_time',
                              normalizePvStartTime(event.target.value)
                            )
                          }
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          min={0}
                          step="0.1"
                          value={row.pv_end_time ?? DEFAULT_PV_END_TIME}
                          onChange={(event) =>
                            updateRow(
                              row.row_id,
                              'pv_end_time',
                              normalizePvEndTime(event.target.value)
                            )
                          }
                        />
                      </td>
                      <td>
                        <div className="number-resource-status">
                          {characterNumberResourceStatusFields.map(({ key, label }) => {
                            const status = statusForResource(row, key)
                            const className =
                              status === 'found'
                                ? 'ok'
                                : status === 'missing'
                                  ? 'missing'
                                  : 'not-configured'
                            return (
                              <span key={key} className={className}>
                                {label}:{resourceStatusLabels[status]}
                              </span>
                            )
                          })}
                        </div>
                      </td>
                      <td>
                        <span className={statusClass}>{row.status || '待保存/导入'}</span>
                      </td>
                      <td>
                        <div className="number-manager-row-actions">
                          <button
                            type="button"
                            onClick={() => importRows([row])}
                            disabled={busy || !normalizedCode}
                          >
                            批量导入
                          </button>
                          <button
                            type="button"
                            className="danger"
                            onClick={() =>
                              setRows((current) => {
                                const nextRows = current.filter(
                                  (item) => item.row_id !== row.row_id
                                )
                                return emptyRowsForDisplay(nextRows)
                              })
                            }
                            disabled={busy}
                          >
                            删除
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

function CharacterManager({
  onMessage,
  sidebarHost
}: {
  onMessage: (type: MessageType, text: string) => void
  sidebarHost: HTMLDivElement | null
}): React.JSX.Element {
  const [characters, setCharacters] = useState<Character[]>([])
  const [filters, setFilters] = useState({ search: '', element: '', path: '', rarity: '' })
  const [form, setForm] = useState<CharacterPayload>(emptyCharacterForm)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [numberManagerOpen, setNumberManagerOpen] = useState(false)
  const [loading, setLoading] = useState(false)

  const loadCharacters = useCallback(
    async (syncEditingForm = false) => {
      const rarity = filters.rarity ? (Number(filters.rarity) as CharacterRarity) : undefined
      const rows = await window.bpAPI.characters.list({
        search: filters.search || undefined,
        element: filters.element || undefined,
        path: filters.path || undefined,
        rarity
      })
      setCharacters(rows)
      setEditingId((current) => {
        if (!current) {
          return current
        }

        const editingCharacter = rows.find((character) => character.id === current)
        if (editingCharacter) {
          if (syncEditingForm) {
            setForm(characterToFormPayload(editingCharacter))
          }
          return current
        }

        setForm(emptyCharacterForm())
        return null
      })
    },
    [filters]
  )

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadCharacters().catch((error: unknown) => onMessage('error', String(error)))
  }, [loadCharacters, onMessage])

  useEffect(
    () =>
      window.bpAPI.files.onChanged((event) => {
        if (fileChangeIncludes(event, 'assets', 'characters')) {
          loadCharacters().catch((error: unknown) =>
            onMessage('error', error instanceof Error ? error.message : String(error))
          )
        }
      }),
    [loadCharacters, onMessage]
  )

  const updateForm = <K extends keyof CharacterPayload>(
    key: K,
    value: CharacterPayload[K]
  ): void => {
    setForm((current) => ({ ...current, [key]: value }))
  }

  const chooseAsset = async (
    field: CharacterAssetField,
    type: 'image' | 'video' | 'audio'
  ): Promise<void> => {
    const result =
      type === 'image'
        ? await window.bpAPI.files.selectImage()
        : type === 'video'
          ? await window.bpAPI.files.selectVideo()
          : await window.bpAPI.files.selectAudio()
    if (!result.canceled && result.path) {
      updateForm(field, result.path)
    }
  }

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setLoading(true)

    try {
      if (editingId) {
        await window.bpAPI.characters.update(editingId, form)
        onMessage('success', `已更新角色：${form.chinese_name}`)
      } else {
        await window.bpAPI.characters.create(form)
        onMessage('success', `已新增角色：${form.chinese_name}`)
      }

      setForm(emptyCharacterForm())
      setEditingId(null)
      await loadCharacters()
    } catch (error) {
      onMessage('error', error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }

  const editCharacter = (character: Character): void => {
    setEditingId(character.id)
    setForm(characterToFormPayload(character))
  }

  const copyCharacter = async (character: Character): Promise<void> => {
    try {
      const copiedAt = Date.now()
      const allCharacters = await window.bpAPI.characters.list()
      const copyName = buildCharacterCopyName(character, allCharacters)

      await window.bpAPI.characters.create({
        code: '',
        english_name: `${character.english_name}-copy-${copiedAt}`,
        chinese_name: copyName,
        rarity: character.rarity,
        element: character.element,
        path: character.path,
        left_head_image: character.left_head_image,
        right_head_image: character.right_head_image,
        chant_video: character.chant_video,
        pv: character.pv,
        pv_start_time: character.pv_start_time,
        pv_end_time: character.pv_end_time,
        avatar_small_image: character.avatar_small_image,
        full_body_image: character.full_body_image,
        ban_voice: character.ban_voice,
        pick_voice: character.pick_voice,
        pick_sound: character.pick_sound
      })
      onMessage('success', `已复制角色：${copyName}`)
      await loadCharacters()
    } catch (error) {
      onMessage('error', error instanceof Error ? error.message : String(error))
    }
  }

  const deleteCharacter = async (character: Character): Promise<void> => {
    if (!window.confirm(`确定删除 ${character.chinese_name} 吗？此操作不可恢复。`)) {
      return
    }

    await window.bpAPI.characters.delete(character.id)
    onMessage('success', `已删除角色：${character.chinese_name}`)
    await loadCharacters()
  }

  const openConfigFolder = async (): Promise<void> => {
    try {
      await window.bpAPI.files.openConfigFolder()
      onMessage('success', '已打开配置文件夹')
    } catch (error) {
      onMessage('error', error instanceof Error ? error.message : String(error))
    }
  }

  const editorPanel = (
    <form className="editor-panel" onSubmit={submit}>
      <label>
        编号
        <input
          value={form.code ?? ''}
          onChange={(event) => updateForm('code', event.target.value)}
          onBlur={() => updateForm('code', formatCharacterCode(form.code ?? ''))}
          placeholder="00001"
        />
      </label>
      <label>
        英文名称
        <input
          value={form.english_name}
          onChange={(event) => updateForm('english_name', event.target.value)}
        />
      </label>
      <label>
        中文名称
        <input
          value={form.chinese_name}
          onChange={(event) => updateForm('chinese_name', event.target.value)}
        />
      </label>
      <div className="form-row">
        <label>
          稀有度
          <select
            value={form.rarity}
            onChange={(event) =>
              updateForm('rarity', Number(event.target.value) as CharacterRarity)
            }
          >
            <option value={5}>五星</option>
            <option value={4}>四星</option>
          </select>
        </label>
        <label>
          属性
          <select
            value={form.element}
            onChange={(event) => updateForm('element', event.target.value)}
          >
            <option value="">未设置</option>
            {elements.map((element) => (
              <option key={element} value={element}>
                {element}
              </option>
            ))}
          </select>
        </label>
        <label>
          命途
          <select value={form.path} onChange={(event) => updateForm('path', event.target.value)}>
            <option value="">未设置</option>
            {paths.map((path) => (
              <option key={path} value={path}>
                {path}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="asset-fields">
        {[
          ['left_head_image', '左头', 'image'],
          ['right_head_image', '右头', 'image'],
          ['chant_video', '唱名视频', 'video'],
          ['pv', 'PV', 'video'],
          ['avatar_small_image', '头像小图', 'image'],
          ['full_body_image', '全身', 'image'],
          ['ban_voice', 'Ban语音', 'audio'],
          ['pick_voice', 'Pick语音', 'audio'],
          ['pick_sound', 'Pick音效', 'audio']
        ].map(([field, label, type]) => (
          <div className="asset-field" key={field}>
            <span>{label}</span>
            <strong title={String(form[field as CharacterAssetField] ?? '')}>
              {fileName(form[field as CharacterAssetField])}
            </strong>
            <button
              type="button"
              onClick={() =>
                chooseAsset(field as CharacterAssetField, type as 'image' | 'video' | 'audio')
              }
            >
              选择
            </button>
          </div>
        ))}
      </div>

      <div className="form-row pv-time-row">
        <label>
          PV开始时间
          <input
            type="number"
            min={0}
            step="0.1"
            value={form.pv_start_time ?? DEFAULT_PV_START_TIME}
            onChange={(event) =>
              updateForm('pv_start_time', normalizePvStartTime(event.target.value))
            }
          />
        </label>
        <label>
          PV结束时间
          <input
            type="number"
            min={0}
            step="0.1"
            value={form.pv_end_time ?? DEFAULT_PV_END_TIME}
            onChange={(event) => updateForm('pv_end_time', normalizePvEndTime(event.target.value))}
          />
        </label>
      </div>

      <div className="form-actions">
        <button type="submit" disabled={loading}>
          {editingId ? '保存角色' : '导入角色'}
        </button>
        <button
          type="button"
          onClick={() => {
            setForm(emptyCharacterForm())
            setEditingId(null)
          }}
        >
          清空
        </button>
      </div>
    </form>
  )

  return (
    <section className="workbench-section">
      <div className="section-header">
        <div>
          <h1>角色管理</h1>
        </div>
        <div className="header-actions">
          <button type="button" onClick={() => setNumberManagerOpen(true)}>
            批量管理
          </button>
          <button type="button" onClick={openConfigFolder}>
            打开配置文件夹
          </button>
          <button type="button" onClick={() => loadCharacters()}>
            刷新
          </button>
        </div>
      </div>

      <CharacterNumberManager
        open={numberManagerOpen}
        onClose={() => setNumberManagerOpen(false)}
        onImported={() => loadCharacters(true)}
        onMessage={onMessage}
      />

      {sidebarHost ? createPortal(editorPanel, sidebarHost) : null}
      <div className={sidebarHost ? 'manager-grid manager-grid-list-only' : 'manager-grid'}>
        {sidebarHost ? null : editorPanel}

        <div className="list-panel">
          <div className="filter-bar">
            <input
              placeholder="搜索角色"
              value={filters.search}
              onChange={(event) =>
                setFilters((current) => ({ ...current, search: event.target.value }))
              }
            />
            <select
              value={filters.element}
              onChange={(event) =>
                setFilters((current) => ({ ...current, element: event.target.value }))
              }
            >
              <option value="">全部属性</option>
              {elements.map((element) => (
                <option key={element} value={element}>
                  {element}
                </option>
              ))}
            </select>
            <select
              value={filters.path}
              onChange={(event) =>
                setFilters((current) => ({ ...current, path: event.target.value }))
              }
            >
              <option value="">全部命途</option>
              {paths.map((path) => (
                <option key={path} value={path}>
                  {path}
                </option>
              ))}
            </select>
            <select
              value={filters.rarity}
              onChange={(event) =>
                setFilters((current) => ({ ...current, rarity: event.target.value }))
              }
            >
              <option value="">全部星级</option>
              <option value="5">五星</option>
              <option value="4">四星</option>
            </select>
          </div>

          <div className="character-list">
            {characters.map((character) => (
              <article className="entity-card" key={character.id}>
                <div className="avatar-box">
                  {character.avatar_small_image_url ? (
                    <img src={character.avatar_small_image_url} alt={character.chinese_name} />
                  ) : (
                    <span>{character.chinese_name.slice(0, 1) || '?'}</span>
                  )}
                </div>
                <div className="entity-main">
                  <div className="entity-title">
                    <strong>{character.chinese_name}</strong>
                    <span>{character.english_name}</span>
                  </div>
                  <div className="entity-meta">
                    {character.code ? <span>编号 {character.code}</span> : null}
                    <span>{character.rarity} 星</span>
                    <span>{character.element || '未设置'}</span>
                    <span>{character.path || '未设置'}</span>
                  </div>
                  <div className="asset-status">
                    <span className={character.left_head_image_exists ? 'ok' : 'missing'}>
                      左头
                    </span>
                    <span className={character.right_head_image_exists ? 'ok' : 'missing'}>
                      右头
                    </span>
                    <span className={character.avatar_small_image_exists ? 'ok' : 'missing'}>
                      头像
                    </span>
                    <span className={character.full_body_image_exists ? 'ok' : 'missing'}>
                      全身
                    </span>
                    <span className={character.chant_video_exists ? 'ok' : 'missing'}>视频</span>
                    <span className={character.pv_exists ? 'ok' : 'missing'}>PV</span>
                    <span className={character.ban_voice_exists ? 'ok' : 'missing'}>Ban语音</span>
                    <span className={character.pick_voice_exists ? 'ok' : 'missing'}>Pick语音</span>
                    <span className={character.pick_sound_exists ? 'ok' : 'missing'}>Pick音效</span>
                  </div>
                </div>
                <div className="entity-actions">
                  <button type="button" onClick={() => editCharacter(character)}>
                    编辑
                  </button>
                  <button type="button" onClick={() => copyCharacter(character)}>
                    复制
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => deleteCharacter(character)}
                  >
                    删除
                  </button>
                </div>
              </article>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

function LightConeManager({
  onMessage,
  sidebarHost
}: {
  onMessage: (type: MessageType, text: string) => void
  sidebarHost: HTMLDivElement | null
}): React.JSX.Element {
  const [lightCones, setLightCones] = useState<LightCone[]>([])
  const [filters, setFilters] = useState({ search: '', path: '', rarity: '' })
  const [form, setForm] = useState<LightConePayload>(emptyLightConeForm)
  const [editingId, setEditingId] = useState<number | null>(null)

  const loadLightCones = useCallback(async () => {
    const rarity = filters.rarity ? (Number(filters.rarity) as LightConeRarity) : undefined
    const rows = await window.bpAPI.lightCones.list({
      search: filters.search || undefined,
      path: filters.path || undefined,
      rarity
    })
    setLightCones(rows)
    setEditingId((current) => {
      if (!current || rows.some((lightCone) => lightCone.id === current)) {
        return current
      }

      setForm(emptyLightConeForm())
      return null
    })
  }, [filters])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadLightCones().catch((error: unknown) => onMessage('error', String(error)))
  }, [loadLightCones, onMessage])

  useEffect(
    () =>
      window.bpAPI.files.onChanged((event) => {
        if (fileChangeIncludes(event, 'assets', 'lightCones')) {
          loadLightCones().catch((error: unknown) =>
            onMessage('error', error instanceof Error ? error.message : String(error))
          )
        }
      }),
    [loadLightCones, onMessage]
  )

  const updateForm = <K extends keyof LightConePayload>(
    key: K,
    value: LightConePayload[K]
  ): void => {
    setForm((current) => ({ ...current, [key]: value }))
  }

  const chooseImage = async (field: 'small_image' | 'large_image'): Promise<void> => {
    const result = await window.bpAPI.files.selectImage()
    if (!result.canceled && result.path) {
      updateForm(field, result.path)
    }
  }

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()

    try {
      if (editingId) {
        await window.bpAPI.lightCones.update(editingId, form)
        onMessage('success', `已更新光锥：${form.name}`)
      } else {
        await window.bpAPI.lightCones.create(form)
        onMessage('success', `已新增光锥：${form.name}`)
      }

      setForm(emptyLightConeForm())
      setEditingId(null)
      await loadLightCones()
    } catch (error) {
      onMessage('error', error instanceof Error ? error.message : String(error))
    }
  }

  const editLightCone = (lightCone: LightCone): void => {
    setEditingId(lightCone.id)
    setForm({
      name: lightCone.name,
      path: lightCone.path,
      rarity: lightCone.rarity,
      small_image: lightCone.small_image,
      large_image: lightCone.large_image
    })
  }

  const copyLightCone = async (lightCone: LightCone): Promise<void> => {
    try {
      const allLightCones = await window.bpAPI.lightCones.list()
      const copyName = buildLightConeCopyName(lightCone, allLightCones)

      await window.bpAPI.lightCones.create({
        name: copyName,
        path: lightCone.path,
        rarity: lightCone.rarity,
        small_image: lightCone.small_image,
        large_image: lightCone.large_image
      })

      onMessage('success', `已复制光锥：${copyName}`)
      await loadLightCones()
    } catch (error) {
      onMessage('error', error instanceof Error ? error.message : String(error))
    }
  }

  const deleteLightCone = async (lightCone: LightCone): Promise<void> => {
    if (!window.confirm(`确定删除 ${lightCone.name} 吗？此操作不可恢复。`)) {
      return
    }

    await window.bpAPI.lightCones.delete(lightCone.id)
    onMessage('success', `已删除光锥：${lightCone.name}`)
    await loadLightCones()
  }

  const editorPanel = (
    <form className="editor-panel" onSubmit={submit}>
      <label>
        名字
        <input value={form.name} onChange={(event) => updateForm('name', event.target.value)} />
      </label>
      <label>
        命途
        <select value={form.path} onChange={(event) => updateForm('path', event.target.value)}>
          <option value="">未设置</option>
          {paths.map((path) => (
            <option key={path} value={path}>
              {path}
            </option>
          ))}
        </select>
      </label>
      <label>
        稀有度
        <select
          value={form.rarity}
          onChange={(event) => updateForm('rarity', Number(event.target.value) as LightConeRarity)}
        >
          <option value={5}>五星</option>
          <option value={4}>四星</option>
          <option value={3}>三星</option>
        </select>
      </label>
      <div className="asset-field single">
        <span>小图</span>
        <strong title={form.small_image ?? ''}>{fileName(form.small_image)}</strong>
        <button type="button" onClick={() => chooseImage('small_image')}>
          选择
        </button>
      </div>
      <div className="asset-field single">
        <span>大图</span>
        <strong title={form.large_image ?? ''}>{fileName(form.large_image)}</strong>
        <button type="button" onClick={() => chooseImage('large_image')}>
          选择
        </button>
      </div>
      <div className="form-actions">
        <button type="submit">{editingId ? '保存光锥' : '导入光锥'}</button>
        <button
          type="button"
          onClick={() => {
            setForm(emptyLightConeForm())
            setEditingId(null)
          }}
        >
          清空
        </button>
      </div>
    </form>
  )

  return (
    <section className="workbench-section">
      <div className="section-header">
        <div>
          <h1>光锥管理</h1>
        </div>
        <button type="button" onClick={() => loadLightCones()}>
          刷新
        </button>
      </div>

      {sidebarHost ? createPortal(editorPanel, sidebarHost) : null}
      <div className={sidebarHost ? 'manager-grid manager-grid-list-only' : 'manager-grid'}>
        {sidebarHost ? null : editorPanel}

        <div className="list-panel">
          <div className="filter-bar">
            <input
              placeholder="搜索光锥"
              value={filters.search}
              onChange={(event) =>
                setFilters((current) => ({ ...current, search: event.target.value }))
              }
            />
            <select
              value={filters.path}
              onChange={(event) =>
                setFilters((current) => ({ ...current, path: event.target.value }))
              }
            >
              <option value="">全部命途</option>
              {paths.map((path) => (
                <option key={path} value={path}>
                  {path}
                </option>
              ))}
            </select>
            <select
              value={filters.rarity}
              onChange={(event) =>
                setFilters((current) => ({ ...current, rarity: event.target.value }))
              }
            >
              <option value="">全部星级</option>
              <option value="5">五星</option>
              <option value="4">四星</option>
            </select>
          </div>

          <div className="character-list">
            {lightCones.map((lightCone) => (
              <article className="entity-card" key={lightCone.id}>
                <div className="avatar-box">
                  {lightCone.small_image_url ? (
                    <img src={lightCone.small_image_url} alt={lightCone.name} />
                  ) : (
                    <span>{lightCone.name.slice(0, 1) || '?'}</span>
                  )}
                </div>
                <div className="entity-main">
                  <div className="entity-title">
                    <strong>{lightCone.name}</strong>
                    <span>{lightCone.path || '未设置'}</span>
                  </div>
                  <div className="entity-meta">
                    <span>{lightCone.rarity} 星</span>
                    <span className={lightCone.small_image_exists ? 'ok' : 'missing'}>小图</span>
                    <span className={lightCone.large_image_exists ? 'ok' : 'missing'}>大图</span>
                  </div>
                </div>
                <div className="entity-actions">
                  <button type="button" onClick={() => editLightCone(lightCone)}>
                    编辑
                  </button>
                  <button type="button" onClick={() => copyLightCone(lightCone)}>
                    复制
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => deleteLightCone(lightCone)}
                  >
                    删除
                  </button>
                </div>
              </article>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

function FlowConfigPanel({
  onMessage,
  onFlowLoaded,
  selectedFlowFile,
  onSelectedFlowFileChange,
  onFlowListRefresh
}: {
  onMessage: (type: MessageType, text: string) => void
  onFlowLoaded: (flow: FlowConfig) => void
  selectedFlowFile: string
  onSelectedFlowFileChange: (fileName: string) => void
  onFlowListRefresh: (preferredFileName?: string) => Promise<void>
}): React.JSX.Element {
  const normalizedDefaultFlow = normalizeFlowConfig(defaultFlow)
  const [flowName, setFlowName] = useState(normalizedDefaultFlow.name)
  const [steps, setSteps] = useState<FlowStep[]>(normalizedDefaultFlow.steps)

  const currentFlow = useMemo(
    () =>
      normalizeFlowConfig({
        name: flowName,
        steps
      }),
    [flowName, steps]
  )

  const applyFlow = useCallback(
    (flow: FlowConfig): void => {
      const normalizedFlow = normalizeFlowConfig(flow)
      setFlowName(normalizedFlow.name)
      setSteps(normalizedFlow.steps)
      onFlowLoaded(normalizedFlow)
    },
    [onFlowLoaded]
  )

  const updateFlowName = (name: string): void => {
    setFlowName(name)
    onFlowLoaded(
      normalizeFlowConfig({
        name,
        steps
      })
    )
  }

  const updateSteps = (nextSteps: FlowStep[]): void => {
    const normalizedSteps = normalizeFlowSteps(nextSteps)
    setSteps(normalizedSteps)
    onFlowLoaded(
      normalizeFlowConfig({
        name: flowName,
        steps: normalizedSteps
      })
    )
  }

  const updateStep = <K extends keyof FlowStep>(
    index: number,
    key: K,
    value: FlowStep[K]
  ): void => {
    updateSteps(
      steps.map((step, stepIndex) =>
        stepIndex === index
          ? {
              ...step,
              [key]: value
            }
          : step
      )
    )
  }

  const updateStepAction = (index: number, action: BpAction): void => {
    updateSteps(
      steps.map((step, stepIndex) =>
        stepIndex === index
          ? {
              ...step,
              side: isPairedAction(action) ? 'star' : step.side,
              action,
              targetType: isPairedAction(action)
                ? 'character'
                : step.targetType === 'lightCone'
                  ? 'lightCone'
                  : 'character'
            }
          : step
      )
    )
  }

  const addStep = (): void => {
    const lastStep = steps.at(-1)
    updateSteps([
      ...steps,
      {
        index: steps.length + 1,
        side: lastStep?.side === 'star' ? 'rail' : 'star',
        action: lastStep?.action ?? 'ban',
        targetType: 'character'
      }
    ])
  }

  const addPairedStep = (action: 'protect' | 'borrow'): void => {
    updateSteps([
      ...steps,
      {
        index: steps.length + 1,
        side: 'star',
        action,
        targetType: 'character'
      }
    ])
  }

  const removeStep = (index: number): void => {
    updateSteps(steps.filter((_, stepIndex) => stepIndex !== index))
  }

  const moveStep = (index: number, direction: -1 | 1): void => {
    const nextIndex = index + direction
    if (nextIndex < 0 || nextIndex >= steps.length) {
      return
    }

    const nextSteps = [...steps]
    const currentStep = nextSteps[index]
    nextSteps[index] = nextSteps[nextIndex]
    nextSteps[nextIndex] = currentStep
    updateSteps(nextSteps)
  }

  const saveFlow = async (): Promise<void> => {
    try {
      if (currentFlow.steps.length === 0) {
        onMessage('error', 'BP 流程至少需要一个步骤')
        return
      }

      const saved = await window.bpAPI.flows.save(currentFlow)
      onFlowLoaded(currentFlow)
      onSelectedFlowFileChange(saved.fileName)
      onMessage('success', `已保存流程：${saved.fileName}`)
      await onFlowListRefresh(saved.fileName)
    } catch (error) {
      onMessage('error', error instanceof Error ? error.message : String(error))
    }
  }

  const loadFlowFile = useCallback(
    async (fileName: string): Promise<void> => {
      if (!fileName) {
        return
      }

      const flow = await window.bpAPI.flows.load(fileName)
      if (flow) {
        applyFlow(flow)
        onMessage('success', `已读取流程：${flow.name}`)
      }
    },
    [applyFlow, onMessage]
  )

  const loadSelectedFlow = async (): Promise<void> => {
    if (!selectedFlowFile) {
      onMessage('error', '请先选择流程文件')
      return
    }

    await loadFlowFile(selectedFlowFile)
  }

  useEffect(() => {
    if (!selectedFlowFile) {
      return
    }

    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadFlowFile(selectedFlowFile).catch((error: unknown) =>
      onMessage('error', error instanceof Error ? error.message : String(error))
    )
  }, [loadFlowFile, onMessage, selectedFlowFile])

  useEffect(
    () =>
      window.bpAPI.files.onChanged((event) => {
        if (!fileChangeIncludes(event, 'flows')) {
          return
        }

        onFlowListRefresh(selectedFlowFile).catch((error: unknown) =>
          onMessage('error', error instanceof Error ? error.message : String(error))
        )

        if (selectedFlowFile) {
          loadFlowFile(selectedFlowFile).catch(() => onSelectedFlowFileChange(''))
        }
      }),
    [loadFlowFile, onFlowListRefresh, onMessage, onSelectedFlowFileChange, selectedFlowFile]
  )

  const importFlow = async (): Promise<void> => {
    const flow = await window.bpAPI.flows.load()
    if (flow) {
      onSelectedFlowFileChange('')
      applyFlow(flow)
      onMessage('success', `已导入流程：${flow.name}`)
    }
  }

  const openFlowFolder = async (): Promise<void> => {
    const flowApi = window.bpAPI.flows as typeof window.bpAPI.flows & {
      openFolder?: () => Promise<boolean>
    }
    if (!flowApi.openFolder) {
      onMessage('error', '当前窗口缺少打开流程配置文件夹接口')
      return
    }

    try {
      await flowApi.openFolder()
      onMessage('success', '已打开流程配置文件夹')
    } catch (error) {
      onMessage('error', error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <section className="workbench-section">
      <div className="section-header">
        <div>
          <h1>BP流程配置</h1>
        </div>
        <div className="header-actions">
          <button type="button" onClick={addStep}>
            添加步骤
          </button>
          <button type="button" onClick={() => addPairedStep('protect')}>
            添加保护
          </button>
          <button type="button" onClick={() => addPairedStep('borrow')}>
            添加租借
          </button>
          <button type="button" onClick={importFlow}>
            从本地导入
          </button>
          <button type="button" onClick={loadSelectedFlow}>
            读取左侧选中流程
          </button>
          <button
            type="button"
            onClick={() => {
              onSelectedFlowFileChange('')
              applyFlow(defaultFlow)
            }}
          >
            使用默认流程
          </button>
          <button type="button" onClick={openFlowFolder}>
            打开流程配置文件夹
          </button>
          <button type="button" onClick={saveFlow}>
            保存当前流程
          </button>
        </div>
      </div>

      <div className="flow-layout flow-layout-single">
        <div className="flow-builder">
          <label className="flow-name-field">
            流程名称
            <input value={flowName} onChange={(event) => updateFlowName(event.target.value)} />
          </label>

          <div className="flow-summary flow-summary-inline">
            <strong>当前槽位</strong>
            <span>
              左侧队：Pick {countFlowSlots(currentFlow).star.picks} / Ban{' '}
              {countFlowSlots(currentFlow).star.bans}
            </span>
            <span>
              右侧队：Pick {countFlowSlots(currentFlow).rail.picks} / Ban{' '}
              {countFlowSlots(currentFlow).rail.bans}
            </span>
          </div>

          <div className="flow-step-table" role="table" aria-label="BP流程步骤">
            <div className="flow-step-row flow-step-head" role="row">
              <span>序号</span>
              <span>队伍</span>
              <span>动作</span>
              <span>目标</span>
              <span>事件触发</span>
              <span>调整</span>
            </div>

            {steps.map((step, index) => (
              <div className="flow-step-row" role="row" key={`flow-step-${index}`}>
                <strong>{index + 1}</strong>
                {isRosterAction(step.action) ? (
                  <select
                    value={step.side}
                    onChange={(event) =>
                      updateStep(index, 'side', event.target.value as FlowStep['side'])
                    }
                  >
                    <option value="star">左侧队</option>
                    <option value="rail">右侧队</option>
                  </select>
                ) : (
                  <input value="双方" disabled />
                )}
                <select
                  value={step.action}
                  onChange={(event) => updateStepAction(index, event.target.value as BpAction)}
                >
                  <option value="ban">Ban</option>
                  <option value="pick">Pick</option>
                  <option value="protect">保护</option>
                  <option value="borrow">租借</option>
                </select>
                <select
                  value={step.targetType}
                  onChange={(event) =>
                    updateStep(index, 'targetType', event.target.value as FlowStep['targetType'])
                  }
                  disabled={isPairedAction(step.action)}
                >
                  {isPairedAction(step.action) ? (
                    <option value="character">已Pick角色</option>
                  ) : (
                    <>
                      <option value="character">角色</option>
                      <option value="lightCone">光锥</option>
                    </>
                  )}
                </select>
                <input
                  list="flow-event-names"
                  value={step.eventName ?? legacyStepEventName(step) ?? ''}
                  onChange={(event) =>
                    updateSteps(
                      steps.map((item, stepIndex) =>
                        stepIndex === index
                          ? {
                              ...item,
                              eventName: event.target.value.trim() || null
                            }
                          : item
                      )
                    )
                  }
                />
                <div className="flow-row-actions">
                  <button type="button" onClick={() => moveStep(index, -1)} disabled={index === 0}>
                    上移
                  </button>
                  <button
                    type="button"
                    onClick={() => moveStep(index, 1)}
                    disabled={index === steps.length - 1}
                  >
                    下移
                  </button>
                  <button type="button" className="danger" onClick={() => removeStep(index)}>
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
          <datalist id="flow-event-names">
            {uniqueTextValues(steps.map((step) => step.eventName || legacyStepEventName(step))).map(
              (eventName) => (
                <option key={eventName} value={eventName} />
              )
            )}
          </datalist>

          {steps.length === 0 ? (
            <div className="flow-empty">当前没有流程步骤，请先添加 BP 步骤。</div>
          ) : null}
        </div>
      </div>
    </section>
  )
}

function SlotLayoutEditor({
  label,
  layout,
  slotCount,
  gapCount,
  onNumberChange,
  onGapChange,
  onSlotCountChange,
  onDirectionChange,
  onChooseFrame
}: {
  label: string
  layout: DisplaySlotLayout
  slotCount?: number
  gapCount?: number
  onNumberChange: (key: SlotLayoutNumberKey, value: number) => void
  onGapChange?: (index: number, value: number) => void
  onSlotCountChange?: (value: number) => void
  onDirectionChange: (direction: DisplaySlotLayout['direction']) => void
  onChooseFrame: () => void
}): React.JSX.Element {
  return (
    <section className="slot-layout-editor">
      <header>
        <strong>{label}</strong>
        <select
          value={layout.direction}
          onChange={(event) =>
            onDirectionChange(event.target.value as DisplaySlotLayout['direction'])
          }
        >
          <option value="vertical">纵向排列</option>
          <option value="horizontal">横向排列</option>
        </select>
      </header>

      <div className="slot-layout-numbers">
        {[
          ['x', 'X'],
          ['y', 'Y'],
          ['width', '宽'],
          ['height', '高'],
          ['gap', '间距'],
          ['layer', '图层']
        ].map(([key, text]) => (
          <label key={key}>
            {text}
            <input
              type="number"
              value={layout[key as SlotLayoutNumberKey]}
              onChange={(event) =>
                onNumberChange(key as SlotLayoutNumberKey, Number(event.target.value))
              }
            />
          </label>
        ))}
        {onSlotCountChange ? (
          <label>
            数量
            <input
              type="number"
              min="0"
              value={slotCount ?? 0}
              onChange={(event) => onSlotCountChange(Math.max(0, Number(event.target.value) || 0))}
            />
          </label>
        ) : null}
      </div>

      {gapCount && gapCount > 0 && onGapChange ? (
        <div className="slot-layout-gap-list">
          {Array.from({ length: gapCount }).map((_, gapIndex) => (
            <label key={`gap-${gapIndex}`}>
              间距 {gapIndex + 1}
              <input
                type="number"
                min="0"
                value={layout.gaps?.[gapIndex] ?? layout.gap}
                onChange={(event) =>
                  onGapChange(gapIndex, Math.max(0, Number(event.target.value) || 0))
                }
              />
            </label>
          ))}
        </div>
      ) : null}

      <div className="asset-field compact">
        <span>框图</span>
        <strong title={layout.frameImage}>{fileName(layout.frameImage)}</strong>
        <button type="button" onClick={onChooseFrame}>
          选择
        </button>
      </div>
    </section>
  )
}

function isPairedSlotEffectKey(key: SlotEffectKey): key is 'protect' | 'borrow' {
  return key === 'protect' || key === 'borrow'
}

function SlotEffectEditor({
  effects,
  availableEventOptions,
  onChooseVideo,
  onClearVideo,
  onChooseAudio,
  onClearAudio,
  onEffectChange,
  onLayoutChange,
  onPreview
}: {
  effects: DisplaySlotEffects
  availableEventOptions: string[]
  onChooseVideo: (key: SlotEffectKey, field: SlotEffectVideoField) => void
  onClearVideo: (key: SlotEffectKey, field: SlotEffectVideoField) => void
  onChooseAudio: (key: SlotEffectKey) => void
  onClearAudio: (key: SlotEffectKey) => void
  onEffectChange: (key: SlotEffectKey, patch: Partial<DisplaySlotEffectConfig>) => void
  onLayoutChange: (key: SlotEffectKey, layoutKey: SlotEffectLayoutNumberKey, value: number) => void
  onPreview: (key: SlotEffectKey) => void
}): React.JSX.Element {
  return (
    <section className="editor-panel display-settings-panel display-effects-panel slot-effect-panel">
      <header className="panel-header">
        <div>
          <span>Inspector</span>
          <h2>特效音效</h2>
        </div>
      </header>
      {(['pick', 'ban', 'protect', 'borrow'] as SlotEffectKey[]).map((key) => {
        const effect = effects[key] ?? defaultSlotEffects[key]
        const pairedEffect = isPairedSlotEffectKey(key)
        const delayEvents = uniqueTextValues(effect.delayActivateAfterEvents ?? [])
        const addableDelayEvents = availableEventOptions.filter(
          (eventName) => !delayEvents.includes(eventName)
        )
        const title =
          key === 'pick'
            ? 'Pick 槽特效'
            : key === 'ban'
              ? 'Ban 槽特效'
              : key === 'protect'
                ? '保护特效'
                : '租借特效'
        const soundLabel = '确选音效'

        return (
          <section className="slot-effect-card" key={key}>
            <h3>{title}</h3>
            <div className="slot-effect-fields">
              {!pairedEffect ? (
                <div className="event-delay-field">
                  <span>事件后延迟激活</span>
                  <div className="event-delay-chips">
                    {delayEvents.length > 0 ? (
                      delayEvents.map((eventName) => (
                        <button
                          type="button"
                          className="event-delay-chip"
                          key={eventName}
                          onClick={() =>
                            onEffectChange(key, {
                              delayActivateAfterEvents: delayEvents.filter(
                                (value) => value !== eventName
                              )
                            })
                          }
                          title="移除此事件"
                        >
                          {eventName} ×
                        </button>
                      ))
                    ) : (
                      <span className="event-delay-empty">未添加</span>
                    )}
                  </div>
                  <select
                    value=""
                    onChange={(event) => {
                      const eventName = event.currentTarget.value
                      if (!eventName) {
                        return
                      }

                      onEffectChange(key, {
                        delayActivateAfterEvents: uniqueTextValues([...delayEvents, eventName])
                      })
                    }}
                    disabled={addableDelayEvents.length === 0}
                  >
                    <option value="">添加已有事件</option>
                    {addableDelayEvents.map((eventName) => (
                      <option value={eventName} key={eventName}>
                        {eventName}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
            </div>
            {pairedEffect ? (
              <div className="asset-field compact">
                <span>循环特效</span>
                <strong title={effect.pendingVideo}>{fileName(effect.pendingVideo)}</strong>
                <button type="button" onClick={() => onChooseVideo(key, 'pendingVideo')}>
                  选择
                </button>
                <button
                  type="button"
                  onClick={() => onClearVideo(key, 'pendingVideo')}
                  disabled={!effect.pendingVideo}
                >
                  清除
                </button>
                <button
                  type="button"
                  onClick={() => onPreview(key)}
                  disabled={!effect.pendingVideo && !effect.pendingVideoUrl}
                >
                  播放
                </button>
              </div>
            ) : (
              <div className="asset-field compact">
                <span>待选特效</span>
                <strong title={effect.pendingVideo}>{fileName(effect.pendingVideo)}</strong>
                <button type="button" onClick={() => onChooseVideo(key, 'pendingVideo')}>
                  选择
                </button>
                <button
                  type="button"
                  onClick={() => onClearVideo(key, 'pendingVideo')}
                  disabled={!effect.pendingVideo}
                >
                  清除
                </button>
                <button
                  type="button"
                  onClick={() => onPreview(key)}
                  disabled={!effect.pendingVideo && !effect.pendingVideoUrl}
                >
                  播放
                </button>
              </div>
            )}
            <div className="slot-effect-fields">
              {pairedEffect ? (
                <label className="inline-check">
                  <input
                    type="checkbox"
                    checked={effect.keepLoop === true}
                    onChange={(event) => onEffectChange(key, { keepLoop: event.target.checked })}
                  />
                  一直循环
                </label>
              ) : null}
              {[
                ['x', 'X'],
                ['y', 'Y'],
                ['scale', '缩放']
              ].map(([layoutKey, text]) => (
                <label key={layoutKey}>
                  {text}
                  <input
                    type="number"
                    step={layoutKey === 'scale' ? '0.05' : undefined}
                    min={layoutKey === 'scale' ? '0.01' : undefined}
                    value={effect.pendingLayout[layoutKey as SlotEffectLayoutNumberKey]}
                    onChange={(event) =>
                      onLayoutChange(
                        key,
                        layoutKey as SlotEffectLayoutNumberKey,
                        Number(event.target.value)
                      )
                    }
                  />
                </label>
              ))}
            </div>
            <div className="asset-field compact">
              <span>确选特效</span>
              <strong title={effect.selectedVideo}>{fileName(effect.selectedVideo)}</strong>
              <button type="button" onClick={() => onChooseVideo(key, 'selectedVideo')}>
                选择
              </button>
              <button
                type="button"
                onClick={() => onClearVideo(key, 'selectedVideo')}
                disabled={!effect.selectedVideo}
              >
                清除
              </button>
            </div>
            <div className="asset-field compact">
              <span>{soundLabel}</span>
              <strong title={effect.selectedSound}>{fileName(effect.selectedSound)}</strong>
              <button type="button" onClick={() => onChooseAudio(key)}>
                选择
              </button>
              <button
                type="button"
                onClick={() => onClearAudio(key)}
                disabled={!effect.selectedSound}
              >
                清除
              </button>
            </div>
          </section>
        )
      })}
    </section>
  )
}

function VideoSlotEditor({
  layout,
  changes,
  onNumberChange,
  onVisibleChange,
  onAddChange,
  onChangeChange,
  onRemoveChange
}: {
  layout: DisplayVideoSlotLayout
  changes: DisplayPageChange[]
  onNumberChange: (key: VideoSlotNumberKey, value: number) => void
  onVisibleChange: (visible: boolean) => void
  onAddChange: () => void
  onChangeChange: (id: string, patch: Partial<DisplayPageChange>) => void
  onRemoveChange: (id: string) => void
}): React.JSX.Element {
  return (
    <section className="slot-layout-editor chant-video-slot-editor">
      <header>
        <strong>唱名视频槽</strong>
        <div className="chant-video-actions">
          <button type="button" onClick={onAddChange}>
            添加变化
          </button>
          <label className="inline-check">
            <input
              type="checkbox"
              checked={layout.visible}
              onChange={(event) => onVisibleChange(event.target.checked)}
            />
            显示
          </label>
        </div>
      </header>

      <div className="slot-layout-numbers">
        {[
          ['x', 'X'],
          ['y', 'Y'],
          ['width', '宽'],
          ['height', '高'],
          ['layer', '图层']
        ].map(([key, text]) => (
          <label key={key}>
            {text}
            <input
              type="number"
              value={layout[key as VideoSlotNumberKey]}
              onChange={(event) =>
                onNumberChange(key as VideoSlotNumberKey, Number(event.target.value))
              }
            />
          </label>
        ))}
      </div>
      {changes.length > 0 ? (
        <div className="chant-video-change-list">
          {changes.map((change) => (
            <div className="chant-video-change-row" key={change.id}>
              <label>
                变化名称
                <input
                  value={change.name}
                  onChange={(event) => onChangeChange(change.id, { name: event.target.value })}
                />
              </label>
              <label>
                响应事件
                <input
                  list="display-event-names"
                  value={change.triggerEvent ?? change.triggerName ?? change.name}
                  onChange={(event) =>
                    onChangeChange(change.id, {
                      triggerEvent: event.target.value,
                      triggerName: event.target.value
                    })
                  }
                />
              </label>
              <label>
                事件触发
                <input
                  list="display-event-names"
                  value={change.emitEvent ?? change.emitEventAfterComplete ?? ''}
                  onChange={(event) =>
                    onChangeChange(change.id, {
                      emitEvent: event.target.value
                    })
                  }
                />
              </label>
              <label className="inline-check">
                <input
                  type="checkbox"
                  checked={change.delayTriggerEnabled === true}
                  onChange={(event) =>
                    onChangeChange(change.id, {
                      delayTriggerEnabled: event.target.checked,
                      delayClickCount: change.delayClickCount ?? 1
                    })
                  }
                />
                延迟触发
              </label>
              {change.delayTriggerEnabled ? (
                <label>
                  额外点击次数
                  <input
                    type="number"
                    min="1"
                    value={change.delayClickCount ?? 1}
                    onChange={(event) =>
                      onChangeChange(change.id, {
                        delayClickCount: Math.max(1, Math.floor(Number(event.target.value) || 1))
                      })
                    }
                  />
                </label>
              ) : null}
              {[
                ['videoX', 'X'],
                ['videoY', 'Y'],
                ['videoWidth', '宽'],
                ['videoHeight', '高'],
                ['speed', '速度']
              ].map(([key, text]) => (
                <label key={key}>
                  {text}
                  <input
                    type="number"
                    min={
                      key === 'videoWidth' || key === 'videoHeight' || key === 'speed'
                        ? 1
                        : undefined
                    }
                    value={change[key as VideoChangeNumberKey]}
                    onChange={(event) => {
                      const rawValue = Number(event.target.value)
                      const value =
                        key === 'videoWidth' || key === 'videoHeight' || key === 'speed'
                          ? Math.max(1, rawValue || 1)
                          : rawValue
                      onChangeChange(change.id, {
                        [key]: value
                      } as Partial<Pick<DisplayPageChange, VideoChangeNumberKey>>)
                    }}
                  />
                </label>
              ))}
              <button type="button" className="danger" onClick={() => onRemoveChange(change.id)}>
                删除
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  )
}

function PageChangeCard({
  pageChange,
  backgroundLayers,
  onChange,
  onRemove
}: {
  pageChange: DisplayPageChange
  backgroundLayers: DisplayBackgroundLayer[]
  onChange: (patch: Partial<DisplayPageChange>) => void
  onRemove: () => void
}): React.JSX.Element {
  const hasFlyMotion = pageChange.mode === 'flyIn' || pageChange.mode === 'flyOut'
  const hasTimedChange =
    hasFlyMotion || pageChange.mode === 'expand' || pageChange.mode === 'collapse'

  return (
    <section className="page-change-card">
      <header>
        <strong>{pageChange.name || '未命名变化'}</strong>
        <button type="button" className="danger" onClick={onRemove}>
          删除
        </button>
      </header>
      <label>
        名称
        <input
          value={pageChange.name}
          onChange={(event) => onChange({ name: event.target.value })}
        />
      </label>
      <label>
        响应事件
        <input
          list="display-event-names"
          value={pageChange.triggerEvent ?? pageChange.triggerName ?? pageChange.name}
          onChange={(event) =>
            onChange({
              triggerEvent: event.target.value,
              triggerName: event.target.value
            })
          }
        />
      </label>
      <label>
        事件触发
        <input
          list="display-event-names"
          value={pageChange.emitEvent ?? pageChange.emitEventAfterComplete ?? ''}
          onChange={(event) => onChange({ emitEvent: event.target.value })}
        />
      </label>
      <label className="inline-check">
        <input
          type="checkbox"
          checked={pageChange.delayTriggerEnabled === true}
          onChange={(event) =>
            onChange({
              delayTriggerEnabled: event.target.checked,
              delayClickCount: pageChange.delayClickCount ?? 1
            })
          }
        />
        延迟触发
      </label>
      {pageChange.delayTriggerEnabled ? (
        <label>
          额外点击次数
          <input
            type="number"
            min="1"
            value={pageChange.delayClickCount ?? 1}
            onChange={(event) =>
              onChange({
                delayClickCount: Math.max(1, Math.floor(Number(event.target.value) || 1))
              })
            }
          />
        </label>
      ) : null}
      <div className="page-change-fields">
        <label>
          图层
          <select
            value={pageChange.layerId}
            onChange={(event) => onChange({ layerId: event.target.value })}
          >
            <option value="">未绑定</option>
            {backgroundLayers.map((layer, index) => (
              <option key={layer.id} value={layer.id}>
                {layer.name || `背景 ${index + 1}`}
              </option>
            ))}
          </select>
        </label>
        <label>
          方式
          <select
            value={pageChange.mode === 'resizeVideo' ? 'appear' : pageChange.mode}
            onChange={(event) =>
              onChange({ mode: event.target.value as DisplayPageChange['mode'] })
            }
          >
            <option value="appear">出现</option>
            <option value="disappear">消失</option>
            <option value="flyIn">飞入</option>
            <option value="flyOut">飞出</option>
            <option value="expand">展开</option>
            <option value="collapse">收缩</option>
          </select>
        </label>
        {hasFlyMotion ? (
          <>
            <label>
              方向
              <select
                value={pageChange.direction}
                onChange={(event) =>
                  onChange({ direction: event.target.value as DisplayPageChange['direction'] })
                }
              >
                <option value="left">左侧</option>
                <option value="right">右侧</option>
                <option value="top">上方</option>
                <option value="bottom">下方</option>
                <option value="custom">自定义</option>
              </select>
            </label>
            {[
              ['startX', '起点 X'],
              ['startY', '起点 Y']
            ].map(([key, label]) => (
              <label key={key}>
                {label}
                <input
                  type="number"
                  value={pageChange[key as PageChangeNumberKey]}
                  onChange={(event) =>
                    onChange({
                      [key]: Number(event.target.value)
                    } as Partial<Pick<DisplayPageChange, PageChangeNumberKey>>)
                  }
                />
              </label>
            ))}
          </>
        ) : null}
        {hasTimedChange ? (
          <label>
            时间 ms
            <input
              type="number"
              min="1"
              value={pageChange.speed}
              onChange={(event) =>
                onChange({ speed: Math.max(1, Number(event.target.value) || 1) })
              }
            />
          </label>
        ) : null}
      </div>
    </section>
  )
}

function normalizeLocalPageChange(
  pageChange: DisplayPageChange,
  fallbackVideoSlot: DisplayVideoSlotLayout
): DisplayPageChange {
  const target =
    pageChange.target ?? (pageChange.mode === 'resizeVideo' ? 'chantVideoSlot' : 'backgroundLayer')
  const name = pageChange.name || `页面变化 ${pageChange.index || 1}`
  const triggerEvent =
    normalizeEventName(pageChange.triggerEvent) ??
    normalizeEventName(pageChange.triggerName) ??
    name
  const emitEvent = pageChangeEmitEventName(pageChange)

  return {
    ...pageChange,
    name,
    triggerEvent,
    emitEvent,
    triggerName: triggerEvent,
    delayTriggerEnabled: pageChange.delayTriggerEnabled === true,
    delayClickCount: Math.max(1, Math.floor(Number(pageChange.delayClickCount) || 1)),
    target,
    layerId: target === 'chantVideoSlot' ? '' : pageChange.layerId,
    mode:
      target === 'chantVideoSlot'
        ? 'resizeVideo'
        : pageChange.mode === 'resizeVideo'
          ? 'appear'
          : pageChange.mode,
    videoX: Number.isFinite(Number(pageChange.videoX))
      ? Number(pageChange.videoX)
      : fallbackVideoSlot.x,
    videoY: Number.isFinite(Number(pageChange.videoY))
      ? Number(pageChange.videoY)
      : fallbackVideoSlot.y,
    videoWidth: Math.max(
      1,
      Number(pageChange.videoWidth) || fallbackVideoSlot.width || defaultChantVideoSlot.width
    ),
    videoHeight: Math.max(
      1,
      Number(pageChange.videoHeight) || fallbackVideoSlot.height || defaultChantVideoSlot.height
    )
  }
}

function mergeLiveDisplaySettings(
  localSettings: DisplaySettings,
  liveSettings: DisplaySettings
): DisplaySettings {
  const livePageChanges = Array.isArray(liveSettings.pageChanges) ? liveSettings.pageChanges : []
  const fallbackVideoSlot = localSettings.chantVideoSlot ?? defaultChantVideoSlot

  return {
    ...liveSettings,
    pageChanges: localSettings.pageChanges.map((pageChange, index) =>
      normalizeLocalPageChange(
        {
          ...(livePageChanges.find((livePageChange) => livePageChange.id === pageChange.id) ??
            livePageChanges[index] ??
            pageChange),
          ...pageChange
        },
        fallbackVideoSlot
      )
    )
  }
}

function DisplayVolumeControl({
  label,
  value,
  onChange
}: {
  label: string
  value: number
  onChange: (value: number) => void
}): React.JSX.Element {
  const volume = normalizeDisplayAudioVolumePercent(value)

  return (
    <label className="display-volume-control">
      <span>
        {label}
        <strong>{volume}%</strong>
      </span>
      <input
        type="range"
        min="0"
        max="100"
        step="1"
        value={volume}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  )
}

function DisplaySettingsPanel({
  currentFlow,
  activeSection,
  onActiveSectionChange,
  selectedSettingsFile,
  onSelectedSettingsFileChange,
  onSettingsListRefresh,
  onMessage
}: {
  currentFlow: FlowConfig
  activeSection: DisplaySettingsSection
  onActiveSectionChange: (section: DisplaySettingsSection) => void
  selectedSettingsFile: string
  onSelectedSettingsFileChange: (fileName: string) => void
  onSettingsListRefresh: (preferredFileName?: string) => Promise<void>
  onMessage: (type: MessageType, text: string) => void
}): React.JSX.Element {
  const [settings, setSettings] = useState<DisplaySettings>(emptyDisplaySettings)
  const [displayFlowList, setDisplayFlowList] = useState<FlowListItem[]>([])
  const [selectedDisplayFlowFile, setSelectedDisplayFlowFile] = useState('')
  const [displayTriggerFlow, setDisplayTriggerFlow] = useState<FlowConfig>(() =>
    normalizeFlowConfig(currentFlow)
  )

  const loadSelectedSettings = useCallback(async (): Promise<void> => {
    const nextSettings = await window.bpAPI.displaySettings.get(selectedSettingsFile || undefined)
    setSettings(nextSettings)

    if (nextSettings.triggerFlowFile) {
      setSelectedDisplayFlowFile(nextSettings.triggerFlowFile)
      window.bpAPI.flows
        .load(nextSettings.triggerFlowFile)
        .then((flow) => {
          if (flow) {
            setDisplayTriggerFlow(normalizeFlowConfig(flow))
          }
        })
        .catch((error: unknown) => onMessage('error', String(error)))
    } else {
      setSelectedDisplayFlowFile('')
      setDisplayTriggerFlow(normalizeFlowConfig(currentFlow))
    }

    if (selectedSettingsFile) {
      const liveSettings = await window.bpAPI.displaySettings.updateLive(nextSettings)
      setSettings(mergeLiveDisplaySettings(nextSettings, liveSettings))
    }
  }, [currentFlow, onMessage, selectedSettingsFile])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadSelectedSettings().catch((error: unknown) => onMessage('error', String(error)))
  }, [loadSelectedSettings, onMessage])

  const loadDisplayFlowList = useCallback(async (): Promise<void> => {
    setDisplayFlowList(await window.bpAPI.flows.list())
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadDisplayFlowList().catch((error: unknown) => onMessage('error', String(error)))
  }, [loadDisplayFlowList, onMessage])

  useEffect(
    () =>
      window.bpAPI.files.onChanged((event) => {
        if (fileChangeIncludes(event, 'flows')) {
          loadDisplayFlowList().catch((error: unknown) =>
            onMessage('error', error instanceof Error ? error.message : String(error))
          )
        }

        if (fileChangeIncludes(event, 'displaySettings')) {
          onSettingsListRefresh(selectedSettingsFile).catch((error: unknown) =>
            onMessage('error', error instanceof Error ? error.message : String(error))
          )
          loadSelectedSettings().catch((error: unknown) =>
            onMessage('error', error instanceof Error ? error.message : String(error))
          )
        }
      }),
    [
      loadDisplayFlowList,
      loadSelectedSettings,
      onMessage,
      onSettingsListRefresh,
      selectedSettingsFile
    ]
  )

  useEffect(() => {
    if (!selectedDisplayFlowFile) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDisplayTriggerFlow(normalizeFlowConfig(currentFlow))
    }
  }, [currentFlow, selectedDisplayFlowFile])

  const loadDisplayTriggerFlow = async (fileName: string): Promise<void> => {
    setSelectedDisplayFlowFile(fileName)
    setSettings((current) => ({ ...current, triggerFlowFile: fileName }))

    if (!fileName) {
      setDisplayTriggerFlow(normalizeFlowConfig(currentFlow))
      return
    }

    const flow = await window.bpAPI.flows.load(fileName)
    if (flow) {
      setDisplayTriggerFlow(normalizeFlowConfig(flow))
      onMessage('success', `展示页响应来源流程：${flow.name}`)
    }
  }

  const updateLive = async (nextSettings: DisplaySettings): Promise<void> => {
    setSettings(nextSettings)
    const liveSettings = await window.bpAPI.displaySettings.updateLive(nextSettings)
    setSettings(mergeLiveDisplaySettings(nextSettings, liveSettings))
  }

  const backgroundLayers = useMemo<DisplayBackgroundLayer[]>(() => {
    if (settings.backgroundLayers?.length > 0) {
      return settings.backgroundLayers
    }

    return settings.backgroundImage
      ? [
          {
            id: 'background-1',
            image: settings.backgroundImage,
            imageUrl: settings.backgroundImageUrl,
            name: '背景 1',
            x: settings.backgroundX,
            y: settings.backgroundY,
            scale: settings.backgroundScale,
            opacity: settings.backgroundOpacity,
            visible: true,
            layer: 1
          }
        ]
      : []
  }, [settings])
  const backgroundPageChanges = useMemo(
    () =>
      settings.pageChanges.filter(
        (pageChange) =>
          (pageChange.target ??
            (pageChange.mode === 'resizeVideo' ? 'chantVideoSlot' : 'backgroundLayer')) ===
          'backgroundLayer'
      ),
    [settings.pageChanges]
  )
  const chantVideoPageChanges = useMemo(
    () =>
      settings.pageChanges.filter(
        (pageChange) =>
          (pageChange.target ??
            (pageChange.mode === 'resizeVideo' ? 'chantVideoSlot' : 'backgroundLayer')) ===
          'chantVideoSlot'
      ),
    [settings.pageChanges]
  )
  const availableEventOptions = useMemo(
    () => collectAvailableEvents(displayTriggerFlow, settings),
    [displayTriggerFlow, settings]
  )
  const previewState = useMemo(() => createRuntime(displayTriggerFlow), [displayTriggerFlow])

  const updateBackgroundLayers = (layers: DisplayBackgroundLayer[]): void => {
    const firstLayer = layers[0]
    const nextSettings: DisplaySettings = {
      ...settings,
      backgroundImage: firstLayer?.image ?? '',
      backgroundX: firstLayer?.x ?? 0,
      backgroundY: firstLayer?.y ?? 0,
      backgroundScale: firstLayer?.scale ?? 1,
      backgroundOpacity: firstLayer?.opacity ?? 1,
      backgroundImageUrl: firstLayer?.imageUrl ?? null,
      backgroundLayers: layers
    }

    updateLive(nextSettings).catch((error: unknown) => onMessage('error', String(error)))
  }

  const addBackgroundLayer = async (): Promise<void> => {
    const result = await window.bpAPI.files.selectImage()
    if (!result.canceled && result.path) {
      updateBackgroundLayers([
        ...backgroundLayers,
        {
          id: `background-${Date.now()}`,
          name: `背景 ${backgroundLayers.length + 1}`,
          image: result.path,
          imageUrl: null,
          x: 0,
          y: 0,
          scale: 1,
          opacity: 1,
          visible: true,
          layer:
            backgroundLayers.reduce(
              (maxLayer, layer) => Math.max(maxLayer, Number(layer.layer) || 0),
              0
            ) + 1
        }
      ])
    }
  }

  const replaceBackgroundLayerImage = async (id: string): Promise<void> => {
    const result = await window.bpAPI.files.selectImage()
    if (!result.canceled && result.path) {
      updateBackgroundLayer(id, {
        image: result.path,
        imageUrl: null
      })
    }
  }

  const saveSettings = async (): Promise<void> => {
    const nextSettings = { ...settings, triggerFlowFile: selectedDisplayFlowFile }
    const targetFile = selectedSettingsFile || defaultDisplaySettingsFileName
    const savedSettings = await window.bpAPI.displaySettings.save(nextSettings, targetFile)
    setSettings(mergeLiveDisplaySettings(nextSettings, savedSettings))
    onSelectedSettingsFileChange(targetFile)
    await onSettingsListRefresh(targetFile)
    onMessage('success', '展示页设置已保存')
  }

  const openDisplaySettingsFolder = async (): Promise<void> => {
    const displaySettingsApi = window.bpAPI
      .displaySettings as typeof window.bpAPI.displaySettings & {
      openFolder?: () => Promise<boolean>
    }
    if (!displaySettingsApi.openFolder) {
      onMessage('error', '当前窗口缺少打开展示页配置文件夹接口')
      return
    }

    try {
      await displaySettingsApi.openFolder()
      onMessage('success', '已打开展示页配置文件夹')
    } catch (error) {
      onMessage('error', error instanceof Error ? error.message : String(error))
    }
  }

  const openPreviewWindow = async (): Promise<void> => {
    try {
      const nextSettings = { ...settings, triggerFlowFile: selectedDisplayFlowFile }
      const liveSettings = await window.bpAPI.displaySettings.updateLive(nextSettings)
      setSettings(mergeLiveDisplaySettings(nextSettings, liveSettings))

      const opened = await window.bpAPI.bp.openPreviewWindow(previewState)
      onMessage(opened ? 'success' : 'error', opened ? '预览页窗口已打开' : '预览页窗口打开失败')
    } catch (error) {
      onMessage('error', error instanceof Error ? error.message : String(error))
    }
  }

  const updateBackgroundLayer = (id: string, patch: Partial<DisplayBackgroundLayer>): void => {
    updateBackgroundLayers(
      backgroundLayers.map((layer) =>
        layer.id === id
          ? {
              ...layer,
              ...patch
            }
          : layer
      )
    )
  }

  const removeBackgroundLayer = (id: string): void => {
    updateBackgroundLayers(backgroundLayers.filter((layer) => layer.id !== id))
  }

  const moveBackgroundLayer = (index: number, direction: -1 | 1): void => {
    const nextIndex = index + direction
    if (nextIndex < 0 || nextIndex >= backgroundLayers.length) {
      return
    }

    const nextLayers = [...backgroundLayers]
    const currentLayer = nextLayers[index]
    nextLayers[index] = nextLayers[nextIndex]
    nextLayers[nextIndex] = currentLayer
    updateBackgroundLayers(nextLayers)
  }

  const updatePageChanges = (pageChanges: DisplayPageChange[]): void => {
    updateLive({ ...settings, pageChanges }).catch((error: unknown) =>
      onMessage('error', String(error))
    )
  }

  const updateAudioVolume = (field: DisplayAudioVolumeField, value: number): void => {
    const nextSettings: DisplaySettings = {
      ...settings,
      [field]: normalizeDisplayAudioVolumePercent(value)
    }

    updateLive(nextSettings).catch((error: unknown) => onMessage('error', String(error)))
  }

  const addPageChange = (): void => {
    const nextIndex =
      settings.pageChanges.reduce(
        (maxIndex, pageChange) => Math.max(maxIndex, pageChange.index),
        0
      ) + 1
    const name = `界面变化 ${nextIndex}`
    updatePageChanges([
      ...settings.pageChanges,
      {
        id: `page-change-${Date.now()}`,
        index: nextIndex,
        name,
        triggerEvent: name,
        emitEvent: '',
        delayTriggerEnabled: false,
        delayClickCount: 1,
        triggerName: name,
        target: 'backgroundLayer',
        layerId: backgroundLayers[0]?.id ?? '',
        mode: 'appear',
        startX: 0,
        startY: 0,
        speed: 800,
        direction: 'left',
        videoX: (settings.chantVideoSlot ?? defaultChantVideoSlot).x,
        videoY: (settings.chantVideoSlot ?? defaultChantVideoSlot).y,
        videoWidth: (settings.chantVideoSlot ?? defaultChantVideoSlot).width,
        videoHeight: (settings.chantVideoSlot ?? defaultChantVideoSlot).height
      }
    ])
  }

  const updatePageChange = (id: string, patch: Partial<DisplayPageChange>): void => {
    updatePageChanges(
      settings.pageChanges.map((pageChange) =>
        pageChange.id === id
          ? {
              ...pageChange,
              ...patch
            }
          : pageChange
      )
    )
  }

  const removePageChange = (id: string): void => {
    updatePageChanges(settings.pageChanges.filter((pageChange) => pageChange.id !== id))
  }

  const addChantVideoChange = (): void => {
    const videoSlot = settings.chantVideoSlot ?? defaultChantVideoSlot
    const nextIndex =
      settings.pageChanges.reduce(
        (maxIndex, pageChange) => Math.max(maxIndex, pageChange.index),
        0
      ) + 1
    const name = `唱名视频变化 ${nextIndex}`

    updatePageChanges([
      ...settings.pageChanges,
      {
        id: `chant-video-change-${Date.now()}`,
        index: nextIndex,
        name,
        triggerEvent: name,
        emitEvent: '',
        delayTriggerEnabled: false,
        delayClickCount: 1,
        triggerName: name,
        target: 'chantVideoSlot',
        layerId: '',
        mode: 'resizeVideo',
        startX: 0,
        startY: 0,
        speed: 800,
        direction: 'left',
        videoX: videoSlot.x,
        videoY: videoSlot.y,
        videoWidth: videoSlot.width,
        videoHeight: videoSlot.height
      }
    ])
  }

  const updateChantVideoChange = (id: string, patch: Partial<DisplayPageChange>): void => {
    updatePageChange(id, {
      ...patch,
      target: 'chantVideoSlot',
      layerId: '',
      mode: 'resizeVideo'
    })
  }

  const removeChantVideoChange = (id: string): void => {
    removePageChange(id)
  }

  const updateSlotLayout = (key: SlotLayoutKey, patch: Partial<DisplaySlotLayout>): void => {
    const nextSettings: DisplaySettings = {
      ...settings,
      slotLayouts: {
        ...settings.slotLayouts,
        [key]: {
          ...settings.slotLayouts[key],
          ...patch
        }
      }
    }

    updateLive(nextSettings).catch((error: unknown) => onMessage('error', String(error)))
  }

  const updateSlotGap = (key: SlotLayoutKey, gapIndex: number, value: number): void => {
    const gaps = [...(settings.slotLayouts[key].gaps ?? [])]
    gaps[gapIndex] = Math.max(0, Number(value) || 0)
    updateSlotLayout(key, { gaps })
  }

  const updateSecondaryPickCount = (key: SecondaryPickCountKey, value: number): void => {
    const nextSettings: DisplaySettings = {
      ...settings,
      secondaryPickCounts: {
        ...(settings.secondaryPickCounts ?? { star: 0, rail: 0 }),
        [key]: Math.max(0, Math.floor(value))
      }
    }

    updateLive(nextSettings).catch((error: unknown) => onMessage('error', String(error)))
  }

  const updateSecondaryBanCount = (key: SecondaryBanCountKey, value: number): void => {
    const nextSettings: DisplaySettings = {
      ...settings,
      secondaryBanCounts: {
        ...(settings.secondaryBanCounts ?? { star: 0, rail: 0 }),
        [key]: Math.max(0, Math.floor(value))
      }
    }

    updateLive(nextSettings).catch((error: unknown) => onMessage('error', String(error)))
  }

  const updateChantVideoSlot = (patch: Partial<DisplayVideoSlotLayout>): void => {
    const nextSettings: DisplaySettings = {
      ...settings,
      chantVideoSlot: {
        ...(settings.chantVideoSlot ?? defaultChantVideoSlot),
        ...patch
      }
    }

    updateLive(nextSettings).catch((error: unknown) => onMessage('error', String(error)))
  }

  const updateSlotEffect = (key: SlotEffectKey, patch: Partial<DisplaySlotEffectConfig>): void => {
    const currentEffect = settings.slotEffects?.[key] ?? defaultSlotEffects[key]
    const nextSettings: DisplaySettings = {
      ...settings,
      slotEffects: {
        ...(settings.slotEffects ?? defaultSlotEffects),
        [key]: {
          ...currentEffect,
          ...patch,
          pendingLayout: {
            ...currentEffect.pendingLayout,
            ...(patch.pendingLayout ?? {})
          }
        }
      }
    }

    updateLive(nextSettings).catch((error: unknown) => onMessage('error', String(error)))
  }

  const updateSlotEffectLayout = (
    key: SlotEffectKey,
    layoutKey: SlotEffectLayoutNumberKey,
    value: number
  ): void => {
    const currentEffect = settings.slotEffects?.[key] ?? defaultSlotEffects[key]
    updateSlotEffect(key, {
      pendingLayout: {
        ...currentEffect.pendingLayout,
        [layoutKey]: layoutKey === 'scale' ? Math.max(0.01, value || 1) : value
      }
    })
  }

  const chooseSlotEffectVideo = async (
    key: SlotEffectKey,
    field: SlotEffectVideoField
  ): Promise<void> => {
    const result = await window.bpAPI.files.selectVideo()
    if (!result.canceled && result.path) {
      const imported = await window.bpAPI.files.importAsset(
        result.path,
        'display',
        'slot-effects',
        `${key}-${field === 'pendingVideo' ? 'pending' : 'selected'}`
      )
      const urlField = field === 'pendingVideo' ? 'pendingVideoUrl' : 'selectedVideoUrl'
      const patch = {
        [field]: imported.storedPath,
        [urlField]: imported.url
      }

      updateSlotEffect(key, patch as Partial<DisplaySlotEffectConfig>)
    }
  }

  const clearSlotEffectVideo = (key: SlotEffectKey, field: SlotEffectVideoField): void => {
    const urlField = field === 'pendingVideo' ? 'pendingVideoUrl' : 'selectedVideoUrl'
    updateSlotEffect(key, {
      [field]: '',
      [urlField]: null
    } as Partial<DisplaySlotEffectConfig>)
  }

  const chooseSlotEffectAudio = async (key: SlotEffectKey): Promise<void> => {
    const result = await window.bpAPI.files.selectAudio()
    if (!result.canceled && result.path) {
      const imported = await window.bpAPI.files.importAsset(
        result.path,
        'display',
        'slot-effects',
        `${key}-sound`
      )
      updateSlotEffect(key, {
        selectedSound: imported.storedPath,
        selectedSoundUrl: imported.url
      })
    }
  }

  const clearSlotEffectAudio = (key: SlotEffectKey): void => {
    updateSlotEffect(key, {
      selectedSound: '',
      selectedSoundUrl: null
    })
  }

  const chooseSlotAsset = async (key: SlotLayoutKey, field: 'frameImage'): Promise<void> => {
    const result = await window.bpAPI.files.selectImage()
    if (!result.canceled && result.path) {
      updateSlotLayout(key, { [field]: result.path })
    }
  }
  const slotCountForLayout = (key: SlotLayoutKey): number | undefined => {
    const starSecondPicks = settings.secondaryPickCounts?.star ?? 0
    const railSecondPicks = settings.secondaryPickCounts?.rail ?? 0
    const starSecondBans = settings.secondaryBanCounts?.star ?? 0
    const railSecondBans = settings.secondaryBanCounts?.rail ?? 0

    switch (key) {
      case 'starPickSecond':
        return starSecondPicks
      case 'railPickSecond':
        return railSecondPicks
      case 'starBan':
        return Math.max(0, previewState.slotCounts.star.bans - starSecondBans)
      case 'starBanSecond':
        return starSecondBans
      case 'railBan':
        return Math.max(0, previewState.slotCounts.rail.bans - railSecondBans)
      case 'railBanSecond':
        return railSecondBans
      default:
        return undefined
    }
  }
  const gapCountForLayout = (key: SlotLayoutKey): number | undefined => {
    if (
      key !== 'starBan' &&
      key !== 'starBanSecond' &&
      key !== 'railBan' &&
      key !== 'railBanSecond'
    ) {
      return undefined
    }

    const totalBans =
      key === 'starBan' || key === 'starBanSecond'
        ? previewState.slotCounts.star.bans
        : previewState.slotCounts.rail.bans
    const secondaryBans =
      key === 'starBan' || key === 'starBanSecond'
        ? (settings.secondaryBanCounts?.star ?? 0)
        : (settings.secondaryBanCounts?.rail ?? 0)
    const actualSecondaryBans = Math.min(totalBans, Math.max(0, secondaryBans))
    const slotCount =
      key === 'starBan' || key === 'railBan' ? totalBans - actualSecondaryBans : actualSecondaryBans

    return Math.max(0, slotCount - 1)
  }

  return (
    <section className="workbench-section display-settings-workbench">
      <div className="editor-tabs">
        <button type="button" className="editor-tab active">
          {selectedSettingsFile || defaultDisplaySettingsFileName}
        </button>
      </div>

      <div className="section-header display-settings-toolbar">
        <div className="display-settings-title">
          <h1>展示页设置</h1>
        </div>
        <div className="header-actions display-settings-actions">
          <label className="display-flow-source">
            响应来源流程
            <select
              value={selectedDisplayFlowFile}
              onChange={(event) =>
                loadDisplayTriggerFlow(event.target.value).catch((error: unknown) =>
                  onMessage('error', error instanceof Error ? error.message : String(error))
                )
              }
            >
              <option value="">当前流程：{normalizeFlowConfig(currentFlow).name}</option>
              {displayFlowList.map((flow) => (
                <option key={flow.fileName} value={flow.fileName}>
                  {flow.name}
                </option>
              ))}
            </select>
          </label>
          <div className="display-section-tabs" aria-label="展示页设置分区">
            {displaySettingsSidebarItems.map((item) => (
              <button
                type="button"
                key={item.key}
                className={`secondary ${activeSection === item.key ? 'active' : ''}`}
                onClick={() => onActiveSectionChange(item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <button type="button" className="secondary" onClick={openDisplaySettingsFolder}>
            打开配置文件夹
          </button>
          <button type="button" className="secondary" onClick={openPreviewWindow}>
            打开预览页面
          </button>
          <button type="button" className="primary" onClick={saveSettings}>
            保存展示设置
          </button>
        </div>
      </div>
      <datalist id="display-event-names">
        {availableEventOptions.map((eventName) => (
          <option key={eventName} value={eventName} />
        ))}
      </datalist>

      <div className={`display-settings-layout display-settings-layout-${activeSection}`}>
        {activeSection === 'base' ? (
          <div className="display-settings-column display-settings-left">
            <section className="editor-panel display-settings-panel display-background-panel">
              <header className="panel-header">
                <div>
                  <span>Background</span>
                  <h2>背景 / 底图 / 图层</h2>
                </div>
                <button type="button" onClick={addBackgroundLayer}>
                  添加背景图
                </button>
              </header>
              <div className="background-layer-list">
                {backgroundLayers.map((layer, index) => (
                  <section className="background-layer-card" key={layer.id}>
                    <header>
                      <input
                        className="background-layer-name-input"
                        aria-label="背景图层名称"
                        value={layer.name || `背景 ${index + 1}`}
                        onChange={(event) =>
                          updateBackgroundLayer(layer.id, { name: event.target.value })
                        }
                      />
                      <label className="inline-check">
                        <input
                          type="checkbox"
                          checked={layer.visible}
                          onChange={(event) =>
                            updateBackgroundLayer(layer.id, { visible: event.target.checked })
                          }
                        />
                        显示
                      </label>
                    </header>
                    <div className="asset-field compact">
                      <span>图片</span>
                      <strong title={layer.image}>{fileName(layer.image)}</strong>
                      <button type="button" onClick={() => replaceBackgroundLayerImage(layer.id)}>
                        替换
                      </button>
                    </div>
                    <div className="background-layer-fields">
                      <label>
                        X
                        <input
                          type="number"
                          value={layer.x}
                          onChange={(event) =>
                            updateBackgroundLayer(layer.id, { x: Number(event.target.value) })
                          }
                        />
                      </label>
                      <label>
                        Y
                        <input
                          type="number"
                          value={layer.y}
                          onChange={(event) =>
                            updateBackgroundLayer(layer.id, { y: Number(event.target.value) })
                          }
                        />
                      </label>
                      <label>
                        缩放
                        <input
                          type="number"
                          min="0.01"
                          step="0.05"
                          value={layer.scale}
                          onChange={(event) =>
                            updateBackgroundLayer(layer.id, { scale: Number(event.target.value) })
                          }
                        />
                      </label>
                      <label>
                        透明度
                        <input
                          type="number"
                          min="0"
                          max="1"
                          step="0.05"
                          value={layer.opacity}
                          onChange={(event) =>
                            updateBackgroundLayer(layer.id, { opacity: Number(event.target.value) })
                          }
                        />
                      </label>
                      <label>
                        图层
                        <input
                          type="number"
                          value={layer.layer}
                          onChange={(event) =>
                            updateBackgroundLayer(layer.id, { layer: Number(event.target.value) })
                          }
                        />
                      </label>
                    </div>
                    <div className="form-actions">
                      <button
                        type="button"
                        onClick={() => moveBackgroundLayer(index, -1)}
                        disabled={index === 0}
                      >
                        上移
                      </button>
                      <button
                        type="button"
                        onClick={() => moveBackgroundLayer(index, 1)}
                        disabled={index === backgroundLayers.length - 1}
                      >
                        下移
                      </button>
                      <button
                        type="button"
                        className="danger"
                        onClick={() => removeBackgroundLayer(layer.id)}
                      >
                        删除
                      </button>
                    </div>
                  </section>
                ))}
              </div>
              {backgroundLayers.length === 0 ? (
                <div className="flow-empty">
                  当前没有背景图。点击“添加背景图”后，可以分别调整每一层的位置、缩放和透明度。
                </div>
              ) : null}
            </section>
            <section className="editor-panel display-settings-panel display-audio-volume-panel">
              <header className="panel-header">
                <div>
                  <span>Audio Volume</span>
                  <h2>音量控制</h2>
                </div>
              </header>
              <div className="display-volume-list">
                <DisplayVolumeControl
                  label="BP音效音量"
                  value={settings.bpSoundVolume}
                  onChange={(value) => updateAudioVolume('bpSoundVolume', value)}
                />
                <DisplayVolumeControl
                  label="角色语音音量"
                  value={settings.characterVoiceVolume}
                  onChange={(value) => updateAudioVolume('characterVoiceVolume', value)}
                />
                <DisplayVolumeControl
                  label="角色音效音量"
                  value={settings.characterEffectVolume}
                  onChange={(value) => updateAudioVolume('characterEffectVolume', value)}
                />
              </div>
            </section>
          </div>
        ) : null}

        {activeSection === 'effects' ? (
          <SlotEffectEditor
            effects={settings.slotEffects ?? defaultSlotEffects}
            availableEventOptions={availableEventOptions}
            onChooseVideo={(key, field) =>
              chooseSlotEffectVideo(key, field).catch((error: unknown) =>
                onMessage('error', error instanceof Error ? error.message : String(error))
              )
            }
            onClearVideo={clearSlotEffectVideo}
            onChooseAudio={(key) =>
              chooseSlotEffectAudio(key).catch((error: unknown) =>
                onMessage('error', error instanceof Error ? error.message : String(error))
              )
            }
            onClearAudio={clearSlotEffectAudio}
            onEffectChange={updateSlotEffect}
            onLayoutChange={updateSlotEffectLayout}
            onPreview={() => {
              openPreviewWindow().catch((error: unknown) =>
                onMessage('error', error instanceof Error ? error.message : String(error))
              )
            }}
          />
        ) : null}

        <section className="editor-panel display-settings-panel display-preview-panel">
          <div className="display-preview-stage-shell">
            <div className="display-preview-stage-frame">
              <DisplayCanvas
                settings={settings}
                state={previewState}
                className="settings-display-stage"
                showCenterStage={false}
                showChantVideoSlotGuide
              />
            </div>
          </div>
        </section>

        {activeSection === 'base' ? (
          <section className="editor-panel display-settings-panel display-slot-config-panel">
            <header className="panel-header">
              <div>
                <span>BP Frames</span>
                <h2>BP 框大小 / 位置</h2>
              </div>
            </header>
            <div className="slot-layout-grid">
              {slotLayoutLabels.map((item) => (
                <SlotLayoutEditor
                  key={item.key}
                  label={item.label}
                  layout={settings.slotLayouts[item.key]}
                  slotCount={slotCountForLayout(item.key)}
                  gapCount={gapCountForLayout(item.key)}
                  onNumberChange={(numberKey, value) =>
                    updateSlotLayout(item.key, { [numberKey]: value })
                  }
                  onGapChange={(gapIndex, value) => updateSlotGap(item.key, gapIndex, value)}
                  onSlotCountChange={
                    item.key === 'starPickSecond'
                      ? (value) => updateSecondaryPickCount('star', value)
                      : item.key === 'railPickSecond'
                        ? (value) => updateSecondaryPickCount('rail', value)
                        : item.key === 'starBanSecond'
                          ? (value) => updateSecondaryBanCount('star', value)
                          : item.key === 'railBanSecond'
                            ? (value) => updateSecondaryBanCount('rail', value)
                            : undefined
                  }
                  onDirectionChange={(direction) => updateSlotLayout(item.key, { direction })}
                  onChooseFrame={() => chooseSlotAsset(item.key, 'frameImage')}
                />
              ))}
            </div>
          </section>
        ) : null}

        {activeSection === 'changes' ? (
          <div className="display-settings-column display-settings-left">
            <section className="editor-panel display-settings-panel display-page-change-panel">
              <header className="panel-header">
                <div>
                  <span>Page Changes</span>
                  <h2>背景变化</h2>
                </div>
                <button type="button" onClick={addPageChange}>
                  添加变化
                </button>
              </header>
              <div className="page-change-list">
                {backgroundPageChanges.map((pageChange) => (
                  <PageChangeCard
                    key={pageChange.id}
                    pageChange={pageChange}
                    backgroundLayers={backgroundLayers}
                    onChange={(patch) =>
                      updatePageChange(pageChange.id, {
                        ...patch,
                        target: 'backgroundLayer'
                      })
                    }
                    onRemove={() => removePageChange(pageChange.id)}
                  />
                ))}
              </div>
              {backgroundPageChanges.length === 0 ? (
                <div className="flow-empty">
                  添加变化后，在 BP 流程步骤的“事件触发”列填入对应事件即可触发。
                </div>
              ) : null}
            </section>
          </div>
        ) : null}

        {activeSection === 'changes' ? (
          <section className="editor-panel display-settings-panel display-video-slot-panel">
            <header className="panel-header">
              <div>
                <span>Chant Video</span>
                <h2>唱名视频 / 变化</h2>
              </div>
            </header>
            <VideoSlotEditor
              layout={settings.chantVideoSlot ?? defaultChantVideoSlot}
              changes={chantVideoPageChanges}
              onNumberChange={(numberKey, value) => updateChantVideoSlot({ [numberKey]: value })}
              onVisibleChange={(visible) => updateChantVideoSlot({ visible })}
              onAddChange={addChantVideoChange}
              onChangeChange={updateChantVideoChange}
              onRemoveChange={removeChantVideoChange}
            />
          </section>
        ) : null}
      </div>
    </section>
  )
}

function BpTeamPanel({
  title,
  side,
  picks,
  bans,
  slotCounts,
  protectedIds = new Set<number>(),
  blockedIds = new Set<number>(),
  selectedIds = new Set<number>(),
  onPickClick
}: {
  title: string
  side: BpSide
  picks: BpTeamTarget[]
  bans: BpTeamTarget[]
  slotCounts: { picks: number; bans: number }
  protectedIds?: Set<number>
  blockedIds?: Set<number>
  selectedIds?: Set<number>
  onPickClick?: (side: BpSide, target: Character, index: number) => void
}): React.JSX.Element {
  const pickCount = Math.max(slotCounts.picks, picks.length)
  const banCount = Math.max(slotCounts.bans, bans.length)

  return (
    <aside className={`bp-team-panel ${side}`}>
      <h2>{title}</h2>
      <div className="slot-group ban-group">
        <h3>Ban</h3>
        <div className="ban-slot-grid">
          {Array.from({ length: banCount }).map((_, index) => {
            const target = bans[index]
            const imageUrl = target ? bpBanSlotImage(target) : null

            return (
              <div className="bp-slot ban" key={`ban-${index}`}>
                {imageUrl ? <img src={imageUrl} alt={target ? bpTargetName(target) : ''} /> : null}
              </div>
            )
          })}
        </div>
      </div>
      <div className="slot-group pick-group">
        <h3>Pick</h3>
        <div className="pick-slot-list">
          {Array.from({ length: pickCount }).map((_, index) => {
            const target = picks[index]
            const imageUrl = target ? bpPickSlotImage(target, side) : null
            const characterTarget = target && !isLightConeTarget(target) ? target : null
            const isProtected = Boolean(characterTarget && protectedIds.has(characterTarget.id))
            const isBlocked = Boolean(characterTarget && blockedIds.has(characterTarget.id))
            const isSelected = Boolean(characterTarget && selectedIds.has(characterTarget.id))
            const isInteractive = Boolean(characterTarget && onPickClick && !isBlocked)
            const className = [
              'bp-slot',
              'pick',
              isProtected ? 'protected' : '',
              isBlocked ? 'blocked' : '',
              isSelected ? 'selected' : '',
              isInteractive ? 'interactive' : ''
            ]
              .filter(Boolean)
              .join(' ')
            const content = imageUrl ? (
              <img src={imageUrl} alt={target ? bpTargetName(target) : ''} />
            ) : null

            return isInteractive && characterTarget ? (
              <button
                type="button"
                className={className}
                key={`pick-${index}`}
                title={bpTargetName(characterTarget)}
                onClick={() => onPickClick?.(side, characterTarget, index)}
              >
                {content}
              </button>
            ) : (
              <div className={className} key={`pick-${index}`}>
                {content}
              </div>
            )
          })}
        </div>
      </div>
    </aside>
  )
}

function StartBpPanel({
  active,
  currentFlow,
  displayOnline,
  onMessage,
  onOpenDisplay,
  selectedResultFile,
  onSelectedResultFileChange,
  onResultListRefresh
}: {
  active: boolean
  currentFlow: FlowConfig
  displayOnline: boolean
  onMessage: (type: MessageType, text: string) => void
  onOpenDisplay: () => Promise<void>
  selectedResultFile: string
  onSelectedResultFileChange: (fileName: string) => void
  onResultListRefresh: (preferredFileName?: string) => Promise<void>
}): React.JSX.Element {
  const initialFlow = normalizeFlowConfig(currentFlow)
  const [characters, setCharacters] = useState<Character[]>([])
  const [lightCones, setLightCones] = useState<LightCone[]>([])
  const [bpFlow, setBpFlow] = useState<FlowConfig>(() => initialFlow)
  const [runtime, setRuntime] = useState<BpRuntimeState>(() => createRuntime(initialFlow))
  const [selectedCharacterId, setSelectedCharacterId] = useState<number | null>(null)
  const [selectedLightConeId, setSelectedLightConeId] = useState<number | null>(null)
  const [pairedSelection, setPairedSelection] = useState<{
    star: Character | null
    rail: Character | null
  }>({ star: null, rail: null })
  const [flowList, setFlowList] = useState<FlowListItem[]>([])
  const [selectedFlowFile, setSelectedFlowFile] = useState('')
  const [resultName, setResultName] = useState(() => defaultResultName(initialFlow.name))
  const [activeResultFile, setActiveResultFile] = useState('')
  const [filters, setFilters] = useState({ search: '', element: '', path: '', rarity: '' })
  const [bpMode, setBpMode] = useState<BpPlaybackMode>('manual')
  const [liveDisplaySettings, setLiveDisplaySettings] =
    useState<DisplaySettings>(emptyDisplaySettings)
  const [liveDelayClickProgress, setLiveDelayClickProgress] = useState<LiveDelayProgress>({})
  const [liveCompletedDelayedChangeKeys, setLiveCompletedDelayedChangeKeys] = useState<Set<string>>(
    () => new Set()
  )

  const loadTargetLists = useCallback(async (): Promise<void> => {
    const [nextCharacters, nextLightCones] = await Promise.all([
      window.bpAPI.characters.list(),
      window.bpAPI.lightCones.list()
    ])
    setCharacters(nextCharacters)
    setLightCones(nextLightCones)
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadTargetLists().catch((error: unknown) => onMessage('error', String(error)))
  }, [loadTargetLists, onMessage])

  const loadFlowList = useCallback(async (): Promise<void> => {
    const flows = await window.bpAPI.flows.list()
    setFlowList(flows)
    setSelectedFlowFile((current) =>
      flows.some((flow) => flow.fileName === current) ? current : flows[0]?.fileName || ''
    )
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadFlowList().catch((error: unknown) => onMessage('error', String(error)))
    onResultListRefresh().catch((error: unknown) => onMessage('error', String(error)))
  }, [loadFlowList, onMessage, onResultListRefresh])

  useEffect(() => {
    if (!active) {
      return
    }

    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadFlowList().catch((error: unknown) => onMessage('error', String(error)))
    onResultListRefresh().catch((error: unknown) => onMessage('error', String(error)))
  }, [active, loadFlowList, onMessage, onResultListRefresh])

  useEffect(
    () =>
      window.bpAPI.files.onChanged((event) => {
        if (fileChangeIncludes(event, 'assets', 'characters', 'lightCones')) {
          loadTargetLists().catch((error: unknown) =>
            onMessage('error', error instanceof Error ? error.message : String(error))
          )
        }

        if (fileChangeIncludes(event, 'flows')) {
          loadFlowList().catch((error: unknown) =>
            onMessage('error', error instanceof Error ? error.message : String(error))
          )
        }

        if (fileChangeIncludes(event, 'bpResults')) {
          onResultListRefresh(activeResultFile).catch((error: unknown) =>
            onMessage('error', error instanceof Error ? error.message : String(error))
          )
        }
      }),
    [activeResultFile, loadFlowList, loadTargetLists, onMessage, onResultListRefresh]
  )

  useEffect(() => {
    window.bpAPI.displaySettings
      .get()
      .then(setLiveDisplaySettings)
      .catch((error: unknown) => onMessage('error', String(error)))
    const stopSettings = window.bpAPI.displaySettings.onUpdated(setLiveDisplaySettings)

    return stopSettings
  }, [onMessage])

  const usedCharacterIds = useMemo(
    () =>
      new Set(
        runtime.actions
          .filter((action) => isRosterAction(action.action) && action.targetType === 'character')
          .map((action) => action.targetId)
      ),
    [runtime.actions]
  )
  const usedLightConeIds = useMemo(
    () =>
      new Set(
        runtime.actions
          .filter((action) => isRosterAction(action.action) && action.targetType === 'lightCone')
          .map((action) => action.targetId)
      ),
    [runtime.actions]
  )
  const protectedCharacterIds = useMemo(
    () => ({
      star: new Set(
        runtime.actions
          .filter((action) => action.action === 'protect' && action.starTargetId)
          .map((action) => Number(action.starTargetId))
      ),
      rail: new Set(
        runtime.actions
          .filter((action) => action.action === 'protect' && action.railTargetId)
          .map((action) => Number(action.railTargetId))
      )
    }),
    [runtime.actions]
  )
  const currentPairedAction = runtime.currentStep
    ? isPairedAction(runtime.currentStep.action)
      ? runtime.currentStep.action
      : null
    : null
  const pairedPanelSelectionIds = useMemo(() => {
    const starSelected = new Set<number>()
    const railSelected = new Set<number>()

    if (currentPairedAction === 'protect') {
      if (pairedSelection.star) {
        starSelected.add(pairedSelection.star.id)
      }
      if (pairedSelection.rail) {
        railSelected.add(pairedSelection.rail.id)
      }
    } else if (currentPairedAction === 'borrow') {
      if (pairedSelection.rail) {
        starSelected.add(pairedSelection.rail.id)
      }
      if (pairedSelection.star) {
        railSelected.add(pairedSelection.star.id)
      }
    }

    return { star: starSelected, rail: railSelected }
  }, [currentPairedAction, pairedSelection])

  const filteredCharacters = useMemo(() => {
    const keyword = filters.search.trim().toLowerCase()
    return characters.filter((character) => {
      const matchesKeyword =
        !keyword ||
        character.chinese_name.toLowerCase().includes(keyword) ||
        character.english_name.toLowerCase().includes(keyword)
      const matchesElement = !filters.element || character.element === filters.element
      const matchesPath = !filters.path || character.path === filters.path
      const matchesRarity = !filters.rarity || character.rarity === Number(filters.rarity)

      return matchesKeyword && matchesElement && matchesPath && matchesRarity
    })
  }, [characters, filters])

  const selectedCharacter =
    characters.find((character) => character.id === selectedCharacterId) ?? null
  const selectedLightCone =
    lightCones.find((lightCone) => lightCone.id === selectedLightConeId) ?? null

  const filteredLightCones = useMemo(() => {
    const keyword = filters.search.trim().toLowerCase()
    return lightCones.filter((lightCone) => {
      const matchesKeyword = !keyword || lightCone.name.toLowerCase().includes(keyword)
      const matchesPath = !filters.path || lightCone.path === filters.path
      const matchesRarity = !filters.rarity || lightCone.rarity === Number(filters.rarity)

      return matchesKeyword && matchesPath && matchesRarity
    })
  }, [filters, lightCones])
  const livePendingDelayedChanges = useMemo(
    () =>
      bpMode === 'live'
        ? resolveLivePendingDelayedChanges(
            runtime,
            liveDisplaySettings,
            liveCompletedDelayedChangeKeys,
            liveDelayClickProgress
          )
        : [],
    [bpMode, liveCompletedDelayedChangeKeys, liveDelayClickProgress, liveDisplaySettings, runtime]
  )
  const liveWaitingExtraClick = bpMode === 'live' && livePendingDelayedChanges.length > 0
  const liveExtraClickRemaining = livePendingDelayedChanges.reduce(
    (maxRemaining, pendingChange) => Math.max(maxRemaining, pendingChange.remainingClicks),
    0
  )
  const livePendingSummary =
    livePendingDelayedChanges.length > 0
      ? livePendingDelayedChanges.map((pendingChange) => pendingChange.pageChangeName).join('、')
      : ''
  const liveModeLabel = bpMode === 'live' ? '直播BP' : '手动回放'
  const liveStatusText =
    runtime.status === 'complete'
      ? 'BP 已完成'
      : runtime.currentStep
        ? stepLabel(runtime.currentStep)
        : '等待开始'

  const resetLiveDelayState = useCallback((): void => {
    setLiveDelayClickProgress({})
    setLiveCompletedDelayedChangeKeys(new Set())
  }, [])

  const syncRuntime = async (
    nextRuntime: BpRuntimeState,
    mode: BpPlaybackMode = bpMode,
    flow: FlowConfig = bpFlow
  ): Promise<void> => {
    const upCharacterPvPath = cleanOptionalPath(nextRuntime.upCharacterPvPath)
    const upCharacterPvUrl = upCharacterPvPath
      ? await window.bpAPI.files.toFileUrl(upCharacterPvPath).catch(() => null)
      : null
    const runtimeWithMode = {
      ...withFollowingStep(nextRuntime, flow),
      upCharacterPvPath,
      upCharacterPvUrl,
      upCharacterPvStartTime: normalizePvStartTime(nextRuntime.upCharacterPvStartTime),
      upCharacterPvEndTime: normalizePvEndTime(nextRuntime.upCharacterPvEndTime),
      playbackMode: mode
    }
    setRuntime(runtimeWithMode)
    await window.bpAPI.bp.sendStateToDisplay(runtimeWithMode)
  }

  const startFlow = async (flow: FlowConfig): Promise<void> => {
    const normalizedFlow = normalizeFlowConfig(flow)
    const nextRuntime = createRuntime(normalizedFlow)

    setBpFlow(normalizedFlow)
    setResultName(defaultResultName(normalizedFlow.name))
    setActiveResultFile('')
    setSelectedCharacterId(null)
    setSelectedLightConeId(null)
    setPairedSelection({ star: null, rail: null })
    setBpMode('manual')
    resetLiveDelayState()
    await syncRuntime(nextRuntime, 'manual', normalizedFlow)
  }

  const useCurrentFlow = async (): Promise<void> => {
    await startFlow(currentFlow)
    onMessage('info', '已切换到当前配置流程')
  }

  const loadSelectedFlow = async (): Promise<void> => {
    if (!selectedFlowFile) {
      onMessage('error', '请先选择流程文件')
      return
    }

    const flow = await window.bpAPI.flows.load(selectedFlowFile)
    if (!flow) {
      return
    }

    await startFlow(flow)
    onMessage('success', `已加载 BP 流程：${flow.name}`)
  }

  const resetBp = async (): Promise<void> => {
    const nextRuntime = withUpCharacterPv(createRuntime(bpFlow), runtime)
    setSelectedCharacterId(null)
    setSelectedLightConeId(null)
    setPairedSelection({ star: null, rail: null })
    resetLiveDelayState()
    await syncRuntime(nextRuntime, bpMode)
    onMessage('info', '已重置 BP 本局')
  }

  const startManualReplay = async (): Promise<void> => {
    setBpMode('manual')
    resetLiveDelayState()
    await syncRuntime(runtime, 'manual')
    await onOpenDisplay()
    onMessage('info', '已切换到手动回放')
  }

  const startLiveBp = async (): Promise<void> => {
    const normalizedFlow = normalizeFlowConfig(bpFlow)
    if (normalizedFlow.steps.length === 0) {
      onMessage('error', '请先选择或配置 BP 流程')
      return
    }

    let nextRuntime = runtime
    if (runtime.status === 'complete' && runtime.actions.length > 0) {
      if (!window.confirm('当前 BP 已结束，是否重新开始直播 BP？')) {
        return
      }
      nextRuntime = createRuntime(normalizedFlow)
    } else if (runtime.actions.length > 0) {
      const restart = window.confirm(
        '当前 BP 已进行到一半，是否重新开始直播 BP？取消则继续当前进度。'
      )
      if (restart) {
        nextRuntime = createRuntime(normalizedFlow)
      }
    }

    setBpMode('live')
    resetLiveDelayState()
    await syncRuntime(nextRuntime, 'live', normalizedFlow)
    await onOpenDisplay()
    onMessage('success', '已进入直播 BP 模式')
  }

  const blockPendingExtraClick = (): boolean => {
    if (!liveWaitingExtraClick) {
      return false
    }

    onMessage(
      'error',
      `当前等待额外点击：${livePendingSummary || '展示页变化'}，还需 ${liveExtraClickRemaining} 次`
    )
    return true
  }

  const handleLiveExtraClick = async (): Promise<void> => {
    if (bpMode !== 'live') {
      onMessage('info', '当前不在直播 BP 模式')
      return
    }

    if (livePendingDelayedChanges.length === 0) {
      onMessage('info', '当前没有需要额外点击的延迟变化')
      return
    }

    const sent = await window.bpAPI.bp.sendDisplayReplayClick('delay_extra_click')
    if (!sent) {
      onMessage('error', '展示页未打开，无法触发额外点击')
      return
    }

    const next = applyLivePendingDelayedClicks(
      livePendingDelayedChanges,
      liveCompletedDelayedChangeKeys,
      liveDelayClickProgress
    )
    setLiveCompletedDelayedChangeKeys(next.completedDelayedChangeKeys)
    setLiveDelayClickProgress(next.delayClickProgress)

    const remainingPendingChanges = resolveLivePendingDelayedChanges(
      runtime,
      liveDisplaySettings,
      next.completedDelayedChangeKeys,
      next.delayClickProgress
    )
    const remainingClicks = remainingPendingChanges.reduce(
      (maxRemaining, pendingChange) => Math.max(maxRemaining, pendingChange.remainingClicks),
      0
    )
    onMessage(
      'success',
      remainingClicks > 0 ? `额外点击已触发，还需 ${remainingClicks} 次` : '额外点击已完成'
    )
  }

  const confirmPairedSelection = async (selection: {
    star: Character | null
    rail: Character | null
  }): Promise<void> => {
    const step = runtime.currentStep

    if (!step || !isPairedAction(step.action)) {
      return
    }

    if (blockPendingExtraClick()) {
      return
    }

    if (!selection.star || !selection.rail) {
      onMessage(
        'error',
        step.action === 'protect'
          ? '请分别选择双方要保护的已 Pick 角色'
          : '请分别选择双方要租借的对方已 Pick 角色'
      )
      return
    }

    if (step.action === 'borrow') {
      if (protectedCharacterIds.rail.has(selection.star.id)) {
        onMessage('error', '左侧队不能租借右侧队已保护角色')
        return
      }

      if (protectedCharacterIds.star.has(selection.rail.id)) {
        onMessage('error', '右侧队不能租借左侧队已保护角色')
        return
      }
    }

    const actionRecord: BpActionRecord = {
      stepIndex: step.index,
      side: 'star',
      action: step.action,
      targetType: 'character',
      targetId: 0,
      targetName:
        step.action === 'protect'
          ? `保护：${selection.star.chinese_name} / ${selection.rail.chinese_name}`
          : `租借：左侧队租借 ${selection.star.chinese_name} / 右侧队租借 ${selection.rail.chinese_name}`,
      targetImage: null,
      target: null,
      starTargetId: selection.star.id,
      starTargetName: selection.star.chinese_name,
      starTarget: selection.star,
      railTargetId: selection.rail.id,
      railTargetName: selection.rail.chinese_name,
      railTarget: selection.rail,
      eventName: step.eventName ?? legacyStepEventName(step),
      pageChangeName: step.pageChangeName ?? null,
      pageChangeIndex: step.pageChangeIndex ?? null
    }
    const actions = [...runtime.actions, actionRecord]
    const nextRuntime = withUpCharacterPv(
      buildRuntimeFromActions(bpFlow, actions, runtime.createdAt),
      runtime
    )

    setSelectedCharacterId(null)
    setSelectedLightConeId(null)
    setPairedSelection({ star: null, rail: null })
    await syncRuntime(nextRuntime)
    onMessage('success', `${stepLabel(step)}：${actionRecord.targetName}`)
  }

  const handleTeamPickClick = (panelSide: BpSide, target: Character): void => {
    const step = runtime.currentStep

    if (!step || !isPairedAction(step.action)) {
      return
    }

    if (blockPendingExtraClick()) {
      return
    }

    if (step.action === 'borrow' && protectedCharacterIds[panelSide].has(target.id)) {
      onMessage('error', '该角色已被保护，不能租借')
      return
    }

    const choiceSide = step.action === 'protect' ? panelSide : oppositeSide(panelSide)
    const nextSelection = {
      ...pairedSelection,
      [choiceSide]: target
    }

    setSelectedCharacterId(null)
    setSelectedLightConeId(null)
    setPairedSelection(nextSelection)

    if (nextSelection.star && nextSelection.rail) {
      void confirmPairedSelection(nextSelection)
    }
  }

  const confirmTarget = async (target: Character | LightCone | null): Promise<void> => {
    const step = runtime.currentStep

    if (!step) {
      onMessage('info', '当前没有可确认的步骤')
      return
    }

    if (blockPendingExtraClick()) {
      return
    }

    if (isPairedAction(step.action)) {
      await confirmPairedSelection(pairedSelection)
      return
    }

    if (!target) {
      onMessage('error', step.targetType === 'character' ? '请选择角色' : '请选择光锥')
      return
    }

    const targetIsLightCone = isLightConeTarget(target)
    if (
      (step.targetType === 'character' && targetIsLightCone) ||
      (step.targetType === 'lightCone' && !targetIsLightCone)
    ) {
      onMessage(
        'error',
        step.targetType === 'character' ? '当前步骤只能选择角色' : '当前步骤只能选择光锥'
      )
      return
    }

    if (
      step.targetType === 'character'
        ? usedCharacterIds.has(target.id)
        : usedLightConeIds.has(target.id)
    ) {
      onMessage(
        'error',
        step.targetType === 'character' ? '该角色已经被 Pick 或 Ban' : '该光锥已经被 Pick 或 Ban'
      )
      return
    }

    const actionRecord: BpActionRecord = {
      stepIndex: step.index,
      side: step.side,
      action: step.action,
      targetType: step.targetType,
      targetId: target.id,
      targetName:
        step.targetType === 'character'
          ? (target as Character).chinese_name
          : (target as LightCone).name,
      targetImage:
        step.targetType === 'character'
          ? characterImage(target as Character, step.side)
          : lightConeImage(target as LightCone),
      target,
      eventName: step.eventName ?? legacyStepEventName(step),
      pageChangeName: step.pageChangeName ?? null,
      pageChangeIndex: step.pageChangeIndex ?? null
    }
    const actions = [...runtime.actions, actionRecord]
    const nextRuntime = withUpCharacterPv(
      buildRuntimeFromActions(bpFlow, actions, runtime.createdAt),
      runtime
    )

    setSelectedCharacterId(null)
    setSelectedLightConeId(null)
    setPairedSelection({ star: null, rail: null })
    await syncRuntime(nextRuntime)
    onMessage('success', `${stepLabel(step)}：${actionRecord.targetName}`)
  }

  const confirmSelection = async (): Promise<void> => {
    await confirmTarget(
      runtime.currentStep?.targetType === 'character' ? selectedCharacter : selectedLightCone
    )
  }

  const undoLast = async (): Promise<void> => {
    if (runtime.actions.length === 0) {
      return
    }

    const nextRuntime = withUpCharacterPv(
      buildRuntimeFromActions(bpFlow, runtime.actions.slice(0, -1), runtime.createdAt),
      runtime
    )
    setSelectedCharacterId(null)
    setSelectedLightConeId(null)
    setPairedSelection({ star: null, rail: null })
    resetLiveDelayState()
    await syncRuntime(nextRuntime)
    onMessage('info', '已撤回上一步选择')
  }

  const saveResult = async (): Promise<void> => {
    const name = resultName.trim() || defaultResultName(runtime.flowName)
    const saved = await window.bpAPI.bp.saveResult(buildBpResultPayload(runtime, bpFlow, name))
    setResultName(name)
    setActiveResultFile(saved.fileName)
    onSelectedResultFileChange(saved.fileName)
    await onResultListRefresh(saved.fileName)
    onMessage('success', `BP 结果已保存：${saved.fileName}`)
  }

  const importUpCharacterPv = async (): Promise<void> => {
    const result = await window.bpAPI.files.selectVideo()
    if (result.canceled || !result.path) {
      return
    }

    if (!result.path.toLowerCase().endsWith('.mp4')) {
      onMessage('error', '当前 UP 角色 PV 只支持 .mp4 文件')
      return
    }

    const upCharacterPvPath = result.path
    const upCharacterPvUrl = await window.bpAPI.files.toFileUrl(upCharacterPvPath).catch(() => null)
    const nextRuntime: BpRuntimeState = {
      ...runtime,
      upCharacterPvPath,
      upCharacterPvUrl
    }
    const name = resultName.trim() || defaultResultName(runtime.flowName)
    const targetFileName = activeResultFile || undefined

    await syncRuntime(nextRuntime)
    const saved = await window.bpAPI.bp.saveResult(
      buildBpResultPayload(nextRuntime, bpFlow, name),
      targetFileName
    )

    setResultName(name)
    setActiveResultFile(saved.fileName)
    onSelectedResultFileChange(saved.fileName)
    await onResultListRefresh(saved.fileName)
    onMessage('success', `已导入当前UP角色PV：${result.fileName ?? fileName(upCharacterPvPath)}`)
  }

  const updateUpCharacterPvTime = async (
    field: 'upCharacterPvStartTime' | 'upCharacterPvEndTime',
    value: string
  ): Promise<void> => {
    const normalizedValue =
      field === 'upCharacterPvStartTime' ? normalizePvStartTime(value) : normalizePvEndTime(value)

    try {
      await syncRuntime({
        ...runtime,
        [field]: normalizedValue
      })
    } catch (error) {
      onMessage('error', error instanceof Error ? error.message : String(error))
    }
  }

  const loadSelectedResult = async (): Promise<void> => {
    if (!selectedResultFile) {
      onMessage('error', '请先选择一个已保存结果')
      return
    }

    const bpApi = window.bpAPI.bp as typeof window.bpAPI.bp & {
      loadResult?: (fileName: string) => Promise<BpResult>
    }
    if (!bpApi.loadResult) {
      onMessage('error', '当前窗口缺少读取结果接口，请重启应用后再读取')
      return
    }

    const result = await bpApi.loadResult(selectedResultFile)
    const restored = createRuntimeFromResult(result, bpFlow)

    setBpFlow(restored.flow)
    setResultName(result.name)
    setActiveResultFile(selectedResultFile)
    setSelectedCharacterId(null)
    setSelectedLightConeId(null)
    setPairedSelection({ star: null, rail: null })
    setBpMode('manual')
    resetLiveDelayState()
    await syncRuntime(restored.runtime, 'manual', restored.flow)
    onMessage('success', `已读取 BP 结果：${result.name}`)
  }

  const openBpResultsFolder = async (): Promise<void> => {
    const bpApi = window.bpAPI.bp as typeof window.bpAPI.bp & {
      openResultsFolder?: () => Promise<boolean>
    }
    if (!bpApi.openResultsFolder) {
      onMessage('error', '当前窗口缺少打开 BP 结果文件夹接口')
      return
    }

    try {
      await bpApi.openResultsFolder()
      onMessage('success', '已打开 BP 结果文件夹')
    } catch (error) {
      onMessage('error', error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <section className="bp-workbench">
      <div className="bp-display-toolbar">
        <button
          type="button"
          className={bpMode === 'manual' ? 'active' : ''}
          onClick={startManualReplay}
        >
          手动回放
        </button>
        <button
          type="button"
          className={bpMode === 'live' ? 'primary active' : 'primary'}
          onClick={startLiveBp}
        >
          直播BP
        </button>
      </div>

      <BpTeamPanel
        title="左侧队"
        side="star"
        picks={runtime.starTeam.picks}
        bans={runtime.starTeam.bans}
        slotCounts={runtime.slotCounts.star}
        protectedIds={protectedCharacterIds.star}
        blockedIds={currentPairedAction === 'borrow' ? protectedCharacterIds.star : undefined}
        selectedIds={pairedPanelSelectionIds.star}
        onPickClick={currentPairedAction ? handleTeamPickClick : undefined}
      />

      <main className="bp-center">
        <div className="bp-step-bar">
          <strong>{stepLabel(runtime.currentStep)}</strong>
          <span>
            {runtime.status === 'complete'
              ? '完成'
              : `进度 ${runtime.stepCursor}/${normalizeFlowConfig(bpFlow).steps.length}`}
          </span>
        </div>

        <div className={`bp-live-status ${liveWaitingExtraClick ? 'pending' : ''}`}>
          <strong>当前模式：{liveModeLabel}</strong>
          <span>展示页：{displayOnline ? '已打开' : '未打开'}</span>
          <span>{liveStatusText}</span>
          {liveWaitingExtraClick ? (
            <span>
              等待额外点击：{livePendingSummary || '展示页变化'}，还需 {liveExtraClickRemaining} 次
            </span>
          ) : (
            <span>额外点击：无等待</span>
          )}
          <button
            type="button"
            disabled={bpMode !== 'live' || !liveWaitingExtraClick}
            onClick={handleLiveExtraClick}
          >
            额外点击
          </button>
        </div>

        <div className="bp-session-bar">
          <div className="bp-flow-summary">
            <strong>{bpFlow.name}</strong>
            <span>{bpFlow.steps.length} 个步骤</span>
          </div>
          <label>
            BP 流程
            <select
              value={selectedFlowFile}
              onChange={(event) => setSelectedFlowFile(event.target.value)}
            >
              <option value="">选择流程文件</option>
              {flowList.map((flow) => (
                <option key={flow.fileName} value={flow.fileName}>
                  {flow.name}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={loadSelectedFlow}>
            读取流程
          </button>
          <button type="button" onClick={useCurrentFlow}>
            使用当前配置
          </button>
          <label>
            结果名
            <input value={resultName} onChange={(event) => setResultName(event.target.value)} />
          </label>
          <button type="button" onClick={loadSelectedResult}>
            读取结果
          </button>
          <button type="button" onClick={importUpCharacterPv}>
            导入当前UP角色PV
          </button>
          <div className="bp-up-pv-status" title={runtime.upCharacterPvPath ?? ''}>
            <span>当前UP角色PV</span>
            <strong>{fileName(runtime.upCharacterPvPath)}</strong>
          </div>
          <label className="bp-up-pv-time-field">
            UP PV开始时间
            <input
              type="number"
              min={0}
              step="0.1"
              value={runtime.upCharacterPvStartTime ?? DEFAULT_PV_START_TIME}
              onChange={(event) =>
                void updateUpCharacterPvTime('upCharacterPvStartTime', event.target.value)
              }
            />
          </label>
          <label className="bp-up-pv-time-field">
            UP PV结束时间
            <input
              type="number"
              min={0}
              step="0.1"
              value={runtime.upCharacterPvEndTime ?? DEFAULT_PV_END_TIME}
              onChange={(event) =>
                void updateUpCharacterPvTime('upCharacterPvEndTime', event.target.value)
              }
            />
          </label>
        </div>

        <div className="bp-controls">
          <button type="button" onClick={resetBp}>
            重置本局
          </button>
          <button type="button" onClick={undoLast}>
            撤回当前选择
          </button>
          <button
            type="button"
            onClick={confirmSelection}
            className="primary"
            disabled={liveWaitingExtraClick}
          >
            确认选择
          </button>
          <button type="button" onClick={saveResult}>
            保存结果
          </button>
          <button type="button" onClick={openBpResultsFolder}>
            打开结果文件夹
          </button>
        </div>

        {currentPairedAction ? (
          <div className="bp-change-only-panel">
            <strong>{currentPairedAction === 'protect' ? '保护流程' : '租借流程'}</strong>
            <span>
              {currentPairedAction === 'protect'
                ? '请点击双方已 Pick 角色，选择要保护的角色。'
                : '请点击对方已 Pick 角色，选择要租借的角色。'}
            </span>
            <span>
              左侧队：{pairedSelection.star?.chinese_name ?? '未选择'} / 右侧队：
              {pairedSelection.rail?.chinese_name ?? '未选择'}
            </span>
          </div>
        ) : (
          <>
            <div className="filter-bar">
              <input
                placeholder="搜索角色"
                value={filters.search}
                onChange={(event) =>
                  setFilters((current) => ({ ...current, search: event.target.value }))
                }
              />
              <select
                value={filters.element}
                onChange={(event) =>
                  setFilters((current) => ({ ...current, element: event.target.value }))
                }
              >
                <option value="">全部属性</option>
                {elements.map((element) => (
                  <option key={element} value={element}>
                    {element}
                  </option>
                ))}
              </select>
              <select
                value={filters.path}
                onChange={(event) =>
                  setFilters((current) => ({ ...current, path: event.target.value }))
                }
              >
                <option value="">全部命途</option>
                {paths.map((path) => (
                  <option key={path} value={path}>
                    {path}
                  </option>
                ))}
              </select>
              <select
                value={filters.rarity}
                onChange={(event) =>
                  setFilters((current) => ({ ...current, rarity: event.target.value }))
                }
              >
                <option value="">全部星级</option>
                <option value="5">五星</option>
                <option value="4">四星</option>
              </select>
            </div>

            <div className="bp-character-grid">
              {runtime.currentStep?.targetType === 'lightCone'
                ? filteredLightCones.map((lightCone) => {
                    const isUsed = usedLightConeIds.has(lightCone.id)
                    const isSelected = selectedLightConeId === lightCone.id
                    const imageUrl = lightConeImage(lightCone)

                    return (
                      <button
                        type="button"
                        className={`bp-character-card bp-image-card ${isUsed ? 'used' : ''} ${isSelected ? 'selected' : ''}`}
                        key={lightCone.id}
                        title={lightCone.name}
                        disabled={isUsed || liveWaitingExtraClick}
                        onClick={() => {
                          setSelectedLightConeId(lightCone.id)
                          setSelectedCharacterId(null)
                          void confirmTarget(lightCone)
                        }}
                      >
                        {imageUrl ? <img src={imageUrl} alt={lightCone.name} /> : null}
                      </button>
                    )
                  })
                : filteredCharacters.map((character) => {
                    const isUsed = usedCharacterIds.has(character.id)
                    const isSelected = selectedCharacterId === character.id
                    const imageUrl = bpCharacterImage(character)

                    return (
                      <button
                        type="button"
                        className={`bp-character-card bp-image-card ${isUsed ? 'used' : ''} ${isSelected ? 'selected' : ''}`}
                        key={character.id}
                        title={character.chinese_name}
                        disabled={isUsed || liveWaitingExtraClick}
                        onClick={() => {
                          setSelectedCharacterId(character.id)
                          setSelectedLightConeId(null)
                          void confirmTarget(character)
                        }}
                      >
                        {imageUrl ? <img src={imageUrl} alt={character.chinese_name} /> : null}
                      </button>
                    )
                  })}
            </div>
          </>
        )}
      </main>

      <BpTeamPanel
        title="右侧队"
        side="rail"
        picks={runtime.railTeam.picks}
        bans={runtime.railTeam.bans}
        slotCounts={runtime.slotCounts.rail}
        protectedIds={protectedCharacterIds.rail}
        blockedIds={currentPairedAction === 'borrow' ? protectedCharacterIds.rail : undefined}
        selectedIds={pairedPanelSelectionIds.rail}
        onPickClick={currentPairedAction ? handleTeamPickClick : undefined}
      />
    </section>
  )
}

function ConsolePage(): React.JSX.Element {
  const [activeView, setActiveView] = useState<ConsoleView>('characters')
  const [currentFlow, setCurrentFlow] = useState<FlowConfig>(defaultFlow)
  const [displayOnline, setDisplayOnline] = useState(false)
  const [displaySettingsSection, setDisplaySettingsSection] =
    useState<DisplaySettingsSection>('base')
  const [flowConfigList, setFlowConfigList] = useState<FlowListItem[]>([])
  const [selectedFlowConfigFile, setSelectedFlowConfigFile] = useState('')
  const [displaySettingsList, setDisplaySettingsList] = useState<DisplaySettingsListItem[]>([])
  const [selectedDisplaySettingsFile, setSelectedDisplaySettingsFile] = useState('')
  const [bpResultList, setBpResultList] = useState<BpResultListItem[]>([])
  const [selectedBpResultFile, setSelectedBpResultFile] = useState('')
  const [voiceTimelineList, setVoiceTimelineList] = useState<VoiceTimelineListItem[]>([])
  const [selectedVoiceTimelineFile, setSelectedVoiceTimelineFile] = useState('')
  const [characterSidebarHost, setCharacterSidebarHost] = useState<HTMLDivElement | null>(null)
  const [lightConeSidebarHost, setLightConeSidebarHost] = useState<HTMLDivElement | null>(null)
  const currentFlowRef = useRef<FlowConfig>(defaultFlow)

  const report = useCallback((type: MessageType, text: string): void => {
    if (type === 'error') {
      console.error(text)
      return
    }

    console.info(text)
  }, [])

  const applyCurrentFlow = useCallback((flow: FlowConfig): void => {
    const normalizedFlow = normalizeFlowConfig(flow)
    currentFlowRef.current = normalizedFlow
    setCurrentFlow(normalizedFlow)
  }, [])

  const loadFlowConfigList = useCallback(async (preferredFileName?: string): Promise<void> => {
    const flows = await window.bpAPI.flows.list()
    setFlowConfigList(flows)
    setSelectedFlowConfigFile((current) => {
      const candidate = preferredFileName ?? current
      return flows.some((flow) => flow.fileName === candidate) ? candidate : ''
    })
  }, [])

  const loadDisplaySettingsList = useCallback(async (preferredFileName?: string): Promise<void> => {
    const settingsFiles = await window.bpAPI.displaySettings.list()
    setDisplaySettingsList(settingsFiles)
    setSelectedDisplaySettingsFile((current) => {
      const candidate = preferredFileName ?? current
      if (settingsFiles.some((file) => file.fileName === candidate)) {
        return candidate
      }

      return settingsFiles[0]?.fileName ?? ''
    })
  }, [])

  const loadBpResultList = useCallback(async (preferredFileName?: string): Promise<void> => {
    const results = await window.bpAPI.bp.listResults()
    setBpResultList(results)
    setSelectedBpResultFile((current) => {
      const candidate = preferredFileName ?? current
      if (results.some((result) => result.fileName === candidate)) {
        return candidate
      }

      return results[0]?.fileName ?? ''
    })
  }, [])

  const loadVoiceTimelineList = useCallback(async (preferredFileName?: string): Promise<void> => {
    const files = await window.bpAPI.voiceTimelines.list()
    setVoiceTimelineList(files)
    setSelectedVoiceTimelineFile((current) => {
      const candidate = preferredFileName ?? current
      if (files.some((item) => item.fileName === candidate)) {
        return candidate
      }

      return files[0]?.fileName ?? ''
    })
  }, [])

  const openFlowConfigFolder = useCallback(async (): Promise<void> => {
    try {
      await window.bpAPI.flows.openFolder()
      report('success', '已打开流程配置文件夹')
    } catch (error) {
      report('error', error instanceof Error ? error.message : String(error))
    }
  }, [report])

  const openDisplaySettingsFolder = useCallback(async (): Promise<void> => {
    try {
      await window.bpAPI.displaySettings.openFolder()
      report('success', '已打开展示页配置文件夹')
    } catch (error) {
      report('error', error instanceof Error ? error.message : String(error))
    }
  }, [report])

  const openBpResultFolder = useCallback(async (): Promise<void> => {
    try {
      await window.bpAPI.bp.openResultsFolder()
      report('success', '已打开 BP 结果文件夹')
    } catch (error) {
      report('error', error instanceof Error ? error.message : String(error))
    }
  }, [report])

  const openVoiceTimelineFolder = useCallback(async (): Promise<void> => {
    try {
      await window.bpAPI.voiceTimelines.openFolder()
      report('success', '已打开配音轴文件夹')
    } catch (error) {
      report('error', error instanceof Error ? error.message : String(error))
    }
  }, [report])

  const createFlowConfig = useCallback(async (): Promise<void> => {
    try {
      const flowName = uniqueListName(
        '新建BP流程',
        flowConfigList.map((flow) => flow.name)
      )
      const flow = normalizeFlowConfig({ ...defaultFlow, name: flowName })
      const saved = await window.bpAPI.flows.save(flow)

      setSelectedFlowConfigFile(saved.fileName)
      applyCurrentFlow(flow)
      await loadFlowConfigList(saved.fileName)
      report('success', `已新建 BP 流程配置：${saved.fileName}`)
    } catch (error) {
      report('error', error instanceof Error ? error.message : String(error))
    }
  }, [applyCurrentFlow, flowConfigList, loadFlowConfigList, report])

  const createDisplaySettingsConfig = useCallback(async (): Promise<void> => {
    try {
      const settingsName = uniqueListName(
        '新建展示页配置',
        displaySettingsList.map((item) => item.name)
      )
      const fileName = `${settingsName}.json`

      await window.bpAPI.displaySettings.save(emptyDisplaySettings, fileName)
      setSelectedDisplaySettingsFile(fileName)
      await loadDisplaySettingsList(fileName)
      report('success', `已新建展示页配置：${fileName}`)
    } catch (error) {
      report('error', error instanceof Error ? error.message : String(error))
    }
  }, [displaySettingsList, loadDisplaySettingsList, report])

  const createVoiceTimelineConfig = useCallback(async (): Promise<void> => {
    try {
      const timelineName = uniqueListName(
        '新建配音轴',
        voiceTimelineList.map((item) => item.name)
      )
      const saved = await window.bpAPI.voiceTimelines.save(emptyVoiceTimelineConfig(timelineName))
      setSelectedVoiceTimelineFile(saved.fileName)
      await loadVoiceTimelineList(saved.fileName)
      report('success', `已新建配音轴：${saved.fileName}`)
    } catch (error) {
      report('error', error instanceof Error ? error.message : String(error))
    }
  }, [loadVoiceTimelineList, report, voiceTimelineList])

  const renameFlowConfig = useCallback(
    async (fileName: string, nextName: string): Promise<void> => {
      const renamedName = nextName.trim()
      if (!renamedName) {
        return
      }

      try {
        const saved = await window.bpAPI.flows.rename(fileName, renamedName)
        if (selectedFlowConfigFile === fileName) {
          setSelectedFlowConfigFile(saved.fileName)
          const renamedFlow = await window.bpAPI.flows.load(saved.fileName)
          if (renamedFlow) {
            applyCurrentFlow(renamedFlow)
          }
        }
        await loadFlowConfigList(saved.fileName)
        report('success', `已重命名 BP 流程配置：${renamedName}`)
      } catch (error) {
        report('error', error instanceof Error ? error.message : String(error))
      }
    },
    [applyCurrentFlow, loadFlowConfigList, report, selectedFlowConfigFile]
  )

  const renameDisplaySettingsConfig = useCallback(
    async (fileName: string, nextName: string): Promise<void> => {
      const renamedName = nextName.trim()
      if (!renamedName) {
        return
      }

      try {
        const saved = await window.bpAPI.displaySettings.rename(fileName, renamedName)
        if (selectedDisplaySettingsFile === fileName) {
          setSelectedDisplaySettingsFile(saved.fileName)
        }
        await loadDisplaySettingsList(saved.fileName)
        report('success', `已重命名展示页配置：${renamedName}`)
      } catch (error) {
        report('error', error instanceof Error ? error.message : String(error))
      }
    },
    [loadDisplaySettingsList, report, selectedDisplaySettingsFile]
  )

  const renameBpResult = useCallback(
    async (fileName: string, nextName: string): Promise<void> => {
      const renamedName = nextName.trim()
      if (!renamedName) {
        return
      }

      try {
        const saved = await window.bpAPI.bp.renameResult(fileName, renamedName)
        if (selectedBpResultFile === fileName) {
          setSelectedBpResultFile(saved.fileName)
        }
        await loadBpResultList(saved.fileName)
        report('success', `已重命名 BP 结果：${renamedName}`)
      } catch (error) {
        report('error', error instanceof Error ? error.message : String(error))
      }
    },
    [loadBpResultList, report, selectedBpResultFile]
  )

  const renameVoiceTimeline = useCallback(
    async (fileName: string, nextName: string): Promise<void> => {
      const renamedName = nextName.trim()
      if (!renamedName) {
        return
      }

      try {
        const saved = await window.bpAPI.voiceTimelines.rename(fileName, renamedName)
        if (selectedVoiceTimelineFile === fileName) {
          setSelectedVoiceTimelineFile(saved.fileName)
        }
        await loadVoiceTimelineList(saved.fileName)
        report('success', `已重命名配音轴：${renamedName}`)
      } catch (error) {
        report('error', error instanceof Error ? error.message : String(error))
      }
    },
    [loadVoiceTimelineList, report, selectedVoiceTimelineFile]
  )

  const deleteFlowConfig = useCallback(
    async (fileName: string): Promise<void> => {
      if (!window.confirm(`确定删除 BP 流程配置文件“${fileName}”？`)) {
        return
      }

      try {
        await window.bpAPI.flows.delete(fileName)
        if (selectedFlowConfigFile === fileName) {
          setSelectedFlowConfigFile('')
        }
        await loadFlowConfigList()
        report('success', `已删除 BP 流程配置：${fileName}`)
      } catch (error) {
        report('error', error instanceof Error ? error.message : String(error))
      }
    },
    [loadFlowConfigList, report, selectedFlowConfigFile]
  )

  const deleteDisplaySettingsConfig = useCallback(
    async (fileName: string): Promise<void> => {
      if (!window.confirm(`确定删除展示页配置文件“${fileName}”？`)) {
        return
      }

      try {
        await window.bpAPI.displaySettings.delete(fileName)
        if (selectedDisplaySettingsFile === fileName) {
          setSelectedDisplaySettingsFile('')
        }
        await loadDisplaySettingsList()
        report('success', `已删除展示页配置：${fileName}`)
      } catch (error) {
        report('error', error instanceof Error ? error.message : String(error))
      }
    },
    [loadDisplaySettingsList, report, selectedDisplaySettingsFile]
  )

  const deleteBpResult = useCallback(
    async (fileName: string): Promise<void> => {
      if (!window.confirm(`确定删除已保存 BP 结果“${fileName}”？`)) {
        return
      }

      try {
        await window.bpAPI.bp.deleteResult(fileName)
        if (selectedBpResultFile === fileName) {
          setSelectedBpResultFile('')
        }
        await loadBpResultList()
        report('success', `已删除 BP 结果：${fileName}`)
      } catch (error) {
        report('error', error instanceof Error ? error.message : String(error))
      }
    },
    [loadBpResultList, report, selectedBpResultFile]
  )

  const deleteVoiceTimeline = useCallback(
    async (fileName: string): Promise<void> => {
      if (!window.confirm(`确定删除配音轴“${fileName}”？`)) {
        return
      }

      try {
        await window.bpAPI.voiceTimelines.delete(fileName)
        if (selectedVoiceTimelineFile === fileName) {
          setSelectedVoiceTimelineFile('')
        }
        await loadVoiceTimelineList()
        report('success', `已删除配音轴：${fileName}`)
      } catch (error) {
        report('error', error instanceof Error ? error.message : String(error))
      }
    },
    [loadVoiceTimelineList, report, selectedVoiceTimelineFile]
  )

  useEffect(() => {
    window.bpAPI.bp
      .getDisplayStatus()
      .then(setDisplayOnline)
      .catch(() => setDisplayOnline(false))
  }, [])

  useEffect(() => {
    if (activeView === 'flows') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      loadFlowConfigList().catch((error: unknown) =>
        report('error', error instanceof Error ? error.message : String(error))
      )
    }

    if (activeView === 'displaySettings') {
      loadDisplaySettingsList().catch((error: unknown) =>
        report('error', error instanceof Error ? error.message : String(error))
      )
    }

    if (activeView === 'bp') {
      loadBpResultList().catch((error: unknown) =>
        report('error', error instanceof Error ? error.message : String(error))
      )
    }
    if (activeView === 'voiceTimeline') {
      loadVoiceTimelineList().catch((error: unknown) =>
        report('error', error instanceof Error ? error.message : String(error))
      )
    }
  }, [
    activeView,
    loadBpResultList,
    loadDisplaySettingsList,
    loadFlowConfigList,
    loadVoiceTimelineList,
    report
  ])

  useEffect(
    () =>
      window.bpAPI.files.onChanged((event) => {
        if (fileChangeIncludes(event, 'flows')) {
          loadFlowConfigList(selectedFlowConfigFile).catch((error: unknown) =>
            report('error', error instanceof Error ? error.message : String(error))
          )
        }

        if (fileChangeIncludes(event, 'displaySettings')) {
          loadDisplaySettingsList(selectedDisplaySettingsFile).catch((error: unknown) =>
            report('error', error instanceof Error ? error.message : String(error))
          )
        }

        if (fileChangeIncludes(event, 'bpResults')) {
          loadBpResultList(selectedBpResultFile).catch((error: unknown) =>
            report('error', error instanceof Error ? error.message : String(error))
          )
        }

        if (fileChangeIncludes(event, 'voiceTimelines')) {
          loadVoiceTimelineList(selectedVoiceTimelineFile).catch((error: unknown) =>
            report('error', error instanceof Error ? error.message : String(error))
          )
        }
      }),
    [
      loadBpResultList,
      loadDisplaySettingsList,
      loadFlowConfigList,
      loadVoiceTimelineList,
      report,
      selectedBpResultFile,
      selectedDisplaySettingsFile,
      selectedFlowConfigFile,
      selectedVoiceTimelineFile
    ]
  )

  const openDisplay = async (): Promise<void> => {
    await window.bpAPI.bp.setVoiceTimelinePlayback(null).catch(() => undefined)
    const cachedState = await window.bpAPI.bp.getCurrentState().catch(() => null)

    if (!cachedState) {
      await window.bpAPI.bp
        .sendStateToDisplay(createRuntime(currentFlowRef.current))
        .catch(() => undefined)
    }

    const online = await window.bpAPI.bp.openDisplayWindow()
    setDisplayOnline(online)
    report(online ? 'success' : 'error', online ? '展示页窗口已打开' : '展示页窗口打开失败')
  }

  return (
    <div className="console-shell">
      <aside className="activity-bar" aria-label="主导航">
        {navItems.map((item) => (
          <button
            type="button"
            key={item.key}
            className={activeView === item.key ? 'active' : ''}
            title={item.label}
            aria-label={item.label}
            onClick={() => setActiveView(item.key)}
          >
            <img src={item.icon} alt="" aria-hidden="true" />
          </button>
        ))}
      </aside>

      <aside className="side-panel">
        <div className="product-title">XQB-BPBox</div>
        {activeView === 'flows' ? (
          <SideFileList
            title="BP流程配置文件列表"
            items={flowConfigList}
            selectedFileName={selectedFlowConfigFile}
            emptyText="暂无流程配置文件"
            getMeta={(flow) => formatListTime(flow.updatedAt)}
            onSelect={setSelectedFlowConfigFile}
            onCreate={createFlowConfig}
            onOpenFolder={openFlowConfigFolder}
            onRename={renameFlowConfig}
            onDelete={deleteFlowConfig}
          />
        ) : null}
        {activeView === 'displaySettings' ? (
          <SideFileList
            title="展示页配置列表"
            items={displaySettingsList}
            selectedFileName={selectedDisplaySettingsFile}
            emptyText="暂无展示页配置"
            getMeta={(item) => formatListTime(item.updatedAt)}
            onSelect={setSelectedDisplaySettingsFile}
            onCreate={createDisplaySettingsConfig}
            onOpenFolder={openDisplaySettingsFolder}
            onRename={renameDisplaySettingsConfig}
            onDelete={deleteDisplaySettingsConfig}
          />
        ) : null}
        {activeView === 'bp' ? (
          <SideFileList
            title="已保存 BP 结果列表"
            items={bpResultList}
            selectedFileName={selectedBpResultFile}
            emptyText="暂无已保存 BP 结果"
            getMeta={(result) =>
              `${result.flowName} / ${result.actionCount} 步 / ${formatListTime(result.updatedAt)}`
            }
            onSelect={setSelectedBpResultFile}
            onOpenFolder={openBpResultFolder}
            onRename={renameBpResult}
            onDelete={deleteBpResult}
          />
        ) : null}
        {activeView === 'voiceTimeline' ? (
          <SideFileList
            title="配音轴列表"
            items={voiceTimelineList}
            selectedFileName={selectedVoiceTimelineFile}
            emptyText="暂无配音轴"
            getMeta={(item) =>
              `${item.bpResultName || '未绑定结果'} / ${item.clickPointCount} 点 / ${formatListTime(item.updatedAt)}`
            }
            onSelect={setSelectedVoiceTimelineFile}
            onCreate={createVoiceTimelineConfig}
            onOpenFolder={openVoiceTimelineFolder}
            onRename={renameVoiceTimeline}
            onDelete={deleteVoiceTimeline}
          />
        ) : null}
        {activeView === 'characters' ? (
          <div className="side-editor-host-panel">
            <div className="side-section-title">新增角色</div>
            <div className="side-editor-host" ref={setCharacterSidebarHost} />
          </div>
        ) : null}
        {activeView === 'lightCones' ? (
          <div className="side-editor-host-panel">
            <div className="side-section-title">新增光锥</div>
            <div className="side-editor-host" ref={setLightConeSidebarHost} />
          </div>
        ) : null}
        {activeView === 'displaySettings' ? (
          <div className="side-note">
            <strong>当前流程</strong>
            <span>{currentFlow.name}</span>
            <span>{currentFlow.steps.length} 个步骤</span>
          </div>
        ) : null}
      </aside>

      <main className="workbench">
        {activeView === 'characters' ? (
          <CharacterManager onMessage={report} sidebarHost={characterSidebarHost} />
        ) : null}
        {activeView === 'lightCones' ? (
          <LightConeManager onMessage={report} sidebarHost={lightConeSidebarHost} />
        ) : null}
        {activeView === 'flows' ? (
          <FlowConfigPanel
            onMessage={report}
            onFlowLoaded={applyCurrentFlow}
            selectedFlowFile={selectedFlowConfigFile}
            onSelectedFlowFileChange={setSelectedFlowConfigFile}
            onFlowListRefresh={loadFlowConfigList}
          />
        ) : null}
        {activeView === 'displaySettings' ? (
          <DisplaySettingsPanel
            currentFlow={currentFlow}
            activeSection={displaySettingsSection}
            onActiveSectionChange={setDisplaySettingsSection}
            selectedSettingsFile={selectedDisplaySettingsFile}
            onSelectedSettingsFileChange={setSelectedDisplaySettingsFile}
            onSettingsListRefresh={loadDisplaySettingsList}
            onMessage={report}
          />
        ) : null}
        <div className={activeView === 'bp' ? 'workbench-view' : 'workbench-view hidden'}>
          <StartBpPanel
            active={activeView === 'bp'}
            currentFlow={currentFlow}
            displayOnline={displayOnline}
            onMessage={report}
            onOpenDisplay={openDisplay}
            selectedResultFile={selectedBpResultFile}
            onSelectedResultFileChange={setSelectedBpResultFile}
            onResultListRefresh={loadBpResultList}
          />
        </div>
        <div
          className={activeView === 'voiceTimeline' ? 'workbench-view' : 'workbench-view hidden'}
        >
          <VoiceTimelinePanel
            active={activeView === 'voiceTimeline'}
            selectedVoiceTimelineFile={selectedVoiceTimelineFile}
            onSelectedVoiceTimelineFileChange={setSelectedVoiceTimelineFile}
            onVoiceTimelineListRefresh={loadVoiceTimelineList}
            onMessage={report}
          />
        </div>
      </main>
      <UpdateStatusBar />
    </div>
  )
}

export default ConsolePage
