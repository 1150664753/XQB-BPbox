import type { BpAction, BpSide, BpTargetType } from '../types'
import { remoteSideToInternalSide } from './sideMapper'
import type {
  BpActionResultCode,
  BpActionTarget,
  RemoteBpAction,
  RemoteBpActionResult,
  RemoteSideMapping
} from './types'

export type BpActionSource = 'local' | 'remote'

export interface BpActionDispatchSnapshot {
  started: boolean
  currentStep: {
    index: number
    side: BpSide
    action: BpAction
    targetType: BpTargetType
  } | null
  availableCharacterIds: readonly string[]
  availableLightConeIds: readonly string[]
  pickedCharacterIds: readonly string[]
  pickedCharacterIdsBySide: Record<BpSide, readonly string[]>
  availablePairedTargetIdsBySide: Record<BpSide, readonly string[]>
  selectedTarget: BpActionTarget | null
  selectedTargetsBySide: Record<BpSide, BpActionTarget | null>
}

export interface BpActionExecutionResult {
  stateChanged: boolean
  code?: Exclude<BpActionResultCode, 'OK'>
  message?: string
}

export interface BpActionExecutor {
  selectTarget(target: BpActionTarget, actorSide: BpSide): Promise<BpActionExecutionResult>
  deselectTarget(actorSide: BpSide): Promise<BpActionExecutionResult>
  confirmTarget(target: BpActionTarget, actorSide: BpSide): Promise<BpActionExecutionResult>
  commitTargets(
    kind: 'BAN' | 'PICK' | 'PROTECT' | 'BORROW',
    targets: readonly BpActionTarget[]
  ): Promise<BpActionExecutionResult>
}

export interface BpActionDispatchEvent {
  action: RemoteBpAction
  source: BpActionSource
  result: RemoteBpActionResult
}

type DispatchListener = (event: BpActionDispatchEvent) => void
type AuthorityListener = (revision: number, reason: string) => void

function expectedTargetType(targetType: BpTargetType): BpActionTarget['kind'] | null {
  if (targetType === 'character') return 'CHARACTER'
  if (targetType === 'lightCone') return 'LIGHT_CONE'
  return null
}

function currentOperation(action: BpAction): string {
  return action.toUpperCase()
}

export class BpActionDispatcher {
  private readonly processedActionIds = new Set<string>()
  private readonly dispatchListeners = new Set<DispatchListener>()
  private readonly authorityListeners = new Set<AuthorityListener>()
  private dispatchQueue: Promise<void> = Promise.resolve()

  constructor(private revision = 1) {}

  getRevision(): number {
    return this.revision
  }

  startAuthoritySession(initialRevision = 1): void {
    this.revision = Math.max(1, Math.floor(initialRevision))
    this.processedActionIds.clear()
  }

  noteAuthoritativeStateChange(reason: string): number {
    this.revision += 1
    this.authorityListeners.forEach((listener) => listener(this.revision, reason))
    return this.revision
  }

  subscribe(listener: DispatchListener): () => void {
    this.dispatchListeners.add(listener)
    return () => this.dispatchListeners.delete(listener)
  }

  subscribeAuthorityChanges(listener: AuthorityListener): () => void {
    this.authorityListeners.add(listener)
    return () => this.authorityListeners.delete(listener)
  }

  async dispatch(
    action: RemoteBpAction,
    source: BpActionSource,
    snapshot: BpActionDispatchSnapshot,
    executor: BpActionExecutor,
    mapping: RemoteSideMapping
  ): Promise<RemoteBpActionResult> {
    let releaseQueue!: () => void
    const previousDispatch = this.dispatchQueue
    this.dispatchQueue = new Promise<void>((resolve) => {
      releaseQueue = resolve
    })
    await previousDispatch
    try {
      return await this.dispatchUnlocked(action, source, snapshot, executor, mapping)
    } finally {
      releaseQueue()
    }
  }

