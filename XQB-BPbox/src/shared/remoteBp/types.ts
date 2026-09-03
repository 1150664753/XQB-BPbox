import type { BpSide } from '../types'

export type RemotePlayerSide = 'first' | 'second'
export type RemoteBpStatus = 'waiting' | 'running' | 'complete' | 'paused'
export type RemoteBpPhase = 'WAITING' | 'BAN' | 'PICK' | 'PROTECT' | 'BORROW' | 'COMPLETE'
export type RemoteBpOperation =
  | 'BAN'
  | 'PICK'
  | 'SELECT'
  | 'DESELECT'
  | 'CONFIRM'
  | 'PROTECT'
  | 'BORROW'
  | 'WAIT'

export type RemoteAssetType = 'avatar' | 'portrait' | 'light-cone'

export interface RemoteSideMapping {
  first: BpSide
  second: BpSide
}

export interface RemoteCharacterDto {
  id: string
  name: string
  avatar: string | null
  portrait: string | null
  element: string | null
  path: string | null
  enabled: boolean
  selected: boolean
  selectedBy: RemotePlayerSide | null
  banned: boolean
  picked: boolean
}

export interface RemoteLightConeDto {
  id: string
  name: string
  image: string | null
  path: string | null
  enabled: boolean
  selected: boolean
  selectedBy: RemotePlayerSide | null
  banned: boolean
  picked: boolean
}

export interface RemoteBpStep {
  id: string
  index: number
  total: number
  label: string
  targetType?: 'CHARACTER' | 'LIGHT_CONE' | 'NONE'
}

export interface RemoteBpTeam {
  side: RemotePlayerSide
  name: string
  shortName?: string
}

export interface RemoteBpCountdown {
  durationMs: number
  remainingMs: number
  serverTime: string
  running: boolean
}

export interface RemoteBpResultEntry {
  characterId: string
  side: RemotePlayerSide
  stepIndex: number
}

export interface RemoteLightConeResultEntry {
  lightConeId: string
  side: RemotePlayerSide
  stepIndex: number
}

export interface RemoteBpState {
  schemaVersion: 1
  revision: number
  sessionId: string
  roomId: string
  flowName: string
  status: RemoteBpStatus
  phase: RemoteBpPhase
  currentActor: RemotePlayerSide | null
  currentOperation: RemoteBpOperation
  waitingForHost: boolean
  currentStep: RemoteBpStep | null
  playerConnections: Record<RemotePlayerSide, RemotePlayerConnectionState>
  sideMapping: RemoteSideMapping
  teams: Record<RemotePlayerSide, RemoteBpTeam>
  characters: RemoteCharacterDto[]
  lightCones: RemoteLightConeDto[]
  bans: RemoteBpResultEntry[]
  picks: RemoteBpResultEntry[]
  lightConeBans: RemoteLightConeResultEntry[]
  lightConePicks: RemoteLightConeResultEntry[]
  protections: RemoteBpResultEntry[]
  borrows: RemoteBpResultEntry[]
  selections: Record<RemotePlayerSide, string | null>
  selectionTargets: Record<RemotePlayerSide, BpActionTarget | null>
  confirmedSides: Record<RemotePlayerSide, boolean>
  availableCharacterIds: string[]
  unavailableCharacterIds: string[]
  availableLightConeIds: string[]
  unavailableLightConeIds: string[]
  availableTargetIdsBySide: Record<RemotePlayerSide, string[]>
  canConfirm: boolean
  canConfirmBySide: Record<RemotePlayerSide, boolean>
  countdown: RemoteBpCountdown | null
  updatedAt: string
}

export interface BpActionTarget {
  kind: 'CHARACTER' | 'LIGHT_CONE'
  id: string
  side?: RemotePlayerSide
}

interface RemoteBpActionBase {
  actionId: string
  actorSide: RemotePlayerSide
  expectedRevision: number
  stepIndex: number | null
  createdAt: string
}

export type RemoteBpAction =
  | (RemoteBpActionBase & {
      kind: 'SELECT' | 'BAN' | 'PICK'
      targets: [BpActionTarget]
    })
  | (RemoteBpActionBase & {
      kind: 'DESELECT' | 'CONFIRM'
      targets: []
    })
  | (RemoteBpActionBase & {
      kind: 'PROTECT' | 'BORROW'
      targets: [BpActionTarget, BpActionTarget]
    })
  | (RemoteBpActionBase & {
      kind: 'CUSTOM'
      targets: BpActionTarget[]
      extension: {
        name: string
        data: Record<string, string | number | boolean | null>
      }
    })

export type BpActionResultCode =
  | 'OK'
  | 'NOT_YOUR_TURN'
  | 'INVALID_ACTION'
  | 'INVALID_TARGET'
  | 'CHARACTER_UNAVAILABLE'
  | 'REVISION_CONFLICT'
  | 'STALE_REVISION'
  | 'ALREADY_PROCESSED'
  | 'DUPLICATE_REQUEST'
  | 'INVALID_SLOT'
  | 'BP_NOT_STARTED'
  | 'UNSUPPORTED_ACTION'
  | 'SESSION_NOT_READY'

export interface RemoteBpActionResult {
  actionId: string
  accepted: boolean
  code: BpActionResultCode
  message: string
  reason?: string
  resultingRevision: number
  appliedRevision?: number
  stateChanged: boolean
}

export interface AssetManifestEntry {
  assetId: string
  type: RemoteAssetType
  hash: string
  size: number
  mimeType: string
  characterId?: string
  lightConeId?: string
  ownerId?: string
}

export interface AssetManifest {
  revision: number
  generatedAt: string
  assets: AssetManifestEntry[]
}

export interface RemoteAssetBinary {
  descriptor: AssetManifestEntry
  data: Uint8Array
}

export type RemoteRoomLifecycleState = 'idle' | 'starting' | 'active' | 'stopping' | 'error'
export type RemotePlayerConnectionState =
  | 'empty'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'

export interface RemoteRoomPlayerState {
  side: RemotePlayerSide
  peerId: string | null
  displayName: string | null
  connectionState: RemotePlayerConnectionState
  joinedAt: string | null
}

export interface RemoteBpRoomState {
  lifecycle: RemoteRoomLifecycleState
  roomId: string | null
  createdAt: string | null
  transport: 'mock' | 'webrtc'
  connectionState:
    | 'offline'
    | 'connecting'
    | 'connected'
    | 'reconnecting'
    | 'disconnected'
    | 'failed'
    | 'mock-active'
  mapping: RemoteSideMapping
  firstPlayer: RemoteRoomPlayerState
  secondPlayer: RemoteRoomPlayerState
  expiresAt: string | null
  assetCount: number
  lastPublishedRevision: number | null
  error: string | null
}
