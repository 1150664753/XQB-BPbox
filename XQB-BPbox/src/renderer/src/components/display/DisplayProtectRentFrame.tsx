import DisplayPickSlot from './DisplayPickSlot'
import { displaySlotGroupClassName, displaySlotLayoutStyle } from './displaySlotLayout'
import type {
  BpActionRecord,
  BpRuntimeState,
  BpSide,
  BpTeamTarget,
  DisplayProtectRentFrameLayoutKey,
  DisplaySettings
} from '../../types/bp'
import type { Character } from '../../types/character'

interface DisplayProtectRentFrameProps {
  settings: DisplaySettings
  state: BpRuntimeState
  renderScale?: number
  forceGuides?: boolean
}

type PairedAction = 'protect' | 'borrow'

interface ProtectRentSlot {
  action: PairedAction
  side: BpSide
  layoutKey: DisplayProtectRentFrameLayoutKey
  record?: BpActionRecord
  placeholder: string
}

function isCharacter(target: BpTeamTarget | null | undefined): target is Character {
  return Boolean(target && 'chinese_name' in target)
}

function characterById(
  targets: BpTeamTarget[],
  id: number | null | undefined
): Character | undefined {
  if (id === null || id === undefined) {
    return undefined
  }

  const target = targets.find((item) => item.id === id)
  return isCharacter(target) ? target : undefined
}

function actionTarget(
  state: BpRuntimeState,
  action: BpActionRecord | undefined,
  side: BpSide
): Character | undefined {
  if (!action) {
    return undefined
  }

  const target = side === 'star' ? action.starTarget : action.railTarget
  if (isCharacter(target)) {
    return target
  }

  const targetId = side === 'star' ? action.starTargetId : action.railTargetId
  const sourceSide = action.action === 'borrow' ? (side === 'star' ? 'rail' : 'star') : side
  const sourceTeam = sourceSide === 'star' ? state.starTeam : state.railTeam
  return characterById(sourceTeam.picks, targetId)
}

function latestAction(state: BpRuntimeState, action: PairedAction): BpActionRecord | undefined {
  for (let index = state.actions.length - 1; index >= 0; index -= 1) {
    if (state.actions[index].action === action) {
      return state.actions[index]
    }
  }

  return undefined
}

function fallbackName(record: BpActionRecord | undefined, side: BpSide): string | null {
  if (!record) {
    return null
  }

  return side === 'star' ? (record.starTargetName ?? null) : (record.railTargetName ?? null)
}

function DisplayProtectRentFrame({
  settings,
  state,
  renderScale = 1,
  forceGuides = false
}: DisplayProtectRentFrameProps): React.JSX.Element | null {
  if (settings.showProtectRentFrame !== true || !settings.protectRentFrameLayouts) {
    return null
  }

  const protectAction = latestAction(state, 'protect')
  const borrowAction = latestAction(state, 'borrow')
  const imageMode = settings.protectRentFrameDisplayMode === 'sideHeads' ? 'sideHeads' : 'avatar'
  const slots: ProtectRentSlot[] = [
    {
      action: 'protect',
      side: 'star',
      layoutKey: 'starProtect',
      record: protectAction,
      placeholder: '先保'
    },
    {
      action: 'protect',
      side: 'rail',
      layoutKey: 'railProtect',
      record: protectAction,
      placeholder: '后保'
    },
    {
      action: 'borrow',
      side: 'star',
      layoutKey: 'starBorrow',
      record: borrowAction,
      placeholder: '先租'
    },
    {
      action: 'borrow',
      side: 'rail',
      layoutKey: 'railBorrow',
      record: borrowAction,
      placeholder: '后租'
    }
  ]
  const bpStarted = !forceGuides && (state.playbackMode === 'live' || state.status !== 'idle')

  return (
    <>
      {slots.map((slot) => {
        const layout = settings.protectRentFrameLayouts[slot.layoutKey]
        return (
          <div
            aria-label={`${slot.side === 'star' ? '先手' : '后手'}${slot.action === 'protect' ? '保护' : '租借'}角色展示框`}
            className={displaySlotGroupClassName(
              [
                'display-protect-rent-frame',
                `display-protect-rent-frame-${slot.action}`,
                slot.record ? '' : 'is-idle',
                bpStarted ? 'is-bp-started' : ''
              ]
                .filter(Boolean)
                .join(' '),
              layout
            )}
            key={slot.layoutKey}
            style={displaySlotLayoutStyle(layout, { scale: renderScale })}
          >
            <DisplayPickSlot
              target={actionTarget(state, slot.record, slot.side)}
              fallbackName={fallbackName(slot.record, slot.side)}
              side={slot.side}
              index={1}
              imageMode={imageMode}
              variant={slot.action}
              showName={false}
              placeholder={slot.placeholder}
            />
          </div>
        )
      })}
    </>
  )
}

export default DisplayProtectRentFrame
