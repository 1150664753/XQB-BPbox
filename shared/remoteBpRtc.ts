/** Connection state, bounded recovery and host-authorized TURN fallback only. */
export type RtcPhase =
  | 'idle'
  | 'signaling'
  | 'ice-checking'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed'
  | 'closed'
export type RtcSignalType = 'OFFER' | 'ANSWER' | 'ICE_CANDIDATE' | 'ICE_RESTART_REQUEST'

/** Opening listeners must be removed after open: later socket errors belong to reconnect. */
export function waitForSignalingSocket(
  socket: WebSocket,
  timeoutMs: number,
  isCurrent: () => boolean
): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error): void => {
      window.clearTimeout(timer)
      socket.removeEventListener('open', onOpen)
      socket.removeEventListener('error', onError)
      socket.removeEventListener('close', onClose)
      if (error) reject(error)
      else resolve()
    }
    const onOpen = (): void => finish(isCurrent() ? undefined : new Error('信令连接请求已取消'))
    const onError = (): void => {
      finish(new Error('连接信令服务器失败'))
      socket.close()
    }
    const onClose = (): void => finish(new Error('信令连接在建立完成前关闭'))
    const timer = window.setTimeout(() => {
      finish(new Error('连接信令服务器超时'))
      socket.close()
    }, timeoutMs)
    socket.addEventListener('open', onOpen)
    socket.addEventListener('error', onError)
    socket.addEventListener('close', onClose)
  })
}

export const RTC_TIMING = {
  totalMs: 120_000,
  iceRoundMs: 45_000,
  dataChannelMs: 20_000,
  disconnectedGraceMs: 15_000,
  maxRestarts: 2,
  signalTtlMs: 120_000,
  maxCandidates: 256,
  relayFallbackMs: 5_000,
  udpPreferenceMs: 3_000
} as const

export interface BufferedRtcSignal {
  type: string
  payload: Record<string, unknown>
  receivedAt: number
}

/** Bounded inbox used before room identity / the peer exists. Never replay across rooms. */
export function bufferRtcSignal(
  queue: BufferedRtcSignal[],
  type: string,
  payload: Record<string, unknown>
): void {
  const now = Date.now()
  while (
    queue.length &&
    (now - queue[0]!.receivedAt > RTC_TIMING.signalTtlMs ||
      queue.length >= RTC_TIMING.maxCandidates)
  )
    queue.shift()
  queue.push({ type, payload, receivedAt: now })
}

export function candidateDetails(candidate: RTCIceCandidateInit): Record<string, unknown> {
  const parts = (candidate.candidate ?? '').trim().split(/\s+/)
  return {
    candidateType:
      enumValue(parts.includes('typ') ? parts[parts.indexOf('typ') + 1] : null, [
        'host',
        'srflx',
        'prflx',
        'relay'
      ]) ?? 'unknown',
    protocol: enumValue(parts[2]?.toLowerCase(), ['udp', 'tcp']) ?? 'unknown',
    endOfCandidates: !candidate.candidate
  }
}

function ufrags(description: RTCSessionDescriptionInit | null): string[] {
  return [...(description?.sdp ?? '').matchAll(/^a=ice-ufrag:(.+)$/gm)].map((match) =>
    match[1]!.trim()
  )
}

function enumValue(value: unknown, allowed: string[]): string | null {
  return typeof value === 'string' && allowed.includes(value) ? value : null
}

export type RtcConnectionMode = 'p2p' | 'turn'
export type RtcConnectionPath = 'unknown' | 'p2p' | 'turn-udp' | 'turn-tcp' | 'turn-relay'

interface RtcSessionOptions {
  connectionId: string
  peerId: string
  roomId: string
  offerer: boolean
  iceServers: RTCIceServer[]
  resumeMode?: RtcConnectionMode
  canUseTurn?: () => boolean
  fetchTurn?: () => Promise<Record<string, unknown> | null>
  send: (type: RtcSignalType, payload: Record<string, unknown>) => boolean
  onState: (state: RtcPhase, reason: string | null) => void
  onPath?: (path: RtcConnectionPath) => void
  onMessage: (data: unknown, stream?: 'control' | 'assets') => void
  onAssetChannelClosed?: () => void
}
/** Only credential-free STUN/TURN endpoints may be retained, never SDP or peer addresses. */
export function iceServerEndpoint(value: unknown): string | null {
  return typeof value === 'string' &&
    value.length <= 512 &&
    /^(?:stun|stuns|turn|turns):[a-z0-9.\-\[\]:]+(?:\?transport=(?:udp|tcp))?$/i.test(value)
    ? value
    : null
}

/** Public build-time configuration may only contain discovery servers. Paid relays are room-scoped. */
export function directIceServers(servers: RTCIceServer[]): RTCIceServer[] {
  return servers.flatMap((server) => {
    const urls = (Array.isArray(server.urls) ? server.urls : [server.urls]).filter((url) =>
      /^stuns?:/i.test(url)
    )
    return urls.length ? [{ urls }] : []
  })
}

