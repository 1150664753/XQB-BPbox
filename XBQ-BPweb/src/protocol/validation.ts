import type { AssetManifest, AssetManifestEntry } from "../types/assets";
import type {
  BpActionResult,
  PlayerConnectionState,
  PlayerSide,
  RemoteBpState,
} from "../types/bp";
import { PROTOCOL_VERSION } from "./constants";

export const MAX_REMOTE_BP_MESSAGE_BYTES = 512 * 1024;
export const MAX_REMOTE_ASSET_BYTES = 64 * 1024 * 1024;
export const MAX_REMOTE_ASSET_CHUNK_BYTES = 128 * 1024;
const MAX_BASE64_CHUNK_LENGTH = Math.ceil(MAX_REMOTE_ASSET_CHUNK_BYTES / 3) * 4;
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/apng",
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export type ValidatedHostMessage =
  | { type: "INITIAL_STATE"; payload: { state: RemoteBpState } }
  | { type: "STATE_UPDATE"; payload: { state: RemoteBpState } }
  | { type: "ACTION_RESULT"; payload: BpActionResult }
  | { type: "ASSET_MANIFEST"; payload: { manifest: AssetManifest } }
  | {
      type: "ASSET_START";
      payload: {
        transferId: string;
        asset: AssetManifestEntry;
        chunkSize: number;
        totalChunks: number;
      };
    }
  | {
      type: "ASSET_CHUNK";
      payload: {
        transferId: string;
        assetId: string;
        index: number;
        total: number;
        data: string;
      };
    }
  | {
      type: "ASSET_COMPLETE";
      payload: {
        transferId: string;
        assetId: string;
        hash: string;
        totalBytes: number;
      };
    }
  | { type: "PONG"; payload: { clientTime: string; hostTime: string } }
  | { type: "KICKED"; payload: { message: string } }
  | { type: "ROOM_CLOSED"; payload: { message: string } }
  | {
      type: "ERROR";
      payload: {
        code: string;
        message: string;
        recoverable: boolean;
        assetId?: string;
      };
    };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown, min = 1, max = 256): value is string {
  return (
    typeof value === "string" && value.length >= min && value.length <= max
  );
}

function isInteger(
  value: unknown,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): value is number {
  return (
    Number.isInteger(value) && Number(value) >= min && Number(value) <= max
  );
}

function isIsoDate(value: unknown): value is string {
  return isString(value, 10, 64) && Number.isFinite(Date.parse(value));
}

function isSide(value: unknown): value is PlayerSide {
  return value === "first" || value === "second";
}

function isPlayerConnectionState(
  value: unknown,
): value is PlayerConnectionState {
  return [
    "empty",
    "connecting",
    "connected",
    "reconnecting",
    "disconnected",
  ].includes(String(value));
}

function isNullableString(value: unknown, max = 256): value is string | null {
  return value === null || isString(value, 1, max);
}

function isStringArray(value: unknown, maxItems = 2_000): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maxItems &&
    value.every((item) => isString(item, 1, 128))
  );
}

function isResultArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= 2_000 &&
    value.every(
      (entry) =>
        isObject(entry) &&
        isString(entry.characterId, 1, 128) &&
        isSide(entry.side) &&
        isInteger(entry.stepIndex, 0, 100_000),
    )
  );
}

function isLightConeResultArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= 2_000 &&
    value.every(
      (entry) =>
        isObject(entry) &&
        isString(entry.lightConeId, 1, 128) &&
        isSide(entry.side) &&
        isInteger(entry.stepIndex, 0, 100_000),
    )
  );
}

function isSelectionTarget(value: unknown): boolean {
  return (
    value === null ||
    (isObject(value) &&
      ["CHARACTER", "LIGHT_CONE"].includes(String(value.kind)) &&
      isString(value.id, 1, 128) &&
      (value.side === undefined || isSide(value.side)))
  );
}

