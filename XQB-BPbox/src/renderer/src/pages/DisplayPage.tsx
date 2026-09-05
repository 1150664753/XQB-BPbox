import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import DisplayCanvas, {
  type CurrentVideoMode,
  type DisplayChantVideo
} from '../components/display/DisplayCanvas'
import type {
  BpAction,
  BpActionRecord,
  BpDisplayReplayClickType,
  BpEventRecord,
  BpRuntimeState,
  BpTeamTarget,
  ChangeEffectMode,
  DisplayPageChange,
  DisplaySlotEffects,
  DisplaySettings,
  FlowStep,
  VoiceTimelineClickPoint,
  VoiceTimelinePlayback
} from '../types/bp'
import type { Character } from '../types/character'
import { playManagedAudio, updateManagedAudioVolume } from '../utils/audioPlayback'
import { displayAudioGain } from '../../../shared/displayAudioVolume'
import {
  DEFAULT_PV_END_TIME,
  DEFAULT_PV_START_TIME,
  getPvPlaybackRange,
  normalizePvEndTime,
  normalizePvStartTime,
  shouldRestartPv
} from '../../../shared/pvPlayback'

const emptyDisplaySettings: DisplaySettings = {
  stageWidth: 1920,
  stageHeight: 1080,
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
  showProtectRentFrame: false,
  protectRentFrameDisplayMode: 'avatar',
  protectRentFrameLayouts: {
    starProtect: {
      x: 345,
      y: 700,
      width: 270,
      height: 110,
      gap: 15,
      gaps: [],
      layer: 12,
      direction: 'horizontal',
      frameImage: '',
      frameImageUrl: null,
      effectVideo: '',
      effectVideoUrl: null
    },
    railProtect: {
      x: 1035,
      y: 700,
      width: 270,
      height: 110,
      gap: 15,
      gaps: [],
      layer: 12,
      direction: 'horizontal',
      frameImage: '',
      frameImageUrl: null,
      effectVideo: '',
      effectVideoUrl: null
    },
    starBorrow: {
      x: 345,
      y: 850,
      width: 270,
      height: 110,
      gap: 15,
      gaps: [],
      layer: 12,
      direction: 'horizontal',
      frameImage: '',
      frameImageUrl: null,
      effectVideo: '',
      effectVideoUrl: null
    },
    railBorrow: {
      x: 1035,
      y: 850,
      width: 270,
      height: 110,
      gap: 15,
      gaps: [],
      layer: 12,
      direction: 'horizontal',
      frameImage: '',
      frameImageUrl: null,
      effectVideo: '',
      effectVideoUrl: null
    }
  },
  slotLayouts: {
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
  },
  secondaryPickCounts: {
    star: 0,
    rail: 0
  },
  secondaryBanCounts: {
    star: 0,
    rail: 0
  },
  slotEffects: {
    pick: {
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
      delayActivateAfterEvents: ['hire_end'],
      keepLoop: false,
      pendingLayout: { x: 0, y: 0, scale: 1 }
    },
    ban: {
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
      delayActivateAfterEvents: ['start'],
      keepLoop: false,
      pendingLayout: { x: 0, y: 0, scale: 1 }
    },
    protect: {
      effectMode: 'continuous',
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
      pendingLayout: { x: 0, y: 0, scale: 1 }
    },
    borrow: {
      effectMode: 'continuous',
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
      pendingLayout: { x: 0, y: 0, scale: 1 }
    }
  },
  chantVideoSlot: {
    x: 645,
    y: 255,
    width: 630,
    height: 390,
    visible: true,
    layer: 20
  }
}

const emptyState: BpRuntimeState = {
  flowName: '默认BP流程',
  createdAt: new Date().toISOString(),
  stepCursor: 0,
  status: 'idle',
  currentStep: null,
  followingStep: null,
  slotCounts: {
    star: {
      picks: 1,
      bans: 1
    },
    rail: {
      picks: 1,
      bans: 1
    }
  },
  starTeam: {
    name: '先手',
    picks: [],
    bans: []
  },
  railTeam: {
    name: '后手',
    picks: [],
    bans: []
  },
  actions: [],
  upCharacterPvPath: null,
  upCharacterPvUrl: null,
  upCharacterPvStartTime: DEFAULT_PV_START_TIME,
  upCharacterPvEndTime: DEFAULT_PV_END_TIME,
  playbackMode: 'manual',
  eventHistory: [],
  currentEvents: [],
  executedPageChangeIds: [],
  currentPageChangeIds: []
}

function normalizePageChangeIndex(value: unknown): number | null {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return null
  }

  return Math.max(1, Math.floor(Number(value)))
}