export function readTurnCredentials(payload: Record<string, unknown>): {
  iceServers: RTCIceServer[]
  expiresAt: number
} {
  if (
    !Number.isFinite(payload.expiresAt) ||
    Number(payload.expiresAt) <= Date.now() ||
    !Array.isArray(payload.iceServers) ||
    !payload.iceServers.length ||
    payload.iceServers.length > 8
  )
    throw new Error('中继凭证无效或已过期')
  const iceServers: RTCIceServer[] = payload.iceServers.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object') throw new Error('中继配置无效')
    const value = entry as Record<string, unknown>
    const urls = Array.isArray(value.urls) ? value.urls : [value.urls]
    if (
      !urls.length ||
      urls.length > 8 ||
      urls.some((url) => !iceServerEndpoint(url) || !/^turns?:/i.test(String(url))) ||
      typeof value.username !== 'string' ||
      !value.username ||
      value.username.length > 2048 ||
      typeof value.credential !== 'string' ||
      !value.credential ||
      value.credential.length > 2048
    )
      throw new Error('中继配置无效')
    return {
      urls: urls as string[],
      username: value.username,
      credential: value.credential
    }
  })
  return { iceServers, expiresAt: Number(payload.expiresAt) }
}

interface CandidateEntry {
  generation: number
  candidate: RTCIceCandidateInit
  receivedAt: number
}
interface LocalSignal {
  type: RtcSignalType
  payload: Record<string, unknown>
  createdAt: number
}

export class RemoteBpRtcSession {
  readonly pc: RTCPeerConnection
  channel: RTCDataChannel | null = null
  assetChannel: RTCDataChannel | null = null
  phase: RtcPhase = 'idle'
  path: RtcConnectionPath = 'unknown'
  private mode: RtcConnectionMode
  private modeLocked: boolean
  private active = true
  private chain: Promise<void> = Promise.resolve()
  private generation = 0
  private remoteGeneration = -1
  private candidates: CandidateEntry[] = []
  private seenCandidates = new Set<string>()
  private localSignals: LocalSignal[] = []
  private localCandidates: RTCIceCandidateInit[] = []
  private localReady = false
  private restartQueued = false
  private restartInFlight = false
  private restartCount = 0
  private episodeStartedAt: number | null = Date.now()
  private roundStartedAt = Date.now()
  private readonly startedAt = Date.now()
  private iceConnectedAt: number | null = null
  private channelClosingAt: number | null = null
  private disconnectedAt: number | null = null
  private readonly timer: number
  private fallbackTimer: number | null = null
  private fallbackAttempts = 0
  private fetchingTurn = false
  private stagedTurn: Record<string, unknown> | null = null
  relayExpiresAt: number | null = null
  private turnRefreshLeadMs = 90_000
  private lastRelayRefreshAt = -Infinity
  private relayServers: RTCIceServer[] = []
  private tcpFallbackAt: number | null = null
  private pathTimer: number | null = null
  private pathEpoch = 0
  private pathVerifiedGeneration = -1
  private iceTransport: RTCIceTransport | null = null
  private readonly onPairChanged = (): void => this.refreshPath()

  constructor(private readonly options: RtcSessionOptions) {
    this.mode = options.resumeMode ?? 'p2p'
    this.modeLocked = options.resumeMode !== undefined
    this.pc = new RTCPeerConnection({
      iceServers: directIceServers(options.iceServers),
      iceTransportPolicy: this.mode === 'turn' ? 'relay' : 'all'
    })
    this.log('PeerConnection created')
    for (const event of [
      'signalingstatechange',
      'icegatheringstatechange',
      'iceconnectionstatechange',
      'connectionstatechange'
    ]) {
      this.pc.addEventListener(event, () => {
        if (!this.active) return
        this.log(event)
        this.reconcile()
        this.refreshPath()
      })
    }
    this.pc.addEventListener('icecandidate', (event) => {
      if (!this.active) return
      const candidate = event.candidate?.toJSON() ?? { candidate: '' }
      if (this.localCandidates.length >= RTC_TIMING.maxCandidates) return
      this.localCandidates.push(candidate)
      this.flushLocalCandidates()
    })
    this.pc.addEventListener('icecandidateerror', (event) => {
      if (!this.active) return
      // A discovery server timeout, including 701, does not prove the selected path failed.
      this.log('candidate gathering error', {
        server: iceServerEndpoint(event.url),
        errorCode: event.errorCode,
        channelOpen: this.channel?.readyState === 'open'
      })
    })
    this.pc.addEventListener('datachannel', (event) => {
      if (
        this.active &&
        options.offerer &&
        event.channel.label === 'xqb-remote-bp-assets-v1' &&
        !this.assetChannel
      ) {
        this.installAssetChannel(event.channel)
        return
      }
      if (!this.active || event.channel.label !== 'xqb-remote-bp' || this.channel) {
        event.channel.close()
        return
      }
      this.installChannel(event.channel)
    })
    if (options.offerer)
      this.installChannel(this.pc.createDataChannel('xqb-remote-bp', { ordered: true }))
    // This interval checks connection deadlines and credential expiry, never network quality.
    this.timer = window.setInterval(() => this.reconcile(), 1000)
    if (options.offerer && !this.modeLocked)
      this.fallbackTimer = window.setTimeout(() => {
        this.fallbackTimer = null
        void this.tryTurnFallback()
      }, RTC_TIMING.relayFallbackMs)
    this.transition('signaling', null)
  }

