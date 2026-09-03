import type { AssetManifest, ReceivedAsset } from "./assets";
import type { BpActionResult, RemoteBpState } from "./bp";

export type ConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "failed"
  | "kicked"
  | "room-closed";

export type ConnectionTransport = "mock" | "p2p" | "turn-relay" | "unknown";

export interface ConnectionSnapshot {
  state: ConnectionState;
  transport: ConnectionTransport;
  latencyMs: number | null;
  lastPingAt: string | null;
  reason: string | null;
}

export interface RemoteConnectionError {
  code: string;
  message: string;
  recoverable: boolean;
  assetId?: string;
}

export interface RemoteBpConnectionEvents {
  connectionStateChanged: ConnectionSnapshot;
  bpStateReceived: RemoteBpState;
  bpStateUpdated: RemoteBpState;
  actionResult: BpActionResult;
  assetManifestReceived: AssetManifest;
  assetReceived: ReceivedAsset;
  error: RemoteConnectionError;
}
