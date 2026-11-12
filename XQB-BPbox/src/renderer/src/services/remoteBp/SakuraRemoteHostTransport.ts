import type {
  RemoteHostTransport,
  RemoteHostPeer,
  RemoteHostIncomingMessage,
  RemoteHostOutgoingMessage,
  RemoteHostTransportStatus,
  RemoteHostTransportStartResult
} from '../../../../shared/remoteBp/transport'
import type { SakuraAPI } from '../../../../shared/sakura'

export class SakuraRemoteHostTransport implements RemoteHostTransport {
  readonly kind = 'sakura' as const
  private roomId: string | null = null
  private unsubscribers: Array<() => void> = []
  private messages = new Set<(message: RemoteHostIncomingMessage) => void>()
  private statuses = new Set<(status: RemoteHostTransportStatus) => void>()
  private peers = {
    connected: new Set<(peer: RemoteHostPeer) => void>(),
    connecting: new Set<(peer: RemoteHostPeer) => void>(),
    reconnecting: new Set<(peer: RemoteHostPeer) => void>(),
    disconnected: new Set<(peer: RemoteHostPeer) => void>()
  }
  constructor(private readonly api: SakuraAPI) {}
  getConnectionPath(): string {
    return 'sakura'
  }
  async start(): Promise<RemoteHostTransportStartResult> {
    if (this.roomId) await this.stop()
    this.unsubscribers = [
      this.api.onEvent((event) => {
        if (event.roomId !== this.roomId) return
        if (event.type === 'message') this.messages.forEach((listener) => listener(event.message))
        else this.peers[event.type].forEach((listener) => listener(event.peer))
      }),
      this.api.onStatus((status) => {
        if (!this.roomId || status.roomId !== this.roomId) return
        this.statuses.forEach((listener) =>
          listener({
            connectionState:
              status.service === 'failed'
                ? 'failed'
                : status.publicConnection === 'verified'
                  ? 'connected'
                  : status.publicConnection === 'failed'
                    ? 'disconnected'
                    : 'connecting',
            error: status.error,
            invitationLink: status.invitationLink
          })
        )
      })
    ]
    try {
      const result = await this.api.start()
      this.roomId = result.roomId
      const status = await this.api.status()
      return {
        ...result,
        connectionState:
          status.publicConnection === 'verified'
            ? 'connected'
            : status.publicConnection === 'failed'
              ? 'disconnected'
              : 'connecting',
        error: status.error
      }
    } catch (error) {
      this.unsubscribers.forEach((unsubscribe) => unsubscribe())
      this.unsubscribers = []
      throw error
    }
  }
  async stop(): Promise<void> {
    this.roomId = null
    this.unsubscribers.forEach((unsubscribe) => unsubscribe())
    this.unsubscribers = []
    await this.api.stop()
  }
  async kick(side: 'first' | 'second'): Promise<void> {
    if (this.roomId) await this.api.kick(this.roomId, side)
  }
  async send(peerId: string, message: RemoteHostOutgoingMessage): Promise<void> {
    if (!this.roomId) return
    try {
      await this.api.send(this.roomId, peerId, message)
    } catch (error) {
      // Control failures are represented by connection events; asset queues must cancel.
      if (message.type.startsWith('ASSET_')) throw error
    }
  }
  async broadcast(message: RemoteHostOutgoingMessage): Promise<void> {
    if (this.roomId) await this.api.send(this.roomId, null, message).catch(() => undefined)
  }
  onMessage(listener: (message: RemoteHostIncomingMessage) => void): () => void {
    this.messages.add(listener)
    return () => this.messages.delete(listener)
  }
  onStatusChange(listener: (status: RemoteHostTransportStatus) => void): () => void {
    this.statuses.add(listener)
    return () => this.statuses.delete(listener)
  }
  onPeerConnected(listener: (peer: RemoteHostPeer) => void): () => void {
    this.peers.connected.add(listener)
    return () => this.peers.connected.delete(listener)
  }
  onPeerConnecting(listener: (peer: RemoteHostPeer) => void): () => void {
    this.peers.connecting.add(listener)
    return () => this.peers.connecting.delete(listener)
  }
  onPeerReconnecting(listener: (peer: RemoteHostPeer) => void): () => void {
    this.peers.reconnecting.add(listener)
    return () => this.peers.reconnecting.delete(listener)
  }
  onPeerDisconnected(listener: (peer: RemoteHostPeer) => void): () => void {
    this.peers.disconnected.add(listener)
    return () => this.peers.disconnected.delete(listener)
  }
}