  get connectionId(): string {
    return this.options.connectionId
  }
  private get controlOpen(): boolean {
    return this.channel?.readyState === 'open'
  }
  get connectionMode(): RtcConnectionMode {
    return this.mode
  }
  get selectedMode(): RtcConnectionMode | undefined {
    return this.modeLocked ? this.mode : undefined
  }
  get needsTurnRefresh(): boolean {
    return (
      this.relayExpiresAt === null || this.relayExpiresAt - Date.now() <= this.turnRefreshLeadMs
    )
  }
  authorizationChanged(): void {
    if (Date.now() - this.startedAt >= RTC_TIMING.relayFallbackMs) void this.tryTurnFallback()
  }
  stageTurn(payload: Record<string, unknown>): void {
    if (!this.active) return
    readTurnCredentials(payload)
    // Credentials alone never change a working connection's ICE policy.
    this.stagedTurn = payload
  }
  private async tryTurnFallback(): Promise<void> {
    if (
      !this.active ||
      !this.options.offerer ||
      this.modeLocked ||
      this.mode !== 'p2p' ||
      this.controlOpen ||
      this.fetchingTurn ||
      this.fallbackAttempts >= 3 ||
      !this.options.canUseTurn?.() ||
      !this.options.fetchTurn
    )
      return
    this.fallbackAttempts++
    this.fetchingTurn = true
    try {
      const payload = await this.options.fetchTurn()
      // Recheck after the provider round trip: open, room close, peer replacement and revocation win.
      if (!this.active || this.modeLocked || this.controlOpen || !this.options.canUseTurn?.())
        return
      if (!payload) throw new Error('TURN_UNAVAILABLE')
      readTurnCredentials(payload)
      let installationFailed = false
      await this.enqueue(async () => {
        // Commit the policy between SDP operations, and recheck success after waiting for the queue.
        if (!this.active || this.modeLocked || this.controlOpen || !this.options.canUseTurn?.())
          return
        this.mode = 'turn'
        this.path = 'unknown'
        try {
          if (!this.installTurn(payload)) throw new Error('TURN_PROVIDER_INVALID')
        } catch {
          // A rejected RTCConfiguration must follow the credential retry path, not SDP recovery.
          this.mode = 'p2p'
          installationFailed = true
          return
        }
        this.requestRestart('P2P 数据通道 5 秒未打开，切换 TURN', true)
      })
      if (installationFailed) throw new Error('TURN_PROVIDER_INVALID')
    } catch {
      if (!this.active) return
      this.mode = 'p2p'
      this.clearRelayConfiguration()
      this.turnFailed('TURN_UNAVAILABLE')
      if (!this.modeLocked && this.fallbackAttempts < 3)
        this.fallbackTimer = window.setTimeout(() => {
          this.fallbackTimer = null
          void this.tryTurnFallback()
        }, this.fallbackAttempts * 10_000)
    } finally {
      this.fetchingTurn = false
    }
  }
  private installTurn(payload: Record<string, unknown>): boolean {
    if (!this.active || this.mode !== 'turn') return false
    const credentials = readTurnCredentials(payload)
    this.stagedTurn = payload
    if (
      credentials.expiresAt === this.relayExpiresAt &&
      JSON.stringify(credentials.iceServers) === JSON.stringify(this.relayServers)
    )
      return true
    const udp = credentials.iceServers.flatMap((server) => {
      const urls = (Array.isArray(server.urls) ? server.urls : [server.urls]).filter(
        (url) => /^turn:/i.test(url) && !/transport=tcp/i.test(url)
      )
      return urls.length ? [{ ...server, urls }] : []
    })
    const preferUdp = this.relayExpiresAt === null && udp.length > 0
    const hasTcp = credentials.iceServers.some((server) =>
      (Array.isArray(server.urls) ? server.urls : [server.urls]).some(
        (url) => /^turns:/i.test(url) || /transport=tcp/i.test(url)
      )
    )
    this.pc.setConfiguration({
      iceServers: preferUdp ? udp : credentials.iceServers,
      iceTransportPolicy: 'relay'
    })
    this.relayServers = credentials.iceServers
    this.relayExpiresAt = credentials.expiresAt
    this.tcpFallbackAt = preferUdp && hasTcp ? Date.now() + RTC_TIMING.udpPreferenceMs : null
    this.turnRefreshLeadMs = Math.min(
      90_000,
      Math.max(1000, (credentials.expiresAt - Date.now()) / 3)
    )
    this.log('TURN credentials installed')
    return true
  }
  private enableTcpFallback(): boolean {
    if (this.tcpFallbackAt === null || this.mode !== 'turn') return false
    this.tcpFallbackAt = null
    this.pc.setConfiguration({ iceServers: this.relayServers, iceTransportPolicy: 'relay' })
    this.log('TURN TCP fallback enabled')
    return true
  }
  turnFailed(code: string): void {
    this.recordError(/^TURN_[A-Z_]+$/.test(code) ? code : 'TURN_UNAVAILABLE', 'TURN 凭证暂不可用')
  }
  private clearRelayConfiguration(): void {
    this.stagedTurn = null
    this.relayExpiresAt = null
    this.relayServers = []
    this.tcpFallbackAt = null
    this.pc.setConfiguration({
      iceServers: this.mode === 'p2p' ? directIceServers(this.options.iceServers) : [],
      iceTransportPolicy: this.mode === 'turn' ? 'relay' : 'all'
    })
  }
  clearTurn(reason: string): void {
    if (!this.active) return
    this.clearRelayConfiguration()
    if (this.mode === 'turn') this.fail(reason, 'TURN_NOT_AUTHORIZED')
  }
  recordError(code: string, reason: string): void {
    this.log('connection error', {
      code: /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'RTC_ERROR',
      reason
    })
  }
  sendAssetReceipt(
    id: string,
    status: 'received' | 'verified' | 'failed',
    bytes: number,
    reason: string | null = null
  ): void {
    if (!this.active || this.assetChannel?.readyState !== 'open') return
    try {
      this.assetChannel.send(
        JSON.stringify({ type: 'ASSET_RECEIPT_V1', id, status, bytes, reason })
      )
    } catch {
      this.log('asset receipt unavailable')
    }
  }
  private receiveAssetReceipt(data: unknown): void {
    if (typeof data !== 'string' || data.length > 1024) return
    try {
      const value = JSON.parse(data)
      if (
        value?.type === 'ASSET_RECEIPT_V1' &&
        ['received', 'verified', 'failed'].includes(value.status) &&
        Number.isSafeInteger(value.bytes) &&
        value.bytes >= 0
      )
        this.log('asset receipt', { status: value.status })
    } catch {
      /* Optional receipt; never enters BP dispatch. */
    }
  }

