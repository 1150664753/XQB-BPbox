import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, SyntheticEvent } from 'react'

import DisplayBackground from './DisplayBackground'
import DisplayCenterStage from './DisplayCenterStage'
import DisplayTeamPanel from './DisplayTeamPanel'
import {
  coordinateScaleX,
  coordinateScaleY,
  designStageHeight,
  designStageWidth,
  renderStageHeight,
  renderStageWidth
} from './displayGeometry'
import type {
  BpActionRecord,
  BpSide,
  BpRuntimeState,
  DisplayPageChange,
  DisplaySettings,
  DisplaySlotEffectConfig,
  DisplaySlotEffectLayout,
  DisplaySlotEffects,
  DisplaySlotLayout,
  DisplayVideoSlotLayout
} from '../../types/bp'
import { getPvPlaybackSeekTime } from '../../../../shared/pvPlayback'

const defaultChantVideoSlot = {
  x: 645,
  y: 255,
  width: 630,
  height: 390,
  visible: true,
  layer: 20
}
// Controls the original mask transition width for paired protect chant videos.
const protectTransitionWidth = 22
// Controls the original diagonal mask angle for paired protect chant videos.
const protectTransitionAngle = 120
// Controls only the scale of paired chant videos shown in the protect stage.
const protectCallVideoScale = 1.3
const defaultSlotEffects: DisplaySlotEffects = {
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
}

type SlotEffectAction = 'pick' | 'ban'
type SlotEffectKind = keyof DisplaySlotEffects
type SlotLayoutGroup = 'pick' | 'pickSecond' | 'ban' | 'banSecond'
type SlotEffectActionRecord = BpActionRecord & { action: SlotEffectAction }

interface SlotEffectTarget {
  side: BpSide
  action: SlotEffectAction
  index: number
}

interface SlotBox {
  x: number
  y: number
  width: number
  height: number
}

interface SlotEffectInstance {
  slotKey: string
  effectKind: SlotEffectKind
  mode: 'pending' | 'selected' | 'preview'
  effectKey: string | number
  loop: boolean
  closeGroup?: string
}

export type CurrentVideoMode = 'voice' | 'characterPv' | 'upPv'

export type DisplayChantVideo =
  | {
      kind: 'single'
      key: string | number
      url: string
      startTime?: number
      pvStartTime?: number
      pvEndTime?: number
      mode?: CurrentVideoMode
    }
  | {
      kind: 'protect'
      key: string | number
      leftUrl?: string | null
      rightUrl?: string | null
      leftStartTime?: number
      rightStartTime?: number
    }

type SingleChantVideo = Extract<DisplayChantVideo, { kind: 'single' }>
type ProtectChantVideo = Extract<DisplayChantVideo, { kind: 'protect' }>
type ProtectChantVideoSide = 'left' | 'right'

interface ProtectChantVideoEndState {
  key: string | number | null
  left: boolean
  right: boolean
  reported: boolean
}

const hiddenChantVideoPreloaderStyle: CSSProperties = {
  position: 'absolute',
  left: 0,
  top: 0,
  width: 1,
  height: 1,
  opacity: 0,
  pointerEvents: 'none'
}

interface TopSlotEffectVideoProps {
  className: string
  src: string
  loop: boolean
  style: CSSProperties
  onFinished?: () => void
}

function seekVideoStartTime(
  video: HTMLVideoElement,
  startTime: number | null | undefined,
  pvStartTime?: number,
  pvEndTime?: number
): void {
  const requestedTime = Number(startTime)
  const hasPvPlaybackRange = pvStartTime !== undefined || pvEndTime !== undefined
  if ((!Number.isFinite(requestedTime) || requestedTime <= 0) && !hasPvPlaybackRange) {
    return
  }

  const duration = video.duration
  const nextTime = hasPvPlaybackRange
    ? getPvPlaybackSeekTime(duration, requestedTime, pvStartTime, pvEndTime)
    : Number.isFinite(duration) && duration > 0
      ? Math.min(requestedTime, Math.max(0, duration - 0.05))
      : requestedTime

  if (!Number.isFinite(nextTime) || nextTime <= 0) {
    return
  }

  try {
    video.currentTime = nextTime
  } catch {
    // Some media containers reject seeking before enough metadata is available.
  }
}

function hasPositiveStartTime(value: number | null | undefined): boolean {
  const numberValue = Number(value)
  return Number.isFinite(numberValue) && numberValue > 0
}

function singleVideoNeedsSeek(video: SingleChantVideo): boolean {
  return hasPositiveStartTime(video.startTime) || hasPositiveStartTime(video.pvStartTime)
}

function logVideoPlayFailure(label: string, error: unknown): void {
  console.warn(`[DisplayPage] ${label} video playback failed`, error)
}

function logVideoLoadFailure(label: string, src: string): void {
  console.warn(`[DisplayPage] ${label} video load failed: ${src}`)
}

