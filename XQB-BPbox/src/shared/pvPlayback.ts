export const DEFAULT_PV_START_TIME = 0
export const DEFAULT_PV_END_TIME = 8

const PV_RESTART_EPSILON_SECONDS = 0.05
const PV_MIN_STABLE_PLAYBACK_SECONDS = 0.25

export interface PvPlaybackRange {
  startTime: number
  endTime: number
  restartBeforeNaturalEnd: boolean
}

function normalizePvTime(value: unknown, fallback: number): number {
  const normalizedFallback = Number.isFinite(fallback) ? Math.max(0, fallback) : 0

  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) {
    return normalizedFallback
  }

  const numberValue = Number(value)
  return Number.isFinite(numberValue) ? Math.max(0, numberValue) : normalizedFallback
}

export function normalizePvStartTime(value: unknown): number {
  return normalizePvTime(value, DEFAULT_PV_START_TIME)
}

export function normalizePvEndTime(value: unknown): number {
  return normalizePvTime(value, DEFAULT_PV_END_TIME)
}

export function getPvPlaybackRange(
  duration: number,
  configuredStartTime: unknown,
  configuredEndTime: unknown
): PvPlaybackRange | null {
  if (!Number.isFinite(duration) || duration <= 0) {
    return null
  }

  const requestedStartTime = normalizePvStartTime(configuredStartTime)
  const excludedEndTime = normalizePvEndTime(configuredEndTime)
  const configuredEndPosition = Math.max(0, duration - excludedEndTime)

  if (
    excludedEndTime > 0 &&
    configuredEndPosition - requestedStartTime >= PV_MIN_STABLE_PLAYBACK_SECONDS
  ) {
    return {
      startTime: requestedStartTime,
      endTime: configuredEndPosition,
      restartBeforeNaturalEnd: true
    }
  }

  if (duration - requestedStartTime >= PV_MIN_STABLE_PLAYBACK_SECONDS) {
    return {
      startTime: requestedStartTime,
      endTime: duration,
      restartBeforeNaturalEnd: false
    }
  }

  return {
    startTime: 0,
    endTime: duration,
    restartBeforeNaturalEnd: false
  }
}

export function getPvPlaybackSeekTime(
  duration: number,
  requestedTime: unknown,
  configuredStartTime: unknown,
  configuredEndTime: unknown
): number {
  const range = getPvPlaybackRange(duration, configuredStartTime, configuredEndTime)
  if (!range) {
    return normalizePvStartTime(requestedTime)
  }

  const normalizedRequestedTime = normalizePvStartTime(requestedTime)
  if (
    normalizedRequestedTime < range.startTime ||
    normalizedRequestedTime >= range.endTime - PV_RESTART_EPSILON_SECONDS
  ) {
    return range.startTime
  }

  return normalizedRequestedTime
}

export function shouldRestartPv(currentTime: number, range: PvPlaybackRange | null): boolean {
  return Boolean(
    range?.restartBeforeNaturalEnd &&
    Number.isFinite(currentTime) &&
    currentTime >= range.startTime &&
    currentTime >= range.endTime - PV_RESTART_EPSILON_SECONDS
  )
}