  // Event-driven, bounded lookup solely for the current connection label / relay policy.
  // No RTT, bandwidth, counters, samples, history, global registry or export is collected.
  private refreshPath(): void {
    if (
      !this.active ||
      this.channel?.readyState !== 'open' ||
      this.pc.signalingState !== 'stable' ||
      this.remoteGeneration !== this.generation ||
      !['connected', 'completed'].includes(this.pc.iceConnectionState)
    )
      return
    const transport = this.pc.sctp?.transport.iceTransport
    if (transport && transport !== this.iceTransport) {
      this.iceTransport?.removeEventListener('selectedcandidatepairchange', this.onPairChanged)
      this.iceTransport = transport
      transport.addEventListener('selectedcandidatepairchange', this.onPairChanged)
    }
    if (this.pathTimer !== null) window.clearTimeout(this.pathTimer)
    const epoch = ++this.pathEpoch
    const inspect = async (attempt: number): Promise<void> => {
      this.pathTimer = null
      if (!this.active || epoch !== this.pathEpoch) return
      try {
        const stats = await this.pc.getStats()
        if (!this.active || epoch !== this.pathEpoch) return
        let pairId: string | undefined
        stats.forEach((report) => {
          if (report.type === 'transport' && report.selectedCandidatePairId)
            pairId = report.selectedCandidatePairId
        })
        if (!pairId) {
          const nominated: string[] = []
          stats.forEach((report) => {
            if (
              report.type === 'candidate-pair' &&
              report.nominated &&
              report.state === 'succeeded'
            )
              nominated.push(report.id)
          })
          if (nominated.length === 1) pairId = nominated[0]
        }
        const pair = pairId ? stats.get(pairId) : undefined
        const local = pair ? stats.get(pair.localCandidateId) : undefined
        const remote = pair ? stats.get(pair.remoteCandidateId) : undefined
        if (local?.candidateType && remote?.candidateType) {
          const relay = local.candidateType === 'relay' || remote.candidateType === 'relay'
          const protocol =
            local.candidateType === 'relay' ? local.relayProtocol : remote.relayProtocol
          const path: RtcConnectionPath = !relay
            ? 'p2p'
            : protocol === 'udp'
              ? 'turn-udp'
              : ['tcp', 'tls'].includes(protocol)
                ? 'turn-tcp'
                : 'turn-relay'
          // During ICE restart getStats may still expose the previous direct pair.
          if (
            this.mode === 'turn' &&
            (local.candidateType !== 'relay' || remote.candidateType !== 'relay')
          ) {
            // Keep waiting for ICE events / normal recovery deadlines. The old pair can remain
            // selected while the relay restart is still checking; do not preempt the TCP fallback.
          } else {
            if (this.mode === 'p2p' && relay) {
              this.fail('P2P 连接意外使用中继', 'RTC_POLICY_MISMATCH')
              return
            }
            this.pathVerifiedGeneration = this.generation
            this.path = path
            this.options.onPath?.(path)
            this.reconcile()
            return
          }
        }
      } catch {
        this.log('selected path unavailable')
      }
      if (this.active && epoch === this.pathEpoch && attempt < 5)
        this.pathTimer = window.setTimeout(() => void inspect(attempt + 1), 500)
    }
    void inspect(0)
  }
  private log(event: string, details: Record<string, unknown> = {}): void {
    console.info('[Remote BP RTC]', {
      event,
      connectionId: this.connectionId,
      mode: this.mode,
      phase: this.phase,
      negotiationId: this.generation,
      iceState: this.pc.iceConnectionState,
      connectionState: this.pc.connectionState,
      dataChannelState: this.channel?.readyState ?? null,
      ...details
    })
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    this.chain = this.chain
      .then(async () => {
        if (this.active) await operation()
      })
      .catch((error) => {
        if (!this.active) return
        this.log('negotiation error', {
          reason: error instanceof DOMException ? error.name : 'RTC_OPERATION_FAILED'
        })
        this.recordError('SDP_NEGOTIATION_FAILED', 'SDP 协商失败，正在受控恢复')
        this.restartQueued = false
        this.restartInFlight = false
        this.requestRestart('SDP 协商失败')
      })
    return this.chain
  }

