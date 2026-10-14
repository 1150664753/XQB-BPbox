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

export type ConnectionTransport =
  | "mock"
  | "p2p"
  | "turn-relay"
  | "turn-udp"
  | "turn-tcp"
  | "unknown";

export interface ConnectionSnapshot {
  state: ConnectionState;
  transport: ConnectionTransport;
  reason: string | null;
}

export interface RemoteConnectionError {
  code: string;
  message: string;
  recoverable: boolean;
  assetId?: string;
}

export interface RemoteBpConnectionEvents {
  assetTransfersReset: undefined;
  connectionStateChanged: ConnectionSnapshot;
  bpStateReceived: RemoteBpState;
  bpStateUpdated: RemoteBpState;
  actionResult: BpActionResult;
  assetManifestReceived: AssetManifest;
  assetReceived: ReceivedAsset;
  error: RemoteConnectionError;
}
