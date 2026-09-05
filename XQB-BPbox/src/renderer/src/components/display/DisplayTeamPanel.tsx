import DisplayBanSlot from './DisplayBanSlot'
import DisplayPickSlot from './DisplayPickSlot'
import {
  displaySlotGapStyle,
  displaySlotGroupClassName,
  displaySlotLayoutStyle
} from './displaySlotLayout'
import { configuredSlotGroups, resolvedSlotGroupCounts } from './slotGroups'
import type {
  BpSide,
  BpTeamTarget,
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
  tentativeTarget?: BpTeamTarget | null
  tentativeAction?: 'pick' | 'ban' | null
  renderSlotEffects?: boolean
  renderScale?: number
}

function tightPickLayout(layout: DisplaySlotLayout): DisplaySlotLayout {
  return {
    ...layout,
    gap: 0,
    gaps: []
  }
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
  tentativeTarget = null,
  tentativeAction = null,
  renderSlotEffects = true,
  renderScale = 1
}: DisplayTeamPanelProps): React.JSX.Element {
  const previewPickIndex = previewIndex(previewSlotKey, side, 'pick')
  const previewBanIndex = previewIndex(previewSlotKey, side, 'ban')
  const tentativePickIndex =
    tentativeTarget && tentativeAction === 'pick' ? team.picks.length : null
  const tentativeBanIndex = tentativeTarget && tentativeAction === 'ban' ? team.bans.length : null
  const pickCount = Math.max(
    slotCounts.picks,
    team.picks.length,
    previewPickIndex === null ? 0 : previewPickIndex + 1,
    tentativePickIndex === null ? 0 : tentativePickIndex + 1
  )
  const banCount = Math.max(
    slotCounts.bans,
    team.bans.length,
    previewBanIndex === null ? 0 : previewBanIndex + 1,
    tentativeBanIndex === null ? 0 : tentativeBanIndex + 1
  )
  const pickGroups = configuredSlotGroups(settings, side, 'pick')
  const banGroups = configuredSlotGroups(settings, side, 'ban')
  const pickGroupCounts = resolvedSlotGroupCounts(pickCount, pickGroups)
  const banGroupCounts = resolvedSlotGroupCounts(banCount, banGroups)

  return (
    <section className={`display-team-panel display-team-${side}`}>
      {pickGroups.map((group, groupIndex) => {
        const groupCount = pickGroupCounts[groupIndex] ?? 0
        if (groupCount <= 0) {
          return null
        }

        const startIndex = pickGroupCounts
          .slice(0, groupIndex)
          .reduce((sum, count) => sum + count, 0)
        const layout = tightPickLayout(group)

        return (
          <div
            key={`pick-group-${groupIndex}`}
            className={displaySlotGroupClassName(
              `display-picks ${groupIndex > 0 ? 'display-picks-second' : ''} display-picks-group-${groupIndex + 1}`,
              layout
            )}
            style={displaySlotLayoutStyle(layout, { scale: renderScale })}
          >
            {Array.from({ length: groupCount }).map((_, localIndex) => {
              const pickIndex = startIndex + localIndex
              const key = slotKey(side, 'pick', pickIndex)

              return (
                <DisplayPickSlot
                  key={`pick-${pickIndex}`}
                  target={
                    team.picks[pickIndex] ??
                    (tentativePickIndex === pickIndex ? (tentativeTarget ?? undefined) : undefined)
                  }
                  side={side}
                  index={pickIndex + 1}
                  tentative={tentativePickIndex === pickIndex}
                >
                  {renderSlotEffects
                    ? renderSlotEffect(key, slotEffects.pick, {
                        pending: activePendingSlotKeys.has(key),
                        selected: selectedSlotKey === key,
                        preview: previewSlotKey === key,
                        selectedEffectKey,
                        previewEffectKey
                      })
                    : null}
                </DisplayPickSlot>
              )
            })}
          </div>
        )
      })}
      {banGroups.map((group, groupIndex) => {
        const groupCount = banGroupCounts[groupIndex] ?? 0
        if (groupCount <= 0) {
          return null
        }

        const startIndex = banGroupCounts
          .slice(0, groupIndex)
          .reduce((sum, count) => sum + count, 0)

        return (
          <div
            key={`ban-group-${groupIndex}`}
            className={displaySlotGroupClassName(
              `display-bans ${groupIndex > 0 ? 'display-bans-second' : ''} display-bans-group-${groupIndex + 1}`,
              group
            )}
            style={displaySlotLayoutStyle(group, {
              reverseHorizontal: side === 'star',
              scale: renderScale
            })}
          >
            {Array.from({ length: groupCount }).map((_, localIndex) => {
              const banIndex = startIndex + localIndex
              const key = slotKey(side, 'ban', banIndex)

              return (
                <DisplayBanSlot
                  key={`ban-${banIndex}`}
                  target={
                    team.bans[banIndex] ??
                    (tentativeBanIndex === banIndex ? (tentativeTarget ?? undefined) : undefined)
                  }
                  index={banIndex + 1}
                  tentative={tentativeBanIndex === banIndex}
                  style={displaySlotGapStyle(group, localIndex, {
                    reverseHorizontal: side === 'star',
                    scale: renderScale
                  })}
                >
                  {renderSlotEffects
                    ? renderSlotEffect(key, slotEffects.ban, {
                        pending: activePendingSlotKeys.has(key),
                        selected: selectedSlotKey === key,
                        preview: previewSlotKey === key,
                        selectedEffectKey,
                        previewEffectKey
                      })
                    : null}
                </DisplayBanSlot>
              )
            })}
          </div>
        )
      })}
    </section>
  )
}

export default DisplayTeamPanel