function parseState(value: unknown): RemoteBpState | null {
  if (!isObject(value) || value.schemaVersion !== 1) return null;
  if (!isInteger(value.revision, 0, 1_000_000_000)) return null;
  if (!isString(value.sessionId, 1, 128) || !isString(value.roomId, 1, 32))
    return null;
  if (!isString(value.flowName, 1, 256) || !isIsoDate(value.updatedAt))
    return null;
  if (
    !["waiting", "running", "complete", "paused"].includes(String(value.status))
  )
    return null;
  const waitingForHost = value.waitingForHost === true;
  let playerConnections: RemoteBpState["playerConnections"] = {
    first: "disconnected",
    second: "disconnected",
  };
  if (isObject(value.playerConnections)) {
    if (
      !isPlayerConnectionState(value.playerConnections.first) ||
      !isPlayerConnectionState(value.playerConnections.second)
    ) {
      return null;
    }
    playerConnections = {
      first: value.playerConnections.first,
      second: value.playerConnections.second,
    };
  }
  if (
    !["WAITING", "BAN", "PICK", "PROTECT", "BORROW", "COMPLETE"].includes(
      String(value.phase),
    )
  )
    return null;
  if (value.currentActor !== null && !isSide(value.currentActor)) return null;
  if (
    ![
      "BAN",
      "PICK",
      "SELECT",
      "DESELECT",
      "CONFIRM",
      "PROTECT",
      "BORROW",
      "WAIT",
    ].includes(String(value.currentOperation))
  )
    return null;

  if (value.currentStep !== null) {
    if (!isObject(value.currentStep)) return null;
    if (
      !isString(value.currentStep.id, 1, 128) ||
      !isString(value.currentStep.label, 1, 256)
    )
      return null;
    if (
      !isInteger(value.currentStep.index, 0, 100_000) ||
      !isInteger(value.currentStep.total, 0, 100_000)
    )
      return null;
    if (
      value.currentStep.targetType !== undefined &&
      !["CHARACTER", "LIGHT_CONE", "NONE"].includes(
        String(value.currentStep.targetType),
      )
    )
      return null;
  }

  if (!isObject(value.sideMapping)) return null;
  const firstMapping = value.sideMapping.first;
  const secondMapping = value.sideMapping.second;
  if (
    !["star", "rail"].includes(String(firstMapping)) ||
    !["star", "rail"].includes(String(secondMapping))
  )
    return null;
  if (firstMapping === secondMapping) return null;

  if (!isObject(value.teams)) return null;
  for (const side of ["first", "second"] as const) {
    const team = value.teams[side];
    if (!isObject(team) || team.side !== side || !isString(team.name, 1, 128))
      return null;
    if (team.shortName !== undefined && !isString(team.shortName, 1, 32))
      return null;
  }

  if (!Array.isArray(value.characters) || value.characters.length > 2_000)
    return null;
  for (const character of value.characters) {
    if (!isObject(character)) return null;
    if (!isString(character.id, 1, 128) || !isString(character.name, 1, 128))
      return null;
    if (
      !isNullableString(character.avatar) ||
      !isNullableString(character.portrait)
    )
      return null;
    if (
      !isNullableString(character.element, 128) ||
      !isNullableString(character.path, 128)
    )
      return null;
    if (
      typeof character.enabled !== "boolean" ||
      typeof character.selected !== "boolean"
    )
      return null;
    if (character.selectedBy !== null && !isSide(character.selectedBy))
      return null;
    if (
      typeof character.banned !== "boolean" ||
      typeof character.picked !== "boolean"
    )
      return null;
  }

  if (!Array.isArray(value.lightCones) || value.lightCones.length > 2_000)
    return null;
  for (const lightCone of value.lightCones) {
    if (!isObject(lightCone)) return null;
    if (!isString(lightCone.id, 1, 128) || !isString(lightCone.name, 1, 128))
      return null;
    if (
      !isNullableString(lightCone.image) ||
      !isNullableString(lightCone.path, 128)
    )
      return null;
    if (
      typeof lightCone.enabled !== "boolean" ||
      typeof lightCone.selected !== "boolean"
    )
      return null;
    if (lightCone.selectedBy !== null && !isSide(lightCone.selectedBy))
      return null;
    if (
      typeof lightCone.banned !== "boolean" ||
      typeof lightCone.picked !== "boolean"
    )
      return null;
  }

  if (!isResultArray(value.bans) || !isResultArray(value.picks)) return null;
  if (
    !isLightConeResultArray(value.lightConeBans) ||
    !isLightConeResultArray(value.lightConePicks)
  )
    return null;
  if (!isResultArray(value.protections) || !isResultArray(value.borrows))
    return null;
  if (!isObject(value.selections)) return null;
  if (
    !isNullableString(value.selections.first, 128) ||
    !isNullableString(value.selections.second, 128)
  )
    return null;
  if (
    !isObject(value.selectionTargets) ||
    !isSelectionTarget(value.selectionTargets.first) ||
    !isSelectionTarget(value.selectionTargets.second)
  )
    return null;
  if (
    !isObject(value.confirmedSides) ||
    typeof value.confirmedSides.first !== "boolean" ||
    typeof value.confirmedSides.second !== "boolean"
  )
    return null;
  if (
    !isStringArray(value.availableCharacterIds) ||
    !isStringArray(value.unavailableCharacterIds) ||
    !isStringArray(value.availableLightConeIds) ||
    !isStringArray(value.unavailableLightConeIds)
  )
    return null;
  if (
    !isObject(value.availableTargetIdsBySide) ||
    !isStringArray(value.availableTargetIdsBySide.first) ||
    !isStringArray(value.availableTargetIdsBySide.second)
  )
    return null;
  if (typeof value.canConfirm !== "boolean") return null;
  if (
    !isObject(value.canConfirmBySide) ||
    typeof value.canConfirmBySide.first !== "boolean" ||
    typeof value.canConfirmBySide.second !== "boolean"
  )
    return null;

  if (value.countdown !== null) {
    if (!isObject(value.countdown)) return null;
    if (
      !isInteger(value.countdown.durationMs, 0, 86_400_000) ||
      !isInteger(value.countdown.remainingMs, 0, 86_400_000)
    )
      return null;
    if (
      !isIsoDate(value.countdown.serverTime) ||
      typeof value.countdown.running !== "boolean"
    )
      return null;
  }
  return {
    ...(value as unknown as RemoteBpState),
    waitingForHost,
    playerConnections,
  };
}

