import type { BpRuntimeState, BpSide, Character, LightCone } from '../types'
import {
  internalSideToRemoteSide,
  remoteSideToInternalSide,
  validateRemoteSideMapping
} from './sideMapper'
import type {
  BpActionTarget,
  RemoteBpOperation,
  RemoteBpPhase,
  RemoteBpState,
  RemoteBpTeam,
  RemotePlayerSide,
  RemoteSideMapping
} from './types'

export interface RemoteBpStateSerializeInput {
  runtime: BpRuntimeState
  characters: readonly Character[]
  lightCones: readonly LightCone[]
  revision: number
  roomId: string
  sessionId?: string
  mapping: RemoteSideMapping
  flowStepCount: number
  selectedCharacterId?: number | null
  selectedLightConeId?: number | null
  pairedSelections?: Partial<Record<BpSide, number | null>>
  pairedConfirmations?: Partial<Record<BpSide, boolean>>
  teamNames?: Partial<Record<RemotePlayerSide, string | null>>
  canConfirm?: boolean
  waitingForHost?: boolean
  playerConnections?: RemoteBpState['playerConnections']
  updatedAt?: string
}

function phaseFor(runtime: BpRuntimeState): RemoteBpPhase {
  if (runtime.status === 'complete') return 'COMPLETE'
  const action = runtime.currentStep?.action
  if (action === 'ban') return 'BAN'
  if (action === 'pick') return 'PICK'
  if (action === 'protect') return 'PROTECT'
  if (action === 'borrow') return 'BORROW'
  return 'WAITING'
}

function operationFor(runtime: BpRuntimeState): RemoteBpOperation {
  const action = runtime.currentStep?.action
  if (action === 'ban') return 'BAN'
  if (action === 'pick') return 'PICK'
  if (action === 'protect') return 'PROTECT'
  if (action === 'borrow') return 'BORROW'
  return 'WAIT'
}

function targetTypeFor(value: string): 'CHARACTER' | 'LIGHT_CONE' | 'NONE' {
  if (value === 'character') return 'CHARACTER'
  if (value === 'lightCone') return 'LIGHT_CONE'
  return 'NONE'
}

function remoteSelectionTargets(
  input: RemoteBpStateSerializeInput
): Record<RemotePlayerSide, BpActionTarget | null> {
  const selections: Record<RemotePlayerSide, BpActionTarget | null> = {
    first: null,
    second: null
  }
  const stepSide = input.runtime.currentStep?.side
  if (stepSide && input.selectedCharacterId) {
    selections[internalSideToRemoteSide(stepSide, input.mapping)] = {
      kind: 'CHARACTER',
      id: String(input.selectedCharacterId)
    }
  } else if (stepSide && input.selectedLightConeId) {
    selections[internalSideToRemoteSide(stepSide, input.mapping)] = {
      kind: 'LIGHT_CONE',
      id: String(input.selectedLightConeId)
    }
  }
  ;(['star', 'rail'] as BpSide[]).forEach((side) => {
    const selected = input.pairedSelections?.[side]
    if (selected) {
      selections[internalSideToRemoteSide(side, input.mapping)] = {
        kind: 'CHARACTER',
        id: String(selected)
      }
    }
  })
  return selections
}

