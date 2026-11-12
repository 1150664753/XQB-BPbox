import { createServer, type Server } from 'node:http'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'
import {
  parseRemoteClientMessage,
  REMOTE_BP_PROTOCOL_VERSION,
  MAX_REMOTE_BP_MESSAGE_BYTES
} from '../../shared/remoteBp/validation'
import type { RemoteHostOutgoingMessage, RemoteHostPeer } from '../../shared/remoteBp/transport'
import type { SakuraRoomEvent } from '../../shared/sakura'
import {
  SAKURA_WIRE_VERSION,
  SAKURA_HEARTBEAT_MS,
  SAKURA_TIMEOUT_MS
} from '../../../../shared/sakuraBp'

interface Peer extends RemoteHostPeer {
  resumeToken: string
  control: WebSocket
  assets: WebSocket | null
  ready: boolean
  controlUntil: number
}
const secret = (): string => randomBytes(32).toString('base64url')
function equal(a: unknown, b: string): boolean {
  return (
    typeof a === 'string' &&
    a.length === b.length &&
    Buffer.byteLength(a) === Buffer.byteLength(b) &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b))
  )
}
function object(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}
export function encodeSakuraHostMessage(message: { type: string; payload: unknown }): string {
  const raw = JSON.stringify({
    ...message,
    protocolVersion: REMOTE_BP_PROTOCOL_VERSION,
    messageId: randomUUID(),
    sentAt: new Date().toISOString()
  })
  if (Buffer.byteLength(raw) > MAX_REMOTE_BP_MESSAGE_BYTES) throw new Error('MESSAGE_TOO_LARGE')
  return raw
}

/** Only loopback HTTP and two authenticated WebSocket streams; never serves local files. */
export class SakuraRoomServer {
  readonly roomId = randomBytes(4).toString('hex').toUpperCase()
  readonly credential = secret()
  readonly probeToken = secret()
  private readonly peers = new Map<'first' | 'second', Peer>()
  private readonly sockets = new Set<WebSocket>()
  private readonly lastSeen = new Map<WebSocket, number>()
  private server: Server | null = null
  private wss: WebSocketServer | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private closing = false

  constructor(
    private readonly emit: (event: SakuraRoomEvent) => void,
    private readonly allowedOrigins: string[],
    private active = true
  ) {}

  activate(): void {
    this.active = true
  }