function parseActionResult(value: unknown): BpActionResult | null {
  if (!isObject(value) || !isString(value.actionId, 1, 128)) return null;
  if (
    typeof value.accepted !== "boolean" ||
    typeof value.stateChanged !== "boolean"
  )
    return null;
  const codes: BpActionResult["code"][] = [
    "OK",
    "NOT_YOUR_TURN",
    "INVALID_ACTION",
    "INVALID_TARGET",
    "CHARACTER_UNAVAILABLE",
    "REVISION_CONFLICT",
    "STALE_REVISION",
    "ALREADY_PROCESSED",
    "DUPLICATE_REQUEST",
    "INVALID_SLOT",
    "BP_NOT_STARTED",
    "UNSUPPORTED_ACTION",
    "SESSION_NOT_READY",
  ];
  if (!codes.includes(value.code as BpActionResult["code"])) return null;
  if (
    !isString(value.message, 1, 512) ||
    !isInteger(value.resultingRevision, 0, 1_000_000_000)
  )
    return null;
  if (value.reason !== undefined && !isString(value.reason, 1, 512))
    return null;
  if (
    value.appliedRevision !== undefined &&
    !isInteger(value.appliedRevision, 0, 1_000_000_000)
  )
    return null;
  return value as unknown as BpActionResult;
}

function parseAssetEntry(value: unknown): AssetManifestEntry | null {
  if (!isObject(value) || !isString(value.assetId, 1, 256)) return null;
  if (!["avatar", "portrait", "light-cone"].includes(String(value.type)))
    return null;
  if (!isString(value.hash, 64, 64) || !/^[a-f0-9]{64}$/i.test(value.hash))
    return null;
  if (!isInteger(value.size, 1, MAX_REMOTE_ASSET_BYTES)) return null;
  if (
    !isString(value.mimeType, 1, 128) ||
    !ALLOWED_IMAGE_MIME_TYPES.has(value.mimeType)
  ) {
    return null;
  }
  if (value.characterId !== undefined && !isString(value.characterId, 1, 128))
    return null;
  if (value.lightConeId !== undefined && !isString(value.lightConeId, 1, 128))
    return null;
  if (value.ownerId !== undefined && !isString(value.ownerId, 1, 128))
    return null;
  return value as unknown as AssetManifestEntry;
}

function parseManifest(value: unknown): AssetManifest | null {
  if (
    !isObject(value) ||
    !isInteger(value.revision, 0, 1_000_000_000) ||
    !isIsoDate(value.generatedAt)
  )
    return null;
  if (!Array.isArray(value.assets) || value.assets.length > 10_000) return null;
  const assets: AssetManifestEntry[] = [];
  for (const item of value.assets) {
    const parsed = parseAssetEntry(item);
    if (!parsed) return null;
    assets.push(parsed);
  }
  return { revision: value.revision, generatedAt: value.generatedAt, assets };
}

