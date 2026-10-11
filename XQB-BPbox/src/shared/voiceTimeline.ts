import type {
  BpActionRecord,
  BpPreviewRecord,
  BpPreviewSelection,
  FlowStep,
  VoiceTimelineClickPoint
} from './types'

export function normalizePreviewRecords(value: unknown): BpPreviewRecord[] {
  if (!Array.isArray(value)) return []
  return value.filter((record): record is BpPreviewRecord => {
    const selection = record?.selection
    return (
      typeof record?.id === 'string' &&
      Number.isInteger(record.stepIndex) &&
      record.stepIndex > 0 &&
      typeof record.createdAt === 'string' &&
      (selection?.side === 'star' || selection?.side === 'rail') &&
      (selection.action === 'pick' || selection.action === 'ban') &&
      selection.target &&
      Number.isFinite(selection.target.id)
    )
  })
}

/** Deduplicate only the candidate view; live records and inserted events remain independent. */
export function previewCandidatesForStep(
  records: BpPreviewRecord[],
  stepIndex: number
): BpPreviewRecord[] {
  const seen = new Set<string>()
  return records.filter((record) => {
    if (record.stepIndex !== stepIndex) return false
    const target = record.selection.target
    const kind = 'chinese_name' in target ? 'character' : 'lightCone'
    const key = `${kind}:${target.id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function closePreviewRecords(
  records: BpPreviewRecord[] = [],
  now = Date.now()
): BpPreviewRecord[] {
  return records.map((record) =>
    record.duration === undefined
      ? { ...record, duration: Math.max(0.1, (now - Date.parse(record.createdAt)) / 1000 || 0.1) }
      : record
  )
}

export function recordPreviewSelection(
  records: BpPreviewRecord[] = [],
  step: FlowStep,
  selection: BpPreviewSelection | null,
  id: string,
  now = Date.now()
): BpPreviewRecord[] {
  const last = records.at(-1)
  if (
    last?.duration === undefined &&
    last?.stepIndex === step.index &&
    selection &&
    last.selection.side === selection.side &&
    last.selection.action === selection.action &&
    last.selection.target.id === selection.target.id
  )
    return records
  const closed = closePreviewRecords(records, now)
  return selection
    ? [...closed, { id, stepIndex: step.index, selection, createdAt: new Date(now).toISOString() }]
    : closed
}

export function sortClickPoints(points: VoiceTimelineClickPoint[]): VoiceTimelineClickPoint[] {
  return [...points].sort((a, b) => {
    if (a.time !== b.time) return a.time - b.time
    if (a.sequence !== undefined && b.sequence !== undefined) return a.sequence - b.sequence
    // Preserve the legacy extra-click priority for old files without sequence metadata.
    if (a.type !== b.type) {
      const rank = { delay_extra_click: 0, preview: 1, bp_step: 2 }
      return rank[a.type] - rank[b.type]
    }
    return a.id.localeCompare(b.id, undefined, { numeric: true })
  })
}

export function withPointSequences(points: VoiceTimelineClickPoint[]): VoiceTimelineClickPoint[] {
  const sorted = sortClickPoints(points)
  if (sorted.every((point) => Number.isFinite(point.sequence))) return sorted
  return sorted.map((point, sequence) => ({ ...point, sequence }))
}

export function mainTimelinePoints(points: VoiceTimelineClickPoint[]): VoiceTimelineClickPoint[] {
  return sortClickPoints(points).filter((point) => point.type !== 'preview')
}

export function removeTimelinePoint(
  points: VoiceTimelineClickPoint[],
  id: string
): VoiceTimelineClickPoint[] {
  const point = points.find((item) => item.id === id)
  if (!point || (point.type !== 'preview' && mainTimelinePoints(points).at(-1)?.id !== id))
    return points
  return points.filter((item) => item.id !== id)
}

/** Moving a main operation must never reorder the deterministic click stream. */
export function moveTimelinePoint(
  points: VoiceTimelineClickPoint[],
  id: string,
  time: number
): VoiceTimelineClickPoint[] {
  if (!Number.isFinite(time)) return points
  const main = mainTimelinePoints(points)
  const index = main.findIndex((point) => point.id === id)
  const clamped =
    index < 0
      ? Math.max(0, time)
      : Math.max(main[index - 1]?.time ?? 0, Math.min(time, main[index + 1]?.time ?? Infinity))
  return sortClickPoints(
    points.map((point) => (point.id === id ? { ...point, time: clamped } : point))
  )
}

export interface TimelineProgress {
  cursor: number
  completedDelayedChangeKeys: Set<string>
  delayClickProgress: Record<string, number>
  clickIndex: number
}

export interface TimelinePendingChange {
  key: string
  requiredClicks: number
}

/** Both the editor and linked player replay the same ordered main click stream. */
export function replayTimeline(
  points: VoiceTimelineClickPoint[],
  time: number,
  actionCount: number,
  pendingAt: (progress: TimelineProgress) => TimelinePendingChange[]
): TimelineProgress {
  const progress: TimelineProgress = {
    cursor: 0,
    completedDelayedChangeKeys: new Set(),
    delayClickProgress: {},
    clickIndex: 0
  }
  for (const point of sortClickPoints(points)) {
    if (point.time > time + 0.001) break
    progress.clickIndex += 1
    if (point.type === 'preview') continue
    const pending = pendingAt(progress)
    if (pending.length) {
      for (const change of pending) {
        const clicks = (progress.delayClickProgress[change.key] ?? 0) + 1
        if (clicks >= change.requiredClicks) {
          delete progress.delayClickProgress[change.key]
          progress.completedDelayedChangeKeys.add(change.key)
        } else progress.delayClickProgress[change.key] = clicks
      }
    } else if (point.type === 'bp_step') {
      progress.cursor = Math.min(progress.cursor + 1, actionCount)
    }
  }
  return progress
}

/** Reconstruct the active step's selection from events, independent of playback history.
 * Legacy durations are ignored: only another preview or formal confirmation ends a selection.
 */
export function timelinePreviewAt(
  points: VoiceTimelineClickPoint[],
  time: number,
  nextAction: BpActionRecord | undefined
): BpPreviewSelection | null {
  if (!nextAction) return null
  let selection: BpPreviewSelection | null = null
  for (const point of sortClickPoints(points)) {
    if (point.time > time + 0.001) break
    if (point.type === 'bp_step') {
      selection = null
      continue
    }
    const record = point.previewRecord
    if (
      point.type === 'preview' &&
      record &&
      record.stepIndex === nextAction.stepIndex &&
      record.selection.side === nextAction.side &&
      record.selection.action === nextAction.action
    ) {
      selection = record.selection
    }
  }
  return selection
}
