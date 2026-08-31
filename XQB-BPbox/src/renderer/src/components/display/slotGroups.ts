import type {
  BpSide,
  DisplaySettings,
  DisplaySlotGroup,
  DisplaySlotGroupKey,
  DisplaySlotLayout
} from '../../types/bp'

const fallbackSlotLayout: DisplaySlotLayout = {
  x: 0,
  y: 0,
  width: 240,
  height: 120,
  gap: 16,
  gaps: [],
  layer: 10,
  direction: 'vertical',
  frameImage: '',
  frameImageUrl: null,
  effectVideo: '',
  effectVideoUrl: null
}

export function slotGroupKey(side: BpSide, action: 'pick' | 'ban'): DisplaySlotGroupKey {
  if (side === 'star') {
    return action === 'pick' ? 'starPick' : 'starBan'
  }

  return action === 'pick' ? 'railPick' : 'railBan'
}

function legacySlotLayout(
  settings: DisplaySettings,
  side: BpSide,
  action: 'pick' | 'ban',
  secondary: boolean
): DisplaySlotLayout {
  const layouts = settings.slotLayouts

  if (side === 'star') {
    if (action === 'pick') {
      return secondary
        ? (layouts?.starPickSecond ?? fallbackSlotLayout)
        : (layouts?.starPick ?? fallbackSlotLayout)
    }

    return secondary
      ? (layouts?.starBanSecond ?? fallbackSlotLayout)
      : (layouts?.starBan ?? fallbackSlotLayout)
  }

  if (action === 'pick') {
    return secondary
      ? (layouts?.railPickSecond ?? fallbackSlotLayout)
      : (layouts?.railPick ?? fallbackSlotLayout)
  }

  return secondary
    ? (layouts?.railBanSecond ?? fallbackSlotLayout)
    : (layouts?.railBan ?? fallbackSlotLayout)
}

export function configuredSlotGroups(
  settings: DisplaySettings,
  side: BpSide,
  action: 'pick' | 'ban'
): DisplaySlotGroup[] {
  const configuredGroups = settings.slotGroups?.[slotGroupKey(side, action)]
  if (Array.isArray(configuredGroups) && configuredGroups.length > 0) {
    return configuredGroups
  }

  const secondaryCount =
    action === 'pick'
      ? (settings.secondaryPickCounts?.[side] ?? 0)
      : (settings.secondaryBanCounts?.[side] ?? 0)

  return [
    { ...legacySlotLayout(settings, side, action, false), slotCount: 0 },
    {
      ...legacySlotLayout(settings, side, action, true),
      slotCount: Math.max(0, Math.floor(Number(secondaryCount) || 0))
    }
  ]
}

export function resolvedSlotGroupCounts(totalSlots: number, groups: DisplaySlotGroup[]): number[] {
  if (groups.length === 0) {
    return []
  }

  const total = Math.max(0, Math.floor(Number(totalSlots) || 0))
  const requestedCounts = groups.map((group) =>
    Math.max(0, Math.floor(Number(group.slotCount) || 0))
  )

  if (requestedCounts[0] === 0) {
    const firstCount = Math.max(
      0,
      total - requestedCounts.slice(1).reduce((sum, count) => sum + count, 0)
    )
    let remaining = total - firstCount

    return [
      firstCount,
      ...requestedCounts.slice(1).map((count) => {
        const resolvedCount = Math.min(count, remaining)
        remaining -= resolvedCount
        return resolvedCount
      })
    ]
  }

  let remaining = total

  return requestedCounts.map((count) => {
    const resolvedCount = Math.min(count, remaining)
    remaining -= resolvedCount
    return resolvedCount
  })
}

export function resolveSlotGroup(
  totalSlots: number,
  slotIndex: number,
  groups: DisplaySlotGroup[]
): { group: DisplaySlotGroup; localIndex: number; groupCount: number } | null {
  const counts = resolvedSlotGroupCounts(totalSlots, groups)
  let startIndex = 0

  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const groupCount = counts[groupIndex] ?? 0
    if (slotIndex < startIndex + groupCount) {
      return {
        group: groups[groupIndex],
        localIndex: slotIndex - startIndex,
        groupCount
      }
    }
    startIndex += groupCount
  }

  return null
}