export function parseHostMessage(raw: string): ValidatedHostMessage {
  if (new TextEncoder().encode(raw).byteLength > MAX_REMOTE_BP_MESSAGE_BYTES) {
    throw new Error("MESSAGE_TOO_LARGE");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("INVALID_JSON");
  }
  if (!isObject(value) || value.protocolVersion !== PROTOCOL_VERSION)
    throw new Error("INVALID_ENVELOPE");
  if (
    !isString(value.messageId, 1, 128) ||
    !isIsoDate(value.sentAt) ||
    !isObject(value.payload)
  ) {
    throw new Error("INVALID_ENVELOPE");
  }

  switch (value.type) {
    case "INITIAL_STATE":
    case "STATE_UPDATE": {
      const state = parseState(value.payload.state);
      if (!state) throw new Error("INVALID_BP_STATE");
      return { type: value.type, payload: { state } };
    }
    case "ACTION_RESULT": {
      const result = parseActionResult(value.payload);
      if (!result) throw new Error("INVALID_ACTION_RESULT");
      return { type: "ACTION_RESULT", payload: result };
    }
    case "ASSET_MANIFEST": {
      const manifest = parseManifest(value.payload.manifest);
      if (!manifest) throw new Error("INVALID_ASSET_MANIFEST");
      return { type: "ASSET_MANIFEST", payload: { manifest } };
    }
    case "ASSET_START": {
      const asset = parseAssetEntry(value.payload.asset);
      if (
        !isString(value.payload.transferId, 1, 128) ||
        !asset ||
        !isInteger(value.payload.chunkSize, 1, MAX_REMOTE_ASSET_CHUNK_BYTES) ||
        !isInteger(value.payload.totalChunks, 1, 1_000_000)
      ) {
        throw new Error("INVALID_ASSET_START");
      }
      return {
        type: "ASSET_START",
        payload: {
          transferId: value.payload.transferId,
          asset,
          chunkSize: value.payload.chunkSize,
          totalChunks: value.payload.totalChunks,
        },
      };
    }
    case "ASSET_CHUNK":
      if (
        !isString(value.payload.transferId, 1, 128) ||
        !isString(value.payload.assetId, 1, 256) ||
        !isInteger(value.payload.index, 0, 1_000_000) ||
        !isInteger(value.payload.total, 1, 1_000_000) ||
        !isString(value.payload.data, 1, MAX_BASE64_CHUNK_LENGTH)
      ) {
        throw new Error("INVALID_ASSET_CHUNK");
      }
      return {
        type: "ASSET_CHUNK",
        payload: {
          transferId: value.payload.transferId,
          assetId: value.payload.assetId,
          index: value.payload.index,
          total: value.payload.total,
          data: value.payload.data,
        },
      };
    case "ASSET_COMPLETE":
      if (
        !isString(value.payload.transferId, 1, 128) ||
        !isString(value.payload.assetId, 1, 256) ||
        !isString(value.payload.hash, 64, 64) ||
        !/^[a-f0-9]{64}$/i.test(value.payload.hash) ||
        !isInteger(value.payload.totalBytes, 1, MAX_REMOTE_ASSET_BYTES)
      ) {
        throw new Error("INVALID_ASSET_COMPLETE");
      }
      return {
        type: "ASSET_COMPLETE",
        payload: {
          transferId: value.payload.transferId,
          assetId: value.payload.assetId,
          hash: value.payload.hash,
          totalBytes: value.payload.totalBytes,
        },
      };
    case "PONG":
      if (
        !isIsoDate(value.payload.clientTime) ||
        !isIsoDate(value.payload.hostTime)
      )
        throw new Error("INVALID_PONG");
      return {
        type: "PONG",
        payload: {
          clientTime: value.payload.clientTime,
          hostTime: value.payload.hostTime,
        },
      };
    case "KICKED":
    case "ROOM_CLOSED":
      if (!isString(value.payload.message, 1, 512)) {
        throw new Error(`INVALID_${value.type}`);
      }
      return { type: value.type, payload: { message: value.payload.message } };
    case "ERROR":
      if (
        !isString(value.payload.code, 1, 64) ||
        !isString(value.payload.message, 1, 512)
      ) {
        throw new Error("INVALID_ERROR");
      }
      return {
        type: "ERROR",
        payload: {
          code: value.payload.code,
          message: value.payload.message,
          recoverable:
            value.payload.recoverable === undefined
              ? true
              : value.payload.recoverable === true,
          ...(isString(value.payload.assetId, 1, 256)
            ? { assetId: value.payload.assetId }
            : {}),
        },
      };
    default:
      throw new Error("UNKNOWN_MESSAGE_TYPE");
  }
}
