import type {
  RemoteHostIncomingMessage,
  RemoteHostOutgoingMessage,
  RemoteHostPeer,
  RemoteHostTransport,
  RemoteHostTransportStartResult,
  RemoteHostTransportStatus
} from '../../../../shared/remoteBp'
import {
  MAX_REMOTE_BP_MESSAGE_BYTES,
  REMOTE_BP_PROTOCOL_VERSION,
  parseRemoteClientMessage
} from '../../../../shared/remoteBp'

type SignalingRole = 'HOST' | 'FIRST' | 'SECOND'

interface SignalingEnvelope {
  type: string
  requestId?: string
  payload: Record<string, unknown>
}

interface HostPeerSession extends RemoteHostPeer {
  role: 'FIRST' | 'SECOND'
  peerConnection: RTCPeerConnection
  dataChannel: RTCDataChannel
  pendingCandidates: RTCIceCandidateInit[]
  announced: boolean
  restartTimer: number | null
}

export interface WebRtcRemoteHostTransportOptions {
  signalingUrl: string
  iceServers: RTCIceServer[]
  connectTimeoutMs?: number
}

const MAX_SIGNALING_MESSAGE_BYTES = 64 * 1024
const DATA_CHANNEL_HIGH_WATER_MARK = 1024 * 1024
const DATA_CHANNEL_LOW_WATER_MARK = 256 * 1024
const DATA_CHANNEL_DRAIN_TIMEOUT_MS = 15_000

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown, min = 1, max = 256): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max
}

function roleToSide(role: SignalingRole): 'first' | 'second' | null {
  if (role === 'FIRST') return 'first'
  if (role === 'SECOND') return 'second'
  return null
}

function sideToRole(side: 'first' | 'second'): 'FIRST' | 'SECOND' {
  return side === 'first' ? 'FIRST' : 'SECOND'
}

function parseSignalingMessage(raw: string): SignalingEnvelope {
  if (new TextEncoder().encode(raw).byteLength > MAX_SIGNALING_MESSAGE_BYTES) {
    throw new Error('信令消息超过大小限制')
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('信令服务器返回了非法 JSON')
  }
  if (!isObject(value) || !isString(value.type, 1, 32) || !isObject(value.payload)) {
    throw new Error('信令服务器消息结构无效')
  }
  if (value.requestId !== undefined && !isString(value.requestId, 1, 128)) {
    throw new Error('信令 requestId 无效')
  }
  return {
    type: value.type,
    ...(value.requestId ? { requestId: value.requestId } : {}),
    payload: value.payload
  }
}

function parseDescription(value: unknown, expectedType: 'answer'): RTCSessionDescriptionInit {
  if (!isObject(value) || value.type !== expectedType || !isString(value.sdp, 1, 48 * 1024)) {
    throw new Error('远端 SDP 无效')
  }
  return { type: expectedType, sdp: value.sdp }
}

function parseCandidate(value: unknown): RTCIceCandidateInit {
  if (!isObject(value) || !isString(value.candidate, 0, 8 * 1024)) {
    throw new Error('远端 ICE candidate 无效')
  }
  return {
    candidate: value.candidate,
    sdpMid: typeof value.sdpMid === 'string' ? value.sdpMid : null,
    sdpMLineIndex: Number.isInteger(value.sdpMLineIndex) ? Number(value.sdpMLineIndex) : null,
    usernameFragment: typeof value.usernameFragment === 'string' ? value.usernameFragment : null
  }
}

function encodeHostMessage(message: RemoteHostOutgoingMessage): string {
  const raw = JSON.stringify({
    type: message.type,
    protocolVersion: REMOTE_BP_PROTOCOL_VERSION,
    messageId: globalThis.crypto.randomUUID(),
    sentAt: new Date().toISOString(),
    payload: message.payload
  })
  if (new TextEncoder().encode(raw).byteLength > MAX_REMOTE_BP_MESSAGE_BYTES) {
    throw new Error('远程 BP 消息超过大小限制')
  }
  return raw
}

export class WebRtcRemoteHostTransport implements RemoteHostTransport {
  readonly kind = 'webrtc' as const
  private readonly messageListeners = new Set<(message: RemoteHostIncomingMessage) => void>()
  private readonly connectedListeners = new Set<(peer: RemoteHostPeer) => void>()
  private readonly disconnectedListeners = new Set<(peer: RemoteHostPeer) => void>()
  private readonly statusListeners = new Set<(status: RemoteHostTransportStatus) => void>()
  private readonly peers = new Map<'first' | 'second', HostPeerSession>()
  private readonly sendQueues = new Map<string, Promise<void>>()
  private socket: WebSocket | null = null
  private stopping = false
  private startResolve: ((result: RemoteHostTransportStartResult) => void) | null = null
  private startReject: ((error: Error) => void) | null = null