export function serializeRemoteBpState(input: RemoteBpStateSerializeInput): RemoteBpState {
  const mapping = validateRemoteSideMapping(input.mapping)
  const usedCharacterIds = new Set(
    input.runtime.actions
      .filter(
        (action) =>
          action.targetType === 'character' && (action.action === 'ban' || action.action === 'pick')
      )
      .map((action) => action.targetId)
  )
  const bannedCharacterIds = new Set(
    input.runtime.actions
      .filter((action) => action.targetType === 'character' && action.action === 'ban')
      .map((action) => action.targetId)
  )
  const pickedCharacterIds = new Set(
    input.runtime.actions
      .filter((action) => action.targetType === 'character' && action.action === 'pick')
      .map((action) => action.targetId)
  )
  const usedLightConeIds = new Set(
    input.runtime.actions
      .filter(
        (action) =>
          action.targetType === 'lightCone' && (action.action === 'ban' || action.action === 'pick')
      )
      .map((action) => action.targetId)
  )
  const bannedLightConeIds = new Set(
    input.runtime.actions
      .filter((action) => action.targetType === 'lightCone' && action.action === 'ban')
      .map((action) => action.targetId)
  )
  const pickedLightConeIds = new Set(
    input.runtime.actions
      .filter((action) => action.targetType === 'lightCone' && action.action === 'pick')
      .map((action) => action.targetId)
  )
  const selectionTargets = remoteSelectionTargets(input)
  const selections: Record<RemotePlayerSide, string | null> = {
    first: selectionTargets.first?.id ?? null,
    second: selectionTargets.second?.id ?? null
  }
  const selectedById = new Map<string, RemotePlayerSide>()
  ;(['first', 'second'] as RemotePlayerSide[]).forEach((side) => {
    const target = selectionTargets[side]
    if (target?.kind === 'CHARACTER') selectedById.set(target.id, side)
  })

  const characters = input.characters.map((character) => {
    const id = String(character.id)
    const selectedBy = selectedById.get(id) ?? null
    return {
      id,
      name: character.chinese_name,
      avatar: character.avatar_small_image ? `character:${id}:avatar` : null,
      portrait: character.full_body_image ? `character:${id}:portrait` : null,
      element: character.element || null,
      path: character.path || null,
      enabled: !usedCharacterIds.has(character.id),
      selected: selectedBy !== null,
      selectedBy,
      banned: bannedCharacterIds.has(character.id),
      picked: pickedCharacterIds.has(character.id)
    }
  })
  const availableCharacterIds = characters
    .filter((character) => character.enabled)
    .map((character) => character.id)
  const unavailableCharacterIds = characters
    .filter((character) => !character.enabled)
    .map((character) => character.id)
  const selectedLightConeById = new Map<string, RemotePlayerSide>()
  ;(['first', 'second'] as RemotePlayerSide[]).forEach((side) => {
    const target = selectionTargets[side]
    if (target?.kind === 'LIGHT_CONE') selectedLightConeById.set(target.id, side)
  })
  const lightCones = input.lightCones.map((lightCone) => {
    const id = String(lightCone.id)
    const selectedBy = selectedLightConeById.get(id) ?? null
    return {
      id,
      name: lightCone.name,
      image: lightCone.small_image ? `light-cone:${id}:image` : null,
      path: lightCone.path || null,
      enabled: !usedLightConeIds.has(lightCone.id),
      selected: selectedBy !== null,
      selectedBy,
      banned: bannedLightConeIds.has(lightCone.id),
      picked: pickedLightConeIds.has(lightCone.id)
    }
  })
  const availableLightConeIds = lightCones.filter((item) => item.enabled).map((item) => item.id)
  const unavailableLightConeIds = lightCones.filter((item) => !item.enabled).map((item) => item.id)
  const step = input.runtime.currentStep
  const pairedResults = (actionName: 'protect' | 'borrow'): RemoteBpState['protections'] =>
    input.runtime.actions
      .filter((action) => action.action === actionName)
      .flatMap((action) => {
        const results: RemoteBpState['protections'] = []
        if (action.starTargetId) {
          results.push({
            characterId: String(action.starTargetId),
            side: internalSideToRemoteSide('star', mapping),
            stepIndex: action.stepIndex
          })
        }
        if (action.railTargetId) {
          results.push({
            characterId: String(action.railTargetId),
            side: internalSideToRemoteSide('rail', mapping),
            stepIndex: action.stepIndex
          })
        }
        return results
      })

  const teamForRemote = (remoteSide: RemotePlayerSide): RemoteBpTeam => {
    return {
      side: remoteSide,
      name: input.teamNames?.[remoteSide]?.trim() || (remoteSide === 'first' ? '先手' : '后手')
    }
  }

  const pickedIdsByInternalSide = (side: BpSide): string[] =>
    input.runtime.actions
      .filter(
        (action) =>
          action.side === side && action.action === 'pick' && action.targetType === 'character'
      )
      .map((action) => String(action.targetId))
  const protectedIds = new Set(
    input.runtime.actions
      .filter((action) => action.action === 'protect')
      .flatMap((action) => [action.starTargetId, action.railTargetId])
      .filter((id): id is number => Boolean(id))
      .map(String)
  )
  const availableTargetIdsBySide = Object.fromEntries(
    (['first', 'second'] as RemotePlayerSide[]).map((remoteSide) => {
      if (!step) return [remoteSide, []]
      if (step.action === 'protect' || step.action === 'borrow') {
        const selectionSide = remoteSideToInternalSide(remoteSide, mapping)
        const ownerSide =
          step.action === 'protect' ? selectionSide : selectionSide === 'star' ? 'rail' : 'star'
        const ids = pickedIdsByInternalSide(ownerSide).filter(
          (id) => step.action !== 'borrow' || !protectedIds.has(id)
        )
        return [remoteSide, ids]
      }
      if (internalSideToRemoteSide(step.side, mapping) !== remoteSide) return [remoteSide, []]
      return [
        remoteSide,
        step.targetType === 'character'
          ? availableCharacterIds
          : step.targetType === 'lightCone'
            ? availableLightConeIds
            : []
      ]
    })
  ) as Record<RemotePlayerSide, string[]>
  const confirmedSides: Record<RemotePlayerSide, boolean> = {
    first: Boolean(input.pairedConfirmations?.[remoteSideToInternalSide('first', mapping)]),
    second: Boolean(input.pairedConfirmations?.[remoteSideToInternalSide('second', mapping)])
  }
  const canConfirmBySide: Record<RemotePlayerSide, boolean> = {
    first: Boolean(selectionTargets.first && !confirmedSides.first),
    second: Boolean(selectionTargets.second && !confirmedSides.second)
  }
  const waitingForHost = Boolean(input.waitingForHost && input.runtime.status === 'running')

  return {
    schemaVersion: 1,
    revision: input.revision,
    sessionId: input.sessionId ?? `host-${input.roomId}`,
    roomId: input.roomId,
    flowName: input.runtime.flowName,
    status:
      input.runtime.status === 'complete'
        ? 'complete'
        : input.runtime.status === 'running'
          ? 'running'
          : 'waiting',
    phase: waitingForHost ? 'WAITING' : phaseFor(input.runtime),
    currentActor: waitingForHost
      ? null
      : step
        ? internalSideToRemoteSide(step.side, mapping)
        : null,
    currentOperation: waitingForHost ? 'WAIT' : operationFor(input.runtime),
    waitingForHost,
    currentStep: step
      ? {
          id: `step-${step.index}`,
          index: step.index,
          total: input.flowStepCount,
          label: `第 ${step.index} 步`,
          targetType: targetTypeFor(step.targetType)
        }
      : null,
    playerConnections: input.playerConnections ?? {
      first: 'empty',
      second: 'empty'
    },
    sideMapping: mapping,
    teams: {
      first: teamForRemote('first'),
      second: teamForRemote('second')
    },
    characters,
    lightCones,
    bans: input.runtime.actions
      .filter((action) => action.targetType === 'character' && action.action === 'ban')
      .map((action) => ({
        characterId: String(action.targetId),
        side: internalSideToRemoteSide(action.side, mapping),
        stepIndex: action.stepIndex
      })),
    picks: input.runtime.actions
      .filter((action) => action.targetType === 'character' && action.action === 'pick')
      .map((action) => ({
        characterId: String(action.targetId),
        side: internalSideToRemoteSide(action.side, mapping),
        stepIndex: action.stepIndex
      })),
    lightConeBans: input.runtime.actions
      .filter((action) => action.targetType === 'lightCone' && action.action === 'ban')
      .map((action) => ({
        lightConeId: String(action.targetId),
        side: internalSideToRemoteSide(action.side, mapping),
        stepIndex: action.stepIndex
      })),
    lightConePicks: input.runtime.actions
      .filter((action) => action.targetType === 'lightCone' && action.action === 'pick')
      .map((action) => ({
        lightConeId: String(action.targetId),
        side: internalSideToRemoteSide(action.side, mapping),
        stepIndex: action.stepIndex
      })),
    protections: pairedResults('protect'),
    borrows: pairedResults('borrow'),
    selections,
    selectionTargets,
    confirmedSides,
    availableCharacterIds,
    unavailableCharacterIds,
    availableLightConeIds,
    unavailableLightConeIds,
    availableTargetIdsBySide: waitingForHost ? { first: [], second: [] } : availableTargetIdsBySide,
    canConfirm: waitingForHost
      ? false
      : Boolean(input.canConfirm || canConfirmBySide.first || canConfirmBySide.second),
    canConfirmBySide: waitingForHost ? { first: false, second: false } : canConfirmBySide,
    countdown: null,
    updatedAt: input.updatedAt ?? input.runtime.createdAt
  }
}
