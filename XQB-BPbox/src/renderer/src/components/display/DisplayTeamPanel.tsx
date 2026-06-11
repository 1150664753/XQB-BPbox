import DisplayBanSlot from './DisplayBanSlot'
import DisplayPickSlot from './DisplayPickSlot'
import type {
  BpSide,
  DisplaySettings,
  DisplaySlotEffectConfig,
  DisplaySlotEffects,
  DisplaySlotEffectLayout,
  DisplaySlotLayout,
  TeamBpState,
  TeamSlotCounts
} from '../../types/bp'

interface DisplayTeamPanelProps {
  side: BpSide
  team: TeamBpState
  slotCounts: TeamSlotCounts
  settings: DisplaySettings
  slotEffects: DisplaySlotEffects
  activePendingSlotKeys: Set<string>
  selectedSlotKey?: string | null
  selectedEffectKey?: string | number
  previewSlotKey?: string | null
  previewEffectKey?: string | number
  renderSlotEffects?: boolean
  renderScale?: number
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

function slotLayout(
  settings: DisplaySettings,
  side: BpSide,
  action: 'pick' | 'pickSecond' | 'ban' | 'banSecond'
): DisplaySlotLayout {
  const layouts = settings.slotLayouts

  if (side === 'star') {
    if (action === 'pick') {
      return layouts?.starPick ?? fallbackSlotLayout
    }

    if (action === 'pickSecond') {
      return layouts?.starPickSecond ?? fallbackSlotLayout
    }

    return action === 'banSecond'
      ? (layouts?.starBanSecond ?? fallbackSlotLayout)
      : (layouts?.starBan ?? fallbackSlotLayout)
  }

  if (action === 'pick') {
    return layouts?.railPick ?? fallbackSlotLayout
  }

  if (action === 'pickSecond') {
    return layouts?.railPickSecond ?? fallbackSlotLayout
  }

  return action === 'banSecond'
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

function layoutStyle(
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

function slotGroupClassName(className: string, layout: DisplaySlotLayout): string {
  const directionClass =
    layout.direction === 'horizontal'
      ? 'display-slot-group-horizontal'
      : 'display-slot-group-vertical'
  const tightClass = Math.max(0, Number(layout.gap) || 0) === 0 ? 'display-slot-group-tight' : ''
  return `display-slot-group ${className} ${directionClass} ${tightClass}`.trim()
}

function slotGapStyle(
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

function slotKey(side: BpSide, action: 'pick' | 'ban', index: number): string {
  return `${side}-${action}-${index}`
}

function previewIndex(
  previewSlotKey: string | null,
  side: BpSide,
  action: 'pick' | 'ban'
): number | null {
  const prefix = `${side}-${action}-`

  if (!previewSlotKey?.startsWith(prefix)) {
    return null
  }

  const index = Number(previewSlotKey.slice(prefix.length))
  return Number.isInteger(index) && index >= 0 ? index : null
}

function effectStyle(layout: DisplaySlotEffectLayout): React.CSSProperties {
  const x = Number(layout.x) || 0
  const y = Number(layout.y) || 0
  const scale = Math.max(0.01, Number(layout.scale) || 1)

  return {
    left: '50%',
    top: '50%',
    transform: `translate(-50%, -50%) translate(${x}px, ${y}px) scale(${scale})`
  }
}

function renderSlotEffect(
  key: string,
  config: DisplaySlotEffectConfig,
  state: {
    pending: boolean
    selected: boolean
    preview: boolean
    selectedEffectKey?: string | number
    previewEffectKey?: string | number
  }
): React.ReactNode {
  const effects: React.ReactNode[] = []

  if (state.pending && config.pendingVideoUrl) {
    effects.push(
      <video
        className="display-slot-effect display-slot-effect-pending"
        key={`pending-${key}-${config.pendingVideoUrl}`}
        src={config.pendingVideoUrl}
        autoPlay
        muted
        loop
        playsInline
        style={effectStyle(config.pendingLayout)}
      />
    )
  }

  if (state.selected && config.selectedVideoUrl) {
    effects.push(
      <video
        className="display-slot-effect display-slot-effect-selected"
        key={`selected-${key}-${state.selectedEffectKey}-${config.selectedVideoUrl}`}
        src={config.selectedVideoUrl}
        autoPlay
        muted
        playsInline
        style={effectStyle(config.pendingLayout)}
      />
    )
  }

  if (state.preview && config.pendingVideoUrl) {
    effects.push(
      <video
        className="display-slot-effect display-slot-effect-preview"
        key={`preview-${key}-${state.previewEffectKey}-${config.pendingVideoUrl}`}
        src={config.pendingVideoUrl}
        autoPlay
        muted
        playsInline
        style={effectStyle(config.pendingLayout)}
      />
    )
  }

  return effects
}

function DisplayTeamPanel({
  side,
  team,
  slotCounts,
  settings,
  slotEffects,
  activePendingSlotKeys,
  selectedSlotKey = null,
  selectedEffectKey,
  previewSlotKey = null,
  previewEffectKey,
  renderSlotEffects = true,
  renderScale = 1
}: DisplayTeamPanelProps): React.JSX.Element {
  const previewPickIndex = previewIndex(previewSlotKey, side, 'pick')
  const previewBanIndex = previewIndex(previewSlotKey, side, 'ban')
  const pickCount = Math.max(
    slotCounts.picks,
    team.picks.length,
    previewPickIndex === null ? 0 : previewPickIndex + 1
  )
  const banCount = Math.max(
    slotCounts.bans,
    team.bans.length,
    previewBanIndex === null ? 0 : previewBanIndex + 1
  )
  const secondPickCount = Math.min(
    pickCount,
    Math.max(0, Math.floor(Number(settings.secondaryPickCounts?.[side]) || 0))
  )
  const firstPickCount = Math.max(0, pickCount - secondPickCount)
  const secondBanCount = Math.min(
    banCount,
    Math.max(0, Math.floor(Number(settings.secondaryBanCounts?.[side]) || 0))
  )
  const firstBanCount = Math.max(0, banCount - secondBanCount)
  const pickLayout = tightPickLayout(slotLayout(settings, side, 'pick'))
  const secondPickLayout = tightPickLayout(slotLayout(settings, side, 'pickSecond'))
  const banLayout = slotLayout(settings, side, 'ban')
  const secondBanLayout = slotLayout(settings, side, 'banSecond')

  return (
    <section className={`display-team-panel display-team-${side}`}>
      <div
        className={slotGroupClassName('display-picks', pickLayout)}
        style={layoutStyle(pickLayout, { scale: renderScale })}
      >
        {Array.from({ length: firstPickCount }).map((_, index) => (
          <DisplayPickSlot
            key={`pick-${index}`}
            target={team.picks[index]}
            side={side}
            index={index + 1}
          >
            {renderSlotEffects
              ? renderSlotEffect(slotKey(side, 'pick', index), slotEffects.pick, {
                  pending: activePendingSlotKeys.has(slotKey(side, 'pick', index)),
                  selected: selectedSlotKey === slotKey(side, 'pick', index),
                  preview: previewSlotKey === slotKey(side, 'pick', index),
                  selectedEffectKey,
                  previewEffectKey
                })
              : null}
          </DisplayPickSlot>
        ))}
      </div>
      {secondPickCount > 0 ? (
        <div
          className={slotGroupClassName('display-picks display-picks-second', secondPickLayout)}
          style={layoutStyle(secondPickLayout, { scale: renderScale })}
        >
          {Array.from({ length: secondPickCount }).map((_, index) => {
            const pickIndex = firstPickCount + index

            return (
              <DisplayPickSlot
                key={`pick-second-${index}`}
                target={team.picks[pickIndex]}
                side={side}
                index={pickIndex + 1}
              >
                {renderSlotEffects
                  ? renderSlotEffect(slotKey(side, 'pick', pickIndex), slotEffects.pick, {
                      pending: activePendingSlotKeys.has(slotKey(side, 'pick', pickIndex)),
                      selected: selectedSlotKey === slotKey(side, 'pick', pickIndex),
                      preview: previewSlotKey === slotKey(side, 'pick', pickIndex),
                      selectedEffectKey,
                      previewEffectKey
                    })
                  : null}
              </DisplayPickSlot>
            )
          })}
        </div>
      ) : null}
      <div
        className={slotGroupClassName('display-bans', banLayout)}
        style={layoutStyle(banLayout, { reverseHorizontal: side === 'star', scale: renderScale })}
      >
        {Array.from({ length: firstBanCount }).map((_, index) => (
          <DisplayBanSlot
            key={`ban-${index}`}
            target={team.bans[index]}
            index={index + 1}
            style={slotGapStyle(banLayout, index, {
              reverseHorizontal: side === 'star',
              scale: renderScale
            })}
          >
            {renderSlotEffects
              ? renderSlotEffect(slotKey(side, 'ban', index), slotEffects.ban, {
                  pending: activePendingSlotKeys.has(slotKey(side, 'ban', index)),
                  selected: selectedSlotKey === slotKey(side, 'ban', index),
                  preview: previewSlotKey === slotKey(side, 'ban', index),
                  selectedEffectKey,
                  previewEffectKey
                })
              : null}
          </DisplayBanSlot>
        ))}
      </div>
      {secondBanCount > 0 ? (
        <div
          className={slotGroupClassName('display-bans display-bans-second', secondBanLayout)}
          style={layoutStyle(secondBanLayout, {
            reverseHorizontal: side === 'star',
            scale: renderScale
          })}
        >
          {Array.from({ length: secondBanCount }).map((_, index) => {
            const banIndex = firstBanCount + index

            return (
              <DisplayBanSlot
                key={`ban-second-${index}`}
                target={team.bans[banIndex]}
                index={banIndex + 1}
                style={slotGapStyle(secondBanLayout, index, {
                  reverseHorizontal: side === 'star',
                  scale: renderScale
                })}
              >
                {renderSlotEffects
                  ? renderSlotEffect(slotKey(side, 'ban', banIndex), slotEffects.ban, {
                      pending: activePendingSlotKeys.has(slotKey(side, 'ban', banIndex)),
                      selected: selectedSlotKey === slotKey(side, 'ban', banIndex),
                      preview: previewSlotKey === slotKey(side, 'ban', banIndex),
                      selectedEffectKey,
                      previewEffectKey
                    })
                  : null}
              </DisplayBanSlot>
            )
          })}
        </div>
      ) : null}
    </section>
  )
}

export default DisplayTeamPanel
