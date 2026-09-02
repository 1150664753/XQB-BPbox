import type {
  AssetManifest,
  AssetManifestEntry,
  RemoteBpAction,
  RemoteBpActionResult,
  RemoteBpRoomState,
  RemoteBpState,
  RemotePlayerSide
} from './types'

export type RemoteHostIncomingMessage =
  | {
      type: 'ACTION_REQUEST'
      peerId: string
      side: RemotePlayerSide
      action: RemoteBpAction
    }
  | {
      type: 'STATE_REQUEST'
      peerId: string
      side: RemotePlayerSide
      lastKnownRevision?: number
    }
  | {
      type: 'ASSET_REQUEST'
      peerId: string
      side: RemotePlayerSide
      assetIds: string[]
    }
  | {
      type: 'PING'
      peerId: string
      side: RemotePlayerSide
      clientTime: string
    }

export type RemoteHostOutgoingMessage =
  | { type: 'INITIAL_STATE'; payload: { state: RemoteBpState } }
  | { type: 'STATE_UPDATE'; payload: { state: RemoteBpState } }
  | { type: 'ACTION_RESULT'; payload: RemoteBpActionResult }
  | { type: 'ASSET_MANIFEST'; payload: { manifest: AssetManifest } }
  | {
      type: 'ASSET_START'
      payload: {
        transferId: string
        asset: AssetManifestEntry
        chunkSize: number
        totalChunks: number
      }
    }
  | {
      type: 'ASSET_CHUNK'
      payload: {
        transferId: string
        assetId: string
        index: number
        total: number
        data: string
      }
    }
  | {
      type: 'ASSET_COMPLETE'
      payload: { transferId: string; assetId: string; hash: string; totalBytes: number }
    }
  | { type: 'PONG'; payload: { clientTime: string; hostTime: string } }
  | {
      type: 'ERROR'
      payload: { code: string; message: string; recoverable?: boolean; assetId?: string }
    }

export interface RemoteHostPeer {
  peerId: string
  side: RemotePlayerSide
  displayName?: string
}

export interface RemoteHostTransportStartResult {
  roomId: string
  createdAt?: string
  expiresAt?: string
  connectionState?: RemoteBpRoomState['connectionState']
}

export interface RemoteHostTransportStatus {
  connectionState: RemoteBpRoomState['connectionState']
  error?: string | null
}

export interface RemoteHostTransport {
  readonly kind: 'mock' | 'webrtc'
  start(room: RemoteBpRoomState): Promise<RemoteHostTransportStartResult | void>
  stop(): Promise<void>
  send(peerId: string, message: RemoteHostOutgoingMessage): Promise<void>
  broadcast(message: RemoteHostOutgoingMessage): Promise<void>
  onMessage(listener: (message: RemoteHostIncomingMessage) => void): () => void
  onPeerConnected(listener: (peer: RemoteHostPeer) => void): () => void
  onPeerDisconnected(listener: (peer: RemoteHostPeer) => void): () => void
  onStatusChange(listener: (status: RemoteHostTransportStatus) => void): () => void
}

export class MockRemoteHostTransport implements RemoteHostTransport {
  readonly kind = 'mock' as const
  readonly sent: Array<{ peerId: string; message: RemoteHostOutgoingMessage }> = []
  readonly broadcasts: RemoteHostOutgoingMessage[] = []
  private readonly messageListeners = new Set<(message: RemoteHostIncomingMessage) => void>()
  private readonly connectedListeners = new Set<(peer: RemoteHostPeer) => void>()
  private readonly disconnectedListeners = new Set<(peer: RemoteHostPeer) => void>()
  private readonly statusListeners = new Set<(status: RemoteHostTransportStatus) => void>()
  private active = false

  async start(): Promise<void> {
    this.active = true
    this.statusListeners.forEach((listener) => listener({ connectionState: 'mock-active' }))
  }

  async stop(): Promise<void> {
    this.active = false
    this.statusListeners.forEach((listener) => listener({ connectionState: 'offline' }))
  }

  async send(peerId: string, message: RemoteHostOutgoingMessage): Promise<void> {
    if (!this.active) throw new Error('Mock transport is not active')
    this.sent.push({ peerId, message })
  }

  async broadcast(message: RemoteHostOutgoingMessage): Promise<void> {
    if (!this.active) throw new Error('Mock transport is not active')
    this.broadcasts.push(message)
  }

  onMessage(listener: (message: RemoteHostIncomingMessage) => void): () => void {
    this.messageListeners.add(listener)
    return () => this.messageListeners.delete(listener)
  }

  onPeerConnected(listener: (peer: RemoteHostPeer) => void): () => void {
    this.connectedListeners.add(listener)
    return () => this.connectedListeners.delete(listener)
  }

  onPeerDisconnected(listener: (peer: RemoteHostPeer) => void): () => void {
    this.disconnectedListeners.add(listener)
    return () => this.disconnectedListeners.delete(listener)
  }

  onStatusChange(listener: (status: RemoteHostTransportStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  simulateMessage(message: RemoteHostIncomingMessage): void {
    this.messageListeners.forEach((listener) => listener(message))
  }

  simulatePeerConnected(peer: RemoteHostPeer): void {
    this.connectedListeners.forEach((listener) => listener(peer))
  }

  simulatePeerDisconnected(peer: RemoteHostPeer): void {
    this.disconnectedListeners.forEach((listener) => listener(peer))
  }
}
