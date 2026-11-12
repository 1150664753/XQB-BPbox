import type {
  RemoteHostIncomingMessage,
  RemoteHostOutgoingMessage,
  RemoteHostPeer
} from './remoteBp/transport'

export type RemoteNetworkMode = 'webrtc' | 'sakura'
export interface SakuraConfig {
  mode: RemoteNetworkMode
  publicUrl: string
  localPort: number
}
export type SakuraSettings = SakuraConfig
export interface SakuraStatus {
  service: 'stopped' | 'starting' | 'listening' | 'failed'
  publicConnection: 'unchecked' | 'checking' | 'verified' | 'failed'
  checkedAt: string | null
  error: string | null
  roomId: string | null
  invitationLink: string | null
}
export type SakuraRoomEvent = { roomId: string } & (
  | { type: 'message'; message: RemoteHostIncomingMessage }
  | { type: 'connected' | 'connecting' | 'reconnecting' | 'disconnected'; peer: RemoteHostPeer }
)
export interface SakuraAPI {
  settings(): Promise<SakuraSettings>
  configure(config: SakuraConfig): Promise<SakuraSettings>
  status(): Promise<SakuraStatus>
  startService(): Promise<SakuraStatus>
  stopService(): Promise<SakuraStatus>
  start(): Promise<{ roomId: string; invitationLink: string }>
  stop(): Promise<void>
  verify(): Promise<SakuraStatus>
  send(roomId: string, peerId: string | null, message: RemoteHostOutgoingMessage): Promise<void>
  kick(roomId: string, side: 'first' | 'second'): Promise<void>
  onEvent(listener: (event: SakuraRoomEvent) => void): () => void
  onStatus(listener: (status: SakuraStatus) => void): () => void
}