  constructor(private readonly options: WebRtcRemoteHostTransportOptions) {}

  async start(): Promise<RemoteHostTransportStartResult> {
    if (this.socket) throw new Error('WebRTC transport 已经启动')
    this.stopping = false
    this.emitStatus({ connectionState: 'connecting', error: null })
    const socket = new WebSocket(this.options.signalingUrl)
    this.socket = socket
    socket.addEventListener('message', (event) => this.handleSignalingRaw(event.data))
    socket.addEventListener('close', () => this.handleSocketClosed())

    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(
        () => reject(new Error('连接信令服务器超时')),
        this.options.connectTimeoutMs ?? 10_000
      )
      socket.addEventListener(
        'open',
        () => {
          window.clearTimeout(timer)
          resolve()
        },
        { once: true }
      )
      socket.addEventListener(
        'error',
        () => {
          window.clearTimeout(timer)
          reject(new Error('连接信令服务器失败'))
        },
        { once: true }
      )
    })

    const requestId = globalThis.crypto.randomUUID()
    const created = new Promise<RemoteHostTransportStartResult>((resolve, reject) => {
      this.startResolve = resolve
      this.startReject = reject
      window.setTimeout(() => {
        if (this.startReject === reject) {
          this.startResolve = null
          this.startReject = null
          reject(new Error('创建远程房间超时'))
        }
      }, this.options.connectTimeoutMs ?? 10_000)
    })
    this.sendSignal('CREATE_ROOM', { displayName: 'XQB-BPBox' }, requestId)
    return created
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.sendSignal('LEAVE_ROOM', {})
    }
    for (const side of [...this.peers.keys()]) this.removePeer(side, true)
    this.socket?.close(1000, 'host stopped')
    this.socket = null
    this.emitStatus({ connectionState: 'offline', error: null })
  }

  async send(peerId: string, message: RemoteHostOutgoingMessage): Promise<void> {
    const previous = this.sendQueues.get(peerId) ?? Promise.resolve()
    const queued = previous
      .catch(() => undefined)
      .then(() => this.sendNow(peerId, encodeHostMessage(message)))
    this.sendQueues.set(peerId, queued)
    try {
      await queued
    } finally {
      if (this.sendQueues.get(peerId) === queued) this.sendQueues.delete(peerId)
    }
  }

  async broadcast(message: RemoteHostOutgoingMessage): Promise<void> {
    await Promise.all([...this.peers.values()].map((peer) => this.send(peer.peerId, message)))
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

  private handleSignalingRaw(data: unknown): void {
    if (typeof data !== 'string') {
      this.emitStatus({ connectionState: 'failed', error: '信令服务器返回了非文本消息' })
      return
    }
    let message: SignalingEnvelope
    try {
      message = parseSignalingMessage(data)
      void this.handleSignalingMessage(message)
    } catch (error) {
      this.emitStatus({
        connectionState: 'failed',
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private async handleSignalingMessage(message: SignalingEnvelope): Promise<void> {
    switch (message.type) {
      case 'ROOM_CREATED': {
        const roomCode = message.payload.roomCode
        const createdAt = message.payload.createdAt
        const expiresAt = message.payload.expiresAt
        if (
          !isString(roomCode, 6, 6) ||
          !/^[A-Z2-9]{6}$/.test(roomCode) ||
          !isString(createdAt, 10, 64) ||
          !isString(expiresAt, 10, 64)
        )
          throw new Error('信令服务器返回的房间信息无效')
        this.emitStatus({ connectionState: 'connected', error: null })
        this.startResolve?.({
          roomId: roomCode,
          createdAt,
          expiresAt,
          connectionState: 'connected'
        })
        this.startResolve = null
        this.startReject = null
        return
      }
      case 'PEER_JOINED': {
        const role = message.payload.role
        const side = roleToSide(role as SignalingRole)
        const sessionId = message.payload.sessionId
        if (!side || !isString(sessionId, 1, 128)) throw new Error('Peer 身份无效')
        const displayName = isString(message.payload.displayName, 1, 64)
          ? message.payload.displayName
          : undefined
        await this.createPeer(side, sessionId, displayName)
        return
      }
      case 'PEER_LEFT': {
        const side = roleToSide(message.payload.role as SignalingRole)
        if (!side) throw new Error('离线 Peer 身份无效')
        this.removePeer(side, true)
        return
      }
      case 'ANSWER': {
        const side = roleToSide(message.payload.fromRole as SignalingRole)
        const peer = side ? this.peers.get(side) : null
        if (!peer) throw new Error('ANSWER 对应的 Peer 不存在')
        await peer.peerConnection.setRemoteDescription(
          parseDescription(message.payload.description, 'answer')
        )
        for (const candidate of peer.pendingCandidates.splice(0)) {
          await peer.peerConnection.addIceCandidate(candidate)
        }
        return
      }
      case 'ICE_CANDIDATE': {
        const side = roleToSide(message.payload.fromRole as SignalingRole)
        const peer = side ? this.peers.get(side) : null
        if (!peer) throw new Error('ICE candidate 对应的 Peer 不存在')
        const candidate = parseCandidate(message.payload.candidate)
        if (peer.peerConnection.remoteDescription)
          await peer.peerConnection.addIceCandidate(candidate)
        else peer.pendingCandidates.push(candidate)
        return
      }
      case 'ERROR': {
        const code = isString(message.payload.code, 1, 64)
          ? message.payload.code
          : 'SIGNALING_ERROR'
        const text = isString(message.payload.message, 1, 512)
          ? message.payload.message
          : '信令服务错误'
        const error = new Error(`${text} (${code})`)
        if (this.startReject) {
          this.startReject(error)
          this.startResolve = null
          this.startReject = null
        }
        this.emitStatus({ connectionState: 'failed', error: error.message })
        return
      }
      case 'ROOM_LEFT':
        return
      default:
        throw new Error(`未知信令消息：${message.type}`)
    }
  }

  private async createPeer(
    side: 'first' | 'second',
    peerId: string,
    displayName?: string
  ): Promise<void> {
    this.removePeer(side, true)
    const peerConnection = new RTCPeerConnection({ iceServers: this.options.iceServers })
    const dataChannel = peerConnection.createDataChannel('xqb-remote-bp', { ordered: true })
    dataChannel.bufferedAmountLowThreshold = DATA_CHANNEL_LOW_WATER_MARK
    const peer: HostPeerSession = {
      peerId,
      side,
      role: sideToRole(side),
      ...(displayName ? { displayName } : {}),
      peerConnection,
      dataChannel,
      pendingCandidates: [],
      announced: false,
      restartTimer: null
    }
    this.peers.set(side, peer)
    dataChannel.addEventListener('open', () => this.announceConnected(peer))
    dataChannel.addEventListener('close', () => this.announceDisconnected(peer))
    dataChannel.addEventListener('message', (event) => this.handleDataMessage(peer, event.data))
    peerConnection.addEventListener('icecandidate', (event) => {
      if (!event.candidate) return
      this.sendSignal('ICE_CANDIDATE', {
        targetRole: peer.role,
        candidate: event.candidate.toJSON()
      })
    })
    peerConnection.addEventListener('connectionstatechange', () => {
      if (peerConnection.connectionState === 'connected') {
        if (peer.restartTimer !== null) window.clearTimeout(peer.restartTimer)
        peer.restartTimer = null
        return
      }
      if (peerConnection.connectionState === 'disconnected') {
        this.announceDisconnected(peer)
        peer.restartTimer = window.setTimeout(() => {
          if (peerConnection.connectionState === 'disconnected') void this.createOffer(peer, true)
        }, 2_000)
      }
      if (peerConnection.connectionState === 'failed') {
        this.announceDisconnected(peer)
        void this.createOffer(peer, true)
      }
    })
    await this.createOffer(peer)
  }

  private async createOffer(peer: HostPeerSession, iceRestart = false): Promise<void> {
    if (peer.peerConnection.signalingState === 'closed') return
    const offer = await peer.peerConnection.createOffer({ iceRestart })
    await peer.peerConnection.setLocalDescription(offer)
    this.sendSignal('OFFER', {
      targetRole: peer.role,
      description: { type: offer.type, sdp: offer.sdp ?? '' }
    })
  }

  private handleDataMessage(peer: HostPeerSession, data: unknown): void {
    if (typeof data !== 'string') {
      void this.send(peer.peerId, {
        type: 'ERROR',
        payload: { code: 'BINARY_NOT_ALLOWED', message: 'BP 控制通道只接受 JSON 文本消息' }
      })
      return
    }
    try {
      const message = parseRemoteClientMessage(data)
      let incoming: RemoteHostIncomingMessage
      switch (message.type) {
        case 'ACTION_REQUEST':
          incoming = {
            type: 'ACTION_REQUEST',
            peerId: peer.peerId,
            side: peer.side,
            action: message.payload.action
          }
          break
        case 'STATE_REQUEST':
          incoming = {
            type: 'STATE_REQUEST',
            peerId: peer.peerId,
            side: peer.side,
            ...message.payload
          }
          break
        case 'ASSET_REQUEST':
          incoming = {
            type: 'ASSET_REQUEST',
            peerId: peer.peerId,
            side: peer.side,
            assetIds: message.payload.assetIds
          }
          break
        case 'PING':
          incoming = {
            type: 'PING',
            peerId: peer.peerId,
            side: peer.side,
            clientTime: message.payload.clientTime
          }
          break
      }
      this.messageListeners.forEach((listener) => listener(incoming))
    } catch (error) {
      void this.send(peer.peerId, {
        type: 'ERROR',
        payload: {
          code: error instanceof Error ? error.message : 'INVALID_MESSAGE',
          message: '远程 BP 请求格式无效'
        }
      })
    }
  }

  private announceConnected(peer: HostPeerSession): void {
    if (peer.announced) return
    peer.announced = true
    this.connectedListeners.forEach((listener) => listener(peer))
  }

  private announceDisconnected(peer: HostPeerSession): void {
    if (!peer.announced) return
    peer.announced = false
    this.disconnectedListeners.forEach((listener) => listener(peer))
  }

  private removePeer(side: 'first' | 'second', notify: boolean): void {
    const peer = this.peers.get(side)
    if (!peer) return
    if (peer.restartTimer !== null) window.clearTimeout(peer.restartTimer)
    if (notify) this.announceDisconnected(peer)
    this.sendQueues.delete(peer.peerId)
    peer.dataChannel.close()
    peer.peerConnection.close()
    this.peers.delete(side)
  }

  private async sendNow(peerId: string, raw: string): Promise<void> {
    const peer = [...this.peers.values()].find((item) => item.peerId === peerId)
    if (!peer || peer.dataChannel.readyState !== 'open') return
    await this.waitForWritable(peer.dataChannel)
    if (peer.dataChannel.readyState === 'open') peer.dataChannel.send(raw)
  }

  private async waitForWritable(channel: RTCDataChannel): Promise<void> {
    if (channel.bufferedAmount <= DATA_CHANNEL_HIGH_WATER_MARK) return
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error): void => {
        window.clearTimeout(timer)
        channel.removeEventListener('bufferedamountlow', onDrained)
        channel.removeEventListener('close', onClosed)
        if (error) reject(error)
        else resolve()
      }
      const onDrained = (): void => finish()
      const onClosed = (): void => finish(new Error('资源传输期间 DataChannel 已关闭'))
      const timer = window.setTimeout(
        () => finish(new Error('等待 DataChannel 发送缓冲区超时')),
        DATA_CHANNEL_DRAIN_TIMEOUT_MS
      )
      channel.addEventListener('bufferedamountlow', onDrained)
      channel.addEventListener('close', onClosed)
    })
  }

  private sendSignal(type: string, payload: Record<string, unknown>, requestId?: string): void {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('信令服务器尚未连接')
    const raw = JSON.stringify({ type, ...(requestId ? { requestId } : {}), payload })
    if (new TextEncoder().encode(raw).byteLength > MAX_SIGNALING_MESSAGE_BYTES) {
      throw new Error('信令消息超过大小限制')
    }
    this.socket.send(raw)
  }

  private handleSocketClosed(): void {
    if (this.stopping) return
    this.startReject?.(new Error('信令服务器连接已断开'))
    this.startResolve = null
    this.startReject = null
    for (const side of [...this.peers.keys()]) this.removePeer(side, true)
    this.emitStatus({ connectionState: 'reconnecting', error: '信令服务器连接已断开' })
    window.setTimeout(() => {
      if (!this.stopping && this.socket?.readyState !== WebSocket.OPEN) {
        this.emitStatus({ connectionState: 'failed', error: '无法恢复信令连接，请重新创建房间' })
      }
    }, 3_000)
  }

  private emitStatus(status: RemoteHostTransportStatus): void {
    this.statusListeners.forEach((listener) => listener(status))
  }
}
