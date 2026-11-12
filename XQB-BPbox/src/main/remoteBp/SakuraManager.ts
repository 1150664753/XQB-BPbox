import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { REMOTE_BP_PROTOCOL_VERSION } from '../../shared/remoteBp/validation'
import type {
  SakuraConfig,
  SakuraSettings,
  SakuraStatus,
  SakuraRoomEvent
} from '../../shared/sakura'
import {
  createSakuraInvitationLink,
  normalizeSakuraEndpoint,
  SAKURA_DEFAULT_PORT,
  SAKURA_PLAYER_URL,
  SAKURA_WIRE_VERSION
} from '../../../../shared/sakuraBp'
import { SakuraRoomServer } from './SakuraRoomServer'

const defaults: SakuraConfig = { mode: 'webrtc', publicUrl: '', localPort: SAKURA_DEFAULT_PORT }
const idle = (): SakuraStatus => ({
  service: 'stopped',
  publicConnection: 'unchecked',
  checkedAt: null,
  error: null,
  roomId: null,
  invitationLink: null
})
const origin = new URL(SAKURA_PLAYER_URL).origin

/** Owns only the loopback BP service. SakuraFrp runs independently outside BPbox. */
export class SakuraManager {
  private config: SakuraConfig = { ...defaults }
  private loaded = false
  private state = idle()
  private room: SakuraRoomServer | null = null
  private monitor: ReturnType<typeof setInterval> | null = null
  private probe: WebSocket | null = null
  private probing: Promise<SakuraStatus> | null = null
  private transition: Promise<unknown> = Promise.resolve()
  private readonly storePath: string

