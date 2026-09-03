import type { AssetId } from "./assets";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export type PlayerSide = "first" | "second";
export type PlayerConnectionState =
  | "empty"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected";
export type InternalBpSide = "star" | "rail";
export interface RemoteSideMapping {
  first: InternalBpSide;
  second: InternalBpSide;
}
export type RemoteBpStatus = "waiting" | "running" | "complete" | "paused";
export type RemoteBpPhase =
  | "WAITING"
  | "BAN"
  | "PICK"
  | "PROTECT"
  | "BORROW"
  | "COMPLETE";
export type RemoteBpOperation =
  | "BAN"
  | "PICK"
  | "SELECT"
  | "DESELECT"
  | "CONFIRM"
  | "PROTECT"
  | "BORROW"
  | "WAIT";

/**
 * Character DTO sent over the network. `avatar` and `portrait` are asset IDs,
 * never local paths from XQB-BPbox. Only player-visible identity/attribute fields
 * plus the operational flags required by the BP flow are exposed.
 */
export interface RemoteCharacterDto {
  id: string;
  name: string;
  avatar: AssetId | null;
  portrait: AssetId | null;
  element: string | null;
  path: string | null;
  enabled: boolean;
  selected: boolean;
  selectedBy: PlayerSide | null;
  banned: boolean;
  picked: boolean;
}

export interface RemoteLightConeDto {
  id: string;
  name: string;
  image: AssetId | null;
  path: string | null;
  enabled: boolean;
  selected: boolean;
  selectedBy: PlayerSide | null;
  banned: boolean;
  picked: boolean;
}

export interface RemoteBpStep {
  id: string;
  index: number;
  total: number;
  label: string;
  targetType?: "CHARACTER" | "LIGHT_CONE" | "NONE";
}

export interface RemoteBpTeam {
  side: PlayerSide;
  name: string;
  shortName?: string;
}

export interface RemoteBpCountdown {
  durationMs: number;
  remainingMs: number;
  serverTime: string;
  running: boolean;
}

export interface RemoteBpResultEntry {
  characterId: string;
  side: PlayerSide;
  stepIndex: number;
}

export interface RemoteLightConeResultEntry {
  lightConeId: string;
  side: PlayerSide;
  stepIndex: number;
}

/** A deliberately small, versioned projection of the host's internal BP state. */
export interface RemoteBpState {
  schemaVersion: 1;
  revision: number;
  sessionId: string;
  roomId: string;
  flowName: string;
  status: RemoteBpStatus;
  phase: RemoteBpPhase;
  currentActor: PlayerSide | null;
  currentOperation: RemoteBpOperation;
  waitingForHost: boolean;
  currentStep: RemoteBpStep | null;
  playerConnections: Record<PlayerSide, PlayerConnectionState>;
  sideMapping: RemoteSideMapping;
  teams: Record<PlayerSide, RemoteBpTeam>;
  characters: RemoteCharacterDto[];
  lightCones: RemoteLightConeDto[];
  bans: RemoteBpResultEntry[];
  picks: RemoteBpResultEntry[];
  lightConeBans: RemoteLightConeResultEntry[];
  lightConePicks: RemoteLightConeResultEntry[];
  protections: RemoteBpResultEntry[];
  borrows: RemoteBpResultEntry[];
  selections: Record<PlayerSide, string | null>;
  selectionTargets: Record<PlayerSide, BpActionTarget | null>;
  confirmedSides: Record<PlayerSide, boolean>;
  availableCharacterIds: string[];
  unavailableCharacterIds: string[];
  availableLightConeIds: string[];
  unavailableLightConeIds: string[];
  availableTargetIdsBySide: Record<PlayerSide, string[]>;
  canConfirm: boolean;
  canConfirmBySide: Record<PlayerSide, boolean>;
  countdown: RemoteBpCountdown | null;
  updatedAt: string;
}

export type BpActionKind =
  | "SELECT"
  | "DESELECT"
  | "BAN"
  | "PICK"
  | "CONFIRM"
  | "PROTECT"
  | "BORROW"
  | "CUSTOM";

export interface BpActionTarget {
  kind: "CHARACTER" | "LIGHT_CONE";
  id: string;
  side?: PlayerSide;
}

interface BpActionBase {
  actionId: string;
  actorSide: PlayerSide;
  expectedRevision: number;
  stepIndex: number | null;
  createdAt: string;
}

export type BpAction =
  | (BpActionBase & {
      kind: "SELECT" | "BAN" | "PICK";
      targets: [BpActionTarget];
    })
  | (BpActionBase & {
      kind: "DESELECT" | "CONFIRM";
      targets: [];
    })
  | (BpActionBase & {
      kind: "PROTECT" | "BORROW";
      targets: [BpActionTarget, BpActionTarget];
    })
  | (BpActionBase & {
      kind: "CUSTOM";
      targets: BpActionTarget[];
      extension: {
        name: string;
        data: JsonObject;
      };
    });

export interface BpActionResult {
  actionId: string;
  accepted: boolean;
  code:
    | "OK"
    | "NOT_YOUR_TURN"
    | "INVALID_ACTION"
    | "INVALID_TARGET"
    | "CHARACTER_UNAVAILABLE"
    | "REVISION_CONFLICT"
    | "STALE_REVISION"
    | "ALREADY_PROCESSED"
    | "DUPLICATE_REQUEST"
    | "INVALID_SLOT"
    | "BP_NOT_STARTED"
    | "UNSUPPORTED_ACTION"
    | "SESSION_NOT_READY";
  message: string;
  reason?: string;
  resultingRevision: number;
  appliedRevision?: number;
  stateChanged: boolean;
}