function normalizePageChangeName(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizeEventName(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizePlaybackMode(value: unknown): BpRuntimeState['playbackMode'] {
  return value === 'live' ? 'live' : 'manual'
}

function legacyActionEventName(
  source: Pick<BpActionRecord | FlowStep, 'pageChangeName' | 'pageChangeIndex'>
): string | null {
  return (
    normalizeEventName(source.pageChangeName) ??
    (source.pageChangeIndex ? String(source.pageChangeIndex) : null)
  )
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

function isPairedAction(action: BpAction): boolean {
  return action === 'protect' || action === 'borrow'
}

function isRosterAction(action: BpAction): boolean {
  return action === 'pick' || action === 'ban'
}

function isEffectSoundAction(action: BpAction): action is keyof DisplaySlotEffects {
  return action === 'pick' || action === 'ban' || action === 'protect' || action === 'borrow'
}

function supportsChangeEffectMode(action: BpAction): boolean {
  return action === 'change'
}

function normalizeChangeEffectMode(value: unknown): ChangeEffectMode {
  return value === 'keep' || value === 'next' || value === 'keepNext' ? value : 'clear'
}

const CHANT_VIDEO_PV_SWITCH_SECONDS = 5
const CHANT_VIDEO_REQUEST_TIMEOUT_MS = 8000
const CHANT_VIDEO_ACTIVE_TIMEOUT_MS = 6500
const PROTECT_VIDEO_END_SWITCH_LEAD_SECONDS = 0.12

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function videoMode(video: DisplayChantVideo | null): CurrentVideoMode | null {
  if (!video) {
    return null
  }

  return video.kind === 'single' ? (video.mode ?? 'voice') : 'voice'
}

function protectVideoPvSwitchTime(duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) {
    return CHANT_VIDEO_PV_SWITCH_SECONDS
  }

  return Math.min(
    CHANT_VIDEO_PV_SWITCH_SECONDS,
    Math.max(0, duration - PROTECT_VIDEO_END_SWITCH_LEAD_SECONDS)
  )
}

function isCharacterTarget(value: unknown): value is Character {
  return Boolean(
    value &&
    typeof value === 'object' &&
    Number.isFinite(Number((value as { id?: unknown }).id)) &&
    typeof (value as { chinese_name?: unknown }).chinese_name === 'string'
  )
}

function resolveActionCharacter(
  action: BpActionRecord,
  characterLookup: Map<number, Character>
): Character | null {
  const actionTargetId = Number(action.targetId)
  const lookupCharacter = Number.isFinite(actionTargetId)
    ? (characterLookup.get(actionTargetId) ?? null)
    : null
  if (isCharacterTarget(action.target)) {
    return lookupCharacter ? { ...action.target, ...lookupCharacter } : action.target
  }

  if (!Number.isFinite(actionTargetId)) {
    return null
  }
  return lookupCharacter
}

const maxEventChainDepth = 8

function uniqueEventNames(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return []
  }

  return [
    ...new Set(values.map(normalizeEventName).filter((value): value is string => Boolean(value)))
  ]
}

function normalizeEventRecords(values: unknown): BpEventRecord[] {
  if (!Array.isArray(values)) {
    return []
  }

  return values
    .map((value): BpEventRecord | null => {
      const record = value && typeof value === 'object' ? (value as BpEventRecord) : null
      const name = normalizeEventName(record?.name)
      if (!record || !name) {
        return null
      }

      return {
        name,
        sourceActionIndex:
          record.sourceActionIndex === null ||
          record.sourceActionIndex === undefined ||
          !Number.isFinite(Number(record.sourceActionIndex))
            ? null
            : Math.floor(Number(record.sourceActionIndex)),
        depth: Math.max(0, Math.floor(Number(record.depth) || 0))
      }
    })
    .filter((record): record is BpEventRecord => record !== null)
}

function pageChangeTriggerEvent(pageChange: DisplayPageChange): string | null {
  return (
    normalizeEventName(pageChange.triggerEvent) ??
    normalizeEventName(pageChange.triggerName) ??
    normalizeEventName(pageChange.name) ??
    (pageChange.index ? String(pageChange.index) : null)
  )
}

function pageChangeEmitEvent(pageChange: DisplayPageChange): string | null {
  return (
    normalizeEventName(pageChange.emitEvent) ??
    normalizeEventName(pageChange.emitEventAfterComplete)
  )
}

function actionEventName(action: BpActionRecord): string | null {
  return normalizeEventName(action.eventName) ?? legacyActionEventName(action)
}

interface PendingDelayedPageChange {
  key: string
  pageChangeId: string
  pageChangeName: string
  requiredClicks: number
  remainingClicks: number
}

interface EventChainResult {
  eventHistory: BpEventRecord[]
  currentEvents: string[]
  executedPageChangeIds: string[]
  currentPageChangeIds: string[]
  pendingDelayedChanges: PendingDelayedPageChange[]
}

interface EventExpansionResult {
  events: BpEventRecord[]
  pageChangeIds: string[]
  pendingDelayedChanges: PendingDelayedPageChange[]
}

interface RuntimeEventSeed {
  name: string
  sourceActionIndex: number | null
}

function pageChangeDelayClickCount(pageChange: DisplayPageChange): number {
  return Math.max(1, Math.floor(Number(pageChange.delayClickCount) || 1))
}

function delayedPageChangeKey(pageChange: DisplayPageChange, eventRecord: BpEventRecord): string {
  return [
    eventRecord.sourceActionIndex ?? 'none',
    eventRecord.depth,
    eventRecord.name,
    pageChange.id
  ].join(':')
}

function expandEventChain(
  seedEvent: string,
  sourceActionIndex: number | null,
  pageChanges: DisplayPageChange[],
  completedDelayedChangeKeys: Set<string>,
  delayClickProgress: Record<string, number>
): EventExpansionResult {
  const records: BpEventRecord[] = []
  const pageChangeIds: string[] = []
  const queue: BpEventRecord[] = [{ name: seedEvent, sourceActionIndex, depth: 0 }]
  const seen = new Set<string>()

  while (queue.length > 0) {
    const current = queue.shift()
    const name = normalizeEventName(current?.name)
    if (!current || !name || current.depth > maxEventChainDepth) {
      continue
    }

    const key = `${name}:${current.sourceActionIndex ?? 'none'}:${current.depth}`
    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    records.push({
      name,
      sourceActionIndex: current.sourceActionIndex ?? null,
      depth: current.depth
    })

    if (current.depth >= maxEventChainDepth) {
      continue
    }

    const pendingDelayedChanges: PendingDelayedPageChange[] = []
    for (const pageChange of pageChanges) {
      if (pageChangeTriggerEvent(pageChange) !== name) {
        continue
      }

      const delayKey = delayedPageChangeKey(pageChange, {
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

      pageChangeIds.push(pageChange.id)

      const emitEvent = pageChangeEmitEvent(pageChange)
      if (emitEvent) {
        queue.push({
          name: emitEvent,
          sourceActionIndex: current.sourceActionIndex ?? null,
          depth: current.depth + 1
        })
      }
    }

    if (pendingDelayedChanges.length > 0) {
      return {
        events: records,
        pageChangeIds,
        pendingDelayedChanges
      }
    }
  }

  return {
    events: records,
    pageChangeIds,
    pendingDelayedChanges: []
  }
}

function runtimeEventSeeds(state: BpRuntimeState): RuntimeEventSeed[] {
  const seeds: RuntimeEventSeed[] = []
  if (state.status !== 'idle') {
    seeds.push({ name: 'start', sourceActionIndex: null })
  }

  state.actions.forEach((action) => {
    const seedEvent = actionEventName(action)
    if (seedEvent) {
      seeds.push({ name: seedEvent, sourceActionIndex: action.stepIndex })
    }
  })

  if (state.status === 'complete') {
    seeds.push({ name: 'end', sourceActionIndex: null })
  }

  return seeds
}

function resolveRuntimeEvents(
  state: BpRuntimeState,
  pageChanges: DisplayPageChange[],
  completedDelayedChangeKeys: Set<string>,
  delayClickProgress: Record<string, number>
): EventChainResult {
  const eventHistory: BpEventRecord[] = []
  const executedPageChangeIds: string[] = []
  let currentEvents: string[] = []
  let currentPageChangeIds: string[] = []
  let pendingDelayedChanges: PendingDelayedPageChange[] = []
  const seeds = runtimeEventSeeds(state)

  for (let index = 0; index < seeds.length; index += 1) {
    const seed = seeds[index]
    const result = expandEventChain(
      seed.name,
      seed.sourceActionIndex,
      pageChanges,
      completedDelayedChangeKeys,
      delayClickProgress
    )
    eventHistory.push(...result.events)
    executedPageChangeIds.push(...result.pageChangeIds)

    if (index === seeds.length - 1) {
      currentEvents = result.events.map((record) => record.name)
      currentPageChangeIds = result.pageChangeIds
    }

    if (result.pendingDelayedChanges.length > 0) {
      currentEvents = result.events.map((record) => record.name)
      currentPageChangeIds = result.pageChangeIds
      pendingDelayedChanges = result.pendingDelayedChanges
      break
    }
  }

  return {
    eventHistory,
    currentEvents: [...new Set(currentEvents)],
    executedPageChangeIds: [...new Set(executedPageChangeIds)],
    currentPageChangeIds: [...new Set(currentPageChangeIds)],
    pendingDelayedChanges
  }
}

function shouldResetDelayTracking(
  currentState: BpRuntimeState,
  nextState: BpRuntimeState
): boolean {
  return (
    currentState.createdAt !== nextState.createdAt ||
    currentState.playbackMode !== nextState.playbackMode ||
    nextState.actions.length < currentState.actions.length ||
    nextState.stepCursor < currentState.stepCursor
  )
}

function shouldInterruptVideoForRuntimeUpdate(
  currentState: BpRuntimeState,
  nextState: BpRuntimeState
): boolean {
  const currentAction = currentState.actions.at(-1)
  const nextAction = nextState.actions.at(-1)
  const mediaContextChanged =
    currentState.createdAt !== nextState.createdAt ||
    currentState.playbackMode !== nextState.playbackMode ||
    currentState.upCharacterPvPath !== nextState.upCharacterPvPath ||
    currentState.upCharacterPvUrl !== nextState.upCharacterPvUrl ||
    currentState.upCharacterPvStartTime !== nextState.upCharacterPvStartTime ||
    currentState.upCharacterPvEndTime !== nextState.upCharacterPvEndTime

  if (mediaContextChanged) {
    return true
  }

  const appendedMediaNeutralAction =
    ((nextAction?.action === 'ban' && nextAction.targetType === 'lightCone') ||
      nextAction?.action === 'borrow') &&
    nextState.actions.length === currentState.actions.length + 1 &&
    nextState.stepCursor >= currentState.stepCursor

  if (appendedMediaNeutralAction) {
    return false
  }

  return (
    currentState.stepCursor !== nextState.stepCursor ||
    currentState.actions.length !== nextState.actions.length ||
    currentAction?.stepIndex !== nextAction?.stepIndex ||
    currentAction?.action !== nextAction?.action ||
    currentAction?.targetId !== nextAction?.targetId ||
    currentAction?.starTargetId !== nextAction?.starTargetId ||
    currentAction?.railTargetId !== nextAction?.railTargetId
  )
}

function normalizeStep(step: FlowStep | null | undefined): FlowStep | null {
  if (!step) {
    return null
  }
  const action = normalizeBpAction(step.action)

  return {
    index: Math.max(1, Math.floor(Number(step.index) || 1)),
    side: step.side === 'rail' ? 'rail' : 'star',
    action,
    targetType:
      action === 'change'
        ? 'none'
        : isPairedAction(action)
          ? 'character'
          : step.targetType === 'lightCone'
            ? 'lightCone'
            : 'character',
    changeEffectMode: supportsChangeEffectMode(action)
      ? normalizeChangeEffectMode(step.changeEffectMode)
      : undefined,
    eventName: normalizeEventName(step.eventName) ?? legacyActionEventName(step),
    pageChangeName: normalizePageChangeName(step.pageChangeName),
    pageChangeIndex: normalizePageChangeIndex(step.pageChangeIndex)
  }
}

function normalizeRuntimeState(state: BpRuntimeState | null): BpRuntimeState {
  if (!state) {
    return emptyState
  }

  const actions: BpActionRecord[] = Array.isArray(state.actions)
    ? (state.actions as unknown[]).map((rawAction) => {
        const action =
          rawAction && typeof rawAction === 'object'
            ? (rawAction as BpActionRecord)
            : ({} as BpActionRecord)
        const bpAction = normalizeBpAction(action.action)

        const normalizedAction: BpActionRecord = {
          ...action,
          side: action.side === 'rail' ? 'rail' : 'star',
          action: bpAction,
          targetType:
            bpAction === 'change'
              ? 'none'
              : isPairedAction(bpAction)
                ? 'character'
                : action.targetType === 'lightCone'
                  ? 'lightCone'
                  : 'character',
          changeEffectMode: supportsChangeEffectMode(bpAction)
            ? normalizeChangeEffectMode(action.changeEffectMode)
            : undefined,
          eventName: normalizeEventName(action.eventName) ?? legacyActionEventName(action),
          pageChangeName: normalizePageChangeName(action.pageChangeName),
          pageChangeIndex: normalizePageChangeIndex(action.pageChangeIndex)
        }

        return normalizedAction
      })
    : []

  return {
    ...emptyState,
    ...state,
    flowName: state.flowName || emptyState.flowName,
    createdAt: state.createdAt || new Date().toISOString(),
    stepCursor: Math.max(0, Math.floor(Number(state.stepCursor) || 0)),
    status: state.status === 'complete' || state.status === 'running' ? state.status : 'idle',
    playbackMode: normalizePlaybackMode(state.playbackMode),
    upCharacterPvPath: optionalString(state.upCharacterPvPath),
    upCharacterPvUrl: optionalString(state.upCharacterPvUrl),
    upCharacterPvStartTime: normalizePvStartTime(state.upCharacterPvStartTime),
    upCharacterPvEndTime: normalizePvEndTime(state.upCharacterPvEndTime),
    currentStep: normalizeStep(state.currentStep),
    followingStep: normalizeStep(state.followingStep),
    slotCounts: {
      star: {
        picks: Math.max(0, Math.floor(Number(state.slotCounts?.star?.picks) || 0)),
        bans: Math.max(0, Math.floor(Number(state.slotCounts?.star?.bans) || 0))
      },
      rail: {
        picks: Math.max(0, Math.floor(Number(state.slotCounts?.rail?.picks) || 0)),
        bans: Math.max(0, Math.floor(Number(state.slotCounts?.rail?.bans) || 0))
      }
    },
    starTeam: {
      name: state.starTeam?.name || emptyState.starTeam.name,
      picks: Array.isArray(state.starTeam?.picks) ? state.starTeam.picks : [],
      bans: Array.isArray(state.starTeam?.bans) ? state.starTeam.bans : []
    },
    railTeam: {
      name: state.railTeam?.name || emptyState.railTeam.name,
      picks: Array.isArray(state.railTeam?.picks) ? state.railTeam.picks : [],
      bans: Array.isArray(state.railTeam?.bans) ? state.railTeam.bans : []
    },
    actions,
    eventHistory: normalizeEventRecords(state.eventHistory),
    currentEvents: uniqueEventNames(state.currentEvents),
    executedPageChangeIds: uniqueEventNames(state.executedPageChangeIds),
    currentPageChangeIds: uniqueEventNames(state.currentPageChangeIds)
  }
}

function actionToStep(action: BpActionRecord | undefined): FlowStep | null {
  if (!action) {
    return null
  }
  const bpAction = normalizeBpAction(action.action)

  return {
    index: Math.max(1, Math.floor(Number(action.stepIndex) || 1)),
    side: action.side === 'rail' ? 'rail' : 'star',
    action: bpAction,
    targetType:
      bpAction === 'change'
        ? 'none'
        : isPairedAction(bpAction)
          ? 'character'
          : action.targetType === 'lightCone'
            ? 'lightCone'
            : 'character',
    changeEffectMode: supportsChangeEffectMode(bpAction)
      ? normalizeChangeEffectMode(action.changeEffectMode)
      : undefined,
    eventName: normalizeEventName(action.eventName) ?? legacyActionEventName(action),
    pageChangeName: normalizePageChangeName(action.pageChangeName),
    pageChangeIndex: normalizePageChangeIndex(action.pageChangeIndex)
  }
}

function pendingActionFromStep(step: FlowStep | null): BpActionRecord | null {
  if (!step || (step.action !== 'pick' && step.action !== 'ban')) {
    return null
  }

  return {
    stepIndex: step.index,
    side: step.side,
    action: step.action,
    targetType: step.targetType,
    targetId: 0,
    targetName: '',
    targetImage: null,
    target: null,
    eventName: step.eventName ?? legacyActionEventName(step),
    pageChangeName: step.pageChangeName ?? null,
    pageChangeIndex: step.pageChangeIndex ?? null
  }
}

function buildReplayState(sourceState: BpRuntimeState, cursor: number): BpRuntimeState {
  const actions = sourceState.actions.slice(
    0,
    Math.max(0, Math.min(cursor, sourceState.actions.length))
  )
  const reachedRecordedEnd = actions.length >= sourceState.actions.length
  const status =
    sourceState.status === 'complete' && reachedRecordedEnd
      ? 'complete'
      : sourceState.status === 'idle' && actions.length === 0
        ? 'idle'
        : 'running'
  const replayState: BpRuntimeState = {
    ...sourceState,
    stepCursor: actions.length,
    status,
    currentStep: reachedRecordedEnd ? sourceState.currentStep : actionToStep(actions.at(-1)),
    starTeam: {
      name: sourceState.starTeam.name,
      picks: [],
      bans: []
    },
    railTeam: {
      name: sourceState.railTeam.name,
      picks: [],
      bans: []
    },
    actions
  }

  actions.forEach((action) => {
    if (!isRosterAction(action.action) || !action.target) {
      return
    }

    const teamKey = action.side === 'star' ? 'starTeam' : 'railTeam'
    const slotKey = action.action === 'pick' ? 'picks' : 'bans'
    replayState[teamKey][slotKey].push(action.target as BpTeamTarget)
  })

  return replayState
}

function pairedDisplayEffectKey(action: BpActionRecord | null | undefined): string | null {
  return action && isPairedAction(action.action) ? `${action.action}-${action.stepIndex}` : null
}

function pairedEffectKeysFromActions(actions: BpActionRecord[]): string[] {
  return actions
    .map((action) => pairedDisplayEffectKey(action))
    .filter((key): key is string => Boolean(key))
}

function normalizeTimelineClickPoints(
  clickPoints: VoiceTimelineClickPoint[] | null | undefined
): VoiceTimelineClickPoint[] {
  if (!Array.isArray(clickPoints)) {
    return []
  }

  return [...clickPoints]
    .map((point): VoiceTimelineClickPoint | null => {
      const type = point?.type === 'delay_extra_click' ? 'delay_extra_click' : 'bp_step'
      const time = Number(point?.time)
      if (!Number.isFinite(time) || time < 0) {
        return null
      }

      return {
        ...point,
        type,
        time
      }
    })
    .filter((point): point is VoiceTimelineClickPoint => point !== null)
    .sort((left, right) => {
      if (left.time !== right.time) {
        return left.time - right.time
      }
      if (left.type === right.type) {
        return String(left.id).localeCompare(String(right.id))
      }
      return left.type === 'delay_extra_click' ? -1 : 1
    })
}

interface TimelineReplayProgress {
  cursor: number
  completedDelayedChangeKeys: Set<string>
  delayClickProgress: Record<string, number>
  clickIndex: number
}

interface PendingUpPvContext {
  key: string
}

function applyPendingDelayedClicks(
  pendingDelayedChanges: PendingDelayedPageChange[],
  completedDelayedChangeKeys: Set<string>,
  delayClickProgress: Record<string, number>
): {
  completedDelayedChangeKeys: Set<string>
  delayClickProgress: Record<string, number>
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

function buildTimelineReplayProgress(
  sourceState: BpRuntimeState,
  pageChanges: DisplayPageChange[],
  clickPoints: VoiceTimelineClickPoint[],
  time: number
): TimelineReplayProgress {
  const points = clickPoints.filter((point) => point.time <= time + 0.001)
  let cursor = 0
  let completedDelayedChangeKeys = new Set<string>()
  let delayClickProgress: Record<string, number> = {}

  for (const point of points) {
    const replayState = buildReplayState(sourceState, cursor)
    const pendingDelayedChanges = resolveRuntimeEvents(
      replayState,
      pageChanges,
      completedDelayedChangeKeys,
      delayClickProgress
    ).pendingDelayedChanges

    if (point.type === 'delay_extra_click') {
      if (pendingDelayedChanges.length === 0) {
        continue
      }
      const next = applyPendingDelayedClicks(
        pendingDelayedChanges,
        completedDelayedChangeKeys,
        delayClickProgress
      )
      completedDelayedChangeKeys = next.completedDelayedChangeKeys
      delayClickProgress = next.delayClickProgress
      continue
    }

    if (pendingDelayedChanges.length > 0) {
      const next = applyPendingDelayedClicks(
        pendingDelayedChanges,
        completedDelayedChangeKeys,
        delayClickProgress
      )
      completedDelayedChangeKeys = next.completedDelayedChangeKeys
      delayClickProgress = next.delayClickProgress
      continue
    }

    cursor = Math.min(cursor + 1, sourceState.actions.length)
  }

  return {
    cursor,
    completedDelayedChangeKeys,
    delayClickProgress,
    clickIndex: points.length
  }
}

function DisplayPage(): React.JSX.Element {
  const [settings, setSettings] = useState<DisplaySettings>(emptyDisplaySettings)
  const [sourceState, setSourceState] = useState<BpRuntimeState>(emptyState)
  const [replayCursor, setReplayCursor] = useState(0)
  const [chantVideo, setChantVideo] = useState<DisplayChantVideo | null>(null)
  const [preloadChantVideo, setPreloadChantVideo] = useState<DisplayChantVideo | null>(null)
  const [completedDelayedChangeKeys, setCompletedDelayedChangeKeys] = useState<Set<string>>(
    () => new Set()
  )
  const [delayClickProgress, setDelayClickProgress] = useState<Record<string, number>>({})
  const [dismissedEffectKeys, setDismissedEffectKeys] = useState<Set<string>>(() => new Set())
  const [completedPageChangeIds, setCompletedPageChangeIds] = useState<Set<string>>(() => new Set())
  const [voiceTimelinePlayback, setVoiceTimelinePlayback] = useState<VoiceTimelinePlayback | null>(
    null
  )
  const [voiceTimelinePlaybackReady, setVoiceTimelinePlaybackReady] = useState(false)
  const [characterLookup, setCharacterLookup] = useState<Map<number, Character>>(() => new Map())
  const [resolvedUpCharacterPvUrl, setResolvedUpCharacterPvUrl] = useState<string | null>(null)
  const completedDelayedChangeKeysRef = useRef<Set<string>>(new Set())
  const delayClickProgressRef = useRef<Record<string, number>>({})
  const completedPageChangeIdsRef = useRef<Set<string>>(new Set())
  const activePageChangeIdsRef = useRef<Set<string>>(new Set())
  const pageChangeCompletionTimersRef = useRef<Map<string, number>>(new Map())
  const sourceStateRef = useRef<BpRuntimeState>(emptyState)
  const lastPlayedCursorRef = useRef(0)
  const suppressNextClickRef = useRef(false)
  const bpSoundAudiosRef = useRef<Set<HTMLAudioElement>>(new Set())
  const characterVoiceAudiosRef = useRef<Set<HTMLAudioElement>>(new Set())
  const characterEffectAudiosRef = useRef<Set<HTMLAudioElement>>(new Set())
  const voiceTimelineAudioRef = useRef<HTMLAudioElement | null>(null)
  const voiceTimelineClickIndexRef = useRef(0)
  const voiceTimelineClickPointsRef = useRef<VoiceTimelineClickPoint[]>([])
  const voiceTimelineSessionKeyRef = useRef<string>('')
  const voiceTimelineAppliedSessionKeyRef = useRef<string>('')
  const voiceTimelinePlayingRef = useRef(false)
  const voiceTimelineLinkedRef = useRef(false)
  const voiceTimelineFrameRef = useRef<number | null>(null)
  const voiceTimelinePlayRetryRef = useRef<number | null>(null)
  const performReplayClickRef = useRef<(clickType?: BpDisplayReplayClickType) => void>(
    () => undefined
  )
  const queuedChantVideoRef = useRef<DisplayChantVideo | null>(null)
  const chantVideoRef = useRef<DisplayChantVideo | null>(null)
  const chantVideoInstanceRef = useRef(0)
  const currentVideoModeRef = useRef<CurrentVideoMode | null>(null)
  const chantVideoSwitchTimeoutRef = useRef<number | null>(null)
  const upCharacterPvCurrentTimeRef = useRef(0)
  const upCharacterPvPathRef = useRef<string | null>(null)
  const upCharacterPvStartTimeRef = useRef(DEFAULT_PV_START_TIME)
  const resolvedUpCharacterPvUrlRef = useRef<string | null>(null)
  const pvRestartedVideoKeyRef = useRef<string | number | null>(null)
  const pendingUpPvContextRef = useRef<PendingUpPvContext | null>(null)
  const pendingIdleUpPvKeyRef = useRef<string | null>(null)
  const openingUpPvSessionRef = useRef({
    contextKey: '',
    hasPlayedFirstAction: false,
    lastReplayCursor: 0,
    started: false
  })
  const openingUpPvResetPendingRef = useRef(false)
  const bpSoundVolume = displayAudioGain(settings, 'bpSoundVolume')
  const characterVoiceVolume = displayAudioGain(settings, 'characterVoiceVolume')
  const characterEffectVolume = displayAudioGain(settings, 'characterEffectVolume')
  const characterVoiceVolumeRef = useRef(characterVoiceVolume)

  const clearPreloadedPvVideo = useCallback((): void => {
    setPreloadChantVideo(null)
  }, [])

  const clearChantVideoSwitchTimeout = useCallback((): void => {
    if (chantVideoSwitchTimeoutRef.current !== null) {
      window.clearTimeout(chantVideoSwitchTimeoutRef.current)
      chantVideoSwitchTimeoutRef.current = null
    }
  }, [])

  const preloadPvVideo = useCallback((video: DisplayChantVideo | null): void => {
    if (video?.kind !== 'single' || video.mode === 'voice') {
      setPreloadChantVideo(null)
      return
    }

    setPreloadChantVideo(video)
  }, [])

  const cancelPendingChantPvSwitch = useCallback((): void => {
    clearChantVideoSwitchTimeout()
    queuedChantVideoRef.current = null
    clearPreloadedPvVideo()
  }, [clearChantVideoSwitchTimeout, clearPreloadedPvVideo])

  const withVideoInstanceKey = useCallback((video: DisplayChantVideo): DisplayChantVideo => {
    chantVideoInstanceRef.current += 1
    return {
      ...video,
      key: `${video.key}-${chantVideoInstanceRef.current}`
    }
  }, [])

  const commitChantVideo = useCallback((video: DisplayChantVideo | null): void => {
    chantVideoRef.current = video
    setChantVideo(video)
  }, [])

  const buildUpPvVideo = useCallback(
    (key: string, url: string): DisplayChantVideo => ({
      kind: 'single',
      key,
      url,
      startTime: upCharacterPvCurrentTimeRef.current,
      pvStartTime: normalizePvStartTime(sourceStateRef.current.upCharacterPvStartTime),
      pvEndTime: normalizePvEndTime(sourceStateRef.current.upCharacterPvEndTime),
      mode: 'upPv'
    }),
    []
  )

  const hideChantVideo = useCallback((): void => {
    cancelPendingChantPvSwitch()
    pendingUpPvContextRef.current = null
    pendingIdleUpPvKeyRef.current = null
    currentVideoModeRef.current = null
    commitChantVideo(null)
  }, [cancelPendingChantPvSwitch, commitChantVideo])

  const applyUpdatedSettings = useCallback((nextSettings: DisplaySettings): void => {
    setSettings(nextSettings)
    const source = sourceStateRef.current
    const appliedActionCount =
      source.playbackMode === 'live'
        ? source.actions.length
        : Math.min(lastPlayedCursorRef.current, source.actions.length)
    setDismissedEffectKeys(
      new Set(pairedEffectKeysFromActions(source.actions.slice(0, appliedActionCount)))
    )
  }, [])

  const showIdleUpPv = useCallback(
    (key: string, forceRestart = false): boolean => {
      const upPvUrl = resolvedUpCharacterPvUrlRef.current

      pendingUpPvContextRef.current = null
      cancelPendingChantPvSwitch()

      if (!upPvUrl) {
        pendingIdleUpPvKeyRef.current = key
        currentVideoModeRef.current = null
        commitChantVideo(null)
        return false
      }

      if (!forceRestart && currentVideoModeRef.current === 'upPv') {
        pendingIdleUpPvKeyRef.current = null
        return true
      }

      const upPvVideo = withVideoInstanceKey(buildUpPvVideo(`${key}-${upPvUrl}`, upPvUrl))

      pendingIdleUpPvKeyRef.current = null
      currentVideoModeRef.current = 'upPv'
      commitChantVideo(upPvVideo)
      return true
    },
    [buildUpPvVideo, cancelPendingChantPvSwitch, commitChantVideo, withVideoInstanceKey]
  )

  const rememberUpPvProgress = useCallback(
    (video: DisplayChantVideo, currentTime: number, duration: number): void => {
      if (video.kind !== 'single' || video.mode !== 'upPv') {
        return
      }

      const range = getPvPlaybackRange(duration, video.pvStartTime, video.pvEndTime)
      upCharacterPvCurrentTimeRef.current = shouldRestartPv(currentTime, range)
        ? (range?.startTime ?? normalizePvStartTime(video.pvStartTime))
        : Number.isFinite(currentTime)
          ? Math.max(0, currentTime)
          : upCharacterPvCurrentTimeRef.current
    },
    []
  )

  const restartPvFromConfiguredStart = useCallback(
    (video: DisplayChantVideo, duration: number): boolean => {
      if (video.kind !== 'single' || (video.mode !== 'characterPv' && video.mode !== 'upPv')) {
        return false
      }

      if (pvRestartedVideoKeyRef.current === video.key) {
        return true
      }

      const range = getPvPlaybackRange(duration, video.pvStartTime, video.pvEndTime)
      const startTime = range?.startTime ?? normalizePvStartTime(video.pvStartTime)
      const replayVideo = withVideoInstanceKey({
        ...video,
        startTime
      })

      pvRestartedVideoKeyRef.current = video.key
      if (video.mode === 'upPv') {
        upCharacterPvCurrentTimeRef.current = startTime
      }
      currentVideoModeRef.current = video.mode
      commitChantVideo(replayVideo)
      return true
    },
    [commitChantVideo, withVideoInstanceKey]
  )

  const takeQueuedPvVideo = useCallback((): DisplayChantVideo | null => {
    const queuedVideo = queuedChantVideoRef.current
    queuedChantVideoRef.current = null

    if (queuedVideo) {
      pendingUpPvContextRef.current = null

      if (queuedVideo.kind === 'single' && queuedVideo.mode === 'upPv') {
        return {
          ...queuedVideo,
          startTime: upCharacterPvCurrentTimeRef.current
        }
      }

      return queuedVideo
    }

    const pendingUpPvContext = pendingUpPvContextRef.current
    const upPvUrl = resolvedUpCharacterPvUrlRef.current

    if (!pendingUpPvContext || !upPvUrl) {
      return null
    }

    pendingUpPvContextRef.current = null
    return withVideoInstanceKey(buildUpPvVideo(`${pendingUpPvContext.key}-${upPvUrl}`, upPvUrl))
  }, [buildUpPvVideo, withVideoInstanceKey])

  const switchVoiceToQueuedPv = useCallback((): boolean => {
    if (currentVideoModeRef.current !== 'voice') {
      return false
    }

    const queuedVideo = takeQueuedPvVideo()

    if (!queuedVideo) {
      return false
    }

    clearChantVideoSwitchTimeout()
    clearPreloadedPvVideo()
    currentVideoModeRef.current = videoMode(queuedVideo)
    commitChantVideo(queuedVideo)
    return true
  }, [clearChantVideoSwitchTimeout, clearPreloadedPvVideo, commitChantVideo, takeQueuedPvVideo])

  const scheduleChantVideoSwitchTimeout = useCallback(
    (videoKey: string | number, timeoutMs: number): void => {
      clearChantVideoSwitchTimeout()
      chantVideoSwitchTimeoutRef.current = window.setTimeout(() => {
        chantVideoSwitchTimeoutRef.current = null

        if (currentVideoModeRef.current !== 'voice' || chantVideoRef.current?.key !== videoKey) {
          return
        }

        if (switchVoiceToQueuedPv()) {
          return
        }

        showIdleUpPv(`idle-after-voice-timeout-${String(videoKey)}`)
      }, timeoutMs)
    },
    [clearChantVideoSwitchTimeout, showIdleUpPv, switchVoiceToQueuedPv]
  )

  const showChantVideo = useCallback(
    (video: DisplayChantVideo, pvVideo: DisplayChantVideo | null = null): void => {
      cancelPendingChantPvSwitch()
      const nextVideo = withVideoInstanceKey(video)
      const nextQueuedVideo = pvVideo ? withVideoInstanceKey(pvVideo) : null
      pendingIdleUpPvKeyRef.current = null
      queuedChantVideoRef.current = nextQueuedVideo
      currentVideoModeRef.current = videoMode(nextVideo)
      commitChantVideo(nextVideo)
      preloadPvVideo(nextQueuedVideo)

      if (videoMode(nextVideo) === 'voice') {
        scheduleChantVideoSwitchTimeout(nextVideo.key, CHANT_VIDEO_REQUEST_TIMEOUT_MS)
      }
    },
    [
      cancelPendingChantPvSwitch,
      commitChantVideo,
      preloadPvVideo,
      scheduleChantVideoSwitchTimeout,
      withVideoInstanceKey
    ]
  )

  const handleChantVideoReady = useCallback(
    (video: DisplayChantVideo): void => {
      if (videoMode(video) !== 'voice' || currentVideoModeRef.current !== 'voice') {
        return
      }

      scheduleChantVideoSwitchTimeout(video.key, CHANT_VIDEO_ACTIVE_TIMEOUT_MS)
    },
    [scheduleChantVideoSwitchTimeout]
  )

  const handleChantVideoEnded = useCallback(
    (video: DisplayChantVideo, currentTime: number, duration: number): void => {
      rememberUpPvProgress(video, currentTime, duration)
      if (chantVideoRef.current?.key !== video.key) {
        return
      }

      if (video.kind === 'protect') {
        if (switchVoiceToQueuedPv()) {
          return
        }

        showIdleUpPv(`idle-after-protect-${String(video.key)}`)
        return
      }

      if (restartPvFromConfiguredStart(video, duration)) {
        return
      }

      if (switchVoiceToQueuedPv()) {
        return
      }

      showIdleUpPv(`idle-after-video-${String(video.key)}`)
    },
    [rememberUpPvProgress, restartPvFromConfiguredStart, showIdleUpPv, switchVoiceToQueuedPv]
  )

  const handleChantVideoTimeUpdate = useCallback(
    (video: DisplayChantVideo, currentTime: number, duration: number): void => {
      rememberUpPvProgress(video, currentTime, duration)
      if (chantVideoRef.current?.key !== video.key) {
        return
      }

      if (video.kind === 'single' && (video.mode === 'characterPv' || video.mode === 'upPv')) {
        const range = getPvPlaybackRange(duration, video.pvStartTime, video.pvEndTime)
        if (shouldRestartPv(currentTime, range)) {
          restartPvFromConfiguredStart(video, duration)
        }
        return
      }

      if (videoMode(video) !== 'voice') {
        return
      }

      const switchTime =
        video.kind === 'protect'
          ? protectVideoPvSwitchTime(duration)
          : CHANT_VIDEO_PV_SWITCH_SECONDS

      if (currentTime >= switchTime) {
        switchVoiceToQueuedPv()
      }
    },
    [rememberUpPvProgress, restartPvFromConfiguredStart, switchVoiceToQueuedPv]
  )

  const handleChantVideoInterrupted = useCallback(
    (video: DisplayChantVideo, currentTime: number, duration: number): void => {
      rememberUpPvProgress(video, currentTime, duration)
    },
    [rememberUpPvProgress]
  )

  const handleChantVideoError = useCallback(
    (video: DisplayChantVideo, currentTime: number, duration: number): void => {
      rememberUpPvProgress(video, currentTime, duration)
      if (chantVideoRef.current?.key !== video.key) {
        return
      }

      if (video.kind === 'protect') {
        if (switchVoiceToQueuedPv()) {
          return
        }

        showIdleUpPv(`idle-after-protect-error-${String(video.key)}`)
        return
      }

      if (video.kind === 'single' && video.mode === 'upPv') {
        upCharacterPvCurrentTimeRef.current = normalizePvStartTime(video.pvStartTime)
        hideChantVideo()
        return
      }

      if (videoMode(video) === 'voice' && switchVoiceToQueuedPv()) {
        return
      }

      showIdleUpPv(`idle-after-video-error-${String(video.key)}`, true)
    },
    [hideChantVideo, rememberUpPvProgress, showIdleUpPv, switchVoiceToQueuedPv]
  )

  const cancelVoiceTimelineFrame = useCallback((): void => {
    if (voiceTimelineFrameRef.current !== null) {
      window.cancelAnimationFrame(voiceTimelineFrameRef.current)
      voiceTimelineFrameRef.current = null
    }
  }, [])

  const clearVoiceTimelinePlayRetry = useCallback((): void => {
    if (voiceTimelinePlayRetryRef.current !== null) {
      window.clearTimeout(voiceTimelinePlayRetryRef.current)
      voiceTimelinePlayRetryRef.current = null
    }
  }, [])

  const processVoiceTimelineAudioTime = useCallback((time: number): void => {
    const clickPoints = voiceTimelineClickPointsRef.current
    while (voiceTimelineClickIndexRef.current < clickPoints.length) {
      const clickPoint = clickPoints[voiceTimelineClickIndexRef.current]
      if (time + 0.01 < clickPoint.time) {
        break
      }
      performReplayClickRef.current(clickPoint.type)
      voiceTimelineClickIndexRef.current += 1
    }
  }, [])

  const startVoiceTimelineFrame = useCallback(
    (audio: HTMLAudioElement): void => {
      cancelVoiceTimelineFrame()

      const tick = (): void => {
        if (voiceTimelineAudioRef.current !== audio) {
          voiceTimelineFrameRef.current = null
          return
        }

        processVoiceTimelineAudioTime(audio.currentTime)

        if (!audio.paused && !audio.ended) {
          voiceTimelineFrameRef.current = window.requestAnimationFrame(tick)
          return
        }

        voiceTimelineFrameRef.current = null
      }

      voiceTimelineFrameRef.current = window.requestAnimationFrame(tick)
    },
    [cancelVoiceTimelineFrame, processVoiceTimelineAudioTime]
  )

  const playVoiceTimelineAudio = useCallback(
    (audio: HTMLAudioElement): void => {
      clearVoiceTimelinePlayRetry()

      let retryCount = 0
      const attemptPlay = (): void => {
        if (voiceTimelineAudioRef.current !== audio) {
          return
        }

        audio
          .play()
          .then(() => {
            startVoiceTimelineFrame(audio)
          })
          .catch(() => {
            if (voiceTimelineAudioRef.current !== audio) {
              return
            }

            retryCount += 1
            if (retryCount <= 5) {
              voiceTimelinePlayRetryRef.current = window.setTimeout(attemptPlay, 120)
              return
            }

            voiceTimelinePlayingRef.current = false
          })
      }

      attemptPlay()
    },
    [clearVoiceTimelinePlayRetry, startVoiceTimelineFrame]
  )

  const replayState = useMemo(
    () => buildReplayState(sourceState, replayCursor),
    [replayCursor, sourceState]
  )
  const voiceTimelineLinked = voiceTimelinePlayback?.mode === 'voice_timeline_linked'
  const voiceTimelineSessionKey = voiceTimelineLinked
    ? `${voiceTimelinePlayback.timelineId}::${voiceTimelinePlayback.audioUrl ?? ''}::${
        voiceTimelinePlayback.sessionId ?? ''
      }`
    : null
  const voiceTimelineCursorAtSyncedTime = useMemo(() => {
    if (voiceTimelinePlayback?.mode !== 'voice_timeline_linked') {
      return null
    }

    const playbackTime = Number(voiceTimelinePlayback.currentTime)
    return buildTimelineReplayProgress(
      sourceState,
      settings.pageChanges,
      normalizeTimelineClickPoints(voiceTimelinePlayback.clickPoints),
      Number.isFinite(playbackTime) && playbackTime >= 0 ? playbackTime : 0
    ).cursor
  }, [settings.pageChanges, sourceState, voiceTimelinePlayback])
  const openingUpPvContextKey = voiceTimelineSessionKey
    ? `${sourceState.createdAt}::voice-timeline::${voiceTimelineSessionKey}`
    : `${sourceState.createdAt}::${sourceState.playbackMode ?? 'manual'}`
  const eventState = useMemo(
    () =>
      resolveRuntimeEvents(
        replayState,
        settings.pageChanges,
        completedDelayedChangeKeys,
        delayClickProgress
      ),
    [completedDelayedChangeKeys, delayClickProgress, replayState, settings.pageChanges]
  )
  const pendingDelayedChanges = eventState.pendingDelayedChanges

  const state = useMemo(() => {
    return {
      ...replayState,
      eventHistory: eventState.eventHistory,
      currentEvents: eventState.currentEvents,
      executedPageChangeIds: eventState.executedPageChangeIds,
      currentPageChangeIds: eventState.currentPageChangeIds
    }
  }, [eventState, replayState])
  const currentCompletedPageChangeIds = useMemo(() => {
    const currentPageChangeIds = new Set(state.currentPageChangeIds ?? [])
    return [...completedPageChangeIds].filter((pageChangeId) =>
      currentPageChangeIds.has(pageChangeId)
    )
  }, [completedPageChangeIds, state.currentPageChangeIds])
  const selectedAction = sourceState.actions[replayCursor - 1] ?? null
  const livePendingAction = useMemo(
    () =>
      sourceState.playbackMode === 'live' ? pendingActionFromStep(sourceState.currentStep) : null,
    [sourceState.currentStep, sourceState.playbackMode]
  )
  const liveFollowingAction = useMemo(
    () =>
      sourceState.playbackMode === 'live'
        ? pendingActionFromStep(sourceState.followingStep ?? null)
        : null,
    [sourceState.followingStep, sourceState.playbackMode]
  )
  const nextAction = sourceState.actions[replayCursor] ?? livePendingAction
  const futureActions = useMemo(() => {
    const recordedFutureActions = sourceState.actions.slice(replayCursor)
    return recordedFutureActions.length > 0
      ? recordedFutureActions
      : livePendingAction
        ? [livePendingAction, liveFollowingAction].filter((action): action is BpActionRecord =>
            Boolean(action)
          )
        : []
  }, [liveFollowingAction, livePendingAction, replayCursor, sourceState.actions])

  const clearPageChangeCompletionTracking = useCallback((): void => {
    pageChangeCompletionTimersRef.current.forEach((timer) => window.clearTimeout(timer))
    pageChangeCompletionTimersRef.current.clear()
    activePageChangeIdsRef.current = new Set()
    completedPageChangeIdsRef.current = new Set()
    setCompletedPageChangeIds(new Set())
  }, [])

  const resetReplay = useCallback(
    (nextState: BpRuntimeState): void => {
      const shouldResetDelays = shouldResetDelayTracking(sourceStateRef.current, nextState)
      const shouldInterruptVideo = shouldInterruptVideoForRuntimeUpdate(
        sourceStateRef.current,
        nextState
      )
      const liveMode = nextState.playbackMode === 'live'

      sourceStateRef.current = nextState
      setSourceState(nextState)
      setReplayCursor((current) =>
        liveMode
          ? nextState.actions.length
          : shouldResetDelays
            ? 0
            : Math.min(current, nextState.actions.length)
      )
      if (shouldInterruptVideo) {
        hideChantVideo()
      }
      if (shouldResetDelays) {
        completedDelayedChangeKeysRef.current = new Set()
        delayClickProgressRef.current = {}
        setCompletedDelayedChangeKeys(new Set())
        setDelayClickProgress({})
        setDismissedEffectKeys(new Set())
        clearPageChangeCompletionTracking()
      }
      lastPlayedCursorRef.current = shouldResetDelays
        ? 0
        : Math.min(lastPlayedCursorRef.current, nextState.actions.length)
    },
    [clearPageChangeCompletionTracking, hideChantVideo]
  )

  const applyVoiceTimelinePlayback = useCallback((playback: VoiceTimelinePlayback | null): void => {
    setVoiceTimelinePlayback(playback)
    setVoiceTimelinePlaybackReady(true)
  }, [])

  useEffect(() => {
    window.bpAPI.displaySettings.get().then(setSettings)
    window.bpAPI.bp.getCurrentState().then((currentState) => {
      if (currentState) {
        resetReplay(normalizeRuntimeState(currentState))
      }
    })
    window.bpAPI.characters
      .list()
      .then((characters) => {
        setCharacterLookup(new Map(characters.map((character) => [character.id, character])))
      })
      .catch(() => setCharacterLookup(new Map()))
    const stopSettings = window.bpAPI.displaySettings.onUpdated(applyUpdatedSettings)
    const stopBp = window.bpAPI.bp.onState((nextState) =>
      resetReplay(normalizeRuntimeState(nextState))
    )

    return () => {
      stopSettings()
      stopBp()
    }
  }, [applyUpdatedSettings, resetReplay])

  useEffect(() => {
    window.bpAPI.bp
      .getVoiceTimelinePlayback()
      .then(applyVoiceTimelinePlayback)
      .catch(() => applyVoiceTimelinePlayback(null))
    const stopVoiceTimeline = window.bpAPI.bp.onVoiceTimelinePlayback(applyVoiceTimelinePlayback)

    return () => {
      stopVoiceTimeline()
    }
  }, [applyVoiceTimelinePlayback])

  useEffect(() => {
    chantVideoRef.current = chantVideo
  }, [chantVideo])

  useEffect(() => {
    resolvedUpCharacterPvUrlRef.current = resolvedUpCharacterPvUrl
  }, [resolvedUpCharacterPvUrl])

  useEffect(() => {
    updateManagedAudioVolume(bpSoundAudiosRef.current, bpSoundVolume)
  }, [bpSoundVolume])

  useEffect(() => {
    characterVoiceVolumeRef.current = characterVoiceVolume
    updateManagedAudioVolume(characterVoiceAudiosRef.current, characterVoiceVolume)
    if (voiceTimelineAudioRef.current) {
      voiceTimelineAudioRef.current.volume = characterVoiceVolume
    }
  }, [characterVoiceVolume])

  useEffect(() => {
    updateManagedAudioVolume(characterEffectAudiosRef.current, characterEffectVolume)
  }, [characterEffectVolume])

  useEffect(() => {
    const pendingKey = pendingIdleUpPvKeyRef.current

    if (!pendingKey || !resolvedUpCharacterPvUrl || chantVideoRef.current) {
      return
    }

    queueMicrotask(() => {
      if (pendingIdleUpPvKeyRef.current === pendingKey && !chantVideoRef.current) {
        showIdleUpPv(pendingKey)
      }
    })
  }, [resolvedUpCharacterPvUrl, showIdleUpPv])

  useEffect(() => {
    const runtimeUrl = optionalString(sourceState.upCharacterPvUrl)
    const runtimePath = optionalString(sourceState.upCharacterPvPath)
    const runtimeStartTime = normalizePvStartTime(sourceState.upCharacterPvStartTime)
    let disposed = false

    if (
      upCharacterPvPathRef.current !== runtimePath ||
      upCharacterPvStartTimeRef.current !== runtimeStartTime
    ) {
      upCharacterPvPathRef.current = runtimePath
      upCharacterPvStartTimeRef.current = runtimeStartTime
      upCharacterPvCurrentTimeRef.current = runtimeStartTime
    }

    if (runtimeUrl || !runtimePath) {
      resolvedUpCharacterPvUrlRef.current = runtimeUrl
      queueMicrotask(() => {
        if (!disposed) {
          setResolvedUpCharacterPvUrl(runtimeUrl)
        }
      })
      return () => {
        disposed = true
      }
    }

    resolvedUpCharacterPvUrlRef.current = null
    window.bpAPI.files
      .toFileUrl(runtimePath)
      .then((url) => {
        if (!disposed) {
          resolvedUpCharacterPvUrlRef.current = url
          setResolvedUpCharacterPvUrl(url)
        }
      })
      .catch(() => {
        if (!disposed) {
          resolvedUpCharacterPvUrlRef.current = null
          setResolvedUpCharacterPvUrl(null)
        }
      })

    return () => {
      disposed = true
    }
  }, [
    sourceState.upCharacterPvEndTime,
    sourceState.upCharacterPvPath,
    sourceState.upCharacterPvStartTime,
    sourceState.upCharacterPvUrl
  ])

  useEffect(() => {
    if (!voiceTimelinePlaybackReady) {
      return
    }

    const effectiveReplayCursor = Math.max(
      replayCursor,
      sourceState.playbackMode === 'live' ? sourceState.actions.length : 0,
      voiceTimelineCursorAtSyncedTime ?? 0
    )
    let openingUpPvSession = openingUpPvSessionRef.current

    const scheduleVideoReset = (): boolean => {
      if (!chantVideoRef.current && !currentVideoModeRef.current) {
        return false
      }

      if (!openingUpPvResetPendingRef.current) {
        openingUpPvResetPendingRef.current = true
        queueMicrotask(() => {
          openingUpPvResetPendingRef.current = false
          if (openingUpPvSessionRef.current.contextKey === openingUpPvContextKey) {
            hideChantVideo()
          }
        })
      }

      return true
    }

    if (openingUpPvSession.contextKey !== openingUpPvContextKey) {
      openingUpPvSession = {
        contextKey: openingUpPvContextKey,
        hasPlayedFirstAction: effectiveReplayCursor > 0,
        lastReplayCursor: effectiveReplayCursor,
        started: false
      }
      openingUpPvSessionRef.current = openingUpPvSession

      if (scheduleVideoReset()) {
        return
      }
    }

    if (effectiveReplayCursor > 0) {
      openingUpPvSession.hasPlayedFirstAction = true
      openingUpPvSession.lastReplayCursor = effectiveReplayCursor
      return
    }

    const returnedToVoiceTimelineOpening =
      voiceTimelineLinked && openingUpPvSession.lastReplayCursor > 0
    openingUpPvSession.lastReplayCursor = 0

    if (returnedToVoiceTimelineOpening) {
      openingUpPvSession.hasPlayedFirstAction = false
      openingUpPvSession.started = false

      if (scheduleVideoReset()) {
        return
      }
    }

    if (
      openingUpPvSession.hasPlayedFirstAction ||
      openingUpPvSession.started ||
      !resolvedUpCharacterPvUrl ||
      chantVideo ||
      chantVideoRef.current ||
      currentVideoModeRef.current
    ) {
      return
    }

    const upPvUrl = resolvedUpCharacterPvUrl

    queueMicrotask(() => {
      const currentSession = openingUpPvSessionRef.current

      if (
        currentSession.contextKey !== openingUpPvContextKey ||
        currentSession.hasPlayedFirstAction ||
        currentSession.started ||
        currentSession.lastReplayCursor !== 0 ||
        resolvedUpCharacterPvUrlRef.current !== upPvUrl ||
        chantVideoRef.current ||
        currentVideoModeRef.current
      ) {
        return
      }

      currentSession.started = showIdleUpPv(`opening-up-pv-${openingUpPvContextKey}`)
    })
  }, [
    chantVideo,
    hideChantVideo,
    openingUpPvContextKey,
    replayCursor,
    resolvedUpCharacterPvUrl,
    showIdleUpPv,
    sourceState.actions.length,
    sourceState.playbackMode,
    voiceTimelineCursorAtSyncedTime,
    voiceTimelineLinked,
    voiceTimelinePlaybackReady
  ])

  useEffect(() => {
    const timers = pageChangeCompletionTimersRef.current

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer))
      timers.clear()
    }
  }, [])

  useEffect(() => {
    return () => {
      cancelPendingChantPvSwitch()
    }
  }, [cancelPendingChantPvSwitch])

  useEffect(() => {
    const pendingUpPvContext = pendingUpPvContextRef.current

    if (
      currentVideoModeRef.current !== 'voice' ||
      !pendingUpPvContext ||
      !resolvedUpCharacterPvUrl
    ) {
      return
    }

    preloadPvVideo(
      buildUpPvVideo(
        `${pendingUpPvContext.key}-${resolvedUpCharacterPvUrl}`,
        resolvedUpCharacterPvUrl
      )
    )
  }, [buildUpPvVideo, preloadPvVideo, resolvedUpCharacterPvUrl])

  useEffect(() => {
    const currentPageChangeIds = state.currentPageChangeIds ?? []
    const activePageChangeIds = new Set(currentPageChangeIds)
    activePageChangeIdsRef.current = activePageChangeIds

    pageChangeCompletionTimersRef.current.forEach((timer, pageChangeId) => {
      if (activePageChangeIds.has(pageChangeId)) {
        return
      }

      window.clearTimeout(timer)
      pageChangeCompletionTimersRef.current.delete(pageChangeId)
    })

    setCompletedPageChangeIds((current) => {
      const next = new Set(
        [...current].filter((pageChangeId) => activePageChangeIds.has(pageChangeId))
      )
      const unchanged =
        next.size === current.size && [...current].every((pageChangeId) => next.has(pageChangeId))

      if (unchanged) {
        completedPageChangeIdsRef.current = current
        return current
      }

      completedPageChangeIdsRef.current = next
      return next
    })

    currentPageChangeIds.forEach((pageChangeId) => {
      if (
        completedPageChangeIdsRef.current.has(pageChangeId) ||
        pageChangeCompletionTimersRef.current.has(pageChangeId)
      ) {
        return
      }

      const pageChange = settings.pageChanges.find((change) => change.id === pageChangeId)
      const delay = Math.max(0, Math.floor(Number(pageChange?.speed) || 0))
      const timer = window.setTimeout(() => {
        pageChangeCompletionTimersRef.current.delete(pageChangeId)
        if (!activePageChangeIdsRef.current.has(pageChangeId)) {
          return
        }

        setCompletedPageChangeIds((current) => {
          if (current.has(pageChangeId)) {
            return current
          }

          const next = new Set(current)
          next.add(pageChangeId)
          completedPageChangeIdsRef.current = next
          return next
        })
      }, delay)

      pageChangeCompletionTimersRef.current.set(pageChangeId, timer)
    })
  }, [settings.pageChanges, state.currentPageChangeIds])

  useEffect(() => {
    if (replayCursor <= 0) {
      lastPlayedCursorRef.current = 0
      return
    }
    if (replayCursor <= lastPlayedCursorRef.current) {
      lastPlayedCursorRef.current = replayCursor
      return
    }

    lastPlayedCursorRef.current = replayCursor
    const action = sourceState.actions[replayCursor - 1]
    if (!action) {
      return
    }

    if (isEffectSoundAction(action.action)) {
      playManagedAudio(
        settings.slotEffects?.[action.action]?.selectedSoundUrl,
        bpSoundVolume,
        bpSoundAudiosRef.current
      )
    }

    if (action.action === 'protect') {
      const leftUrl = action.starTarget?.chant_video_url ?? null
      const rightUrl = action.railTarget?.chant_video_url ?? null
      const upPvKey = `up-pv-protect-${action.stepIndex}`
      pendingUpPvContextRef.current = { key: upPvKey }
      const upPvVideo = resolvedUpCharacterPvUrl
        ? buildUpPvVideo(`${upPvKey}-${resolvedUpCharacterPvUrl}`, resolvedUpCharacterPvUrl)
        : null

      queueMicrotask(() =>
        leftUrl || rightUrl
          ? showChantVideo(
              {
                kind: 'protect',
                key: `protect-${action.stepIndex}-${leftUrl ?? 'empty'}-${rightUrl ?? 'empty'}`,
                leftUrl,
                rightUrl
              },
              upPvVideo
            )
          : showIdleUpPv(`idle-protect-${action.stepIndex}`)
      )
      return
    }

    if (
      (action.action === 'ban' && action.targetType === 'lightCone') ||
      action.action === 'borrow'
    ) {
      return
    }

    if (
      (action.action !== 'pick' && action.action !== 'ban') ||
      action.targetType !== 'character'
    ) {
      queueMicrotask(() => showIdleUpPv(`idle-${action.action}-${action.stepIndex}`))
      return
    }

    const character = resolveActionCharacter(action, characterLookup)
    if (!character) {
      queueMicrotask(() => showIdleUpPv(`idle-missing-character-${action.stepIndex}`))
      return
    }
    const voiceUrl = action.action === 'ban' ? character.ban_voice_url : character.pick_voice_url

    if (action.action === 'pick') {
      playManagedAudio(
        character.pick_sound_url,
        characterEffectVolume,
        characterEffectAudiosRef.current
      )
    }
    playManagedAudio(voiceUrl, characterVoiceVolume, characterVoiceAudiosRef.current)

    const nextChantVideoUrl = optionalString(character.chant_video_url)
    if (nextChantVideoUrl) {
      const characterPvUrl = character.pv_exists === true ? optionalString(character.pv_url) : null
      const characterPvVideo = characterPvUrl
        ? {
            kind: 'single' as const,
            key: `pv-${action.action}-${action.stepIndex}-${character.id}-${characterPvUrl}`,
            url: characterPvUrl,
            startTime: normalizePvStartTime(character.pv_start_time),
            pvStartTime: normalizePvStartTime(character.pv_start_time),
            pvEndTime: normalizePvEndTime(character.pv_end_time),
            mode: 'characterPv' as const
          }
        : null
      const upPvKey = `up-pv-${action.action}-${action.stepIndex}-${character.id}`
      pendingUpPvContextRef.current = !characterPvVideo ? { key: upPvKey } : null
      const upPvVideo =
        !characterPvVideo && resolvedUpCharacterPvUrl
          ? buildUpPvVideo(`${upPvKey}-${resolvedUpCharacterPvUrl}`, resolvedUpCharacterPvUrl)
          : null

      queueMicrotask(() =>
        showChantVideo(
          {
            kind: 'single',
            key: `${action.action}-${action.stepIndex}-${character.id}-${nextChantVideoUrl}`,
            url: nextChantVideoUrl,
            mode: 'voice'
          },
          characterPvVideo ?? upPvVideo
        )
      )
    } else {
      queueMicrotask(() => showIdleUpPv(`idle-no-chant-${action.stepIndex}`))
    }
  }, [
    characterLookup,
    bpSoundVolume,
    buildUpPvVideo,
    characterEffectVolume,
    characterVoiceVolume,
    replayCursor,
    resolvedUpCharacterPvUrl,
    settings.slotEffects,
    showIdleUpPv,
    showChantVideo,
    sourceState.actions
  ])

  const consumeDelayedClick = useCallback((): boolean => {
    if (pendingDelayedChanges.length === 0) {
      return false
    }

    const currentProgress = delayClickProgressRef.current
    const nextProgress = { ...currentProgress }
    const nextCompletedKeys = new Set(completedDelayedChangeKeysRef.current)
    let completedAny = false

    pendingDelayedChanges.forEach((pendingDelayedChange) => {
      const completedClicks = (currentProgress[pendingDelayedChange.key] ?? 0) + 1

      if (completedClicks >= pendingDelayedChange.requiredClicks) {
        delete nextProgress[pendingDelayedChange.key]
        nextCompletedKeys.add(pendingDelayedChange.key)
        completedAny = true
        return
      }

      nextProgress[pendingDelayedChange.key] = completedClicks
    })

    delayClickProgressRef.current = nextProgress
    setDelayClickProgress(nextProgress)
    if (completedAny) {
      completedDelayedChangeKeysRef.current = nextCompletedKeys
      setCompletedDelayedChangeKeys(nextCompletedKeys)
    }

    return true
  }, [pendingDelayedChanges])

  const advanceReplay = useCallback((): void => {
    setReplayCursor((current) => Math.min(current + 1, sourceState.actions.length))
  }, [sourceState.actions.length])

  const performReplayClick = useCallback(
    (clickType: BpDisplayReplayClickType = 'bp_step'): void => {
      if (clickType === 'delay_extra_click') {
        void consumeDelayedClick()
        return
      }
      if (consumeDelayedClick()) {
        return
      }
      advanceReplay()
    },
    [advanceReplay, consumeDelayedClick]
  )

  useEffect(() => {
    performReplayClickRef.current = performReplayClick
  }, [performReplayClick])

  useEffect(() => {
    const stopReplayClick = window.bpAPI.bp.onDisplayReplayClick((clickType) => {
      performReplayClickRef.current(clickType)
    })

    return stopReplayClick
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (voiceTimelineLinkedRef.current) {
        return
      }

      if (event.code === 'ArrowLeft') {
        event.preventDefault()
        hideChantVideo()
        completedDelayedChangeKeysRef.current = new Set()
        delayClickProgressRef.current = {}
        setCompletedDelayedChangeKeys(new Set())
        setDelayClickProgress({})
        setDismissedEffectKeys(new Set())
        clearPageChangeCompletionTracking()
        setReplayCursor((current) => {
          const nextCursor = Math.max(current - 1, 0)
          lastPlayedCursorRef.current = nextCursor
          return nextCursor
        })
        return
      }

      if (
        event.code === 'ArrowRight' ||
        event.code === 'Space' ||
        event.code === 'Numpad6' ||
        event.key === 'ArrowRight'
      ) {
        event.preventDefault()
        performReplayClick('bp_step')
      }
    }

    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [clearPageChangeCompletionTracking, hideChantVideo, performReplayClick])

  useEffect(() => {
    const handleMouseDown = (event: MouseEvent): void => {
      if (voiceTimelineLinkedRef.current) {
        return
      }

      if (event.button !== 0) {
        return
      }

      event.preventDefault()
      event.stopPropagation()
      suppressNextClickRef.current = true
      performReplayClick('bp_step')
    }
    const handleClick = (event: MouseEvent): void => {
      if (!suppressNextClickRef.current) {
        return
      }

      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      suppressNextClickRef.current = false
    }

    window.addEventListener('mousedown', handleMouseDown, true)
    window.addEventListener('click', handleClick, true)

    return () => {
      window.removeEventListener('mousedown', handleMouseDown, true)
      window.removeEventListener('click', handleClick, true)
    }
  }, [performReplayClick])

  useEffect(() => {
    const previousAudio = voiceTimelineAudioRef.current
    if (previousAudio) {
      previousAudio.pause()
      voiceTimelineAudioRef.current = null
    }
    voiceTimelineClickIndexRef.current = 0
    voiceTimelineClickPointsRef.current = []
    voiceTimelinePlayingRef.current = false
    voiceTimelineSessionKeyRef.current = ''
    voiceTimelineAppliedSessionKeyRef.current = ''
    voiceTimelineLinkedRef.current = false
    cancelVoiceTimelineFrame()
    clearVoiceTimelinePlayRetry()

    if (
      voiceTimelinePlayback?.mode !== 'voice_timeline_linked' ||
      !voiceTimelinePlayback.audioUrl
    ) {
      return
    }

    voiceTimelineLinkedRef.current = true
    const sessionKey = `${voiceTimelinePlayback.timelineId}::${voiceTimelinePlayback.audioUrl}::${
      voiceTimelinePlayback.sessionId ?? ''
    }`
    voiceTimelineSessionKeyRef.current = sessionKey
    const audio = new Audio(voiceTimelinePlayback.audioUrl)
    audio.preload = 'auto'
    audio.volume = characterVoiceVolumeRef.current
    voiceTimelineAudioRef.current = audio

    const handlePlay = (): void => {
      voiceTimelinePlayingRef.current = true
      startVoiceTimelineFrame(audio)
    }
    const handlePause = (): void => {
      voiceTimelinePlayingRef.current = false
      cancelVoiceTimelineFrame()
    }
    const handleEnded = (): void => {
      voiceTimelinePlayingRef.current = false
      cancelVoiceTimelineFrame()
    }
    const handleTimeUpdate = (): void => {
      processVoiceTimelineAudioTime(audio.currentTime)
    }

    audio.addEventListener('play', handlePlay)
    audio.addEventListener('pause', handlePause)
    audio.addEventListener('ended', handleEnded)
    audio.addEventListener('timeupdate', handleTimeUpdate)

    return () => {
      voiceTimelinePlayingRef.current = false
      voiceTimelineLinkedRef.current = false
      clearVoiceTimelinePlayRetry()
      cancelVoiceTimelineFrame()
      audio.pause()
      audio.removeEventListener('play', handlePlay)
      audio.removeEventListener('pause', handlePause)
      audio.removeEventListener('ended', handleEnded)
      audio.removeEventListener('timeupdate', handleTimeUpdate)
    }
  }, [
    cancelVoiceTimelineFrame,
    clearVoiceTimelinePlayRetry,
    processVoiceTimelineAudioTime,
    startVoiceTimelineFrame,
    voiceTimelinePlayback?.audioUrl,
    voiceTimelinePlayback?.timelineId,
    voiceTimelinePlayback?.sessionId,
    voiceTimelinePlayback?.mode
  ])

  useEffect(() => {
    const audio = voiceTimelineAudioRef.current
    if (
      !voiceTimelinePlayback ||
      voiceTimelinePlayback.mode !== 'voice_timeline_linked' ||
      !audio ||
      !voiceTimelinePlayback.audioUrl
    ) {
      return
    }

    const clickPoints = normalizeTimelineClickPoints(voiceTimelinePlayback.clickPoints)
    voiceTimelineClickPointsRef.current = clickPoints

    const playbackRate = Number(voiceTimelinePlayback.playbackRate)
    audio.playbackRate = Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1

    const sessionKey = `${voiceTimelinePlayback.timelineId}::${voiceTimelinePlayback.audioUrl}::${
      voiceTimelinePlayback.sessionId ?? ''
    }`
    const nextTime = Number(voiceTimelinePlayback.currentTime)
    if (Number.isFinite(nextTime) && nextTime >= 0) {
      const isNewSession = voiceTimelineAppliedSessionKeyRef.current !== sessionKey
      const shouldSyncTime =
        isNewSession ||
        voiceTimelinePlayback.playing !== true ||
        !voiceTimelinePlayingRef.current ||
        Math.abs(audio.currentTime - nextTime) > 0.35

      if (shouldSyncTime && Math.abs(audio.currentTime - nextTime) > 0.02) {
        audio.currentTime = nextTime
      }
      if (shouldSyncTime) {
        const progress = buildTimelineReplayProgress(
          sourceStateRef.current,
          settings.pageChanges,
          clickPoints,
          nextTime
        )
        completedDelayedChangeKeysRef.current = progress.completedDelayedChangeKeys
        delayClickProgressRef.current = progress.delayClickProgress
        setCompletedDelayedChangeKeys(progress.completedDelayedChangeKeys)
        setDelayClickProgress(progress.delayClickProgress)
        setDismissedEffectKeys(new Set())
        clearPageChangeCompletionTracking()
        lastPlayedCursorRef.current = Math.max(progress.cursor - 1, 0)
        setReplayCursor(progress.cursor)
        voiceTimelineClickIndexRef.current = progress.clickIndex
      }
      voiceTimelineAppliedSessionKeyRef.current = sessionKey
    }

    if (voiceTimelinePlayback.playing === true) {
      playVoiceTimelineAudio(audio)
      return
    }

    clearVoiceTimelinePlayRetry()
    audio.pause()
  }, [
    clearPageChangeCompletionTracking,
    clearVoiceTimelinePlayRetry,
    playVoiceTimelineAudio,
    settings.pageChanges,
    voiceTimelinePlayback
  ])

  return (
    <div className="display-page live-page">
      <DisplayCanvas
        settings={settings}
        state={state}
        className="live-display-stage"
        pixelExact
        showCenterStage={false}
        chantVideo={chantVideo}
        preloadChantVideo={preloadChantVideo}
        onChantVideoReady={handleChantVideoReady}
        onChantVideoEnded={handleChantVideoEnded}
        onChantVideoTimeUpdate={handleChantVideoTimeUpdate}
        onChantVideoInterrupted={handleChantVideoInterrupted}
        onChantVideoError={handleChantVideoError}
        muteChantVideo
        nextAction={nextAction}
        followingAction={sourceState.actions[replayCursor + 1] ?? liveFollowingAction}
        futureActions={futureActions}
        selectedAction={selectedAction}
        dismissedEffectKeys={[...dismissedEffectKeys]}
        completedPageChangeIds={currentCompletedPageChangeIds}
      />
    </div>
  )
}

export default DisplayPage
