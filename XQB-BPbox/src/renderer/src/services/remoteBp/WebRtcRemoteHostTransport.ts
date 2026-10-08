import {
  RemoteBpRtcSession,
  waitForSignalingSocket,
  bufferRtcSignal,
  RTC_TIMING,
  type BufferedRtcSignal
} from '../../../../../../shared/remoteBpRtc'
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
  rtc: RemoteBpRtcSession
  announced: boolean
}

export interface WebRtcRemoteHostTransportOptions {
  signalingUrl: string
  iceServers: RTCIceServer[]
  connectTimeoutMs?: number
}

const MAX_SIGNALING_MESSAGE_BYTES = 64 * 1024
const DATA_CHANNEL_HIGH_WATER_MARK = 1024 * 1024
const DATA_CHANNEL_DRAIN_TIMEOUT_MS = 15_000
const SIGNALING_HEARTBEAT_INTERVAL_MS = 20_000
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
  private signalChain: Promise<void> = Promise.resolve()
  private earlySignals: BufferedRtcSignal[] = []
  private readonly joinedPeers = new Map<
    'first' | 'second',
    { peerId: string; displayName?: string }
  >()
  private lastSignalAt = Date.now()
  private lifecycle = 0
  private roomReady = false
  private resumeTimer: number | null = null
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
    const lifecycle = ++this.lifecycle
    this.emitStatus({ connectionState: 'connecting', error: null })
    console.info('[Remote BP signaling] WebSocket connect start', this.options.signalingUrl)
    await this.openSocket(this.options.signalingUrl)
    if (this.lifecycle !== lifecycle || this.stopping) throw new Error('创建房间已取消')

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
    this.lifecycle += 1
    this.startReject?.(new Error('远程房间已停止'))
    this.startResolve = null
    this.startReject = null
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
    this.earlySignals = []
    this.joinedPeers.clear()
    this.roomReady = false
    if (this.resumeTimer !== null) window.clearTimeout(this.resumeTimer)
    this.resumeTimer = null
    this.emitStatus({ connectionState: 'offline', error: null })
  }

  async kick(side: 'first' | 'second'): Promise<void> {
    if (!this.joinedPeers.has(side)) return
    this.joinedPeers.delete(side)
    if (this.roomReady && this.socket?.readyState === WebSocket.OPEN) {
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

  private handleSignalingRaw(data: unknown, socket: WebSocket): void {
    this.signalChain = this.signalChain
      .then(async () => {
        if (this.socket !== socket) return
        if (typeof data !== 'string') throw new Error('信令服务器返回了非文本消息')
        this.lastSignalAt = Date.now()
        await this.handleSignalingMessage(parseSignalingMessage(data))
      })
      .catch((error: unknown) => {
        if (this.socket !== socket) return
        console.warn('[Remote BP signaling] message failure', {
          roomId: this.roomId,
          error: String(error)
        })
        if (!this.roomId) {
          this.startReject?.(error instanceof Error ? error : new Error(String(error)))
          this.startResolve = null
          this.startReject = null
        }
      })
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
        this.roomReady = true
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
        this.roomReady = true
        if (this.resumeTimer !== null) window.clearTimeout(this.resumeTimer)
        this.resumeTimer = null
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
        this.joinedPeers.set(side, { peerId: sessionId, ...(displayName ? { displayName } : {}) })
        const existing = this.peers.get(side)
        if (existing && existing.peerId !== sessionId) this.removePeer(side, true)
        await this.flushEarlySignals(side)
        return
      }
      case 'PEER_LEFT': {
        const side = roleToSide(message.payload.role as SignalingRole)
        if (!side) return
        if (this.joinedPeers.get(side)?.peerId !== message.payload.sessionId) return
        this.joinedPeers.delete(side)
        this.earlySignals = this.earlySignals.filter(
          (signal) => signal.payload.fromSessionId !== message.payload.sessionId
        )
        this.removePeer(side, true)
        return
      }
      case 'PEER_READY':
      case 'ANSWER':
      case 'ICE_CANDIDATE':
      case 'ICE_RESTART_REQUEST': {
        if (this.stopping) return
        const side = roleToSide(message.payload.fromRole as SignalingRole)
        if (!side) return
        const identity = this.joinedPeers.get(side)
        if (!identity) {
          bufferRtcSignal(this.earlySignals, message.type, message.payload)
          console.info('[Remote BP RTC] signal buffered before peer initialization', {
            roomId: this.roomId,
            ...message.payload,
            candidate: undefined,
            description: undefined
          })
          return
        }
        if (message.payload.fromSessionId !== identity.peerId) return
        if (message.type === 'PEER_READY') {
          if (!isString(message.payload.connectionId, 1, 128)) return
          const existing = this.peers.get(side)
          if (existing?.rtc.connectionId === message.payload.connectionId) {
            existing.rtc.replay()
          } else {
            await this.createPeer(
              side,
              identity.peerId,
              message.payload.connectionId,
              identity.displayName
            )
          }
          await this.flushEarlySignals(side)
          return
        }
        const peer = this.peers.get(side)
        if (!peer) {
          bufferRtcSignal(this.earlySignals, message.type, message.payload)
          return
        }
        await peer.rtc.receive(message.type, message.payload)
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

  private async flushEarlySignals(side: 'first' | 'second'): Promise<void> {
    const signals = this.earlySignals
    this.earlySignals = []
    for (const signal of signals) {
      if (Date.now() - signal.receivedAt > RTC_TIMING.signalTtlMs) continue
      if (roleToSide(signal.payload.fromRole as SignalingRole) === side)
        await this.handleSignalingMessage(signal)
      else this.earlySignals.push(signal)
    }
  }

  private async createPeer(
    side: 'first' | 'second',
    peerId: string,
    connectionId: string,
    displayName?: string
  ): Promise<void> {
    this.removePeer(side, false)
    let rtc: RemoteBpRtcSession | null = null
    rtc = new RemoteBpRtcSession({
      connectionId,
      peerId,
      roomId: this.roomId!,
      offerer: true,
      iceServers: this.options.iceServers,
      send: (type, payload) => {
        if (
          this.stopping ||
          !this.roomReady ||
          this.socket?.readyState !== WebSocket.OPEN ||
          this.peers.get(side)?.rtc !== rtc
        )
          return false
        this.sendSignal(type, { ...payload, targetRole: sideToRole(side), targetSessionId: peerId })
        return true
      },
      onState: (state, reason) => {
        const peer = this.peers.get(side)
        if (!peer || peer.rtc !== rtc) return
        if (state === 'connected') this.announceConnected(peer)
        else if (state === 'reconnecting') this.announceReconnecting(peer)
        else if (state === 'failed') {
          console.warn('[Remote BP RTC] peer failed', {
            connectionId,
            peerId,
            roomId: this.roomId,
            reason
          })
          this.announceDisconnectedRemoved(peer)
        }
      },
      onMessage: (data) => {
        const peer = this.peers.get(side)
        if (peer?.rtc === rtc) this.handleDataMessage(peer, data)
      }
    })
    const peer: HostPeerSession = {
      peerId,
      side,
      role: sideToRole(side),
      ...(displayName ? { displayName } : {}),
      rtc,
      announced: false
    }
    this.peers.set(side, peer)
    this.connectingListeners.forEach((listener) => listener(peer))
    await rtc.start()
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

  private removePeer(side: 'first' | 'second', notify: boolean): void {
    const peer = this.peers.get(side)
    if (!peer) return
    this.peers.delete(side)
    if (notify) this.announceDisconnectedRemoved(peer)
    this.sendQueues.delete(peer.peerId)
    peer.rtc.close()
  }

  private announceDisconnectedRemoved(peer: HostPeerSession): void {
    peer.announced = false
    this.disconnectedListeners.forEach((listener) => listener(peer))
  }

  private async sendNow(peerId: string, raw: string): Promise<void> {
    const peer = [...this.peers.values()].find((item) => item.peerId === peerId)
    const channel = peer?.rtc.channel
    if (!peer || !channel || channel.readyState !== 'open') return
    await this.waitForWritable(channel)
    if (this.peers.get(peer.side) === peer && channel.readyState === 'open') channel.send(raw)
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
    this.roomReady = false
    this.stopHeartbeat()
    if (this.stopping) return
    this.startReject?.(new Error('信令服务器连接已断开'))
    this.startResolve = null
    this.startReject = null
    this.emitStatus({ connectionState: 'reconnecting', error: '信令服务器连接已断开' })
    this.scheduleReconnect()
  }

  private async openSocket(url: string): Promise<void> {
    const previous = this.socket
    const socket = new WebSocket(url)
    this.socket = socket
    this.roomReady = false
    this.signalChain = Promise.resolve()
    previous?.close(4000, 'socket replaced')
    socket.addEventListener('message', (event) => {
      if (this.socket === socket) this.handleSignalingRaw(event.data, socket)
    })
    socket.addEventListener('close', (event) => this.handleSocketClosed(event, socket))
    await waitForSignalingSocket(
      socket,
      this.options.connectTimeoutMs ?? 10_000,
      () => this.socket === socket
    )
  }

  private scheduleReconnect(): void {
    if (
      this.stopping ||
      !this.roomId ||
      !this.resumeToken ||
      this.reconnectTimer !== null ||
      this.socket
    )
      return
    const delay = Math.min(MAX_RECONNECT_DELAY_MS, 1_000 * 2 ** this.reconnectAttempt)
    this.reconnectAttempt += 1
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      void this.resumeRoom()
    }, delay)
  }

  private async resumeRoom(): Promise<void> {
    if (this.stopping || !this.roomId || !this.resumeToken) return
    const lifecycle = this.lifecycle
    try {
      await this.openSocket(createResumeUrl(this.options.signalingUrl, this.roomId))
      if (this.lifecycle !== lifecycle || this.stopping) return
      this.resumeInFlight = true
      this.sendSignal('RESUME_ROOM', {
        roomCode: this.roomId,
        resumeToken: this.resumeToken
      })
      if (this.resumeTimer !== null) window.clearTimeout(this.resumeTimer)
      const socket = this.socket
      this.resumeTimer = window.setTimeout(() => {
        if (this.socket === socket && this.resumeInFlight)
          socket?.close(4000, 'resume acknowledgement timeout')
      }, this.options.connectTimeoutMs ?? 10_000)
    } catch {
      this.scheduleReconnect()
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    const heartbeat = (): void => {
      if (this.socket?.readyState !== WebSocket.OPEN) return
      if (Date.now() - this.lastSignalAt > 60_000) {
        this.socket.close(4000, 'signaling heartbeat timeout')
        return
      }
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