  constructor(
    private readonly directory: string,
    private readonly emitStatus: (status: SakuraStatus) => void,
    private readonly emitEvent: (event: SakuraRoomEvent) => void
  ) {
    this.storePath = join(directory, 'network.json')
  }
  settings(): SakuraSettings {
    if (!this.loaded) {
      if (existsSync(this.storePath)) {
        try {
          this.config = this.validateConfig(JSON.parse(readFileSync(this.storePath, 'utf8')))
        } catch {
          throw new Error('网络配置格式损坏，请检查本地 network.json')
        }
      }
      this.loaded = true
    }
    return { ...this.config }
  }
  private validateConfig(value: unknown): SakuraConfig {
    if (!value || typeof value !== 'object') throw new Error('网络配置无效')
    const c = value as SakuraConfig
    if (
      !['webrtc', 'sakura'].includes(c.mode) ||
      typeof c.publicUrl !== 'string' ||
      c.publicUrl.length > 512 ||
      !Number.isInteger(c.localPort) ||
      c.localPort < 1024 ||
      c.localPort > 65535
    )
      throw new Error('请检查连接模式、公网地址和本地端口（1024–65535）')
    return {
      mode: c.mode,
      localPort: c.localPort,
      publicUrl: c.publicUrl.trim() ? normalizeSakuraEndpoint(c.publicUrl.trim()) : ''
    }
  }
  configure(config: SakuraConfig): Promise<SakuraSettings> {
    return this.serialize(async () => {
      this.settings()
      if (this.state.roomId) throw new Error('请先关闭当前远程房间再修改网络设置')
      const validated = this.validateConfig(config)
      mkdirSync(this.directory, { recursive: true, mode: 0o700 })
      // This file holds non-secret network preferences only; never accepts SakuraFrp credentials.
      writeFileSync(`${this.storePath}.tmp`, JSON.stringify(validated), { mode: 0o600 })
      renameSync(`${this.storePath}.tmp`, this.storePath)
      await this.stopNow()
      this.config = validated
      return this.settings()
    })
  }
  status(): SakuraStatus {
    return { ...this.state }
  }
  private patch(patch: Partial<SakuraStatus>): void {
    this.state = { ...this.state, ...patch }
    this.emitStatus(this.status())
  }
  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const next = this.transition.catch(() => undefined).then(run)
    this.transition = next
    return next
  }
  startService(): Promise<SakuraStatus> {
    return this.serialize(async () => {
      await this.startServiceNow()
      return this.status()
    })
  }
  private async startServiceNow(): Promise<void> {
    this.settings()
    if (this.config.mode !== 'sakura') throw new Error('请先选择樱花穿透模式')
    if (this.room) return
    this.patch({ service: 'starting', error: null })
    try {
      const room = new SakuraRoomServer(this.emitEvent, [origin], false)
      this.room = room
      await room.listen(this.config.localPort)
      this.patch({ service: 'listening' })
      this.monitor = setInterval(() => {
        if (this.config.publicUrl) void this.verify()
      }, 20_000)
      this.monitor.unref()
      if (this.config.publicUrl) void this.verify()
    } catch {
      await this.stopNow()
      const message = '无法启动本地 BP 服务，请检查端口占用和系统权限'
      this.patch({ service: 'failed', error: message })
      throw new Error(message)
    }
  }
  start(): Promise<{ roomId: string; invitationLink: string }> {
    return this.serialize(async () => {
      this.settings()
      if (this.state.roomId) throw new Error('请先关闭当前远程房间')
      if (!this.config.publicUrl) throw new Error('请在远程 BP 网络设置中填写公网 HTTPS/WSS 地址')
      await this.startServiceNow()
      const room = this.room!
      room.activate()
      const invitationLink = createSakuraInvitationLink({
        version: SAKURA_WIRE_VERSION,
        endpoint: this.config.publicUrl,
        roomId: room.roomId,
        credential: room.credential
      })
      this.patch({ roomId: room.roomId, invitationLink })
      return { roomId: room.roomId, invitationLink }
    })
  }
  verify(): Promise<SakuraStatus> {
    if (this.probing) return this.probing
    const room = this.room
    if (!room) return Promise.resolve(this.status())
    if (!this.config.publicUrl) {
      this.patch({ publicConnection: 'failed', error: '请先填写并保存公网 HTTPS/WSS 地址' })
      return Promise.resolve(this.status())
    }
    if (this.state.publicConnection !== 'verified') this.patch({ publicConnection: 'checking' })
    const task = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.config.publicUrl, {
        origin,
        handshakeTimeout: 8000,
        maxPayload: 4096,
        perMessageDeflate: false,
        rejectUnauthorized: true,
        followRedirects: false
      })
      this.probe = ws
      let settled = false
      const timer = setTimeout(
        () => finish(new Error('公网 WSS 验证超时，请检查隧道、自动 HTTPS、证书及访问认证设置')),
        10_000
      )
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (this.probe === ws) this.probe = null
        ws.terminate()
        if (error) reject(error)
        else resolve()
      }
      ws.on('open', () =>
        ws.send(
          JSON.stringify({
            type: 'SAKURA_PROBE',
            version: SAKURA_WIRE_VERSION,
            protocolVersion: REMOTE_BP_PROTOCOL_VERSION,
            token: room.probeToken
          })
        )
      )
      ws.on('message', (raw) => {
        try {
          const message = JSON.parse(raw.toString())
          if (
            message.type !== 'SAKURA_PROBE_OK' ||
            message.roomId !== room.roomId ||
            message.version !== SAKURA_WIRE_VERSION
          )
            throw new Error()
          finish()
        } catch {
          finish(new Error('公网地址未连接到当前 BP 房间'))
        }
      })
      ws.on('error', () => finish(new Error('公网 WSS 连接失败，请检查域名、端口、证书和隧道状态')))
      ws.on('close', () => finish(new Error('公网 WSS 验证未完成')))
    })
      .then(
        () => {
          if (this.room === room)
            this.patch({
              publicConnection: 'verified',
              checkedAt: new Date().toISOString(),
              error: null
            })
        },
        (error: Error) => {
          if (this.room === room)
            this.patch({
              publicConnection: 'failed',
              checkedAt: new Date().toISOString(),
              error: error.message
            })
        }
      )
      .then(() => this.status())
      .finally(() => {
        if (this.probing === task) this.probing = null
      })
    this.probing = task
    return task
  }
  stopService(): Promise<SakuraStatus> {
    return this.serialize(async () => {
      if (this.state.roomId) throw new Error('请先关闭当前远程房间再停止本地服务')
      await this.stopNow()
      return this.status()
    })
  }
  stop(): Promise<void> {
    return this.serialize(() => this.stopNow())
  }
  private async stopNow(): Promise<void> {
    if (this.monitor) clearInterval(this.monitor)
    this.monitor = null
    const room = this.room
    this.room = null
    this.probe?.terminate()
    this.probe = null
    await this.probing
    await room?.close()
    this.patch(idle())
  }
  getRoom(roomId: string): SakuraRoomServer {
    if (!this.room || this.state.roomId !== roomId) throw new Error('樱花房间已失效')
    return this.room
  }
}