function SeamlessChantVideo({
  video,
  preloadVideo,
  style,
  muted,
  paused = false,
  onEnded,
  onError,
  onTimeUpdate,
  onInterrupted,
  onActiveReady
}: {
  video: SingleChantVideo
  preloadVideo?: SingleChantVideo | null
  style: CSSProperties
  muted: boolean
  paused?: boolean
  onEnded?: (video: DisplayChantVideo, currentTime: number, duration: number) => void
  onError?: (video: DisplayChantVideo, currentTime: number, duration: number) => void
  onTimeUpdate?: (video: DisplayChantVideo, currentTime: number, duration: number) => void
  onInterrupted?: (video: DisplayChantVideo, currentTime: number, duration: number) => void
  onActiveReady?: (video: SingleChantVideo) => void
}): React.JSX.Element {
  const [renderedVideos, setRenderedVideos] = useState<SingleChantVideo[]>(() => [video])
  const [activeKey, setActiveKey] = useState<string | number>(video.key)
  const renderedKeysRef = useRef<Set<string | number>>(new Set([video.key]))
  const renderedVideosRef = useRef<SingleChantVideo[]>([video])
  const activeKeyRef = useRef<string | number>(video.key)
  const preloadKeysRef = useRef<Set<string | number>>(new Set())
  const onInterruptedRef = useRef<typeof onInterrupted>(onInterrupted)
  const onActiveReadyRef = useRef<typeof onActiveReady>(onActiveReady)
  const pausedRef = useRef(paused)
  const videoRefs = useRef<Map<string | number, HTMLVideoElement>>(new Map())
  const cleanupTimersRef = useRef<number[]>([])

  useEffect(() => {
    renderedVideosRef.current = renderedVideos
  }, [renderedVideos])

  useEffect(() => {
    activeKeyRef.current = activeKey
  }, [activeKey])

  useEffect(() => {
    onInterruptedRef.current = onInterrupted
  }, [onInterrupted])

  useEffect(() => {
    onActiveReadyRef.current = onActiveReady
  }, [onActiveReady])

  const reportActiveInterrupted = useCallback((): void => {
    const previousKey = activeKeyRef.current
    const element = videoRefs.current.get(previousKey)
    const previousVideo = renderedVideosRef.current.find((item) => item.key === previousKey)

    if (!element || !previousVideo) {
      return
    }

    onInterruptedRef.current?.(previousVideo, element.currentTime, element.duration)
  }, [])

  useEffect(() => {
    if (pausedRef.current === paused) {
      return
    }

    pausedRef.current = paused
    const element = videoRefs.current.get(activeKeyRef.current)
    if (!element) {
      return
    }

    if (paused) {
      reportActiveInterrupted()
      element.pause()
      return
    }

    element.play().catch((error: unknown) => logVideoPlayFailure('Chant/PV', error))
  }, [paused, reportActiveInterrupted])

  useEffect(() => {
    return () => {
      reportActiveInterrupted()
      cleanupTimersRef.current.forEach((timer) => window.clearTimeout(timer))
      cleanupTimersRef.current = []
    }
  }, [reportActiveInterrupted])

  const addRenderedVideo = useCallback((nextVideo: SingleChantVideo): void => {
    if (renderedKeysRef.current.has(nextVideo.key)) {
      setRenderedVideos((current) =>
        current.map((item) => (item.key === nextVideo.key ? nextVideo : item))
      )
      return
    }

    renderedKeysRef.current.add(nextVideo.key)
    queueMicrotask(() =>
      setRenderedVideos((current) => [
        ...current.filter((item) => item.key !== nextVideo.key),
        nextVideo
      ])
    )
  }, [])

  const activateVideo = useCallback(
    (nextVideo: SingleChantVideo): void => {
      if (activeKeyRef.current !== nextVideo.key) {
        reportActiveInterrupted()
      }
      preloadKeysRef.current.delete(nextVideo.key)
      setActiveKey(nextVideo.key)
      activeKeyRef.current = nextVideo.key
      onActiveReadyRef.current?.(nextVideo)
      if (!pausedRef.current) {
        window.requestAnimationFrame(() => {
          videoRefs.current
            .get(nextVideo.key)
            ?.play()
            .catch((error: unknown) => logVideoPlayFailure('Chant/PV', error))
        })
      }

      const cleanupTimer = window.setTimeout(() => {
        setRenderedVideos((current) =>
          current.filter(
            (item) => item.key === nextVideo.key || preloadKeysRef.current.has(item.key)
          )
        )
        renderedKeysRef.current = new Set([nextVideo.key, ...preloadKeysRef.current])
      }, 120)
      cleanupTimersRef.current.push(cleanupTimer)
    },
    [reportActiveInterrupted]
  )

  useEffect(() => {
    if (activeKeyRef.current !== video.key) {
      videoRefs.current.get(activeKeyRef.current)?.pause()
    }

    addRenderedVideo(video)
    queueMicrotask(() => {
      const element = videoRefs.current.get(video.key)

      if (element && element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        activateVideo(video)
      }
    })
  }, [activateVideo, addRenderedVideo, video])

  useEffect(() => {
    if (!preloadVideo || preloadVideo.key === video.key) {
      preloadKeysRef.current.clear()
      return
    }

    preloadKeysRef.current = new Set([preloadVideo.key])
    addRenderedVideo(preloadVideo)
  }, [addRenderedVideo, preloadVideo, video.key])

  const preparePendingVideo = (
    event: SyntheticEvent<HTMLVideoElement>,
    item: SingleChantVideo
  ): void => {
    const element = event.currentTarget
    if (item.key === activeKey) {
      seekVideoStartTime(element, item.startTime, item.pvStartTime, item.pvEndTime)
      return
    }

    if (preloadKeysRef.current.has(item.key)) {
      seekVideoStartTime(element, item.startTime, item.pvStartTime, item.pvEndTime)
      return
    }

    if (!singleVideoNeedsSeek(item)) {
      return
    }

    let activated = false
    const activateOnce = (): void => {
      if (activated) {
        return
      }
      activated = true
      activateVideo(item)
    }

    element.addEventListener('seeked', activateOnce, { once: true })
    seekVideoStartTime(element, item.startTime, item.pvStartTime, item.pvEndTime)
    const fallbackTimer = window.setTimeout(activateOnce, 220)
    cleanupTimersRef.current.push(fallbackTimer)
  }

  return (
    <>
      {renderedVideos.map((item) => {
        const active = item.key === activeKey
        const isPvVideo = item.mode === 'characterPv' || item.mode === 'upPv'
        const videoStyle: CSSProperties = {
          ...style,
          opacity: active ? 1 : 0
        }

        return (
          <video
            className={`display-chant-video${isPvVideo ? ' display-chant-video-pv' : ''}`}
            key={item.key}
            ref={(element) => {
              if (element) {
                videoRefs.current.set(item.key, element)
              } else {
                videoRefs.current.delete(item.key)
              }
            }}
            src={item.url}
            autoPlay={active}
            muted={!active || muted}
            playsInline
            preload="auto"
            onLoadedMetadata={(event) => preparePendingVideo(event, item)}
            onLoadedData={(event) => {
              if (
                item.key !== activeKey &&
                !preloadKeysRef.current.has(item.key) &&
                !singleVideoNeedsSeek(item)
              ) {
                activateVideo(item)
              }
              if (item.key === activeKey) {
                onActiveReadyRef.current?.(item)
                if (pausedRef.current) {
                  event.currentTarget.pause()
                  return
                }

                event.currentTarget
                  .play()
                  .catch((error: unknown) => logVideoPlayFailure('Chant/PV', error))
              }
            }}
            onTimeUpdate={(event) =>
              !pausedRef.current
                ? onTimeUpdate?.(
                    item,
                    event.currentTarget.currentTime,
                    event.currentTarget.duration
                  )
                : undefined
            }
            onEnded={() => {
              if (active) {
                const element = videoRefs.current.get(item.key)
                onEnded?.(item, element?.currentTime ?? 0, element?.duration ?? Number.NaN)
              }
            }}
            onError={(event) => {
              logVideoLoadFailure('Chant/PV', event.currentTarget.currentSrc || item.url)
              if (active) {
                onError?.(item, event.currentTarget.currentTime, event.currentTarget.duration)
              }
            }}
            style={videoStyle}
          />
        )
      })}
    </>
  )
}

function HiddenChantVideoPreloader({ video }: { video: SingleChantVideo }): React.JSX.Element {
  return (
    <video
      aria-hidden="true"
      key={video.key}
      src={video.url}
      muted
      playsInline
      preload="auto"
      onLoadedMetadata={(event) =>
        seekVideoStartTime(event.currentTarget, video.startTime, video.pvStartTime, video.pvEndTime)
      }
      style={hiddenChantVideoPreloaderStyle}
    />
  )
}

