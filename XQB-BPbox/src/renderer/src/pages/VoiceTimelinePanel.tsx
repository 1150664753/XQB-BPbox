import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import DisplayCanvas, { type DisplayChantVideo } from '../components/display/DisplayCanvas'
import type {
  BpAction,
  BpActionRecord,
  BpResult,
  BpResultListItem,
  BpRuntimeState,
  BpSide,
  BpSlotCounts,
  DisplayPageChange,
  DisplaySettings,
  FlowConfig,
  FlowListItem,
  FlowStep,
  ProjectFileChangeArea,
  ProjectFileChangeEvent,
  VoiceTimelineClickPoint,
  VoiceTimelineConfig,
  VoiceTimelinePlayback
} from '../types/bp'
import type { Character } from '../types/character'
import type { LightCone } from '../types/lightCone'

type MessageType = 'info' | 'success' | 'error'

function fileChangeIncludes(
  event: ProjectFileChangeEvent,
  ...areas: ProjectFileChangeArea[]
): boolean {
  return areas.some((area) => event.areas.includes(area))
}

interface VoiceTimelinePanelProps {
  active: boolean
  selectedVoiceTimelineFile: string
  onSelectedVoiceTimelineFileChange: (fileName: string) => void
  onVoiceTimelineListRefresh: (preferredFileName?: string) => Promise<void>
  onMessage: (type: MessageType, text: string) => void
}

interface TimelineStepTemplate {
  id: string
  stepIndex: number
  stepName: string
  side: BpSide | null
  action: BpAction
  targetType: 'character' | 'lightCone' | 'none'
  targetId: number | null
  targetName: string
  iconPath: string | null
  iconUrl: string | null
  note: string
}

interface PendingDelayedPageChange {
  key: string
  requiredClicks: number
}

interface ReplayProgress {
  cursor: number
  completedDelayedChangeKeys: Set<string>
  delayClickProgress: Record<string, number>
}

const playbackRates = [0.5, 0.75, 1, 1.25, 1.5, 2]

const defaultFlow: FlowConfig = {
  name: '默认BP流程',
  steps: [
    { index: 1, side: 'star', action: 'ban', targetType: 'character' },
    { index: 2, side: 'rail', action: 'ban', targetType: 'character' },
    { index: 3, side: 'star', action: 'pick', targetType: 'character' },
    { index: 4, side: 'rail', action: 'pick', targetType: 'character' }
  ]
}

const emptyState: BpRuntimeState = {
  flowName: defaultFlow.name,
  createdAt: new Date().toISOString(),
  stepCursor: 0,
  status: 'idle',
  currentStep: null,
  slotCounts: {
    star: { picks: 0, bans: 0 },
    rail: { picks: 0, bans: 0 }
  },
  starTeam: { name: '左侧队', picks: [], bans: [] },
  railTeam: { name: '右侧队', picks: [], bans: [] },
  actions: [],
  eventHistory: [],
  currentEvents: [],
  executedPageChangeIds: [],
  currentPageChangeIds: []
}

