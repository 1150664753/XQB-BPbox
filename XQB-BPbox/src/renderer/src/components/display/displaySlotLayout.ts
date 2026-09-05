import type { DisplaySlotLayout } from '../../types/bp'

export function displaySlotLayoutStyle(
  layout: DisplaySlotLayout,
  options: { reverseHorizontal?: boolean; scale?: number } = {}
): React.CSSProperties {
  const hasCustomGaps = Array.isArray(layout.gaps) && layout.gaps.length > 0
  const scale = options.scale ?? 1
  const scaledPixel = (value: number): number => Math.round(value * scale)
  const gap = hasCustomGaps ? 0 : Math.max(0, scaledPixel(Number(layout.gap) || 0))
  const isHorizontal = layout.direction === 'horizontal'

  return {
    left: `${scaledPixel(layout.x)}px`,
    top: `${scaledPixel(layout.y)}px`,
    flexDirection: isHorizontal ? (options.reverseHorizontal ? 'row-reverse' : 'row') : 'column',
    gap: `${gap}px`,
    zIndex: layout.layer,
    '--display-slot-width': `${Math.max(1, scaledPixel(layout.width))}px`,
    '--display-slot-height': `${Math.max(1, scaledPixel(layout.height))}px`,
    '--display-slot-frame': layout.frameImageUrl ? `url("${layout.frameImageUrl}")` : 'none'
  } as React.CSSProperties
}

export function displaySlotGroupClassName(className: string, layout: DisplaySlotLayout): string {
  const directionClass =
    layout.direction === 'horizontal'
      ? 'display-slot-group-horizontal'
      : 'display-slot-group-vertical'
  const tightClass = Math.max(0, Number(layout.gap) || 0) === 0 ? 'display-slot-group-tight' : ''
  return `display-slot-group ${className} ${directionClass} ${tightClass}`.trim()
}

export function displaySlotGapStyle(
  layout: DisplaySlotLayout,
  index: number,
  options: { reverseHorizontal?: boolean; scale?: number } = {}
): React.CSSProperties | undefined {
  if (!Array.isArray(layout.gaps) || layout.gaps.length === 0 || index === 0) {
    return undefined
  }

  const gap = Math.max(
    0,
    Math.round((Number(layout.gaps[index - 1] ?? layout.gap) || 0) * (options.scale ?? 1))
  )

  if (layout.direction === 'horizontal') {
    return options.reverseHorizontal ? { marginRight: `${gap}px` } : { marginLeft: `${gap}px` }
  }

  return { marginTop: `${gap}px` }
}