  async listen(port: number): Promise<void> {
    if (this.server) throw new Error('本地 BP 服务已启动')
    this.closing = false
    const server = createServer((request, response) => {
      response.setHeader('Cache-Control', 'no-store')
      response.writeHead(request.url === '/health' ? 200 : 404, {
        'Content-Type': 'application/json'
      })
      response.end(
        JSON.stringify(
          request.url === '/health'
            ? { service: 'xqb-sakura-bp', version: SAKURA_WIRE_VERSION }
            : { error: 'NOT_FOUND' }
        )
      )
    })
    server.headersTimeout = 5000
    server.requestTimeout = 5000
    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: 64 * 1024,
      perMessageDeflate: false
    })
    this.server = server
    this.wss = wss
    server.on('upgrade', (request, socket, head) => {
      if (
        this.closing ||
        !['/bp', '/assets'].includes(request.url ?? '') ||
        !this.allowedOrigins.includes(request.headers.origin ?? '') ||
        this.sockets.size >= 16
      ) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
        return
      }
      wss.handleUpgrade(request, socket, head, (ws) => this.accept(ws, request.url === '/assets'))
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject)
        resolve()
      })
    }).catch(async (error) => {
      await this.close()
      throw error
    })
    this.heartbeat = setInterval(() => {
      for (const ws of this.sockets) {
        if (Date.now() - (this.lastSeen.get(ws) ?? 0) > SAKURA_TIMEOUT_MS) ws.terminate()
        else if (ws.readyState === WebSocket.OPEN) ws.ping()
      }
    }, SAKURA_HEARTBEAT_MS)
    this.heartbeat.unref()
  }

  private event(
    type: 'connected' | 'connecting' | 'reconnecting' | 'disconnected',
    peer: Peer
  ): void {
    this.emit({
      roomId: this.roomId,
      type,
      peer: { peerId: peer.peerId, side: peer.side, displayName: peer.displayName }
    })
  }

  private accept(ws: WebSocket, assetStream: boolean): void {
    this.sockets.add(ws)
    this.lastSeen.set(ws, Date.now())
    let peer: Peer | null = null
    let authenticated = false
    let windowStart = Date.now(),
      count = 0
    const deadline = setTimeout(() => {
      if (!authenticated) ws.close(4001, 'Authentication timeout')
    }, 5000)
    ws.on('error', () => {
      /* Close handler owns recovery; never log frames or credentials. */
    })
    ws.on('pong', () => this.lastSeen.set(ws, Date.now()))
    ws.on('message', (bytes, binary) => {
      try {
        if (binary) throw new Error('BINARY_NOT_ALLOWED')
        if (Date.now() - windowStart > 1000) {
          count = 0
          windowStart = Date.now()
        }
        if (++count > 120) throw new Error('RATE_LIMITED')
        this.lastSeen.set(ws, Date.now())
        const raw = bytes.toString()
        const message: unknown = JSON.parse(raw)
        if (!object(message)) throw new Error('INVALID_MESSAGE')
        if (!authenticated) {
          if (
            message.version !== SAKURA_WIRE_VERSION ||
            message.protocolVersion !== REMOTE_BP_PROTOCOL_VERSION
          )
            throw new Error('UNSUPPORTED_PROTOCOL_VERSION')
          if (
            message.type === 'SAKURA_PROBE' &&
            !assetStream &&
            equal(message.token, this.probeToken)
          ) {
            ws.send(
              JSON.stringify({
                type: 'SAKURA_PROBE_OK',
                roomId: this.roomId,
                version: SAKURA_WIRE_VERSION
              })
            )
            ws.close(1000)
            return
          }
          if (!this.active) throw new Error('ROOM_NOT_FOUND')
          if (message.roomId !== this.roomId) throw new Error('ROOM_NOT_FOUND')
          if (assetStream) {
            if (message.type !== 'SAKURA_ASSETS') throw new Error('AUTH_REQUIRED')
            const candidate = [...this.peers.values()].find((p) => p.peerId === message.peerId)
            if (
              !candidate ||
              !equal(message.resumeToken, candidate.resumeToken) ||
              candidate.control.readyState !== WebSocket.OPEN
            )
              throw new Error('AUTH_FAILED')
            peer = candidate
            peer.assets?.terminate()
            peer.assets = ws
            ws.send(JSON.stringify({ type: 'SAKURA_ASSETS_READY', version: SAKURA_WIRE_VERSION }))
          } else {
            if (message.type !== 'SAKURA_JOIN' || !equal(message.credential, this.credential))
              throw new Error('AUTH_FAILED')
            if (message.side !== 'first' && message.side !== 'second')
              throw new Error('INVALID_SIDE')
            if (
              typeof message.displayName !== 'string' ||
              !message.displayName.trim() ||
              message.displayName.length > 64
            )
              throw new Error('INVALID_NAME')
            const previous = this.peers.get(message.side)
            if (previous && !equal(message.resumeToken, previous.resumeToken))
              throw new Error('SEAT_OCCUPIED')
            peer = {
              peerId: previous?.peerId ?? randomUUID(),
              side: message.side,
              displayName: message.displayName.trim(),
              resumeToken: previous?.resumeToken ?? secret(),
              control: ws,
              assets: null,
              ready: false,
              controlUntil: 0
            }
            this.peers.set(peer.side, peer)
            previous?.control.terminate()
            previous?.assets?.terminate()
            this.event('connecting', peer)
            ws.send(
              JSON.stringify({
                type: 'SAKURA_JOINED',
                version: SAKURA_WIRE_VERSION,
                protocolVersion: REMOTE_BP_PROTOCOL_VERSION,
                roomId: this.roomId,
                peerId: peer.peerId,
                side: peer.side,
                resumeToken: peer.resumeToken
              })
            )
          }
          authenticated = true
          clearTimeout(deadline)
          return
        }
        if (!peer || this.peers.get(peer.side) !== peer) throw new Error('STALE_SESSION')
        if (assetStream) throw new Error('UNEXPECTED_ASSET_MESSAGE')
        if (message.type === 'SAKURA_READY') {
          if (!peer.assets || peer.assets.readyState !== WebSocket.OPEN)
            throw new Error('ASSETS_NOT_READY')
          if (!peer.ready) {
            peer.ready = true
            this.event('connected', peer)
          }
          return
        }
        if (message.type === 'SAKURA_LEAVE') {
          this.release(peer)
          return
        }
        if (!peer.ready) throw new Error('SESSION_NOT_READY')
        const parsed = parseRemoteClientMessage(raw)
        if (parsed.type === 'ACTION_REQUEST') {
          if (parsed.payload.action.actorSide !== peer.side) throw new Error('INVALID_SIDE')
          peer.controlUntil = Date.now() + 150
        }
        this.emit({
          roomId: this.roomId,
          type: 'message',
          message: {
            type: parsed.type,
            peerId: peer.peerId,
            side: peer.side,
            ...parsed.payload
          } as import('../../shared/remoteBp/transport').RemoteHostIncomingMessage
        })
      } catch (error) {
        const code =
          error instanceof Error && /^[A-Z_]+$/.test(error.message)
            ? error.message
            : 'INVALID_MESSAGE'
        if (ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ type: 'SAKURA_ERROR', code }))
        ws.close(4003, code)
      }
    })
    ws.on('close', () => {
      clearTimeout(deadline)
      this.sockets.delete(ws)
      this.lastSeen.delete(ws)
      if (!peer || this.peers.get(peer.side) !== peer || this.closing) return
      if (peer.control !== ws && peer.assets !== ws) return
      if (peer.ready) {
        peer.ready = false
        this.event('reconnecting', peer)
      }
      peer.assets?.terminate()
      peer.control.terminate()
    })
  }

  async send(peerId: string, message: RemoteHostOutgoingMessage): Promise<void> {
    const peer = [...this.peers.values()].find((p) => p.peerId === peerId)
    if (!peer?.ready) return
    const asset = ['ASSET_START', 'ASSET_CHUNK', 'ASSET_COMPLETE'].includes(message.type)
    const ws = asset ? peer.assets : peer.control
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('连接已断开')
    const raw = encodeSakuraHostMessage(message)
    if (asset) {
      // Separate TCP streams plus small paced chunks keep pictures off the BP control queue.
      const deadline = Date.now() + 30_000
      while (ws.bufferedAmount > 16 * 1024 || peer.controlUntil > Date.now()) {
        if (Date.now() > deadline || !peer.ready || this.peers.get(peer.side) !== peer)
          throw new Error('资源传输已取消')
        await new Promise((resolve) => setTimeout(resolve, 15))
      }
      await new Promise((resolve) => setTimeout(resolve, 4))
    } else if (ws.bufferedAmount > 2 * MAX_REMOTE_BP_MESSAGE_BYTES) {
      ws.terminate()
      throw new Error('连接拥塞，正在重连')
    }
    if (!peer.ready || this.peers.get(peer.side) !== peer || ws.readyState !== WebSocket.OPEN)
      throw new Error('连接已断开')
    await new Promise<void>((resolve, reject) =>
      ws.send(raw, (error) => (error ? reject(new Error('消息发送失败')) : resolve()))
    )
  }

  async broadcast(message: RemoteHostOutgoingMessage): Promise<void> {
    // One failed player must not block the other player's authoritative state.
    await Promise.allSettled(
      [...this.peers.values()].map((peer) => this.send(peer.peerId, message))
    )
  }

  private release(peer: Peer): void {
    this.peers.delete(peer.side)
    peer.ready = false
    peer.control.close(1000)
    peer.assets?.close(1000)
    this.event('disconnected', peer)
  }
  kick(side: 'first' | 'second'): void {
    const peer = this.peers.get(side)
    if (peer) this.release(peer)
  }

  async close(): Promise<void> {
    this.closing = true
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    for (const peer of this.peers.values()) peer.ready = false
    for (const peer of this.peers.values()) this.event('disconnected', peer)
    const server = this.server,
      wss = this.wss
    this.server = null
    this.wss = null
    for (const ws of this.sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          encodeSakuraHostMessage({ type: 'ROOM_CLOSED', payload: { message: '房间已关闭' } })
        )
        ws.close(4004, 'ROOM_CLOSED')
      }
    }
    // Give close frames a bounded opportunity to flush, then reclaim every socket.
    if (this.sockets.size) await new Promise((resolve) => setTimeout(resolve, 100))
    for (const ws of this.sockets) ws.terminate()
    this.peers.clear()
    this.lastSeen.clear()
    this.sockets.clear()
    wss?.close()
    if (server?.listening)
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
  }
}
