import type { AssetManifest, AssetManifestEntry } from "../types/assets";
import type {
  BpAction,
  BpActionResult,
  PlayerSide,
  RemoteBpState,
} from "../types/bp";
import {
  CLIENT_MESSAGE_TYPES,
  HOST_MESSAGE_TYPES,
  PROTOCOL_VERSION,
  type ClientMessageType,
  type HostMessageType,
  type ProtocolMessageType,
} from "./constants";

export interface ProtocolEnvelope<TType extends ProtocolMessageType, TPayload> {
  type: TType;
  protocolVersion: typeof PROTOCOL_VERSION;
  messageId: string;
  requestId?: string;
  sentAt: string;
  payload: TPayload;
}

export interface ClientPayloadMap {
  [CLIENT_MESSAGE_TYPES.HELLO]: {
    clientId: string;
    clientName: string;
    supportedProtocolVersions: string[];
    capabilities: string[];
  };
  [CLIENT_MESSAGE_TYPES.JOIN]: {
    roomId: string;
    side: PlayerSide;
    lastKnownRevision?: number;
  };
  [CLIENT_MESSAGE_TYPES.ACTION_REQUEST]: { action: BpAction };
  [CLIENT_MESSAGE_TYPES.STATE_REQUEST]: { lastKnownRevision?: number };
  [CLIENT_MESSAGE_TYPES.ASSET_REQUEST]: { assetIds: string[] };
  [CLIENT_MESSAGE_TYPES.PING]: { clientTime: string };
}

export interface HostPayloadMap {
  [HOST_MESSAGE_TYPES.WELCOME]: {
    sessionId: string;
    roomId: string;
    assignedSide: PlayerSide;
    capabilities: string[];
  };
  [HOST_MESSAGE_TYPES.INITIAL_STATE]: { state: RemoteBpState };
  [HOST_MESSAGE_TYPES.STATE_UPDATE]: {
    state: RemoteBpState;
    previousRevision?: number;
  };
  [HOST_MESSAGE_TYPES.ACTION_RESULT]: BpActionResult;
  [HOST_MESSAGE_TYPES.ASSET_MANIFEST]: { manifest: AssetManifest };
  [HOST_MESSAGE_TYPES.ASSET_START]: {
    transferId: string;
    asset: AssetManifestEntry;
    chunkSize: number;
    totalChunks: number;
  };
  [HOST_MESSAGE_TYPES.ASSET_CHUNK]: {
    transferId: string;
    assetId: string;
    index: number;
    total: number;
    data: string;
  };
  [HOST_MESSAGE_TYPES.ASSET_COMPLETE]: {
    transferId: string;
    assetId: string;
    hash: string;
    totalBytes: number;
  };
  [HOST_MESSAGE_TYPES.PONG]: {
    clientTime: string;
    hostTime: string;
  };
  [HOST_MESSAGE_TYPES.KICKED]: { message: string };
  [HOST_MESSAGE_TYPES.ROOM_CLOSED]: { message: string };
  [HOST_MESSAGE_TYPES.ERROR]: {
    code: string;
    message: string;
    requestId?: string;
    recoverable: boolean;
    assetId?: string;
  };
}

export type ClientMessage = {
  [K in ClientMessageType]: ProtocolEnvelope<K, ClientPayloadMap[K]>;
}[ClientMessageType];

export type HostMessage = {
  [K in HostMessageType]: ProtocolEnvelope<K, HostPayloadMap[K]>;
}[HostMessageType];

export function createMessageId(): string {
  if (typeof globalThis.crypto.randomUUID === "function")
    return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes]
    .map((item) => item.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createEnvelope<TType extends ProtocolMessageType, TPayload>(
  type: TType,
  payload: TPayload,
  requestId?: string,
): ProtocolEnvelope<TType, TPayload> {
  return {
    type,
    protocolVersion: PROTOCOL_VERSION,
    messageId: createMessageId(),
    ...(requestId ? { requestId } : {}),
    sentAt: new Date().toISOString(),
    payload,
  };
}