function ProtectChantVideoLayer({
  video,
  active,
  holdUntilReady,
  style,
  muted,
  onEnded,
  onTimeUpdate,
  onError
}: {
  video: ProtectChantVideo
  active: boolean
  holdUntilReady: boolean
  style: CSSProperties
  muted: boolean
  onEnded?: (video: DisplayChantVideo, currentTime: number, duration: number) => void
  onTimeUpdate?: (video: DisplayChantVideo, currentTime: number, duration: number) => void
  onError?: (video: DisplayChantVideo, currentTime: number, duration: number) => void
}): React.JSX.Element {
  const leftVideoRef = useRef<HTMLVideoElement | null>(null)
  const rightVideoRef = useRef<HTMLVideoElement | null>(null)
  const endStateRef = useRef<ProtectChantVideoEndState>({
    key: null,
    left: false,
    right: false,
    reported: false
  })
  const [readyState, setReadyState] = useState({
    key: video.key,
    left: !video.leftUrl,
    right: !video.rightUrl
  })

  useEffect(() => {
    if (active) {
      return
    }

    leftVideoRef.current?.pause()
    rightVideoRef.current?.pause()
  }, [active])

  const markReady = (side: ProtectChantVideoSide): void => {
    setReadyState((current) => {
      const base =
        current.key === video.key
          ? current
          : {
              key: video.key,
              left: !video.leftUrl,
              right: !video.rightUrl
            }

      return {
        ...base,
        [side]: true
      }
    })
  }

  const handleFinished = (
    side: ProtectChantVideoSide,
    currentTime: number,
    duration: number,
    callback?: (video: DisplayChantVideo, currentTime: number, duration: number) => void
  ): void => {
    if (!active) {
      return
    }

    const currentState =
      endStateRef.current.key === video.key
        ? endStateRef.current
        : {
            key: video.key,
            left: !video.leftUrl,
            right: !video.rightUrl,
            reported: false
          }

    const nextState = {
      ...currentState,
      [side]: true
    }
    endStateRef.current = nextState

    if (nextState.reported || !nextState.left || !nextState.right) {
      return
    }

    endStateRef.current = {
      ...nextState,
      reported: true
    }
    callback?.(video, currentTime, duration)
  }

  const ready = readyState.key === video.key && readyState.left && readyState.right
  const layerStyle: CSSProperties = {
    ...style,
    opacity: !active || ready || !holdUntilReady ? style.opacity : 0
  }

  return (
    <div
      className="display-chant-video display-chant-video-composite"
      key={video.key}
      style={layerStyle}
    >
      {video.leftUrl ? (
        <div className="display-chant-video-layer display-chant-video-protect-left">
          <div className="display-chant-video-source-frame display-chant-video-source-frame-left">
            <video
              ref={leftVideoRef}
              className="display-chant-video-source display-chant-video-source-mirror"
              src={video.leftUrl}
              autoPlay={active}
              muted={muted}
              playsInline
              preload="auto"
              onLoadedMetadata={(event) =>
                seekVideoStartTime(event.currentTarget, video.leftStartTime)
              }
              onLoadedData={() => markReady('left')}
              onTimeUpdate={(event) =>
                active
                  ? onTimeUpdate?.(
                      video,
                      event.currentTarget.currentTime,
                      event.currentTarget.duration
                    )
                  : undefined
              }
              onEnded={(event) =>
                handleFinished(
                  'left',
                  event.currentTarget.currentTime,
                  event.currentTarget.duration,
                  onEnded
                )
              }
              onError={(event) => {
                markReady('left')
                handleFinished(
                  'left',
                  event.currentTarget.currentTime,
                  event.currentTarget.duration,
                  onError ?? onEnded
                )
              }}
            />
          </div>
        </div>
      ) : null}
      {video.rightUrl ? (
        <div className="display-chant-video-layer display-chant-video-protect-right">
          <div className="display-chant-video-source-frame display-chant-video-source-frame-right">
            <video
              ref={rightVideoRef}
              className="display-chant-video-source"
              src={video.rightUrl}
              autoPlay={active}
              muted={muted}
              playsInline
              preload="auto"
              onLoadedMetadata={(event) =>
                seekVideoStartTime(event.currentTarget, video.rightStartTime)
              }
              onLoadedData={() => markReady('right')}
              onTimeUpdate={(event) =>
                active
                  ? onTimeUpdate?.(
                      video,
                      event.currentTarget.currentTime,
                      event.currentTarget.duration
                    )
                  : undefined
              }
              onEnded={(event) =>
                handleFinished(
                  'right',
                  event.currentTarget.currentTime,
                  event.currentTarget.duration,
                  onEnded
                )
              }
              onError={(event) => {
                markReady('right')
                handleFinished(
                  'right',
                  event.currentTarget.currentTime,
                  event.currentTarget.duration,
                  onError ?? onEnded
                )
              }}
            />
          </div>
        </div>
      ) : null}
    </div>
  )
}

interface ResolvedChantVideoSlot {
  layout: DisplayVideoSlotLayout
  activeResizeChange: DisplayPageChange | null
}

const fallbackSlotLayout: DisplaySlotLayout = {
  x: 0,
  y: 0,
  width: 240,
  height: 120,
  gap: 16,
  layer: 10,
  direction: 'vertical',
  frameImage: '',
  frameImageUrl: null,
  effectVideo: '',
  effectVideoUrl: null
}

function numberOrFallback(value: unknown, fallback: number): number {
  const normalized = Number(value)
  return Number.isFinite(normalized) ? normalized : fallback
}