function fileName(value: string): string {
  const parts = value.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? value
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

function normalizeFlowSteps(steps: FlowStep[]): FlowStep[] {
  return steps.reduce<FlowStep[]>((normalized, step) => {
    const action = normalizeBpAction(step.action)
    if (action === 'change') {
      return normalized
    }

    normalized.push({
      index: normalized.length + 1,
      side: step.side === 'rail' ? 'rail' : 'star',
      action,
      targetType: isPairedAction(action)
        ? 'character'
        : step.targetType === 'lightCone'
          ? 'lightCone'
          : 'character',
      eventName: normalizeEventName(step.eventName) ?? legacyStepEventName(step),
      pageChangeName: normalizeEventName(step.pageChangeName),
      pageChangeIndex:
        step.pageChangeIndex === null || step.pageChangeIndex === undefined
          ? null
          : Math.max(1, Math.floor(Number(step.pageChangeIndex) || 1))
    })

    return normalized
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
      if (step.action === 'pick') {
        counts[step.side].picks += 1
      }
      if (step.action === 'ban') {
        counts[step.side].bans += 1
      }
      return counts
    },
    {
      star: { picks: 0, bans: 0 },
      rail: { picks: 0, bans: 0 }
    }
  )
}

function createRuntime(flow: FlowConfig): BpRuntimeState {
  const normalizedFlow = normalizeFlowConfig(flow)
  return {
    ...emptyState,
    flowName: normalizedFlow.name,
    createdAt: new Date().toISOString(),
    status: normalizedFlow.steps.length > 0 ? 'running' : 'complete',
    currentStep: normalizedFlow.steps[0] ?? null,
    slotCounts: countFlowSlots(normalizedFlow)
  }
}

function buildRuntimeFromActions(flow: FlowConfig, actions: BpActionRecord[]): BpRuntimeState {
  const runtime = createRuntime(flow)
  const normalizedFlow = normalizeFlowConfig(flow)

  actions.forEach((record) => {
    if (!isRosterAction(record.action) || !record.target) {
      return
    }

    const teamKey = record.side === 'star' ? 'starTeam' : 'railTeam'
    const slotKey = record.action === 'pick' ? 'picks' : 'bans'
    runtime[teamKey][slotKey].push(record.target as Character | LightCone)
  })

  runtime.actions = actions
  runtime.stepCursor = Math.min(actions.length, normalizedFlow.steps.length)
  runtime.currentStep = normalizedFlow.steps[runtime.stepCursor] ?? null
  runtime.status = runtime.stepCursor >= normalizedFlow.steps.length ? 'complete' : 'running'

  return runtime
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
  return normalizeEventName(action.eventName) ?? legacyStepEventName(action)
}

function delayedPageChangeKey(
  pageChange: DisplayPageChange,
  eventName: string,
  sourceActionIndex: number | null,
  depth: number
): string {
  return [sourceActionIndex ?? 'none', depth, eventName, pageChange.id].join(':')
}

interface EventExpansionResult {
  events: Array<{ name: string; sourceActionIndex: number | null; depth: number }>
  pageChangeIds: string[]
  pendingDelayedChanges: PendingDelayedPageChange[]
}

interface ReplayEventState {
  eventHistory: Array<{ name: string; sourceActionIndex: number | null; depth: number }>
  currentEvents: string[]
  executedPageChangeIds: string[]
  currentPageChangeIds: string[]
  pendingDelayedChanges: PendingDelayedPageChange[]
}

function expandEventChain(
  seedEvent: string,
  sourceActionIndex: number | null,
  pageChanges: DisplayPageChange[],
  completedDelayedChangeKeys: Set<string>,
  delayClickProgress: Record<string, number>
): EventExpansionResult {
  const events: Array<{ name: string; sourceActionIndex: number | null; depth: number }> = []
  const pageChangeIds: string[] = []
  const queue: Array<{ name: string; sourceActionIndex: number | null; depth: number }> = [
    { name: seedEvent, sourceActionIndex, depth: 0 }
  ]
  const seen = new Set<string>()

  while (queue.length > 0) {
    const current = queue.shift()
    const name = normalizeEventName(current?.name)
    if (!current || !name || current.depth > 8) {
      continue
    }

    const seenKey = `${name}:${current.sourceActionIndex ?? 'none'}:${current.depth}`
    if (seen.has(seenKey)) {
      continue
    }
    seen.add(seenKey)

    events.push({
      name,
      sourceActionIndex: current.sourceActionIndex ?? null,
      depth: current.depth
    })

    const pendingDelayed: PendingDelayedPageChange[] = []
    for (const pageChange of pageChanges) {
      if (pageChangeTriggerEvent(pageChange) !== name) {
        continue
      }
      const delayKey = delayedPageChangeKey(
        pageChange,
        name,
        current.sourceActionIndex ?? null,
        current.depth
      )
      if (pageChange.delayTriggerEnabled === true && !completedDelayedChangeKeys.has(delayKey)) {
        const required = Math.max(1, Math.floor(Number(pageChange.delayClickCount) || 1))
        const completed = Math.max(0, Math.floor(delayClickProgress[delayKey] ?? 0))
        if (completed < required) {
          pendingDelayed.push({ key: delayKey, requiredClicks: required })
          continue
        }
      }

      pageChangeIds.push(pageChange.id)
      const emit = pageChangeEmitEvent(pageChange)
      if (emit) {
        queue.push({
          name: emit,
          sourceActionIndex: current.sourceActionIndex ?? null,
          depth: current.depth + 1
        })
      }
    }

    if (pendingDelayed.length > 0) {
      return {
        events,
        pageChangeIds,
        pendingDelayedChanges: pendingDelayed
      }
    }
  }

  return {
    events,
    pageChangeIds,
    pendingDelayedChanges: []
  }
}

function resolveReplayEventState(
  state: BpRuntimeState,
  pageChanges: DisplayPageChange[],
  completedDelayedChangeKeys: Set<string>,
  delayClickProgress: Record<string, number>
): ReplayEventState {
  const seeds: Array<{ name: string; sourceActionIndex: number | null }> = []
  if (state.status !== 'idle') {
    seeds.push({ name: 'start', sourceActionIndex: null })
  }
  state.actions.forEach((action) => {
    const name = actionEventName(action)
    if (name) {
      seeds.push({ name, sourceActionIndex: action.stepIndex })
    }
  })
  if (state.status === 'complete') {
    seeds.push({ name: 'end', sourceActionIndex: null })
  }

  const eventHistory: Array<{ name: string; sourceActionIndex: number | null; depth: number }> = []
  const executedPageChangeIds: string[] = []
  let currentEvents: string[] = []
  let currentPageChangeIds: string[] = []
  let pendingDelayedChanges: PendingDelayedPageChange[] = []

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

function pendingDelayedChanges(
  state: BpRuntimeState,
  pageChanges: DisplayPageChange[],
  completedDelayedChangeKeys: Set<string>,
  delayClickProgress: Record<string, number>
): PendingDelayedPageChange[] {
  return resolveReplayEventState(state, pageChanges, completedDelayedChangeKeys, delayClickProgress)
    .pendingDelayedChanges
}

function actionToStep(action: BpActionRecord | undefined): FlowStep | null {
  if (!action) {
    return null
  }
  const normalizedAction = normalizeBpAction(action.action)
  return {
    index: Math.max(1, Math.floor(Number(action.stepIndex) || 1)),
    side: action.side === 'rail' ? 'rail' : 'star',
    action: normalizedAction,
    targetType:
      normalizedAction === 'change'
        ? 'none'
        : isPairedAction(normalizedAction)
          ? 'character'
          : action.targetType === 'lightCone'
            ? 'lightCone'
            : 'character',
    eventName: normalizeEventName(action.eventName) ?? legacyStepEventName(action),
    pageChangeName: normalizeEventName(action.pageChangeName),
    pageChangeIndex:
      action.pageChangeIndex === null || action.pageChangeIndex === undefined
        ? null
        : Math.max(1, Math.floor(Number(action.pageChangeIndex) || 1))
  }
}

function buildReplayState(sourceState: BpRuntimeState, cursor: number): BpRuntimeState {
  const actions = sourceState.actions.slice(
    0,
    Math.max(0, Math.min(cursor, sourceState.actions.length))
  )
  const reachedEnd = actions.length >= sourceState.actions.length
  const status =
    sourceState.status === 'complete' && reachedEnd
      ? 'complete'
      : sourceState.status === 'idle' && actions.length === 0
        ? 'idle'
        : 'running'

  const replayState: BpRuntimeState = {
    ...sourceState,
    stepCursor: actions.length,
    status,
    currentStep: reachedEnd ? sourceState.currentStep : actionToStep(actions.at(-1)),
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
    replayState[teamKey][slotKey].push(action.target as Character | LightCone)
  })

  return replayState
}

function formatTimeLabel(time: number): string {
  const safe = Math.max(0, time)
  const minutes = Math.floor(safe / 60)
  const seconds = Math.floor(safe % 60)
  const ms = Math.floor((safe - Math.floor(safe)) * 10)
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${ms}`
}

function actionLabel(action: BpAction): string {
  if (action === 'ban') return 'Ban'
  if (action === 'pick') return 'Pick'
  if (action === 'protect') return '保护'
  if (action === 'borrow') return '租借'
  return action
}

function isEffectSoundAction(action: BpAction): action is 'pick' | 'ban' | 'protect' | 'borrow' {
  return action === 'pick' || action === 'ban' || action === 'protect' || action === 'borrow'
}

function playAudio(url: string | null | undefined): void {
  if (!url) {
    return
  }
  const audio = new Audio(url)
  audio.play().catch(() => undefined)
}

function normalizePvStartTime(value: unknown): number {
  const numberValue = Number(value)
  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : 0
}

function isCharacterTarget(value: unknown): value is Character {
  return Boolean(
    value &&
    typeof value === 'object' &&
    Number.isFinite(Number((value as { id?: unknown }).id)) &&
    typeof (value as { chinese_name?: unknown }).chinese_name === 'string'
  )
}

function isLightConeTarget(value: unknown): value is LightCone {
  return Boolean(
    value &&
    typeof value === 'object' &&
    Number.isFinite(Number((value as { id?: unknown }).id)) &&
    typeof (value as { name?: unknown }).name === 'string'
  )
}

function timelineTargetIconUrl(action: BpActionRecord): string | null {
  if (isLightConeTarget(action.target)) {
    return (
      action.target.small_image_url || action.targetImage || action.target.large_image_url || null
    )
  }

  if (isCharacterTarget(action.target)) {
    return action.target.avatar_small_image_url || action.targetImage || null
  }

  if (isCharacterTarget(action.starTarget)) {
    return action.starTarget.avatar_small_image_url || action.targetImage || null
  }

  if (isCharacterTarget(action.railTarget)) {
    return action.railTarget.avatar_small_image_url || action.targetImage || null
  }

  return action.targetImage ?? null
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

function stepAlias(records: BpActionRecord[]): string[] {
  const counters = new Map<string, number>()
  return records.map((record) => {
    const sidePrefix = record.side === 'star' ? 'a' : 'b'
    const keyBase =
      record.action === 'ban'
        ? `${sidePrefix}-B`
        : record.action === 'pick'
          ? `${sidePrefix}-P`
          : record.action === 'protect'
            ? 'protect'
            : record.action === 'borrow'
              ? 'borrow'
              : `${sidePrefix}-${record.action}`
    const count = (counters.get(keyBase) ?? 0) + 1
    counters.set(keyBase, count)

    if (record.action === 'ban') return `${sidePrefix}B${count}`
    if (record.action === 'pick') return `${sidePrefix}P${count}`
    if (record.action === 'protect') return `Protect${count}`
    if (record.action === 'borrow') return `Borrow${count}`
    return `${sidePrefix}${record.action.slice(0, 1).toUpperCase()}${count}`
  })
}

function emptyTimelineConfig(name = '新建配音轴'): VoiceTimelineConfig {
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
    clickPoints: [],
    createdAt: now,
    updatedAt: now
  }
}

function sortClickPoints(points: VoiceTimelineClickPoint[]): VoiceTimelineClickPoint[] {
  return [...points].sort((left, right) => {
    if (left.time !== right.time) {
      return left.time - right.time
    }
    if (left.type === right.type) {
      return left.id.localeCompare(right.id)
    }
    return left.type === 'delay_extra_click' ? -1 : 1
  })
}

function VoiceTimelinePanel({
  active,
  selectedVoiceTimelineFile,
  onSelectedVoiceTimelineFileChange,
  onVoiceTimelineListRefresh,
  onMessage
}: VoiceTimelinePanelProps): React.JSX.Element {
  const [flowList, setFlowList] = useState<FlowListItem[]>([])
  const [resultList, setResultList] = useState<BpResultListItem[]>([])
  const [characters, setCharacters] = useState<Character[]>([])
  const [timeline, setTimeline] = useState<VoiceTimelineConfig>(emptyTimelineConfig())
  const [displaySettings, setDisplaySettings] = useState<DisplaySettings | null>(null)
  const [selectedResult, setSelectedResult] = useState<BpResult | null>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [playbackRate, setPlaybackRate] = useState(1)
  const [selectedPointId, setSelectedPointId] = useState<string | null>(null)
  const [pendingPointDragId, setPendingPointDragId] = useState<string | null>(null)
  const [audioError, setAudioError] = useState('')
  const [displayLinked, setDisplayLinked] = useState(false)
  const [extraClickSerial, setExtraClickSerial] = useState(0)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [audioDuration, setAudioDuration] = useState(0)
  const [previewChantVideo, setPreviewChantVideo] = useState<DisplayChantVideo | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const currentTimeRef = useRef(0)
  const playbackRateRef = useRef(1)
  const playingRef = useRef(false)
  const previewCursorRef = useRef(0)
  const previewPvSwitchTimerRef = useRef<number | null>(null)
  const previewPvSessionRef = useRef(0)
  const displaySessionIdRef = useRef('')
  const trackRef = useRef<HTMLDivElement>(null)
  const pointIdSerialRef = useRef(0)
  const characterLookup = useMemo(
    () => new Map(characters.map((character) => [character.id, character])),
    [characters]
  )

  const cancelPendingPreviewPvSwitch = useCallback((): void => {
    if (previewPvSwitchTimerRef.current !== null) {
      window.clearTimeout(previewPvSwitchTimerRef.current)
      previewPvSwitchTimerRef.current = null
    }
    previewPvSessionRef.current += 1
  }, [])

  const hidePreviewChantVideo = useCallback((): void => {
    cancelPendingPreviewPvSwitch()
    setPreviewChantVideo(null)
  }, [cancelPendingPreviewPvSwitch])

  const showPreviewChantVideo = useCallback(
    (video: DisplayChantVideo, pvVideo: DisplayChantVideo | null = null): void => {
      cancelPendingPreviewPvSwitch()
      const session = previewPvSessionRef.current
      setPreviewChantVideo(video)

      if (!pvVideo) {
        return
      }

      previewPvSwitchTimerRef.current = window.setTimeout(() => {
        if (previewPvSessionRef.current !== session) {
          return
        }

        previewPvSwitchTimerRef.current = null
        setPreviewChantVideo(pvVideo)
      }, 5000)
    },
    [cancelPendingPreviewPvSwitch]
  )

  const loadReferenceLists = useCallback(async (): Promise<void> => {
    const [flows, results, nextCharacters] = await Promise.all([
      window.bpAPI.flows.list(),
      window.bpAPI.bp.listResults(),
      window.bpAPI.characters.list()
    ])
    setFlowList(flows)
    setResultList(results)
    setCharacters(nextCharacters)
  }, [])

  const resetTimelineSelection = useCallback((): void => {
    setTimeline(emptyTimelineConfig())
    setSelectedResult(null)
    setAudioUrl(null)
    setAudioDuration(0)
  }, [])

  const loadTimelineFile = useCallback(
    async (fileName: string): Promise<void> => {
      if (!fileName) {
        resetTimelineSelection()
        return
      }

      const loaded = await window.bpAPI.voiceTimelines.load(fileName)
      setTimeline({ ...loaded, clickPoints: sortClickPoints(loaded.clickPoints) })
      setPlaybackRate(
        playbackRates.includes(Number(loaded.playbackRate)) ? Number(loaded.playbackRate) : 1
      )
      setCurrentTime(0)

      if (loaded.bpResultFile) {
        const result = await window.bpAPI.bp.loadResult(loaded.bpResultFile)
        setSelectedResult(result)
      } else {
        setSelectedResult(null)
      }
    },
    [resetTimelineSelection]
  )

  useEffect(() => {
    if (!active) {
      return
    }
    let disposed = false
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadReferenceLists().catch((error: unknown) =>
      onMessage('error', error instanceof Error ? error.message : String(error))
    )
    window.bpAPI.displaySettings
      .get()
      .then((settings) => {
        if (!disposed) {
          setDisplaySettings(settings)
        }
      })
      .catch((error: unknown) =>
        onMessage('error', error instanceof Error ? error.message : String(error))
      )
    const stopDisplayUpdated = window.bpAPI.displaySettings.onUpdated((settings) => {
      if (!disposed) {
        setDisplaySettings(settings)
      }
    })
    return () => {
      disposed = true
      stopDisplayUpdated()
    }
  }, [active, loadReferenceLists, onMessage])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadTimelineFile(selectedVoiceTimelineFile).catch((error: unknown) =>
      onMessage('error', error instanceof Error ? error.message : String(error))
    )
  }, [loadTimelineFile, onMessage, selectedVoiceTimelineFile])

  useEffect(() => {
    if (!active) {
      return undefined
    }

    return window.bpAPI.files.onChanged((event) => {
      if (fileChangeIncludes(event, 'flows', 'bpResults', 'characters', 'assets')) {
        loadReferenceLists().catch((error: unknown) =>
          onMessage('error', error instanceof Error ? error.message : String(error))
        )
      }

      if (fileChangeIncludes(event, 'voiceTimelines')) {
        onVoiceTimelineListRefresh(selectedVoiceTimelineFile).catch((error: unknown) =>
          onMessage('error', error instanceof Error ? error.message : String(error))
        )
        loadTimelineFile(selectedVoiceTimelineFile).catch(() => resetTimelineSelection())
      }
    })
  }, [
    active,
    loadReferenceLists,
    loadTimelineFile,
    onMessage,
    onVoiceTimelineListRefresh,
    resetTimelineSelection,
    selectedVoiceTimelineFile
  ])

  useEffect(() => {
    const resolveAudioUrl = async (): Promise<void> => {
      if (!timeline.audioPath) {
        setAudioUrl(null)
        setAudioDuration(0)
        return
      }
      const url = await window.bpAPI.files.toFileUrl(timeline.audioPath)
      setAudioUrl(url)
    }
    resolveAudioUrl().catch((error: unknown) =>
      onMessage('error', error instanceof Error ? error.message : String(error))
    )
  }, [onMessage, timeline.audioPath])

  useEffect(() => {
    previewCursorRef.current = 0
    queueMicrotask(hidePreviewChantVideo)
  }, [hidePreviewChantVideo, selectedVoiceTimelineFile, selectedResult?.createdAt])

  useEffect(() => {
    return () => {
      cancelPendingPreviewPvSwitch()
    }
  }, [cancelPendingPreviewPvSwitch])

  useEffect(() => {
    currentTimeRef.current = currentTime
  }, [currentTime])

  useEffect(() => {
    playbackRateRef.current = playbackRate
  }, [playbackRate])

  useEffect(() => {
    playingRef.current = playing
  }, [playing])

  useEffect(() => {
    if (!audioUrl) {
      if (audioRef.current) {
        audioRef.current.pause()
      }
      audioRef.current = null
      queueMicrotask(() => setPlaying(false))
      return
    }

    const audio = new Audio(audioUrl)
    audio.preload = 'metadata'
    audio.playbackRate = playbackRateRef.current
    const initialTime = currentTimeRef.current
    audio.currentTime = Math.min(initialTime, audio.duration || initialTime)
    audioRef.current = audio
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAudioError('')

    const onLoaded = (): void => {
      const duration = Number.isFinite(audio.duration) ? audio.duration : 0
      setAudioDuration(duration)
      setTimeline((current) => ({ ...current, duration }))
    }
    const onError = (): void => {
      setAudioError('音频加载失败，请检查文件是否存在')
      setPlaying(false)
    }
    const onTimeUpdate = (): void => {
      setCurrentTime(audio.currentTime)
    }
    const onPlay = (): void => setPlaying(true)
    const onPause = (): void => setPlaying(false)

    audio.addEventListener('loadedmetadata', onLoaded)
    audio.addEventListener('error', onError)
    audio.addEventListener('timeupdate', onTimeUpdate)
    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)

    return () => {
      audio.pause()
      audio.removeEventListener('loadedmetadata', onLoaded)
      audio.removeEventListener('error', onError)
      audio.removeEventListener('timeupdate', onTimeUpdate)
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
    }
  }, [audioUrl])

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = playbackRate
    }
  }, [playbackRate])

  const flowForPreview = useMemo(() => {
    if (selectedResult?.flowConfig) {
      return normalizeFlowConfig(selectedResult.flowConfig)
    }
    return normalizeFlowConfig(defaultFlow)
  }, [selectedResult])

  const sourceRuntime = useMemo(() => {
    if (!selectedResult) {
      return createRuntime(flowForPreview)
    }
    return {
      ...buildRuntimeFromActions(flowForPreview, selectedResult.actions),
      upCharacterPvPath: selectedResult.upCharacterPvPath ?? null,
      upCharacterPvUrl: null
    }
  }, [flowForPreview, selectedResult])

  const stepTemplates = useMemo<TimelineStepTemplate[]>(() => {
    if (!selectedResult) {
      return []
    }
    const aliases = stepAlias(selectedResult.actions)
    return selectedResult.actions.map((action, index) => {
      const iconPath = timelineTargetIconUrl(action)
      return {
        id: `${index + 1}-${action.stepIndex}-${action.action}-${action.targetId}`,
        stepIndex: action.stepIndex,
        stepName: aliases[index] ?? `Step${index + 1}`,
        side: action.action === 'protect' || action.action === 'borrow' ? null : action.side,
        action: action.action,
        targetType: action.targetType,
        targetId: action.targetId ?? null,
        targetName: action.targetName ?? '',
        iconPath,
        iconUrl: iconPath,
        note:
          action.action === 'protect' || action.action === 'borrow'
            ? action.targetName
            : `${actionLabel(action.action)} ${action.targetName}`
      }
    })
  }, [selectedResult])

  const insertedStepIds = useMemo(() => {
    return new Set(
      timeline.clickPoints
        .filter((point) => point.type === 'bp_step')
        .map((point) => `${point.stepIndex}-${point.action}-${point.targetId}`)
    )
  }, [timeline.clickPoints])

  const pendingTemplates = useMemo(() => {
    return stepTemplates.filter(
      (step) => !insertedStepIds.has(`${step.stepIndex}-${step.action}-${step.targetId}`)
    )
  }, [insertedStepIds, stepTemplates])

  const sortedClickPoints = useMemo(
    () => sortClickPoints(timeline.clickPoints),
    [timeline.clickPoints]
  )

  const previewProgress = useMemo<ReplayProgress>(() => {
    const points = sortedClickPoints.filter((point) => point.time <= currentTime + 0.001)
    let progress: ReplayProgress = {
      cursor: 0,
      completedDelayedChangeKeys: new Set(),
      delayClickProgress: {}
    }

    for (const point of points) {
      const replayState = buildReplayState(sourceRuntime, progress.cursor)
      const pending = pendingDelayedChanges(
        replayState,
        displaySettings?.pageChanges ?? [],
        progress.completedDelayedChangeKeys,
        progress.delayClickProgress
      )

      if (point.type === 'delay_extra_click') {
        if (pending.length === 0) {
          continue
        }
        const next = { ...progress.delayClickProgress }
        const completed = new Set(progress.completedDelayedChangeKeys)
        for (const pendingPoint of pending) {
          const clicks = (next[pendingPoint.key] ?? 0) + 1
          if (clicks >= pendingPoint.requiredClicks) {
            delete next[pendingPoint.key]
            completed.add(pendingPoint.key)
          } else {
            next[pendingPoint.key] = clicks
          }
        }
        progress = {
          ...progress,
          delayClickProgress: next,
          completedDelayedChangeKeys: completed
        }
        continue
      }

      if (pending.length > 0) {
        const next = { ...progress.delayClickProgress }
        const completed = new Set(progress.completedDelayedChangeKeys)
        for (const pendingPoint of pending) {
          const clicks = (next[pendingPoint.key] ?? 0) + 1
          if (clicks >= pendingPoint.requiredClicks) {
            delete next[pendingPoint.key]
            completed.add(pendingPoint.key)
          } else {
            next[pendingPoint.key] = clicks
          }
        }
        progress = {
          ...progress,
          delayClickProgress: next,
          completedDelayedChangeKeys: completed
        }
        continue
      }

      progress = {
        ...progress,
        cursor: Math.min(progress.cursor + 1, sourceRuntime.actions.length)
      }
    }

    return progress
  }, [currentTime, displaySettings?.pageChanges, sortedClickPoints, sourceRuntime])

  const previewRuntime = useMemo(() => {
    const replayState = buildReplayState(sourceRuntime, previewProgress.cursor)
    const eventState = resolveReplayEventState(
      replayState,
      displaySettings?.pageChanges ?? [],
      previewProgress.completedDelayedChangeKeys,
      previewProgress.delayClickProgress
    )
    return {
      ...replayState,
      currentEvents: eventState.currentEvents,
      eventHistory: eventState.eventHistory,
      executedPageChangeIds: eventState.executedPageChangeIds,
      currentPageChangeIds: eventState.currentPageChangeIds
    }
  }, [displaySettings?.pageChanges, previewProgress, sourceRuntime])

  const pendingDelayForNow = useMemo(() => {
    const replayState = buildReplayState(sourceRuntime, previewProgress.cursor)
    return pendingDelayedChanges(
      replayState,
      displaySettings?.pageChanges ?? [],
      previewProgress.completedDelayedChangeKeys,
      previewProgress.delayClickProgress
    )
  }, [displaySettings?.pageChanges, previewProgress, sourceRuntime])

  useEffect(() => {
    const nextCursor = previewProgress.cursor
    const previousCursor = previewCursorRef.current

    if (nextCursor < previousCursor) {
      queueMicrotask(hidePreviewChantVideo)
    }
    if (nextCursor <= 0 || nextCursor === previousCursor) {
      previewCursorRef.current = nextCursor
      return
    }
    previewCursorRef.current = nextCursor

    const action = sourceRuntime.actions[nextCursor - 1]
    if (!action) {
      return
    }

    if (isEffectSoundAction(action.action)) {
      playAudio(displaySettings?.slotEffects?.[action.action]?.selectedSoundUrl)
    }

    if (action.action === 'protect') {
      cancelPendingPreviewPvSwitch()
      const leftUrl = action.starTarget?.chant_video_url ?? null
      const rightUrl = action.railTarget?.chant_video_url ?? null
      if (leftUrl || rightUrl) {
        queueMicrotask(() =>
          showPreviewChantVideo({
            kind: 'protect',
            key: `protect-${action.stepIndex}-${leftUrl ?? 'empty'}-${rightUrl ?? 'empty'}`,
            leftUrl,
            rightUrl
          })
        )
      }
      return
    }

    if (
      (action.action !== 'pick' && action.action !== 'ban') ||
      action.targetType !== 'character'
    ) {
      cancelPendingPreviewPvSwitch()
      return
    }

    const character = resolveActionCharacter(action, characterLookup)
    if (!character) {
      cancelPendingPreviewPvSwitch()
      return
    }
    const voiceUrl = action.action === 'ban' ? character.ban_voice_url : character.pick_voice_url
    if (action.action === 'pick') {
      playAudio(character.pick_sound_url)
    }
    playAudio(voiceUrl)

    const chantVideoUrl = character.chant_video_url
    if (!chantVideoUrl) {
      cancelPendingPreviewPvSwitch()
      return
    }

    const pvVideo =
      character.pv_url && character.pv_url.trim()
        ? {
            kind: 'single' as const,
            key: `pv-${action.action}-${action.stepIndex}-${character.id}-${character.pv_url}`,
            url: character.pv_url,
            startTime: normalizePvStartTime(character.pv_start_time)
          }
        : null

    queueMicrotask(() =>
      showPreviewChantVideo(
        {
          kind: 'single',
          key: `${action.action}-${action.stepIndex}-${character.id}-${chantVideoUrl}`,
          url: chantVideoUrl
        },
        pvVideo
      )
    )
  }, [
    cancelPendingPreviewPvSwitch,
    characterLookup,
    displaySettings?.slotEffects,
    hidePreviewChantVideo,
    previewProgress.cursor,
    showPreviewChantVideo,
    sourceRuntime.actions
  ])

  const buildPlaybackPayload = useCallback(
    (patch: Partial<VoiceTimelinePlayback> = {}): VoiceTimelinePlayback => ({
      timelineId: timeline.id,
      sessionId: displaySessionIdRef.current || undefined,
      timelineName: timeline.name,
      audioPath: timeline.audioPath,
      audioUrl,
      duration: Math.max(timeline.duration, audioDuration),
      clickPoints: sortClickPoints(timeline.clickPoints),
      playbackRate,
      currentTime: currentTimeRef.current,
      playing: playingRef.current,
      mode: 'voice_timeline_linked',
      ...patch
    }),
    [audioDuration, audioUrl, playbackRate, timeline]
  )

  const syncDisplayPlayback = useCallback(
    (patch: Partial<VoiceTimelinePlayback> = {}): void => {
      if (!displayLinked) {
        return
      }
      const payload = buildPlaybackPayload(patch)
      window.bpAPI.bp.setVoiceTimelinePlayback(payload).catch((error: unknown) => {
        onMessage('error', error instanceof Error ? error.message : String(error))
      })
    },
    [buildPlaybackPayload, displayLinked, onMessage]
  )

  useEffect(() => {
    syncDisplayPlayback({ playing, currentTime: currentTimeRef.current })
  }, [playing, syncDisplayPlayback])

  useEffect(() => {
    syncDisplayPlayback({ clickPoints: sortedClickPoints, currentTime: currentTimeRef.current })
  }, [sortedClickPoints, syncDisplayPlayback])

  useEffect(() => {
    if (playingRef.current) {
      return
    }
    syncDisplayPlayback({ currentTime })
  }, [currentTime, syncDisplayPlayback])

  const jumpTo = useCallback(
    (nextTime: number): void => {
      const duration = Math.max(timeline.duration, audioDuration)
      const clamped = Math.max(0, Math.min(nextTime, duration > 0 ? duration : 0))
      currentTimeRef.current = clamped
      setCurrentTime(clamped)
      if (audioRef.current) {
        audioRef.current.currentTime = clamped
      }
      syncDisplayPlayback({ currentTime: clamped })
    },
    [audioDuration, syncDisplayPlayback, timeline.duration]
  )

  const importAudio = async (): Promise<void> => {
    try {
      const selected = await window.bpAPI.files.selectAudio()
      if (selected.canceled || !selected.path) {
        return
      }

      const imported = await window.bpAPI.files.importAsset(
        selected.path,
        'display',
        timeline.name || 'voice-timeline',
        `voice-timeline-audio-${Date.now()}`
      )
      setTimeline((current) => ({
        ...current,
        audioPath: imported.storedPath,
        audioUrl: imported.url,
        audioExists: imported.exists
      }))
      currentTimeRef.current = 0
      setCurrentTime(0)
      syncDisplayPlayback({
        audioPath: imported.storedPath,
        audioUrl: imported.url,
        currentTime: 0,
        playing: false
      })
      onMessage('success', `已导入音频：${fileName(selected.path)}`)
    } catch (error) {
      onMessage('error', error instanceof Error ? error.message : String(error))
    }
  }

  const pickResult = async (file: string): Promise<void> => {
    setTimeline((current) => ({ ...current, bpResultFile: file }))
    if (!file) {
      setSelectedResult(null)
      return
    }
    const result = await window.bpAPI.bp.loadResult(file)
    setSelectedResult(result)
    setTimeline((current) => ({
      ...current,
      bpResultName: result.name,
      bpFlowConfigName: result.flowName
    }))
  }

  const insertStepAtCurrentTime = (template: TimelineStepTemplate): void => {
    pointIdSerialRef.current += 1
    const point: VoiceTimelineClickPoint = {
      id: `click-${pointIdSerialRef.current}`,
      time: currentTime,
      type: 'bp_step',
      stepIndex: template.stepIndex,
      stepName: template.stepName,
      side: template.side,
      action: template.action,
      targetType: template.targetType,
      targetId: template.targetId,
      targetName: template.targetName,
      iconPath: template.iconPath
    }
    const nextPoints = sortClickPoints([...timeline.clickPoints, point])
    setTimeline((current) => ({
      ...current,
      clickPoints: nextPoints
    }))
    syncDisplayPlayback({ clickPoints: nextPoints, currentTime })
    onMessage('success', `已插入：${template.stepName} @ ${formatTimeLabel(currentTime)}`)
  }

  const insertExtraClickAtCurrentTime = (): void => {
    setExtraClickSerial((current) => current + 1)
    const index = extraClickSerial + 1
    pointIdSerialRef.current += 1
    const point: VoiceTimelineClickPoint = {
      id: `extra-${pointIdSerialRef.current}`,
      time: currentTime,
      type: 'delay_extra_click',
      label: `额外点击 ${index}`
    }
    const nextPoints = sortClickPoints([...timeline.clickPoints, point])
    setTimeline((current) => ({
      ...current,
      clickPoints: nextPoints
    }))
    syncDisplayPlayback({ clickPoints: nextPoints, currentTime })
    onMessage('success', `已插入额外点击 @ ${formatTimeLabel(currentTime)}`)
  }

  const deletePoint = (pointId: string): void => {
    const nextPoints = timeline.clickPoints.filter((point) => point.id !== pointId)
    setTimeline((current) => ({
      ...current,
      clickPoints: nextPoints
    }))
    syncDisplayPlayback({ clickPoints: nextPoints, currentTime })
    if (selectedPointId === pointId) {
      setSelectedPointId(null)
    }
  }

  const saveTimeline = async (forceSaveAs = false): Promise<void> => {
    try {
      const payload: VoiceTimelineConfig = {
        ...timeline,
        duration: Math.max(timeline.duration, audioDuration),
        updatedAt: new Date().toISOString(),
        playbackRate
      } as VoiceTimelineConfig
      const targetFileName =
        forceSaveAs || !selectedVoiceTimelineFile ? undefined : selectedVoiceTimelineFile
      const saved = await window.bpAPI.voiceTimelines.save(payload, targetFileName)
      onSelectedVoiceTimelineFileChange(saved.fileName)
      await onVoiceTimelineListRefresh(saved.fileName)
      onMessage('success', `已保存配音轴：${saved.fileName}`)
    } catch (error) {
      onMessage('error', error instanceof Error ? error.message : String(error))
    }
  }

  const openDisplayWithTimeline = async (): Promise<void> => {
    if (!timeline.audioPath || !audioUrl) {
      onMessage('error', '请先导入音频，再打开配音轴联动展示页')
      return
    }
    if (!timeline.bpFlowConfigFile || !timeline.bpResultFile || !selectedResult) {
      onMessage('error', '请先选择 BP 流程和 BP 结果，再打开配音轴联动展示页')
      return
    }

    if (timeline.clickPoints.length === 0) {
      onMessage('info', '当前没有插入点击点，展示页只会播放音频，不会自动推进 BP')
    }

    try {
      const audio = audioRef.current
      const startTime = 0
      currentTimeRef.current = startTime
      setCurrentTime(startTime)
      displaySessionIdRef.current = `${timeline.id}-${Date.now()}`
      playingRef.current = true
      setPlaying(true)
      if (audio) {
        audio.currentTime = startTime
      }

      const opened = await window.bpAPI.bp.openDisplayWindowLinked(
        sourceRuntime,
        buildPlaybackPayload({ currentTime: startTime, playing: true }),
        displaySettings
      )
      if (!opened) {
        playingRef.current = false
        setPlaying(false)
        onMessage('error', '展示页窗口打开失败')
        return
      }

      setDisplayLinked(true)
      if (audio) {
        await audio.play().catch(() => undefined)
      }
      onMessage('success', '展示页已打开，并进入配音轴联动模式')
    } catch (error: unknown) {
      playingRef.current = false
      setPlaying(false)
      onMessage('error', error instanceof Error ? error.message : String(error))
    }
  }
  useEffect(() => {
    if (!pendingPointDragId) {
      return
    }

    const move = (event: MouseEvent): void => {
      const track = trackRef.current
      const duration = Math.max(timeline.duration, audioDuration)
      if (!track || duration <= 0) {
        return
      }
      const rect = track.getBoundingClientRect()
      const ratio = Math.max(0, Math.min((event.clientX - rect.left) / rect.width, 1))
      const time = duration * ratio
      setTimeline((current) => ({
        ...current,
        clickPoints: sortClickPoints(
          current.clickPoints.map((point) =>
            point.id === pendingPointDragId ? { ...point, time } : point
          )
        )
      }))
    }

    const up = (): void => setPendingPointDragId(null)
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [audioDuration, pendingPointDragId, timeline.duration])

  const togglePlay = async (): Promise<void> => {
    const audio = audioRef.current
    if (!audio) {
      onMessage('error', '请先导入音频')
      return
    }
    if (playing) {
      audio.pause()
      syncDisplayPlayback({ playing: false, currentTime: audio.currentTime })
      return
    }
    try {
      await audio.play()
      syncDisplayPlayback({ playing: true, currentTime: audio.currentTime })
    } catch {
      onMessage('error', '音频播放失败，请先与页面交互后重试')
    }
  }

  return (
    <section className="voice-timeline-workbench">
      <div className="voice-timeline-main">
        <div className="section-header">
          <div>
            <h1>配音轴 / 配音编排</h1>
          </div>
          <div className="header-actions">
            <button type="button" onClick={importAudio}>
              导入音频
            </button>
            <button type="button" onClick={() => saveTimeline(false)}>
              保存
            </button>
            <button type="button" onClick={() => saveTimeline(true)}>
              另存为
            </button>
            <button type="button" onClick={() => void openDisplayWithTimeline()}>
              打开展示页
            </button>
          </div>
        </div>

        <div className="voice-timeline-toolbar">
          <label>
            名称
            <input
              value={timeline.name}
              onChange={(event) =>
                setTimeline((current) => ({ ...current, name: event.target.value }))
              }
            />
          </label>
          <label>
            BP 流程
            <select
              value={timeline.bpFlowConfigFile}
              onChange={(event) => {
                const file = event.target.value
                const flow = flowList.find((item) => item.fileName === file)
                setTimeline((current) => ({
                  ...current,
                  bpFlowConfigFile: file,
                  bpFlowConfigName: flow?.name ?? ''
                }))
              }}
            >
              <option value="">选择流程文件</option>
              {flowList.map((flow) => (
                <option key={flow.fileName} value={flow.fileName}>
                  {flow.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            BP 结果
            <select
              value={timeline.bpResultFile}
              onChange={(event) =>
                pickResult(event.target.value).catch((error: unknown) =>
                  onMessage('error', error instanceof Error ? error.message : String(error))
                )
              }
            >
              <option value="">选择 BP 结果</option>
              {resultList.map((result) => (
                <option key={result.fileName} value={result.fileName}>
                  {result.name}
                </option>
              ))}
            </select>
          </label>
          <div className="voice-audio-status">
            <strong>{timeline.audioPath ? fileName(timeline.audioPath) : '未导入音频'}</strong>
            <span>时长：{formatTimeLabel(Math.max(timeline.duration, audioDuration))}</span>
            {audioError ? <span className="error">{audioError}</span> : null}
          </div>
        </div>

        <div className="voice-preview-panel">
          <div className="voice-preview-stage">
            <div className="voice-preview-wrapper">
              {displaySettings ? (
                <DisplayCanvas
                  settings={displaySettings}
                  state={previewRuntime}
                  className="voice-preview-canvas live-display-stage"
                  showCenterStage={false}
                  chantVideo={previewChantVideo}
                  onChantVideoEnded={hidePreviewChantVideo}
                  muteChantVideo
                  nextAction={sourceRuntime.actions[previewProgress.cursor] ?? null}
                  followingAction={sourceRuntime.actions[previewProgress.cursor + 1] ?? null}
                  futureActions={sourceRuntime.actions.slice(previewProgress.cursor)}
                  selectedAction={sourceRuntime.actions[previewProgress.cursor - 1] ?? null}
                />
              ) : (
                <div className="voice-empty">未读取到展示页配置，请先保存或加载展示页配置。</div>
              )}
            </div>
          </div>
        </div>

        <section className="voice-timeline-panel">
          <div className="voice-click-track" ref={trackRef}>
            {sortedClickPoints.map((point) => {
              const duration = Math.max(timeline.duration, audioDuration)
              const ratio = duration > 0 ? point.time / duration : 0
              const template = stepTemplates.find(
                (item) =>
                  item.stepIndex === point.stepIndex &&
                  item.action === point.action &&
                  item.targetId === point.targetId
              )
              const label =
                point.type === 'delay_extra_click'
                  ? point.label || '额外点击'
                  : point.stepName || 'BP点击'
              const tooltip = [
                `步骤：${label}`,
                `时间：${formatTimeLabel(point.time)}`,
                `阵营：${point.side === 'star' ? '先手/左侧队' : point.side === 'rail' ? '后手/右侧队' : '无'}`,
                `行为：${point.type === 'delay_extra_click' ? '额外点击' : actionLabel(point.action || 'pick')}`,
                `目标：${point.targetName || '-'}`
              ].join('\n')

              return (
                <button
                  key={point.id}
                  type="button"
                  className={`voice-marker ${point.type} ${selectedPointId === point.id ? 'active' : ''}`}
                  style={{ left: `${Math.max(0, Math.min(ratio * 100, 100))}%` }}
                  title={tooltip}
                  onClick={() => {
                    setSelectedPointId(point.id)
                    jumpTo(point.time)
                  }}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    setPendingPointDragId(point.id)
                  }}
                >
                  {template?.iconUrl ? <img src={template.iconUrl} alt="" /> : null}
                  <span>{label}</span>
                </button>
              )
            })}
            <div
              className="voice-cursor"
              style={{
                left: `${Math.max(0, Math.min((Math.max(0, currentTime) / Math.max(timeline.duration, audioDuration, 0.001)) * 100, 100))}%`
              }}
            />
          </div>

          <div className="voice-audio-scrubber">
            <input
              type="range"
              min={0}
              max={Math.max(timeline.duration, audioDuration, 0.001)}
              step={0.01}
              value={Math.min(currentTime, Math.max(timeline.duration, audioDuration, 0.001))}
              onChange={(event) => jumpTo(Number(event.target.value))}
            />
          </div>

          <div className="voice-controls">
            <button type="button" onClick={() => jumpTo(currentTime - 5)}>
              {'<5s'}
            </button>
            <button type="button" onClick={() => jumpTo(currentTime - 1)}>
              {'<1s'}
            </button>
            <button type="button" onClick={() => jumpTo(currentTime - 0.5)}>
              {'<0.5s'}
            </button>
            <button type="button" onClick={() => jumpTo(currentTime - 0.1)}>
              {'<0.1s'}
            </button>
            <button type="button" className="primary" onClick={() => void togglePlay()}>
              {playing ? '暂停' : '播放'}
            </button>
            <button type="button" onClick={() => jumpTo(currentTime + 0.1)}>
              {'0.1s>'}
            </button>
            <button type="button" onClick={() => jumpTo(currentTime + 0.5)}>
              {'0.5s>'}
            </button>
            <button type="button" onClick={() => jumpTo(currentTime + 1)}>
              {'1s>'}
            </button>
            <button type="button" onClick={() => jumpTo(currentTime + 5)}>
              {'5s>'}
            </button>
            <label className="voice-rate">
              倍数
              <select
                value={String(playbackRate)}
                onChange={(event) => {
                  const nextRate = Number(event.target.value)
                  setPlaybackRate(nextRate)
                  syncDisplayPlayback({ playbackRate: nextRate })
                }}
              >
                {playbackRates.map((rate) => (
                  <option key={rate} value={rate}>
                    {rate}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </section>

        <section className="voice-inserted-panel">
          <header className="voice-inserted-header">
            <h3>已插入流程</h3>
            <div className="voice-bottom-info">
              <span>当前时间：{formatTimeLabel(currentTime)}</span>
              <span>已插入点击：{timeline.clickPoints.length}</span>
              <span>
                预览进度：{previewProgress.cursor}/{sourceRuntime.actions.length}
              </span>
              {pendingDelayForNow.length > 0 ? (
                <span className="warning">当前存在延迟变化，BP 点击会被拦截，请插入额外点击。</span>
              ) : null}
            </div>
          </header>
          <div className="voice-inserted-list">
            {sortedClickPoints.map((point) => {
              const template = stepTemplates.find(
                (item) =>
                  item.stepIndex === point.stepIndex &&
                  item.action === point.action &&
                  item.targetId === point.targetId
              )
              const pointLabel =
                point.type === 'delay_extra_click'
                  ? point.label || '额外点击'
                  : point.stepName || 'BP点击'
              const actionText =
                point.type === 'delay_extra_click'
                  ? '额外点击'
                  : actionLabel(point.action || 'pick')

              return (
                <article
                  key={point.id}
                  className={`voice-point-item ${point.type} ${selectedPointId === point.id ? 'active' : ''}`}
                  onClick={() => {
                    setSelectedPointId(point.id)
                    jumpTo(point.time)
                  }}
                >
                  <div className="voice-point-main">
                    {template?.iconUrl ? <img src={template.iconUrl} alt="" /> : null}
                    <div className="voice-point-meta">
                      <strong>{pointLabel}</strong>
                      <span>{formatTimeLabel(point.time)}</span>
                      <small>{actionText}</small>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="danger"
                    onClick={(event) => {
                      event.stopPropagation()
                      deletePoint(point.id)
                    }}
                  >
                    删除
                  </button>
                </article>
              )
            })}
            {sortedClickPoints.length === 0 ? (
              <div className="voice-empty">暂无点击点。</div>
            ) : null}
          </div>
        </section>
      </div>

      <aside className="voice-pending-panel">
        <header>
          <h2>待插入 BP 内容</h2>
          <button type="button" onClick={insertExtraClickAtCurrentTime}>
            插入额外点击
          </button>
        </header>
        {pendingTemplates.length === 0 ? (
          <div className="voice-empty">已插入全部 BP 步骤。</div>
        ) : (
          <div className="voice-pending-list">
            {pendingTemplates.map((template) => (
              <article key={template.id} className="voice-pending-item">
                <div className="voice-pending-meta">
                  <strong>{template.stepName}</strong>
                  <span>
                    {actionLabel(template.action)} /{' '}
                    {template.side === 'star' ? '先手' : template.side === 'rail' ? '后手' : '双方'}
                  </span>
                  <span>{template.targetName || '-'}</span>
                </div>
                <button type="button" onClick={() => insertStepAtCurrentTime(template)}>
                  插入
                </button>
              </article>
            ))}
          </div>
        )}
      </aside>
    </section>
  )
}

export default VoiceTimelinePanel
