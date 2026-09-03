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
const SIGNALING_HEARTBEAT_INTERVAL_MS = 20_000
const PEER_RECOVERY_GRACE_MS = 10_000
const MAX_RECONNECT_DELAY_MS = 15_000

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

function createResumeUrl(baseUrl: string, roomId: string): string {
  const url = new URL(baseUrl)
  url.searchParams.set('roomId', roomId)
  url.searchParams.set('mode', 'resume')
  return url.toString()
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
  private readonly connectingListeners = new Set<(peer: RemoteHostPeer) => void>()
  private readonly reconnectingListeners = new Set<(peer: RemoteHostPeer) => void>()
  private readonly disconnectedListeners = new Set<(peer: RemoteHostPeer) => void>()
  private readonly statusListeners = new Set<(status: RemoteHostTransportStatus) => void>()
  private readonly peers = new Map<'first' | 'second', HostPeerSession>()
  private readonly sendQueues = new Map<string, Promise<void>>()
  private readonly pendingKicks = new Set<'first' | 'second'>()
  private socket: WebSocket | null = null
  private stopping = false
  private startResolve: ((result: RemoteHostTransportStartResult) => void) | null = null
  private startReject: ((error: Error) => void) | null = null
  private roomId: string | null = null
  private resumeToken: string | null = null
  private heartbeatTimer: number | null = null
  private reconnectTimer: number | null = null
  private reconnectAttempt = 0
  private resumeInFlight = false
  private resumeResolve: (() => void) | null = null

  constructor(private readonly options: WebRtcRemoteHostTransportOptions) {}

  async start(): Promise<RemoteHostTransportStartResult> {
    if (this.socket) throw new Error('WebRTC transport 已经启动')
    this.stopping = false
    this.emitStatus({ connectionState: 'connecting', error: null })
    console.info('[Remote BP signaling] WebSocket connect start', this.options.signalingUrl)
    await this.openSocket(this.options.signalingUrl)

    const requestId = globalThis.crypto.randomUUID()
    const created = new Promise<RemoteHostTransportStartResult>((resolve, reject) => {
      this.startResolve = resolve
      this.startReject = reject
      window.setTimeout(() => {
        if (this.startReject === reject) {
          this.startResolve = null
          this.startReject = null
          const socket = this.socket
          this.socket = null
          socket?.close(4000, 'create room timeout')
          reject(new Error('创建远程房间超时'))
        }
      }, this.options.connectTimeoutMs ?? 10_000)
    })
    console.info('[Remote BP signaling] CREATE_ROOM send')
    this.sendSignal('CREATE_ROOM', { displayName: 'XQB-BPBox' }, requestId)
    return created
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.clearReconnectTimer()
    this.stopHeartbeat()
    if (this.socket?.readyState !== WebSocket.OPEN && this.roomId && this.resumeToken) {
      try {
        await this.openSocket(createResumeUrl(this.options.signalingUrl, this.roomId))
        const resumed = new Promise<void>((resolve) => {
          this.resumeResolve = resolve
          window.setTimeout(resolve, 5_000)
        })
        this.sendSignal('RESUME_ROOM', {
          roomCode: this.roomId,
          resumeToken: this.resumeToken
        })
        await resumed
      } catch {
        // The DataChannel ROOM_CLOSED message remains the best-effort fallback.
      }
    }
    if (this.socket?.readyState === WebSocket.OPEN) {
      try {
        this.sendSignal('LEAVE_ROOM', {})
      } catch {
        // The signaling socket may have closed between the readyState check and send.
      }
    }
    for (const side of [...this.peers.keys()]) this.removePeer(side, true)
    this.socket?.close(1000, 'host stopped')
    this.socket = null
    this.roomId = null
    this.resumeToken = null
    this.reconnectAttempt = 0
    this.resumeInFlight = false
    this.resumeResolve = null
    this.pendingKicks.clear()
    this.emitStatus({ connectionState: 'offline', error: null })
  }

  async kick(side: 'first' | 'second'): Promise<void> {
    const peer = this.peers.get(side)
    if (!peer) return
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.sendSignal('KICK_PEER', { side: sideToRole(side) })
    } else this.pendingKicks.add(side)
    this.removePeer(side, true)
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

  onPeerConnecting(listener: (peer: RemoteHostPeer) => void): () => void {
    this.connectingListeners.add(listener)
    return () => this.connectingListeners.delete(listener)
  }

  onPeerReconnecting(listener: (peer: RemoteHostPeer) => void): () => void {
    this.reconnectingListeners.add(listener)
    return () => this.reconnectingListeners.delete(listener)
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
      void this.handleSignalingMessage(message).catch((error: unknown) => {
        const normalized = error instanceof Error ? error : new Error(String(error))
        if (this.roomId) this.restartSignaling(normalized.message)
        else this.emitStatus({ connectionState: 'failed', error: normalized.message })
      })
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
        const resumeToken = message.payload.resumeToken
        if (
          !isString(roomCode, 6, 6) ||
          !/^[A-Z2-9]{6}$/.test(roomCode) ||
          !isString(createdAt, 10, 64) ||
          !isString(expiresAt, 10, 64) ||
          !isString(resumeToken, 16, 128)
        )
          throw new Error('信令服务器返回的房间信息无效')
        console.info('[Remote BP signaling] ROOM_CREATED received', roomCode)
        this.roomId = roomCode
        this.resumeToken = resumeToken
        this.reconnectAttempt = 0
        this.startHeartbeat()
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
      case 'ROOM_RESUMED': {
        const roomCode = message.payload.roomCode
        if (!isString(roomCode, 6, 6) || roomCode !== this.roomId) {
          throw new Error('恢复的房间信息无效')
        }
        this.resumeInFlight = false
        this.reconnectAttempt = 0
        this.resumeResolve?.()
        this.resumeResolve = null
        if (!this.stopping) {
          this.startHeartbeat()
          this.emitStatus({ connectionState: 'connected', error: null })
          for (const side of this.pendingKicks) {
            this.sendSignal('KICK_PEER', { side: sideToRole(side) })
          }
          this.pendingKicks.clear()
        }
        return
      }
      case 'PEER_JOINED': {
        if (this.stopping) return
        const role = message.payload.role
        const side = roleToSide(role as SignalingRole)
        const sessionId = message.payload.sessionId
        if (!side || !isString(sessionId, 1, 128)) throw new Error('Peer 身份无效')
        const displayName = isString(message.payload.displayName, 1, 64)
          ? message.payload.displayName
          : undefined
        const existing = this.peers.get(side)
        if (
          existing?.peerId === sessionId &&
          existing.dataChannel.readyState === 'open' &&
          existing.peerConnection.connectionState !== 'failed' &&
          existing.peerConnection.connectionState !== 'closed'
        ) {
          // A signaling-only outage does not invalidate an otherwise healthy P2P
          // channel. Keep it in place so resuming the room cannot tear down a live
          // player connection just because the server re-announced the seat.
          this.announceConnected(existing)
          return
        }
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
        const wasStarting = this.startReject !== null
        if (this.startReject) {
          this.startReject(error)
          this.startResolve = null
          this.startReject = null
        }
        if (this.resumeInFlight && (code === 'ROOM_NOT_FOUND' || code === 'INVALID_RESUME_TOKEN')) {
          this.resumeInFlight = false
          this.stopping = true
          this.clearReconnectTimer()
          this.stopHeartbeat()
          this.emitStatus({ connectionState: 'failed', error: error.message })
          return
        }
        if (wasStarting) this.emitStatus({ connectionState: 'failed', error: error.message })
        else console.warn('[Remote BP signaling] recoverable error', code, text)
        return
      }
      case 'HEARTBEAT_ACK':
      case 'HOST_RECONNECTED':
        return
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
    this.removePeer(side, false)
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
    this.connectingListeners.forEach((listener) => listener(peer))
    dataChannel.addEventListener('open', () => this.announceConnected(peer))
    dataChannel.addEventListener('close', () => this.handleDataChannelClosed(peer))
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
        if (dataChannel.readyState === 'open') this.announceConnected(peer)
        return
      }
      if (peerConnection.connectionState === 'disconnected') {
        this.announceReconnecting(peer)
        if (peer.restartTimer !== null) window.clearTimeout(peer.restartTimer)
        peer.restartTimer = window.setTimeout(() => {
          if (
            this.peers.get(side) === peer &&
            peerConnection.connectionState === 'disconnected' &&
            this.socket?.readyState === WebSocket.OPEN
          ) {
            void this.createOffer(peer, true).catch(() => this.scheduleReconnect())
          }
        }, PEER_RECOVERY_GRACE_MS)
      }
      if (peerConnection.connectionState === 'failed') {
        this.announceReconnecting(peer)
        if (this.socket?.readyState === WebSocket.OPEN) {
          void this.createOffer(peer, true).catch(() => this.scheduleReconnect())
        }
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
    if (this.peers.get(peer.side) !== peer) return
    if (peer.announced) return
    peer.announced = true
    this.connectedListeners.forEach((listener) => listener(peer))
  }

  private announceReconnecting(peer: HostPeerSession): void {
    if (this.peers.get(peer.side) !== peer) return
    if (peer.announced) peer.announced = false
    this.reconnectingListeners.forEach((listener) => listener(peer))
  }

  private handleDataChannelClosed(peer: HostPeerSession): void {
    if (this.stopping || this.peers.get(peer.side) !== peer) return
    this.announceReconnecting(peer)
    if (peer.restartTimer !== null) window.clearTimeout(peer.restartTimer)
    peer.restartTimer = window.setTimeout(() => {
      if (this.peers.get(peer.side) !== peer || this.socket?.readyState !== WebSocket.OPEN) return
      void this.createPeer(peer.side, peer.peerId, peer.displayName).catch(() =>
        this.scheduleReconnect()
      )
    }, 1_000)
  }

  private removePeer(side: 'first' | 'second', notify: boolean): void {
    const peer = this.peers.get(side)
    if (!peer) return
    if (peer.restartTimer !== null) window.clearTimeout(peer.restartTimer)
    this.peers.delete(side)
    if (notify) {
      peer.announced = true
      this.announceDisconnectedRemoved(peer)
    }
    this.sendQueues.delete(peer.peerId)
    peer.dataChannel.close()
    peer.peerConnection.close()
  }

  private announceDisconnectedRemoved(peer: HostPeerSession): void {
    peer.announced = false
    this.disconnectedListeners.forEach((listener) => listener(peer))
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

  private handleSocketClosed(event: CloseEvent, socket: WebSocket): void {
    console.warn('[Remote BP signaling] WebSocket close', {
      url: this.options.signalingUrl,
      code: event.code,
      reason: event.reason,
      wasClean: event.wasClean
    })
    if (this.socket !== socket) return
    this.socket = null
    this.stopHeartbeat()
    if (this.stopping) return
    this.startReject?.(new Error('信令服务器连接已断开'))
    this.startResolve = null
    this.startReject = null
    this.emitStatus({ connectionState: 'reconnecting', error: '信令服务器连接已断开' })
    this.scheduleReconnect()
  }

  private restartSignaling(reason: string): void {
    if (this.stopping || !this.roomId || !this.resumeToken) return
    this.emitStatus({ connectionState: 'reconnecting', error: reason })
    const socket = this.socket
    this.socket = null
    this.stopHeartbeat()
    socket?.close(4000, 'reconnect')
    this.scheduleReconnect()
  }

  private async openSocket(url: string): Promise<void> {
    const socket = new WebSocket(url)
    this.socket = socket
    socket.addEventListener('message', (event) => {
      if (this.socket === socket) this.handleSignalingRaw(event.data)
    })
    socket.addEventListener('close', (event) => this.handleSocketClosed(event, socket))
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        if (this.socket === socket) this.socket = null
        socket.close()
        reject(new Error('连接信令服务器超时'))
      }, this.options.connectTimeoutMs ?? 10_000)
      socket.addEventListener(
        'open',
        () => {
          window.clearTimeout(timer)
          console.info('[Remote BP signaling] WebSocket open', url)
          resolve()
        },
        { once: true }
      )
      socket.addEventListener(
        'error',
        () => {
          window.clearTimeout(timer)
          console.error('[Remote BP signaling] WebSocket error', url)
          if (this.socket === socket) this.socket = null
          socket.close()
          reject(new Error('连接信令服务器失败'))
        },
        { once: true }
      )
    })
  }

  private scheduleReconnect(): void {
    if (this.stopping || !this.roomId || !this.resumeToken || this.reconnectTimer !== null) return
    const delay = Math.min(MAX_RECONNECT_DELAY_MS, 1_000 * 2 ** this.reconnectAttempt)
    this.reconnectAttempt += 1
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      void this.resumeRoom()
    }, delay)
  }

  private async resumeRoom(): Promise<void> {
    if (this.stopping || !this.roomId || !this.resumeToken) return
    try {
      await this.openSocket(createResumeUrl(this.options.signalingUrl, this.roomId))
      this.resumeInFlight = true
      this.sendSignal('RESUME_ROOM', {
        roomCode: this.roomId,
        resumeToken: this.resumeToken
      })
    } catch {
      this.scheduleReconnect()
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    const heartbeat = (): void => {
      if (this.socket?.readyState !== WebSocket.OPEN) return
      try {
        this.sendSignal('HEARTBEAT', { sentAt: new Date().toISOString() })
      } catch {
        // The close event owns reconnect scheduling.
      }
    }
    heartbeat()
    this.heartbeatTimer = window.setInterval(heartbeat, SIGNALING_HEARTBEAT_INTERVAL_MS)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) window.clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private emitStatus(status: RemoteHostTransportStatus): void {
    this.statusListeners.forEach((listener) => listener(status))
  }
}