  private async makeOffer(restart: boolean): Promise<void> {
    if (this.pc.signalingState === 'have-local-offer') {
      this.log('setLocalDescription rollback')
      await this.pc.setLocalDescription({ type: 'rollback' })
      if (!this.active) return
    }
    this.beginRound(this.generation + 1)
    this.log('OFFER create', { iceRestart: restart })
    const offer = await this.pc.createOffer({ iceRestart: restart })
    if (!this.active) return
    await this.setLocalAndSend('OFFER', offer)
  }

  private flushLocalCandidates(): void {
    if (!this.active || !this.localReady) return
    const currentUfrags = ufrags(this.pc.localDescription)
    for (const candidate of this.localCandidates.splice(0)) {
      const fragment =
        candidate.usernameFragment || /\bufrag\s+(\S+)/.exec(candidate.candidate ?? '')?.[1]
      if (fragment && currentUfrags.length && !currentUfrags.includes(fragment)) {
        this.log('old local candidate ignored')
        continue
      }
      this.rememberAndSend('ICE_CANDIDATE', { candidate })
    }
  }

  private rememberAndSend(type: RtcSignalType, data: Record<string, unknown>): void {
    if (!this.active) return
    if (this.localSignals.length >= RTC_TIMING.maxCandidates + 2) {
      this.log('signal buffer limit reached')
      return
    }
    const payload = {
      ...data,
      connectionId: this.connectionId,
      negotiationId: this.generation
    }
    const signal = { type, payload, createdAt: Date.now() }
    this.localSignals.push(signal)
    this.transmit(signal)
  }

  private transmit(signal: LocalSignal): void {
    let sent = false
    try {
      sent = this.options.send(signal.type, signal.payload)
    } catch (error) {
      this.log('signal send deferred', {
        reason: error instanceof DOMException ? error.name : 'SIGNAL_SEND_FAILED'
      })
    }
    this.log(
      `${signal.type === 'ICE_CANDIDATE' ? 'candidate' : signal.type} ${sent ? 'sent' : 'cached for signaling recovery'}`,
      signal.type === 'ICE_CANDIDATE'
        ? candidateDetails(signal.payload.candidate as RTCIceCandidateInit)
        : {}
    )
  }

  replay(): void {
    if (!this.active) return
    this.localSignals = this.localSignals.filter(
      (signal) => Date.now() - signal.createdAt <= RTC_TIMING.signalTtlMs
    )
    for (const signal of this.localSignals) this.transmit(signal)
    if (!this.options.offerer && this.restartInFlight) {
      this.transmit({
        type: 'ICE_RESTART_REQUEST',
        payload: {
          connectionId: this.connectionId,
          negotiationId: this.generation
        },
        createdAt: Date.now()
      })
    }
  }

  private async drainCandidates(): Promise<void> {
    if (!this.pc.remoteDescription || this.remoteGeneration !== this.generation) return
    while (this.active) {
      const index = this.candidates.findIndex((entry) => entry.generation <= this.remoteGeneration)
      if (index < 0) return
      const entry = this.candidates.splice(index, 1)[0]!
      if (
        entry.generation !== this.remoteGeneration ||
        Date.now() - entry.receivedAt > RTC_TIMING.signalTtlMs
      )
        continue
      const fragment =
        entry.candidate.usernameFragment ||
        /\bufrag\s+(\S+)/.exec(entry.candidate.candidate ?? '')?.[1]
      const remoteUfrags = ufrags(this.pc.remoteDescription)
      if (fragment && remoteUfrags.length && !remoteUfrags.includes(fragment)) {
        this.log('old remote candidate ignored', candidateDetails(entry.candidate))
        continue
      }
      try {
        await this.pc.addIceCandidate(entry.candidate)

        if (this.active) this.log('addIceCandidate success', candidateDetails(entry.candidate))
      } catch (error) {
        this.recordError('ADD_CANDIDATE_FAILED', '部分 ICE 候选应用失败，继续尝试其他候选')
        // One duplicate, obsolete or malformed candidate must not discard the rest of the queue.
        if (this.active)
          this.log('addIceCandidate failure', {
            ...candidateDetails(entry.candidate),
            reason: error instanceof DOMException ? error.name : 'ADD_CANDIDATE_FAILED'
          })
      }
    }
  }