  private async dispatchUnlocked(
    action: RemoteBpAction,
    source: BpActionSource,
    snapshot: BpActionDispatchSnapshot,
    executor: BpActionExecutor,
    mapping: RemoteSideMapping
  ): Promise<RemoteBpActionResult> {
    const reject = (code: BpActionResultCode, message: string): RemoteBpActionResult => ({
      actionId: action.actionId,
      accepted: false,
      code,
      message,
      reason: message,
      resultingRevision: this.revision,
      stateChanged: false
    })

    if (this.processedActionIds.has(action.actionId)) {
      const result = reject('ALREADY_PROCESSED', '该 actionId 已经处理')
      this.emit({ action, source, result })
      return result
    }
    this.processedActionIds.add(action.actionId)

    if (action.expectedRevision !== this.revision) {
      const result = reject('REVISION_CONFLICT', '操作基于的 revision 已过期')
      this.emit({ action, source, result })
      return result
    }
    if (!snapshot.started || !snapshot.currentStep) {
      const result = reject('BP_NOT_STARTED', 'BP 尚未开始或已经结束')
      this.emit({ action, source, result })
      return result
    }

    const step = snapshot.currentStep
    if (action.stepIndex !== null && action.stepIndex !== step.index) {
      const result = reject('INVALID_ACTION', '操作步骤与当前 BP 步骤不一致')
      this.emit({ action, source, result })
      return result
    }
    const actorSide = remoteSideToInternalSide(action.actorSide, mapping)
    const pairedAction = step.action === 'protect' || step.action === 'borrow'
    if (!pairedAction && actorSide !== step.side) {
      const result = reject('NOT_YOUR_TURN', '当前尚未轮到该玩家操作')
      this.emit({ action, source, result })
      return result
    }
    if (
      pairedAction &&
      source === 'remote' &&
      action.kind !== 'SELECT' &&
      action.kind !== 'DESELECT' &&
      action.kind !== 'CONFIRM'
    ) {
      const result = reject('INVALID_ACTION', '保护/租借阶段需要双方分别选择并确认')
      this.emit({ action, source, result })
      return result
    }

    const targetType = expectedTargetType(step.targetType)
    const validateAvailableTarget = (target: BpActionTarget): RemoteBpActionResult | null => {
      if (!targetType || target.kind !== targetType) {
        return reject('INVALID_TARGET', '目标类型与当前步骤不一致')
      }
      const available =
        target.kind === 'CHARACTER'
          ? snapshot.availableCharacterIds
          : snapshot.availableLightConeIds
      if (!available.includes(target.id)) {
        return reject(
          target.kind === 'CHARACTER' ? 'CHARACTER_UNAVAILABLE' : 'INVALID_TARGET',
          '目标当前不可操作'
        )
      }
      return null
    }

    let execution: BpActionExecutionResult
    switch (action.kind) {
      case 'SELECT': {
        const invalid = pairedAction
          ? action.targets[0].kind !== 'CHARACTER' ||
            !snapshot.availablePairedTargetIdsBySide[actorSide].includes(action.targets[0].id)
            ? reject('INVALID_TARGET', '该角色不属于当前选手可确认的保护/租借范围')
            : null
          : validateAvailableTarget(action.targets[0])
        if (invalid) {
          this.emit({ action, source, result: invalid })
          return invalid
        }
        execution = await executor.selectTarget(action.targets[0], actorSide)
        break
      }
      case 'DESELECT':
        execution = await executor.deselectTarget(actorSide)
        break
      case 'CONFIRM': {
        const selectedTarget = pairedAction
          ? snapshot.selectedTargetsBySide[actorSide]
          : snapshot.selectedTarget
        if (!selectedTarget) {
          const result = reject('INVALID_TARGET', '当前没有可确认的选择')
          this.emit({ action, source, result })
          return result
        }
        if (
          pairedAction &&
          !snapshot.availablePairedTargetIdsBySide[actorSide].includes(selectedTarget.id)
        ) {
          const result = reject('INVALID_TARGET', '保护/租借选择已经失效，请重新选择')
          this.emit({ action, source, result })
          return result
        }
        execution = await executor.confirmTarget(selectedTarget, actorSide)
        break
      }
      case 'BAN':
      case 'PICK': {
        if (currentOperation(step.action) !== action.kind) {
          const result = reject('INVALID_ACTION', '操作类型与当前步骤不一致')
          this.emit({ action, source, result })
          return result
        }
        const invalid = validateAvailableTarget(action.targets[0])
        if (invalid) {
          this.emit({ action, source, result: invalid })
          return invalid
        }
        execution = await executor.commitTargets(action.kind, action.targets)
        break
      }
      case 'PROTECT':
      case 'BORROW': {
        if (currentOperation(step.action) !== action.kind) {
          const result = reject('INVALID_ACTION', '特殊操作与当前步骤不一致')
          this.emit({ action, source, result })
          return result
        }
        const targetSides = action.targets.map((target) => target.side)
        if (
          action.targets[0].kind !== 'CHARACTER' ||
          action.targets[1].kind !== 'CHARACTER' ||
          targetSides.some((side) => side === undefined) ||
          targetSides[0] === targetSides[1] ||
          action.targets[0].id === action.targets[1].id ||
          action.targets.some((target) => !snapshot.pickedCharacterIds.includes(target.id))
        ) {
          const result = reject('INVALID_TARGET', '保护/租借目标必须是双方不同的已 Pick 角色')
          this.emit({ action, source, result })
          return result
        }
        for (const target of action.targets) {
          if (!target.side) {
            const result = reject('INVALID_TARGET', '保护/租借目标缺少阵营信息')
            this.emit({ action, source, result })
            return result
          }
          const selectionSide = remoteSideToInternalSide(target.side, mapping)
          const ownerSide =
            action.kind === 'PROTECT' ? selectionSide : selectionSide === 'star' ? 'rail' : 'star'
          if (!snapshot.pickedCharacterIdsBySide[ownerSide].includes(target.id)) {
            const result = reject('INVALID_TARGET', '保护/租借目标不属于指定队伍的 Pick 列表')
            this.emit({ action, source, result })
            return result
          }
        }
        execution = await executor.commitTargets(action.kind, action.targets)
        break
      }
      case 'CUSTOM': {
        const result = reject('UNSUPPORTED_ACTION', `暂不支持扩展操作：${action.extension.name}`)
        this.emit({ action, source, result })
        return result
      }
    }

    if (!execution.stateChanged) {
      const result = reject(
        execution.code ?? 'INVALID_ACTION',
        execution.message ?? 'BP Core 未应用该操作'
      )
      this.emit({ action, source, result })
      return result
    }

    this.revision += 1
    const result: RemoteBpActionResult = {
      actionId: action.actionId,
      accepted: true,
      code: 'OK',
      message: execution.message ?? '操作已应用',
      resultingRevision: this.revision,
      appliedRevision: this.revision,
      stateChanged: true
    }
    this.emit({ action, source, result })
    return result
  }

  private emit(event: BpActionDispatchEvent): void {
    this.dispatchListeners.forEach((listener) => listener(event))
  }
}
