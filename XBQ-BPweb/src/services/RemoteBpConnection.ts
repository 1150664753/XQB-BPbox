import type { BpAction, PlayerSide } from "../types/bp";
import type {
  ConnectionSnapshot,
  RemoteBpConnectionEvents,
} from "../types/connection";

export interface RemoteBpConnectOptions {
  roomId: string;
  side: PlayerSide;
  clientId: string;
  displayName?: string;
  lastKnownRevision?: number;
}

export interface RemoteBpConnectResult {
  roomId: string;
  sessionId: string;
  assignedSide: PlayerSide;
}

export type ConnectionEventListener<TPayload> = (payload: TPayload) => void;
export type Unsubscribe = () => void;

/**
 * UI-facing transport boundary. Implementations own signaling/DataChannel details;
 * React pages only call this semantic BP API.
 */
export interface RemoteBpConnection {
  connect(options: RemoteBpConnectOptions): Promise<RemoteBpConnectResult>;
  disconnect(): Promise<void>;
  sendAction(action: BpAction): Promise<void>;
  requestState(lastKnownRevision?: number): Promise<void>;
  requestAssets(assetIds: string[]): Promise<void>;
  getSnapshot(): ConnectionSnapshot;
  on<K extends keyof RemoteBpConnectionEvents>(
    event: K,
    listener: ConnectionEventListener<RemoteBpConnectionEvents[K]>,
  ): Unsubscribe;
}