function normalizeEventName(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function legacyPageChangeKey(
  pageChangeName?: string | null,
  pageChangeIndex?: number | null
): string | null {
  return normalizeEventName(pageChangeName) ?? (pageChangeIndex ? String(pageChangeIndex) : null)
}

function pageChangeKeys(state: BpRuntimeState): string[] {
  const eventKeys = state.eventHistory
    ?.map((eventRecord) => normalizeEventName(eventRecord.name))
    .filter((key): key is string => Boolean(key))
  if (eventKeys?.length) {
    return eventKeys
  }

  const actionKeys = state.actions
    .map((action) => legacyPageChangeKey(action.pageChangeName, action.pageChangeIndex))
    .filter((key): key is string => Boolean(key))
  const currentKey = legacyPageChangeKey(
    state.currentStep?.pageChangeName,
    state.currentStep?.pageChangeIndex
  )

  return currentKey ? [...actionKeys, currentKey] : actionKeys
}

function currentPageChangeKeys(state: BpRuntimeState): string[] {
  const currentEvents = state.currentEvents
    ?.map(normalizeEventName)
    .filter((key): key is string => Boolean(key))
  if (currentEvents?.length) {
    return currentEvents
  }

  const currentKey = legacyPageChangeKey(
    state.currentStep?.pageChangeName,
    state.currentStep?.pageChangeIndex
  )
  return currentKey ? [currentKey] : []
}

function pageChangeTriggerKey(pageChange: DisplayPageChange): string | null {
  return (
    normalizeEventName(pageChange.triggerEvent) ??
    normalizeEventName(pageChange.triggerName) ??
    normalizeEventName(pageChange.name) ??
    (pageChange.index ? String(pageChange.index) : null)
  )
}

function matchesPageChangeKey(pageChange: DisplayPageChange, key: string): boolean {
  return pageChangeTriggerKey(pageChange) === key
}

function resolvedPageChanges(
  state: BpRuntimeState,
  pageChanges: DisplayPageChange[]
): Array<{ pageChange: DisplayPageChange; active: boolean }> {
  if (Array.isArray(state.executedPageChangeIds)) {
    const currentIds = new Set(state.currentPageChangeIds ?? [])
    return state.executedPageChangeIds
      .map((id) => pageChanges.find((pageChange) => pageChange.id === id) ?? null)
      .filter((pageChange): pageChange is DisplayPageChange => Boolean(pageChange))
      .map((pageChange) => ({
        pageChange,
        active: currentIds.has(pageChange.id)
      }))
  }

  const currentChangeKeys = new Set(currentPageChangeKeys(state))
  return pageChangeKeys(state).flatMap((changeKey) =>
    pageChanges
      .filter((pageChange) => matchesPageChangeKey(pageChange, changeKey))
      .map((pageChange) => ({
        pageChange,
        active: currentChangeKeys.has(changeKey)
      }))
  )
}

function resolveChantVideoSlot(
  settings: DisplaySettings,
  state: BpRuntimeState
): ResolvedChantVideoSlot {
  const baseSlot = settings.chantVideoSlot ?? defaultChantVideoSlot
  const layout: DisplayVideoSlotLayout = { ...baseSlot }
  let activeResizeChange: DisplayPageChange | null = null

  resolvedPageChanges(state, settings.pageChanges).forEach(({ pageChange, active }) => {
    if (pageChange.target !== 'chantVideoSlot' || pageChange.mode !== 'resizeVideo') {
      return
    }

    layout.x = numberOrFallback(pageChange.videoX, baseSlot.x)
    layout.y = numberOrFallback(pageChange.videoY, baseSlot.y)
    layout.width = Math.max(1, numberOrFallback(pageChange.videoWidth, baseSlot.width))
    layout.height = Math.max(1, numberOrFallback(pageChange.videoHeight, baseSlot.height))
    if (active) {
      activeResizeChange = pageChange
    }
  })

  return {
    layout,
    activeResizeChange
  }
}

interface DisplayCanvasProps {
  settings: DisplaySettings
  state: BpRuntimeState
  className?: string
  pixelExact?: boolean
  showCenterStage?: boolean
  chantVideo?: DisplayChantVideo | null
  preloadChantVideo?: DisplayChantVideo | null
  onChantVideoEnded?: (video: DisplayChantVideo, currentTime: number, duration: number) => void
  onChantVideoTimeUpdate?: (video: DisplayChantVideo, currentTime: number, duration: number) => void
  onChantVideoInterrupted?: (
    video: DisplayChantVideo,
    currentTime: number,
    duration: number
  ) => void
  onChantVideoError?: (video: DisplayChantVideo, currentTime: number, duration: number) => void
  muteChantVideo?: boolean
  showChantVideoSlotGuide?: boolean
  nextAction?: BpActionRecord | null
  followingAction?: BpActionRecord | null
  futureActions?: BpActionRecord[]
  selectedAction?: BpActionRecord | null
  previewSlotEffect?: { action: SlotEffectKind; nonce: number } | null
  dismissedEffectKeys?: string[]
  completedPageChangeIds?: string[]
}

function isSlotEffectAction(action: unknown): action is SlotEffectAction {
  return action === 'pick' || action === 'ban'
}

function isSlotEffectKind(action: unknown): action is SlotEffectKind {
  return action === 'pick' || action === 'ban' || action === 'protect' || action === 'borrow'
}

function isPairedEffectAction(action: unknown): action is 'protect' | 'borrow' {
  return action === 'protect' || action === 'borrow'
}

function slotEffectKey(side: BpSide, action: SlotEffectAction, index: number): string {
  return `${side}-${action}-${index}`
}

function nextSlotIndex(state: BpRuntimeState, side: BpSide, action: SlotEffectAction): number {
  const team = side === 'star' ? state.starTeam : state.railTeam
  return action === 'pick' ? team.picks.length : team.bans.length
}

function selectedSlotIndex(
  state: BpRuntimeState,
  selectedAction: BpActionRecord | null
): number | null {
  if (!selectedAction || !isSlotEffectAction(selectedAction.action)) {
    return null
  }

  const matchedCount = state.actions.filter(
    (action) =>
      action.stepIndex <= selectedAction.stepIndex &&
      action.side === selectedAction.side &&
      action.action === selectedAction.action
  ).length

  return matchedCount > 0 ? matchedCount - 1 : null
}

function parseSlotEffectKey(key: string | null): SlotEffectTarget | null {
  const match = key?.match(/^(star|rail)-(pick|ban)-(\d+)$/)
  if (!match) {
    return null
  }

  return {
    side: match[1] as BpSide,
    action: match[2] as SlotEffectAction,
    index: Number(match[3])
  }
}

function slotLayout(
  settings: DisplaySettings,
  side: BpSide,
  group: SlotLayoutGroup
): DisplaySlotLayout {
  const layouts = settings.slotLayouts

  if (side === 'star') {
    if (group === 'pick') {
      return layouts?.starPick ?? fallbackSlotLayout
    }

    if (group === 'pickSecond') {
      return layouts?.starPickSecond ?? fallbackSlotLayout
    }

    return group === 'banSecond'
      ? (layouts?.starBanSecond ?? fallbackSlotLayout)
      : (layouts?.starBan ?? fallbackSlotLayout)
  }

  if (group === 'pick') {
    return layouts?.railPick ?? fallbackSlotLayout
  }

  if (group === 'pickSecond') {
    return layouts?.railPickSecond ?? fallbackSlotLayout
  }

  return group === 'banSecond'
    ? (layouts?.railBanSecond ?? fallbackSlotLayout)
    : (layouts?.railBan ?? fallbackSlotLayout)
}

function tightPickLayout(layout: DisplaySlotLayout): DisplaySlotLayout {
  return {
    ...layout,
    gap: 0,
    gaps: []
  }
}

function slotGap(layout: DisplaySlotLayout, gapIndex: number): number {
  return Math.max(0, Number(layout.gaps?.[gapIndex] ?? layout.gap) || 0)
}

function slotOffset(layout: DisplaySlotLayout, localIndex: number): number {
  let offset = 0

  for (let gapIndex = 0; gapIndex < localIndex; gapIndex += 1) {
    offset +=
      (layout.direction === 'horizontal' ? layout.width : layout.height) + slotGap(layout, gapIndex)
  }

  return offset
}

function slotBox(
  layout: DisplaySlotLayout,
  localIndex: number,
  groupCount: number,
  reverseHorizontal: boolean
): SlotBox {
  if (layout.direction === 'horizontal') {
    const offset = slotOffset(layout, localIndex)
    let gapWidth = 0

    for (let gapIndex = 0; gapIndex < Math.max(0, groupCount - 1); gapIndex += 1) {
      gapWidth += slotGap(layout, gapIndex)
    }

    const groupWidth = groupCount * layout.width + gapWidth
    const x = reverseHorizontal ? layout.x + groupWidth - layout.width - offset : layout.x + offset

    return {
      x,
      y: layout.y,
      width: layout.width,
      height: layout.height
    }
  }

  return {
    x: layout.x,
    y: layout.y + slotOffset(layout, localIndex),
    width: layout.width,
    height: layout.height
  }
}

function effectSlotBox(
  settings: DisplaySettings,
  state: BpRuntimeState,
  target: SlotEffectTarget
): SlotBox | null {
  const team = target.side === 'star' ? state.starTeam : state.railTeam
  const totalSlots = Math.max(
    target.action === 'pick'
      ? state.slotCounts[target.side].picks
      : state.slotCounts[target.side].bans,
    target.action === 'pick' ? team.picks.length : team.bans.length,
    target.index + 1
  )

  if (target.action === 'pick') {
    const secondCount = Math.min(
      totalSlots,
      Math.max(0, Math.floor(Number(settings.secondaryPickCounts?.[target.side]) || 0))
    )
    const firstCount = Math.max(0, totalSlots - secondCount)

    if (target.index < firstCount) {
      return slotBox(
        tightPickLayout(slotLayout(settings, target.side, 'pick')),
        target.index,
        firstCount,
        false
      )
    }

    return slotBox(
      tightPickLayout(slotLayout(settings, target.side, 'pickSecond')),
      target.index - firstCount,
      secondCount,
      false
    )
  }

  const secondCount = Math.min(
    totalSlots,
    Math.max(0, Math.floor(Number(settings.secondaryBanCounts?.[target.side]) || 0))
  )
  const firstCount = Math.max(0, totalSlots - secondCount)

  if (target.index < firstCount) {
    return slotBox(
      slotLayout(settings, target.side, 'ban'),
      target.index,
      firstCount,
      target.side === 'star'
    )
  }

  return slotBox(
    slotLayout(settings, target.side, 'banSecond'),
    target.index - firstCount,
    secondCount,
    target.side === 'star'
  )
}

function pickSlotKeyByCharacterId(
  state: BpRuntimeState,
  side: BpSide,
  characterId: number | null | undefined
): string | null {
  if (!characterId) {
    return null
  }

  const team = side === 'star' ? state.starTeam : state.railTeam
  const index = team.picks.findIndex(
    (target) => 'chinese_name' in target && target.id === characterId
  )

  return index >= 0 ? slotEffectKey(side, 'pick', index) : null
}

function pairedActionSlotKeys(state: BpRuntimeState, action: BpActionRecord): string[] {
  if (!isPairedEffectAction(action.action)) {
    return []
  }

  const starTargetSide: BpSide = action.action === 'protect' ? 'star' : 'rail'
  const railTargetSide: BpSide = action.action === 'protect' ? 'rail' : 'star'

  return [
    pickSlotKeyByCharacterId(state, starTargetSide, action.starTargetId),
    pickSlotKeyByCharacterId(state, railTargetSide, action.railTargetId)
  ].filter((key): key is string => Boolean(key))
}

function firstPendingEffectAction(
  actions: BpActionRecord[] | undefined,
  fallbackAction: BpActionRecord | null
): SlotEffectActionRecord | null {
  const action = actions && actions.length > 0 ? actions[0] : fallbackAction
  return action && isSlotEffectAction(action.action) ? (action as SlotEffectActionRecord) : null
}

function pageChangeTriggerEvent(pageChange: DisplayPageChange): string | null {
  return (
    normalizeEventName(pageChange.triggerEvent) ??
    normalizeEventName(pageChange.triggerName) ??
    normalizeEventName(pageChange.name) ??
    (pageChange.index ? String(pageChange.index) : null)
  )
}

function pendingActivationDelayEvents(effect: DisplaySlotEffectConfig | undefined): string[] {
  return [
    ...new Set(
      (effect?.delayActivateAfterEvents ?? [])
        .map((eventName) => normalizeEventName(eventName))
        .filter((eventName): eventName is string => Boolean(eventName))
    )
  ]
}

function eventResolvedPageChanges(
  settings: DisplaySettings,
  state: BpRuntimeState,
  eventName: string,
  completedPageChangeIds: Set<string> | null
): boolean {
  const matchingChanges = settings.pageChanges.filter(
    (pageChange) => pageChangeTriggerEvent(pageChange) === eventName
  )
  if (matchingChanges.length === 0) {
    return true
  }

  const resolvedIds = completedPageChangeIds
    ? completedPageChangeIds
    : new Set([...(state.executedPageChangeIds ?? []), ...(state.currentPageChangeIds ?? [])])
  return matchingChanges.every((pageChange) => resolvedIds.has(pageChange.id))
}

function pendingActivationAllowed(
  settings: DisplaySettings,
  state: BpRuntimeState,
  effect: DisplaySlotEffectConfig | undefined,
  completedPageChangeIds: Set<string> | null
): boolean {
  const delayEvents = pendingActivationDelayEvents(effect)
  if (delayEvents.length === 0) {
    return true
  }

  const currentEvents = new Set(
    (state.currentEvents ?? [])
      .map((eventName) => normalizeEventName(eventName))
      .filter((eventName): eventName is string => Boolean(eventName))
  )
  const activeDelayEvents = delayEvents.filter((eventName) => currentEvents.has(eventName))
  if (activeDelayEvents.length === 0) {
    return true
  }

  return activeDelayEvents.every((eventName) =>
    eventResolvedPageChanges(settings, state, eventName, completedPageChangeIds)
  )
}

function pairedEffectKey(action: BpActionRecord | null | undefined): string | null {
  return action && isPairedEffectAction(action.action)
    ? `${action.action}-${action.stepIndex}`
    : null
}

function topSlotEffectStyle(box: SlotBox, layout: DisplaySlotEffectLayout): CSSProperties {
  const x = Number(layout.x) || 0
  const y = Number(layout.y) || 0
  const scale = Math.max(0.01, Number(layout.scale) || 1)

  return {
    left: `${box.x + box.width / 2 + x}px`,
    top: `${box.y + box.height / 2 + y}px`,
    width: `${box.width}px`,
    height: `${box.height}px`,
    transform: `translate(-50%, -50%) scale(${scale})`
  }
}

function TopSlotEffectVideo({
  className,
  src,
  loop,
  style,
  onFinished
}: TopSlotEffectVideoProps): React.JSX.Element | null {
  const [hidden, setHidden] = useState(false)

  if (hidden) {
    return null
  }

  return (
    <video
      className={className}
      src={src}
      autoPlay
      muted
      loop={loop}
      playsInline
      onEnded={() => {
        if (!loop) {
          setHidden(true)
          onFinished?.()
        }
      }}
      onError={() => {
        logVideoLoadFailure('Slot effect', src)
        setHidden(true)
        onFinished?.()
      }}
      style={style}
    />
  )
}

function slotEffectVideoUrl(
  _kind: SlotEffectKind,
  config: DisplaySlotEffectConfig,
  mode: 'pending' | 'selected' | 'preview'
): string | null | undefined {
  if (mode === 'selected') {
    return config.selectedVideoUrl
  }

  return config.pendingVideoUrl
}

function renderTopSlotEffect(
  settings: DisplaySettings,
  state: BpRuntimeState,
  key: string | null,
  kind: SlotEffectKind,
  config: DisplaySlotEffectConfig,
  mode: 'pending' | 'selected' | 'preview',
  effectKey: string | number,
  loop: boolean,
  onFinished?: () => void
): React.ReactNode {
  const target = parseSlotEffectKey(key)
  if (!target) {
    return null
  }

  const src = slotEffectVideoUrl(kind, config, mode)
  if (!src) {
    return null
  }

  const box = effectSlotBox(settings, state, target)
  if (!box) {
    return null
  }

  return (
    <TopSlotEffectVideo
      className={`display-slot-effect display-slot-effect-${mode} display-slot-effect-top`}
      key={`${mode}-${key}-${effectKey}-${src}`}
      src={src}
      loop={loop}
      style={topSlotEffectStyle(box, config.pendingLayout)}
      onFinished={onFinished}
    />
  )
}

function selectedActionEffectInstances(
  state: BpRuntimeState,
  action: BpActionRecord
): SlotEffectInstance[] {
  if (isSlotEffectAction(action.action)) {
    const selectedIndex = selectedSlotIndex(state, action)
    if (selectedIndex === null) {
      return []
    }

    return [
      {
        slotKey: slotEffectKey(action.side, action.action, selectedIndex),
        effectKind: action.action,
        mode: 'selected',
        effectKey: `selected-${action.stepIndex}-${action.action}`,
        loop: false
      }
    ]
  }

  if (action.action === 'protect' || action.action === 'borrow') {
    const effectKind = action.action
    const effectKey = `${effectKind}-${action.stepIndex}`
    return pairedActionSlotKeys(state, action).flatMap((slotKey) => [
      {
        slotKey,
        effectKind,
        mode: 'pending',
        effectKey,
        loop: true
      },
      {
        slotKey,
        effectKind,
        mode: 'selected',
        effectKey,
        loop: false
      }
    ])
  }

  return []
}

function isPairedLoopInstance(instance: SlotEffectInstance): boolean {
  return isPairedEffectAction(instance.effectKind) && instance.mode === 'pending'
}

function retainedPairedLoopInstances(
  current: SlotEffectInstance[],
  slotEffects: DisplaySlotEffects,
  nextAction: SlotEffectAction
): SlotEffectInstance[] {
  return current.filter((instance) => {
    if (!isPairedLoopInstance(instance)) {
      return false
    }

    return nextAction === 'pick' ? slotEffects[instance.effectKind].keepLoop === true : true
  })
}

function retainedPairedLoopInstancesForPendingAction(
  current: SlotEffectInstance[]
): SlotEffectInstance[] {
  return current.filter(isPairedLoopInstance)
}

function pendingActionEffectInstances(
  settings: DisplaySettings,
  state: BpRuntimeState,
  action: SlotEffectActionRecord,
  actionAfter: BpActionRecord | null | undefined,
  effectKey: string | number,
  completedPageChangeIds: Set<string> | null
): SlotEffectInstance[] {
  return pendingSlotEffectInstances(
    settings,
    state,
    action.side,
    action.action,
    actionAfter,
    effectKey,
    completedPageChangeIds
  )
}

function pendingSlotEffectInstances(
  settings: DisplaySettings,
  state: BpRuntimeState,
  side: BpSide,
  action: SlotEffectAction,
  actionAfter: BpActionRecord | null | undefined,
  effectKey: string | number,
  completedPageChangeIds: Set<string> | null
): SlotEffectInstance[] {
  const slotEffects = settings.slotEffects ?? defaultSlotEffects
  if (!pendingActivationAllowed(settings, state, slotEffects[action], completedPageChangeIds)) {
    return []
  }

  const index = nextSlotIndex(state, side, action)
  const instances: SlotEffectInstance[] = [
    {
      slotKey: slotEffectKey(side, action, index),
      effectKind: action,
      mode: 'pending',
      effectKey,
      loop: true
    }
  ]

  if (action === 'pick' && actionAfter?.action === 'pick' && actionAfter.side === side) {
    instances.push({
      slotKey: slotEffectKey(side, action, index + 1),
      effectKind: 'pick',
      mode: 'pending',
      effectKey,
      loop: true
    })
  }

  return instances
}

function effectInstancesFromActions(
  state: BpRuntimeState,
  slotEffects: DisplaySlotEffects
): SlotEffectInstance[] {
  let activeEffects: SlotEffectInstance[] = []

  state.actions.forEach((action) => {
    if (isSlotEffectAction(action.action)) {
      activeEffects = [
        ...retainedPairedLoopInstances(activeEffects, slotEffects, action.action),
        ...selectedActionEffectInstances(state, action)
      ]
      return
    }

    if (action.action === 'protect') {
      activeEffects = selectedActionEffectInstances(state, action)
      return
    }

    if (action.action === 'borrow') {
      activeEffects = mergeEffectInstances(
        activeEffects,
        selectedActionEffectInstances(state, action)
      )
      return
    }

    if (!isSlotEffectKind(action.action)) {
      activeEffects = []
      return
    }
  })

  return activeEffects
}

function mergeEffectInstances(
  current: SlotEffectInstance[],
  additions: SlotEffectInstance[]
): SlotEffectInstance[] {
  const seen = new Set(current.map(effectInstanceIdentity))
  const next = [...current]

  additions.forEach((instance) => {
    const key = effectInstanceIdentity(instance)
    if (!seen.has(key)) {
      seen.add(key)
      next.push(instance)
    }
  })

  return next
}

function effectInstanceIdentity(instance: SlotEffectInstance): string {
  return `${instance.mode}-${instance.slotKey}-${instance.effectKind}-${instance.effectKey}`
}

function DisplayCanvas({
  settings,
  state,
  className = '',
  pixelExact = false,
  showCenterStage = true,
  chantVideo = null,
  preloadChantVideo = null,
  onChantVideoEnded,
  onChantVideoTimeUpdate,
  onChantVideoInterrupted,
  onChantVideoError,
  muteChantVideo = true,
  showChantVideoSlotGuide = false,
  nextAction = null,
  followingAction = null,
  futureActions,
  selectedAction,
  previewSlotEffect = null,
  dismissedEffectKeys = [],
  completedPageChangeIds
}: DisplayCanvasProps): React.JSX.Element {
  const stageRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    stageWidth: renderStageWidth,
    stageHeight: renderStageHeight,
    pixelExactActive: false
  })
  const [closedEffectGroups, setClosedEffectGroups] = useState<Set<string>>(() => new Set())
  const [retainedSingleChantVideo, setRetainedSingleChantVideo] = useState<SingleChantVideo | null>(
    null
  )
  const [retainedProtectChantVideo, setRetainedProtectChantVideo] =
    useState<ProtectChantVideo | null>(null)
  const replayPositionRef = useRef({ createdAt: state.createdAt, stepCursor: state.stepCursor })
  const protectRetentionTimerRef = useRef<number | null>(null)
  const { layout: chantVideoSlot, activeResizeChange } = resolveChantVideoSlot(settings, state)
  const slotEffects = settings.slotEffects ?? defaultSlotEffects
  const currentStep = state.currentStep
  const currentStepAction = currentStep?.action
  const reachedReplayEnd = state.status === 'complete' && !selectedAction
  const dismissedEffects = new Set(dismissedEffectKeys)
  const completedPageChanges = completedPageChangeIds ? new Set(completedPageChangeIds) : null
  const currentSingleChantVideo = chantVideo?.kind === 'single' ? chantVideo : null
  const currentProtectChantVideo = chantVideo?.kind === 'protect' ? chantVideo : null
  if (currentSingleChantVideo) {
    if (retainedSingleChantVideo?.key !== currentSingleChantVideo.key) {
      setRetainedSingleChantVideo(currentSingleChantVideo)
    }
  }
  if (currentProtectChantVideo) {
    if (retainedProtectChantVideo?.key !== currentProtectChantVideo.key) {
      setRetainedProtectChantVideo(currentProtectChantVideo)
    }
  }
  const displayedSingleChantVideo = currentSingleChantVideo ?? retainedSingleChantVideo
  const displayedProtectChantVideo = currentProtectChantVideo ?? retainedProtectChantVideo
  const clearProtectRetentionTimer = useCallback((): void => {
    if (protectRetentionTimerRef.current === null) {
      return
    }

    window.clearTimeout(protectRetentionTimerRef.current)
    protectRetentionTimerRef.current = null
  }, [])
  const selectedPairedEffectKey = pairedEffectKey(selectedAction)
  const selectedPairedDismissed = Boolean(
    selectedPairedEffectKey && dismissedEffects.has(selectedPairedEffectKey)
  )

  useEffect(() => {
    if (!currentProtectChantVideo) {
      return
    }

    clearProtectRetentionTimer()
  }, [clearProtectRetentionTimer, currentProtectChantVideo])

  useEffect(() => {
    if (currentProtectChantVideo || !displayedProtectChantVideo) {
      return undefined
    }

    clearProtectRetentionTimer()
    protectRetentionTimerRef.current = window.setTimeout(() => {
      protectRetentionTimerRef.current = null
      setRetainedProtectChantVideo(null)
    }, 500)

    return clearProtectRetentionTimer
  }, [clearProtectRetentionTimer, currentProtectChantVideo, displayedProtectChantVideo])

  const handleSingleChantVideoReady = useCallback(
    (video: SingleChantVideo): void => {
      if (!currentSingleChantVideo || currentSingleChantVideo.key !== video.key) {
        return
      }

      clearProtectRetentionTimer()
      setRetainedProtectChantVideo(null)
    },
    [clearProtectRetentionTimer, currentSingleChantVideo]
  )

  let activeEffectInstances = reachedReplayEnd ? [] : effectInstancesFromActions(state, slotEffects)

  if (
    !reachedReplayEnd &&
    selectedAction &&
    (isSlotEffectAction(selectedAction.action) ||
      selectedAction.action === 'borrow' ||
      selectedPairedDismissed)
  ) {
    const pendingAction = firstPendingEffectAction(futureActions, nextAction)
    if (pendingAction) {
      const pendingEffects = pendingActionEffectInstances(
        settings,
        state,
        pendingAction,
        futureActions?.[1] ?? followingAction,
        `after-${selectedAction.stepIndex}-${pendingAction.stepIndex}`,
        completedPageChanges
      )
      activeEffectInstances =
        pendingEffects.length > 0
          ? mergeEffectInstances(activeEffectInstances, pendingEffects)
          : activeEffectInstances
    }
  }

  if (!reachedReplayEnd && !selectedAction) {
    const pendingAction = firstPendingEffectAction(futureActions, nextAction)
    if (pendingAction) {
      const pendingEffects = pendingActionEffectInstances(
        settings,
        state,
        pendingAction,
        futureActions?.[1] ?? followingAction,
        `current-${pendingAction.stepIndex}-${pendingAction.action}`,
        completedPageChanges
      )
      activeEffectInstances = mergeEffectInstances(
        retainedPairedLoopInstancesForPendingAction(activeEffectInstances),
        pendingEffects
      )
    } else if (currentStep && isSlotEffectAction(currentStepAction)) {
      const pendingEffects = pendingSlotEffectInstances(
        settings,
        state,
        currentStep.side,
        currentStepAction,
        followingAction,
        `current-${currentStep.index}-${currentStepAction}`,
        completedPageChanges
      )
      activeEffectInstances = mergeEffectInstances(
        retainedPairedLoopInstancesForPendingAction(activeEffectInstances),
        pendingEffects
      )
    } else if (currentStep && !isSlotEffectKind(currentStepAction)) {
      activeEffectInstances = []
    }
  }

  activeEffectInstances = activeEffectInstances.filter(
    (instance) =>
      !dismissedEffects.has(String(instance.effectKey)) &&
      (!instance.closeGroup || !closedEffectGroups.has(instance.closeGroup))
  )

  const activePendingSlotKeys = new Set(
    activeEffectInstances
      .filter((instance) => instance.mode === 'pending')
      .map((instance) => instance.slotKey)
  )
  const selectedEffectInstance =
    activeEffectInstances.find((instance) => instance.mode === 'selected') ?? null
  const selectedSlotKey = selectedEffectInstance?.slotKey ?? null
  const selectedEffectKey = selectedEffectInstance?.effectKey ?? 'none'

  const previewSide =
    previewSlotEffect &&
    (previewSlotEffect.action === 'ban'
      ? state.slotCounts.star.bans > 0
      : state.slotCounts.star.picks > 0)
      ? 'star'
      : 'rail'
  const previewSlotKey = previewSlotEffect
    ? slotEffectKey(previewSide, previewSlotEffect.action === 'ban' ? 'ban' : 'pick', 0)
    : null
  const chantVideoSlotStyle: CSSProperties = {
    left: `${chantVideoSlot.x * coordinateScaleX}px`,
    top: `${chantVideoSlot.y * coordinateScaleY}px`,
    width: `${chantVideoSlot.width * coordinateScaleX}px`,
    height: `${chantVideoSlot.height * coordinateScaleY}px`,
    zIndex: chantVideoSlot.layer,
    '--chant-video-change-duration': `${activeResizeChange?.speed ?? 0}ms`
  } as CSSProperties
  const protectChantVideoSlotStyle: CSSProperties = {
    ...chantVideoSlotStyle,
    '--protect-transition-angle': `${protectTransitionAngle}deg`,
    '--protect-transition-half-width': `${protectTransitionWidth / 2}%`,
    '--protect-transition-quarter-width': `${protectTransitionWidth / 4}%`,
    '--protect-call-video-scale': `${protectCallVideoScale}`
  } as CSSProperties
  const closeEffectGroup = (group: string): void => {
    setClosedEffectGroups((current) => {
      if (current.has(group)) {
        return current
      }

      const next = new Set(current)
      next.add(group)
      return next
    })
  }
  const topSlotEffects = [
    ...activeEffectInstances.map(({ slotKey, effectKind, mode, effectKey, loop, closeGroup }) => {
      return renderTopSlotEffect(
        settings,
        state,
        slotKey,
        effectKind,
        slotEffects[effectKind],
        mode,
        effectKey,
        loop,
        closeGroup && effectKind === 'borrow' ? () => closeEffectGroup(closeGroup) : undefined
      )
    }),
    previewSlotKey
      ? renderTopSlotEffect(
          settings,
          state,
          previewSlotKey,
          previewSlotEffect?.action ?? 'pick',
          slotEffects[previewSlotEffect?.action ?? 'pick'],
          'preview',
          previewSlotEffect?.nonce ?? 0,
          false
        )
      : null
  ]

  useEffect(() => {
    const previous = replayPositionRef.current
    if (previous.createdAt !== state.createdAt || state.stepCursor < previous.stepCursor) {
      setClosedEffectGroups(new Set())
    }

    replayPositionRef.current = { createdAt: state.createdAt, stepCursor: state.stepCursor }
  }, [state.createdAt, state.stepCursor])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) {
      return
    }

    const updateScale = (): void => {
      const rect = stage.getBoundingClientRect()
      const deviceScale = Math.max(1, window.devicePixelRatio || 1)
      const pixelAlignedWidth = Math.max(1, Math.floor(rect.width * deviceScale)) / deviceScale
      const pixelAlignedHeight = Math.max(1, Math.floor(rect.height * deviceScale)) / deviceScale
      const pixelExactActive =
        pixelExact &&
        Math.abs(pixelAlignedWidth - renderStageWidth) <= 1 &&
        Math.abs(pixelAlignedHeight - renderStageHeight) <= 1
      const nextScale = Math.min(
        pixelAlignedWidth / renderStageWidth,
        pixelAlignedHeight / renderStageHeight
      )
      const safeScale = pixelExactActive
        ? 1
        : Number.isFinite(nextScale) && nextScale > 0
          ? nextScale
          : 1
      const scaledWidth = renderStageWidth * safeScale
      const scaledHeight = renderStageHeight * safeScale
      const snapCssPixel = (value: number): number => Math.round(value * deviceScale) / deviceScale
      const snapDisplayPixel = (value: number): number =>
        pixelExactActive ? Math.round(value) : snapCssPixel(value)

      setViewport({
        scale: safeScale,
        offsetX: snapDisplayPixel(Math.max(0, (rect.width - scaledWidth) / 2)),
        offsetY: snapDisplayPixel(Math.max(0, (rect.height - scaledHeight) / 2)),
        stageWidth: rect.width,
        stageHeight: rect.height,
        pixelExactActive
      })
    }
    const observer = new ResizeObserver(updateScale)

    observer.observe(stage)
    window.addEventListener('resize', updateScale)
    requestAnimationFrame(updateScale)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateScale)
    }
  }, [pixelExact])

  const canvasTransform =
    viewport.scale === 1
      ? viewport.offsetX === 0 && viewport.offsetY === 0
        ? 'none'
        : `translate(${Math.round(viewport.offsetX)}px, ${Math.round(viewport.offsetY)}px)`
      : `translate(${viewport.offsetX}px, ${viewport.offsetY}px) scale(${viewport.scale})`
  const canvasStyle: CSSProperties = {
    width: `${renderStageWidth}px`,
    height: `${renderStageHeight}px`,
    transform: canvasTransform
  }
  const slotEffectLayerStyle: CSSProperties = {
    width: `${designStageWidth}px`,
    height: `${designStageHeight}px`,
    transform: `scale(${coordinateScaleX}, ${coordinateScaleY})`
  }

  useEffect(() => {
    if (!import.meta.env.DEV) {
      return
    }

    console.info('[DisplayCanvas] viewport', {
      isLiveDisplay: pixelExact,
      viewportScale: viewport.scale,
      stageWidth: viewport.stageWidth,
      stageHeight: viewport.stageHeight,
      canvasTransform,
      pixelExactActive: viewport.pixelExactActive,
      devicePixelRatio: window.devicePixelRatio
    })
  }, [
    canvasTransform,
    pixelExact,
    viewport.offsetX,
    viewport.offsetY,
    viewport.pixelExactActive,
    viewport.scale,
    viewport.stageHeight,
    viewport.stageWidth
  ])

  return (
    <div className={`display-stage ${className}`} ref={stageRef}>
      <div className="display-stage-canvas" style={canvasStyle}>
        <DisplayBackground settings={settings} state={state} />
        <div className="display-overlay">
          <DisplayTeamPanel
            side="star"
            team={state.starTeam}
            slotCounts={state.slotCounts.star}
            settings={settings}
            slotEffects={slotEffects}
            activePendingSlotKeys={activePendingSlotKeys}
            selectedSlotKey={selectedSlotKey}
            selectedEffectKey={selectedEffectKey}
            previewSlotKey={previewSlotKey}
            previewEffectKey={previewSlotEffect?.nonce}
            renderSlotEffects={false}
            renderScale={coordinateScaleX}
          />
          {showCenterStage ? <DisplayCenterStage state={state} /> : null}
          <DisplayTeamPanel
            side="rail"
            team={state.railTeam}
            slotCounts={state.slotCounts.rail}
            settings={settings}
            slotEffects={slotEffects}
            activePendingSlotKeys={activePendingSlotKeys}
            selectedSlotKey={selectedSlotKey}
            selectedEffectKey={selectedEffectKey}
            previewSlotKey={previewSlotKey}
            previewEffectKey={previewSlotEffect?.nonce}
            renderSlotEffects={false}
            renderScale={coordinateScaleX}
          />
        </div>
        {showChantVideoSlotGuide && chantVideoSlot.visible ? (
          <div className="display-chant-video-guide" style={chantVideoSlotStyle}>
            唱名视频
          </div>
        ) : null}
        {displayedSingleChantVideo && chantVideoSlot.visible ? (
          <SeamlessChantVideo
            video={displayedSingleChantVideo}
            preloadVideo={preloadChantVideo?.kind === 'single' ? preloadChantVideo : null}
            style={chantVideoSlotStyle}
            muted={muteChantVideo}
            paused={Boolean(currentProtectChantVideo)}
            onEnded={onChantVideoEnded}
            onError={onChantVideoError ?? onChantVideoEnded}
            onTimeUpdate={onChantVideoTimeUpdate}
            onInterrupted={onChantVideoInterrupted}
            onActiveReady={handleSingleChantVideoReady}
          />
        ) : null}
        {displayedProtectChantVideo && chantVideoSlot.visible ? (
          <ProtectChantVideoLayer
            key={displayedProtectChantVideo.key}
            video={displayedProtectChantVideo}
            active={Boolean(currentProtectChantVideo)}
            holdUntilReady={Boolean(displayedSingleChantVideo)}
            style={protectChantVideoSlotStyle}
            muted={muteChantVideo}
            onEnded={onChantVideoEnded}
            onTimeUpdate={onChantVideoTimeUpdate}
            onError={onChantVideoError ?? onChantVideoEnded}
          />
        ) : null}
        {currentProtectChantVideo &&
        !displayedSingleChantVideo &&
        preloadChantVideo?.kind === 'single' ? (
          <HiddenChantVideoPreloader video={preloadChantVideo} />
        ) : null}
        <div className="display-slot-effect-layer" style={slotEffectLayerStyle}>
          {topSlotEffects}
        </div>
      </div>
    </div>
  )
}

export default DisplayCanvas
