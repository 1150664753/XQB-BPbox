import type {
  RemoteHostTransport,
  RemoteHostPeer,
  RemoteHostIncomingMessage,
  RemoteHostOutgoingMessage,
  RemoteHostTransportStatus,
  RemoteHostTransportStartResult
} from '../../../../shared/remoteBp/transport'
import type { RemoteBpRoomState } from '../../../../shared/remoteBp/types'

/** Stable subscription boundary. Mode changes are allowed only after the old room has stopped. */
export class SelectableRemoteHostTransport implements RemoteHostTransport {
  private transport: RemoteHostTransport
  private subscriptions: Array<() => void> = []
  private active = false
  private readonly messages = new Set<(message: RemoteHostIncomingMessage) => void>()
  private readonly statuses = new Set<(status: RemoteHostTransportStatus) => void>()
  private readonly peers = {
    connected: new Set<(peer: RemoteHostPeer) => void>(),
    connecting: new Set<(peer: RemoteHostPeer) => void>(),
    reconnecting: new Set<(peer: RemoteHostPeer) => void>(),
    disconnected: new Set<(peer: RemoteHostPeer) => void>()
  }
  constructor(
    private readonly factory: (mode: 'webrtc' | 'sakura') => RemoteHostTransport,
    initial: RemoteHostTransport
  ) {
    this.transport = initial
    this.subscribe()
  }
  get kind(): RemoteHostTransport['kind'] {
    return this.transport.kind
  }
  selectMode(mode: 'webrtc' | 'sakura'): void {
    if (this.active) throw new Error('请先关闭当前房间')
    this.subscriptions.forEach((unsubscribe) => unsubscribe())
    this.transport = this.factory(mode)
    this.subscribe()
  }
  private subscribe(): void {
    this.subscriptions = [
      this.transport.onMessage((message) => this.messages.forEach((listener) => listener(message))),
      this.transport.onStatusChange((status) =>
        this.statuses.forEach((listener) => listener(status))
      ),
      this.transport.onPeerConnected((peer) =>
        this.peers.connected.forEach((listener) => listener(peer))
      ),
      this.transport.onPeerConnecting((peer) =>
        this.peers.connecting.forEach((listener) => listener(peer))
      ),
      this.transport.onPeerReconnecting((peer) =>
        this.peers.reconnecting.forEach((listener) => listener(peer))
      ),
      this.transport.onPeerDisconnected((peer) =>
        this.peers.disconnected.forEach((listener) => listener(peer))
      )
    ]
  }
  async start(room: RemoteBpRoomState): Promise<RemoteHostTransportStartResult | void> {
    this.active = true
    try {
      return await this.transport.start(room)
    } catch (error) {
      this.active = false
      throw error
    }
  }
  async stop(): Promise<void> {
    await this.transport.stop()
    this.active = false
  }
  kick(side: 'first' | 'second'): Promise<void> {
    return this.transport.kick(side)
  }
  send(peerId: string, message: RemoteHostOutgoingMessage): Promise<void> {
    return this.transport.send(peerId, message)
  }
  broadcast(message: RemoteHostOutgoingMessage): Promise<void> {
    return this.transport.broadcast(message)
  }
  getConnectionPath(side: 'first' | 'second'): string {
    return this.transport.getConnectionPath?.(side) ?? 'unknown'
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