  start(): Promise<void> {
    return this.enqueue(async () => {
      if (this.mode === 'turn' && this.options.offerer) {
        const payload = this.options.canUseTurn?.() ? await this.options.fetchTurn?.() : null
        if (!this.active) return
        if (!payload || !this.options.canUseTurn?.() || !this.installTurn(payload)) {
          this.fail('无法恢复 TURN 连接：缺少授权或有效凭证', 'TURN_REQUIRED')
          return
        }
      }
      if (this.options.offerer && this.generation === 0) await this.makeOffer(false)
    })
  }
  receive(type: string, payload: Record<string, unknown>): Promise<void> {
    if (
      payload.connectionId !== this.connectionId ||
      !Number.isSafeInteger(payload.negotiationId)
    ) {
      this.log('stale or invalid signal ignored', { type })
      return Promise.resolve()
    }
    const generation = Number(payload.negotiationId)
    // Signaling can be offline for a whole round. The next offer may skip a generation.
    if (generation < 0 || generation > this.generation + RTC_TIMING.maxRestarts + 1) {
      this.log('out-of-window signal ignored', {
        type,
        receivedGeneration: generation
      })
      return Promise.resolve()
    }
    return this.enqueue(async () => {
      if (generation < this.generation) {
        this.log('old negotiation ignored', {
          type,
          receivedGeneration: generation
        })
        return
      }
      if (type === 'ICE_RESTART_REQUEST') {
        if (this.options.offerer && generation === this.generation) {
          if (payload.connectionMode === 'p2p' && this.mode === 'turn' && !this.modeLocked) {
            // The player already opened P2P before seeing our fallback offer. Preserve it.
            this.mode = 'p2p'
            this.modeLocked = true
            this.clearRelayConfiguration()
            this.restartInFlight = false
            this.restartQueued = false
            this.requestRestart('保留已经建立的 P2P 连接', true)
          } else if (!payload.connectionMode || payload.connectionMode === this.mode) {
            this.requestRestart('远端请求 ICE Restart')
          }
        }
        return
      }
      if (type === 'ICE_CANDIDATE') {
        const value = payload.candidate as RTCIceCandidateInit | undefined
        if (!value || typeof value.candidate !== 'string') {
          this.log('invalid candidate ignored')
          return
        }
        const candidate = value
        this.log('candidate received', {
          ...candidateDetails(candidate),
          receivedGeneration: generation
        })
        const key = JSON.stringify([
          generation,
          candidate.candidate,
          candidate.sdpMid,
          candidate.sdpMLineIndex,
          candidate.usernameFragment
        ])
        if (this.seenCandidates.has(key)) {
          this.log('duplicate candidate ignored', candidateDetails(candidate))
          return
        }
        if (
          this.candidates.length >= RTC_TIMING.maxCandidates ||
          this.seenCandidates.size >= RTC_TIMING.maxCandidates * 2
        ) {
          this.log('candidate buffer limit reached')
          return
        }
        this.seenCandidates.add(key)
        this.candidates.push({ generation, candidate, receivedAt: Date.now() })
        this.log('candidate buffered', {
          ...candidateDetails(candidate),
          count: this.candidates.length
        })
        await this.drainCandidates()
        return
      }
      const description = payload.description as RTCSessionDescriptionInit | undefined
      const expected = this.options.offerer ? 'answer' : 'offer'
      if (
        type !== expected.toUpperCase() ||
        description?.type !== expected ||
        typeof description.sdp !== 'string' ||
        !description.sdp
      ) {
        this.log('unexpected SDP ignored', { type })
        return
      }
      const requestedMode = payload.connectionMode
      if (requestedMode !== 'p2p' && requestedMode !== 'turn') {
        this.fail('连接策略不兼容，请同步更新房主、网页和信令服务', 'RTC_POLICY_UNSUPPORTED')
        return
      }
      if (requestedMode !== this.mode) {
        if (this.options.offerer || this.modeLocked || requestedMode !== 'turn') {
          // A P2P channel may open at the player just before the host's timeout offer arrives.
          // Reject that offer instead of changing a connection that already succeeded.
          if (!this.options.offerer && this.mode === 'p2p' && this.modeLocked) {
            this.transmit({
              type: 'ICE_RESTART_REQUEST',
              payload: {
                connectionId: this.connectionId,
                negotiationId: generation,
                connectionMode: 'p2p'
              },
              createdAt: Date.now()
            })
            return
          }
          this.fail('对端连接模式与本次连接不一致', 'RTC_POLICY_MISMATCH')
          return
        }
        this.mode = 'turn'
        this.path = 'unknown'
      }
      if (this.mode === 'turn') {
        if (!this.stagedTurn || !this.installTurn(this.stagedTurn)) {
          this.fail('TURN 协商缺少有效凭证', 'TURN_REQUIRED')
          return
        }
      }
      this.log(`${type} received`, { receivedGeneration: generation })
      if (this.remoteGeneration === generation) {
        if (!this.options.offerer) this.replay()
        this.log('duplicate SDP ignored')
        return
      }
      if (this.options.offerer) {
        if (generation !== this.generation || this.pc.signalingState !== 'have-local-offer') {
          this.log('unexpected ANSWER ignored')
          return
        }
      } else {
        this.beginRound(generation)
        if (this.tcpFallbackAt !== null && Date.now() >= this.tcpFallbackAt)
          this.enableTcpFallback()
        if (generation > 1) {
          this.restartInFlight = true
          this.log('ICE Restart started (remote)')
        }
      }
      this.log('setRemoteDescription start')
      await this.pc.setRemoteDescription(description)
      if (!this.active) return
      this.remoteGeneration = generation
      this.log('setRemoteDescription success')

      await this.drainCandidates()
      if (!this.active) return
      if (!this.options.offerer) {
        this.log('ANSWER create')
        const answer = await this.pc.createAnswer()
        if (!this.active) return
        await this.setLocalAndSend('ANSWER', answer)
      }
      this.reconcile()
      this.refreshPath()
    })
  }
  private beginRound(generation: number): void {
    ++this.pathEpoch
    if (this.pathTimer !== null) window.clearTimeout(this.pathTimer)
    this.pathTimer = null
    this.pathVerifiedGeneration = -1
    this.generation = generation
    this.roundStartedAt = Date.now()
    this.iceConnectedAt = null
    this.localReady = false
    this.localSignals = []
    this.localCandidates = []
    this.candidates = this.candidates.filter(
      (entry) =>
        entry.generation >= generation && Date.now() - entry.receivedAt <= RTC_TIMING.signalTtlMs
    )
    this.seenCandidates = new Set(
      this.candidates.map(({ generation: id, candidate: c }) =>
        JSON.stringify([id, c.candidate, c.sdpMid, c.sdpMLineIndex, c.usernameFragment])
      )
    )
    if (this.episodeStartedAt === null) this.episodeStartedAt = Date.now()
  }
  private async setLocalAndSend(
    type: 'OFFER' | 'ANSWER',
    description: RTCSessionDescriptionInit
  ): Promise<void> {
    await this.pc.setLocalDescription(description)
    if (!this.active) return
    this.localReady = true
    const local = this.pc.localDescription ?? description
    this.rememberAndSend(type, {
      description: { type: local.type, sdp: local.sdp },
      connectionMode: this.mode
    })
    this.flushLocalCandidates()
  }
  requestRestart(reason: string, roundTimedOut = false): void {
    if (!this.active || this.restartQueued || (this.restartInFlight && !roundTimedOut)) return
    if (this.restartCount >= RTC_TIMING.maxRestarts) {
      this.fail('ICE Restart 已达到最大重试次数', 'ICE_RESTART_EXHAUSTED')
      return
    }
    this.restartCount++
    this.restartQueued = true
    this.restartInFlight = true
    this.episodeStartedAt ??= Date.now()
    this.roundStartedAt = Date.now()
    this.transition('reconnecting', reason)
    void this.enqueue(async () => {
      if (this.options.offerer) {
        if (this.mode === 'turn' && this.needsTurnRefresh) {
          const payload = this.options.canUseTurn?.() ? await this.options.fetchTurn?.() : null
          if (!this.active) return
          if (payload && this.options.canUseTurn?.()) this.installTurn(payload)
          if (this.relayExpiresAt === null || this.relayExpiresAt <= Date.now()) {
            this.fail('TURN 恢复未取得有效凭证', 'TURN_REQUIRED')
            return
          }
        }
        await this.makeOffer(true)
      } else {
        this.transmit({
          type: 'ICE_RESTART_REQUEST',
          payload: {
            connectionId: this.connectionId,
            negotiationId: this.generation,
            connectionMode: this.mode
          },
          createdAt: Date.now()
        })
      }
      this.restartQueued = false
      this.reconcile()
      this.refreshPath()
    })
  }
  private installChannel(channel: RTCDataChannel): void {
    this.channel = channel
    channel.bufferedAmountLowThreshold = 16 * 1024
    for (const event of ['open', 'closing', 'close', 'error']) {
      channel.addEventListener(event, (rawEvent) => {
        if (!this.active || this.channel !== channel) return
        const error = (rawEvent as RTCErrorEvent).error
        this.log('DataChannel ' + event, {
          errorDetail: error?.errorDetail ?? null,
          sctpCauseCode: error?.sctpCauseCode ?? null
        })
        if (event === 'open' && this.mode === 'p2p') this.lockMode()
        this.reconcile()
        this.refreshPath()
        if (event === 'open' && !this.options.offerer && !this.assetChannel)
          this.installAssetChannel(
            this.pc.createDataChannel('xqb-remote-bp-assets-v1', { ordered: true })
          )
      })
    }
    channel.addEventListener('message', (event) => {
      if (this.active && this.channel === channel) this.options.onMessage(event.data, 'control')
    })
  }
  private installAssetChannel(channel: RTCDataChannel): void {
    this.assetChannel = channel
    channel.binaryType = 'arraybuffer'
    channel.bufferedAmountLowThreshold = 16 * 1024
    channel.addEventListener('message', (event) => {
      if (!this.active || this.assetChannel !== channel) return
      if (this.options.offerer) this.receiveAssetReceipt(event.data)
      else this.options.onMessage(event.data, 'assets')
    })
    for (const event of ['open', 'close', 'error'])
      channel.addEventListener(event, () => {
        if (!this.active || this.assetChannel !== channel) return
        this.log('asset channel ' + event)
        if (event === 'close') this.options.onAssetChannelClosed?.()
      })
  }
  private lockMode(): void {
    this.modeLocked = true
    if (this.fallbackTimer !== null) window.clearTimeout(this.fallbackTimer)
    this.fallbackTimer = null
    if (this.mode === 'p2p') this.stagedTurn = null
  }
  private reconcile(): void {
    if (!this.active) return
    const now = Date.now()
    const ice = this.pc.iceConnectionState
    const connection = this.pc.connectionState
    const healthyIce = ice === 'connected' || ice === 'completed'
    const channelOpen = this.channel?.readyState === 'open'
    if (channelOpen && this.mode === 'p2p') this.lockMode()
    this.localSignals = this.localSignals.filter((s) => now - s.createdAt <= RTC_TIMING.signalTtlMs)
    this.candidates = this.candidates.filter((c) => now - c.receivedAt <= RTC_TIMING.signalTtlMs)
    if (this.channel?.readyState === 'closing') {
      this.channelClosingAt ??= now
      if (now - this.channelClosingAt >= 10_000)
        this.fail('DataChannel 关闭超时', 'DATA_CHANNEL_CLOSE_TIMEOUT')
      return
    }
    if (connection === 'closed' || ice === 'closed' || this.channel?.readyState === 'closed') {
      this.fail('连接或 DataChannel 已关闭', 'DATA_CHANNEL_CLOSED')
      return
    }
    if (this.relayExpiresAt !== null && now >= this.relayExpiresAt) {
      this.fail('TURN 凭证已到期，未取得有效替换凭证', 'TURN_EXPIRED')
      return
    }
    if (this.episodeStartedAt !== null && now - this.episodeStartedAt >= RTC_TIMING.totalMs) {
      this.fail('连接超过 120 秒总恢复时限', 'RTC_TIMEOUT')
      return
    }
    if (
      channelOpen &&
      healthyIce &&
      connection === 'connected' &&
      this.remoteGeneration === this.generation &&
      this.pc.signalingState === 'stable' &&
      !this.restartQueued &&
      (this.mode === 'p2p' || this.pathVerifiedGeneration === this.generation)
    ) {
      this.lockMode()
      this.restartInFlight = false
      this.restartCount = 0
      this.episodeStartedAt = null
      this.disconnectedAt = null
      this.iceConnectedAt = null
      this.enableTcpFallback() // Availability for future recovery, not a path switch.
      this.transition('connected', null)
      if (
        this.mode === 'turn' &&
        this.options.offerer &&
        this.needsTurnRefresh &&
        !this.fetchingTurn &&
        now - this.lastRelayRefreshAt >= Math.min(30_000, this.turnRefreshLeadMs)
      ) {
        this.fetchingTurn = true
        this.lastRelayRefreshAt = now
        void this.options
          .fetchTurn?.()
          .then((payload) => {
            if (!this.active || !payload || !this.options.canUseTurn?.()) return
            const previousExpiry = this.relayExpiresAt
            this.installTurn(payload)
            if (previousExpiry !== this.relayExpiresAt) this.requestRestart('更新 TURN 凭证')
          })
          .catch(() => this.turnFailed('TURN_UNAVAILABLE'))
          .finally(() => {
            this.fetchingTurn = false
          })
      }
      return
    }
    if (this.episodeStartedAt === null) {
      this.episodeStartedAt = now
      this.roundStartedAt = now
    }
    if (ice === 'failed' || connection === 'failed') {
      this.requestRestart('ICE / PeerConnection 失败', this.enableTcpFallback())
    } else if (ice === 'disconnected' || connection === 'disconnected') {
      this.disconnectedAt ??= now
      this.transition('reconnecting', '网络暂时中断，等待恢复')
      if (now - this.disconnectedAt >= RTC_TIMING.disconnectedGraceMs)
        this.requestRestart('网络中断超过 15 秒')
    } else if (!this.restartInFlight) {
      this.disconnectedAt = null
      this.transition(
        healthyIce ? 'connecting' : ice === 'checking' ? 'ice-checking' : 'signaling',
        null
      )
    }
    if (this.generation > 0 && this.tcpFallbackAt !== null && now >= this.tcpFallbackAt) {
      this.enableTcpFallback()
      if (this.options.offerer) {
        this.requestRestart('TURN UDP 未就绪，加入 TCP 备用', true)
        return
      }
    }
    if (
      healthyIce &&
      this.remoteGeneration === this.generation &&
      this.pc.signalingState === 'stable'
    ) {
      this.iceConnectedAt ??= now
      if (now - this.iceConnectedAt >= RTC_TIMING.dataChannelMs) {
        this.iceConnectedAt = now
        this.requestRestart('数据通道未就绪', true)
      }
    } else {
      this.iceConnectedAt = null
      if (now - this.roundStartedAt >= RTC_TIMING.iceRoundMs)
        this.requestRestart('本轮 ICE / SDP 超过 45 秒', true)
    }
  }
  private transition(phase: RtcPhase, reason: string | null): void {
    if (this.phase === phase) return
    this.phase = phase
    this.log('state transition', { reason })
    this.options.onState(phase, reason)
  }
  private fail(reason: string, code?: string): void {
    if (!this.active) return
    if (code) this.recordError(code, reason)
    this.dispose()
    this.transition('failed', reason)
  }
  close(_reason = 'ASSET_CANCELLED', initiator = 'application-close'): void {
    if (!this.active) return
    this.log('application close', { initiator })
    this.dispose()
    this.transition('closed', null)
  }
  private dispose(): void {
    this.active = false
    ++this.pathEpoch
    window.clearInterval(this.timer)
    if (this.fallbackTimer !== null) window.clearTimeout(this.fallbackTimer)
    if (this.pathTimer !== null) window.clearTimeout(this.pathTimer)
    this.iceTransport?.removeEventListener('selectedcandidatepairchange', this.onPairChanged)
    this.stagedTurn = null
    this.relayServers = []
    this.candidates = []
    this.seenCandidates.clear()
    this.localSignals = []
    this.localCandidates = []
    this.channel?.close()
    this.assetChannel?.close()
    this.pc.close()
    this.log('PeerConnection destroyed')
  }
}
