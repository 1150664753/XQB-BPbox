/** Connection-layer only: BP messages and asset transfer stay in the existing adapters. */
import {
  createRtcDiagnostics,
  iceServerEndpoint,
  type RtcDiagnostics,
  type AssetTransferDiagnostic
} from './remoteBpDiagnostics'
export { getRtcDiagnostics, exportRtcDiagnostics, type RtcDiagnostics } from './remoteBpDiagnostics'
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
function nonnegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

interface RtcSessionOptions {
  connectionId: string
  peerId: string
  roomId: string
  offerer: boolean
  iceServers: RTCIceServer[]
  send: (type: RtcSignalType, payload: Record<string, unknown>) => boolean
  onState: (state: RtcPhase, reason: string | null) => void
  onMessage: (data: unknown, stream?: 'control' | 'assets') => void
  onAssetChannelClosed?: () => void
  onDiagnostics?: (diagnostic: RtcDiagnostics) => void
  prepareRestart?: () => Promise<void>
  testOnlyForceRelay?: boolean
  turnProvider?: unknown
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
  private totalRestartCount = 0
  private episodeStartedAt: number | null = Date.now()
  private roundStartedAt = Date.now()
  private iceConnectedAt: number | null = null
  private disconnectedAt: number | null = null
  private readonly timer: number
  relayExpiresAt: number | null = null
  private lastRelayRefreshAt = 0
  private lastStatsAt = -5_000
  private statsPending = false
  private verifiedGeneration = -1
  private verifiedAt = -Infinity
  private relayVerificationStartedAt: number | null = null
  private diagnostic: RtcDiagnostics
  private turnRequestedAt: number | null = null
  private turnRefreshLeadMs = 90_000
  private relayServers: RTCIceServer[] = []
  private tcpFallbackAt: number | null = null
  private triedEarlyRelay = false
  private refreshingRelay = false
  private iceErrorLoggedAt = new Map<string, number>()
  private sample: {
    pairId: string
    at: number
    sent: number
    received: number
    assetSent: number
    packetsSent: number | null
    packetsDiscarded: number | null
  } | null = null

  constructor(private readonly options: RtcSessionOptions) {
    this.diagnostic = createRtcDiagnostics(
      options.connectionId,
      options.roomId,
      options.peerId,
      options.offerer,
      Boolean(options.testOnlyForceRelay)
    )
    this.pc = new RTCPeerConnection({
      iceServers: directIceServers(options.iceServers),
      iceTransportPolicy: options.testOnlyForceRelay ? 'relay' : 'all'
    })
    this.setTurnProvider(options.turnProvider)
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
      })
    }
    this.pc.addEventListener('icecandidate', (event) => {
      if (!this.active) return
      if (!event.candidate) {
        this.diagnostic.candidates.localComplete = true
        // Empty candidate is the existing signaling schema's end-of-candidates marker.
        this.localCandidates.push({ candidate: '' })
        this.flushLocalCandidates()
        this.log('candidate gathering complete')
        return
      }
      const candidate = event.candidate.toJSON()
      this.diagnostic.candidates.generated += 1
      if (candidateDetails(candidate).candidateType === 'relay')
        this.diagnostic.candidates.localRelay++
      this.log('candidate generated', candidateDetails(candidate))
      if (this.localCandidates.length >= RTC_TIMING.maxCandidates) {
        this.diagnostic.candidates.rejected += 1
        this.log('candidate buffer limit reached')
        return
      }
      this.localCandidates.push(candidate)
      this.flushLocalCandidates()
    })
    this.pc.addEventListener('icecandidateerror', (event) => {
      if (!this.active) return
      const server = iceServerEndpoint(event.url)
      const code = Number.isInteger(event.errorCode) ? event.errorCode : 0
      // Browser text is not trusted logging input. Preserve the concrete cause via an allowlist.
      const native = String(event.errorText ?? '')
      const reason = /host lookup|resolve|dns/i.test(native)
        ? 'DNS_LOOKUP_FAILED'
        : /timed? ?out|timeout/i.test(native)
          ? 'SERVER_TIMEOUT'
          : /unauthori|authenticat/i.test(native)
            ? 'AUTHENTICATION_FAILED'
            : /unreachable|not reachable|could not be reached/i.test(native)
              ? 'SERVER_UNREACHABLE'
              : code === 701
                ? 'NO_LOCAL_CANDIDATE_REACHED_SERVER'
                : 'SERVER_ERROR'
      const protocol = server
        ? /^turns:|^stuns:/i.test(server)
          ? 'tls'
          : /transport=tcp/i.test(server)
            ? 'tcp'
            : 'udp'
        : null
      const key = `${server}:${code}:${reason}`
      const now = Date.now()
      let entry = this.diagnostic.iceServerErrors.find(
        (e) => e.server === server && e.code === code && e.reason === reason
      )
      if (!entry) {
        entry = {
          server,
          protocol,
          code,
          reason,
          count: 0,
          firstAt: now,
          lastAt: now,
          impact: 'gathering',
          selectedServer: null
        }
        this.diagnostic.iceServerErrors.push(entry)
        if (this.diagnostic.iceServerErrors.length > 32) this.diagnostic.iceServerErrors.shift()
      }
      entry.count++
      entry.lastAt = now
      entry.impact =
        this.pc.connectionState === 'connected' && this.channel?.readyState === 'open'
          ? 'connected-probe-failure'
          : this.pc.connectionState === 'failed' || this.pc.iceConnectionState === 'failed'
            ? 'connection-unhealthy'
            : 'gathering'
      entry.selectedServer =
        this.diagnostic.selectedPair?.server && server
          ? this.diagnostic.selectedPair.server === server
          : null
      if (now - (this.iceErrorLoggedAt.get(key) ?? -Infinity) >= 30_000) {
        this.iceErrorLoggedAt.set(key, now)
        if (this.iceErrorLoggedAt.size > 32)
          this.iceErrorLoggedAt.delete(this.iceErrorLoggedAt.keys().next().value!)
        // Gathering failures (including on another interface of a selected server)
        // are retained separately. ICE/DTLS state determines connection failure.
        this.log('candidate gathering error', {
          server,
          protocol,
          errorCode: code,
          reason,
          count: entry.count
        })
      }
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
    let previousTick = Date.now()
    this.timer = window.setInterval(() => {
      const now = Date.now()
      this.diagnostic.timerLagMs = Math.max(0, now - previousTick - 1000)
      previousTick = now
      this.reconcile()
    }, 1_000)
    this.transition('signaling', null)
  }

  get connectionId(): string {
    return this.options.connectionId
  }

  getDiagnostic(): RtcDiagnostics {
    return structuredClone(this.diagnostic)
  }
  getTransferMetrics(): Readonly<RtcDiagnostics['assets']> {
    return this.diagnostic.assets
  }
  get roundTripTimeMs(): number | null {
    return this.diagnostic.rttMs
  }
  get selectedPairId(): string | null {
    return this.diagnostic.selectedPair?.id ?? null
  }
  get needsTurnRefresh(): boolean {
    return (
      this.relayExpiresAt === null || this.relayExpiresAt - Date.now() <= this.turnRefreshLeadMs
    )
  }
  updateTransfer(patch: Partial<RtcDiagnostics['assets']>, rate: number): void {
    Object.assign(this.diagnostic.assets, patch)
    this.diagnostic.assetRateLimit = rate
  }
  beginTransfer(id: string, direction: 'send' | 'receive', totalBytes: number): void {
    const now = Date.now()
    this.diagnostic.transfers.push({
      id,
      direction,
      totalBytes,
      bytes: 0,
      startedAt: now,
      updatedAt: now,
      status: 'transferring',
      durationMs: null,
      reason: null,
      submittedAt: null,
      receivedAt: null,
      verifiedAt: null,
      wireBytes: 0,
      payloadBytesPerSecond: null,
      waitMs: { queue: 0, buffer: 0, control: 0, pacing: 0 },
      receiptSource: null
    })
    if (this.diagnostic.transfers.length > 64) this.diagnostic.transfers.shift()
  }
  advanceTransfer(id: string, bytes: number): void {
    const entry = this.diagnostic.transfers.find((t) => t.id === id && t.status === 'transferring')
    if (entry) {
      entry.bytes = Math.min(entry.totalBytes, entry.bytes + bytes)
      entry.updatedAt = Date.now()
    }
  }
  finishTransfer(
    id: string,
    status: AssetTransferDiagnostic['status'],
    reason: string | null = null
  ): void {
    const entry = this.diagnostic.transfers.find(
      (t) => t.id === id && ['transferring', 'submitted', 'received'].includes(t.status)
    )
    if (!entry) return
    entry.status = status
    entry.reason = reason && /^[A-Z0-9_]{1,64}$/.test(reason) ? reason : null
    entry.updatedAt = Date.now()
    entry.durationMs = entry.updatedAt - entry.startedAt
    if (status === 'submitted') entry.submittedAt = entry.updatedAt
    if (status === 'received') entry.receivedAt = entry.updatedAt
    if (status === 'verified') entry.verifiedAt = entry.updatedAt
    if (status === 'received' || status === 'verified') {
      entry.receiptSource = entry.direction === 'receive' ? 'local' : 'peer'
      const duration = (entry.receivedAt ?? entry.updatedAt) - entry.startedAt
      entry.payloadBytesPerSecond = duration > 0 ? (entry.bytes * 1000) / duration : null
    }
    if (
      entry.direction === 'receive' &&
      ['received', 'verified', 'failed'].includes(status) &&
      this.assetChannel?.readyState === 'open'
    ) {
      // Optional reverse messages on the existing asset stream. Older hosts ignore
      // them; no control-protocol change or acknowledgement per chunk is needed.
      try {
        this.assetChannel.send(
          JSON.stringify({
            type: 'ASSET_RECEIPT_V1',
            id,
            status,
            bytes: entry.bytes,
            reason: entry.reason
          })
        )
      } catch {
        /* Closing channel: local evidence remains exportable. */
      }
    }
    this.log('asset transfer finished', {
      status,
      durationMs: entry.durationMs,
      bytes: entry.bytes,
      code: entry.reason
    })
  }
  recordTransferWireBytes(id: string, bytes: number): void {
    const entry = this.diagnostic.transfers.find((t) => t.id === id)
    if (entry) entry.wireBytes += bytes
  }
  recordTransferWait(
    id: string,
    kind: 'queue' | 'buffer' | 'control' | 'pacing',
    ms: number
  ): void {
    const entry = this.diagnostic.transfers.find((t) => t.id === id)
    if (entry) entry.waitMs[kind] += Math.max(0, ms)
  }
  recordApplicationPing(durationMs: number): void {
    if (Number.isFinite(durationMs) && durationMs >= 0)
      this.diagnostic.applicationPingMs = Math.round(durationMs)
  }
  private receiveAssetReceipt(data: unknown): void {
    if (typeof data !== 'string' || data.length > 1024) return
    try {
      const value = JSON.parse(data)
      if (
        !value ||
        value.type !== 'ASSET_RECEIPT_V1' ||
        typeof value.id !== 'string' ||
        value.id.length > 128 ||
        !['received', 'verified', 'failed'].includes(value.status)
      )
        return
      const entry = this.diagnostic.transfers.find(
        (t) =>
          t.id === value.id &&
          t.direction === 'send' &&
          ['submitted', 'received'].includes(t.status)
      )
      if (
        !entry ||
        !Number.isSafeInteger(value.bytes) ||
        value.bytes < 0 ||
        value.bytes > entry.totalBytes ||
        (value.status !== 'failed' && value.bytes !== entry.totalBytes)
      )
        return
      if (value.status === 'received' && entry.status === 'received') return
      this.finishTransfer(
        entry.id,
        value.status,
        typeof value.reason === 'string' ? value.reason : null
      )
    } catch {
      /* Untrusted optional diagnostics must never reach BP dispatch. */
    }
  }
  recordActionResponse(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return
    this.diagnostic.actionResponseMs = Math.round(durationMs)
    this.diagnostic.actionResponses.push({
      at: Date.now(),
      durationMs: Math.round(durationMs)
    })
    if (this.diagnostic.actionResponses.length > 100) this.diagnostic.actionResponses.shift()
  }
  recordError(code: string, reason: string): void {
    this.diagnostic.errorCode = /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'RTC_ERROR'
    this.diagnostic.reason = reason
    this.diagnostic.errorMessage = reason
    this.log('connection error', { code: this.diagnostic.errorCode })
  }

  applyTurn(payload: Record<string, unknown>): boolean {
    if (!this.active) return false
    const credentials = readTurnCredentials(payload)
    this.recordTurnRequest(payload.turnDiagnostic, 'ok')
    this.diagnostic.turn = 'ready'
    this.diagnostic.turnRequestMs =
      this.turnRequestedAt === null ? null : Date.now() - this.turnRequestedAt
    if (
      credentials.expiresAt === this.relayExpiresAt &&
      JSON.stringify(credentials.iceServers) === JSON.stringify(this.relayServers)
    )
      return false
    const firstInstall = this.relayExpiresAt === null
    const udp = credentials.iceServers.flatMap((server) => {
      const urls = (Array.isArray(server.urls) ? server.urls : [server.urls]).filter(
        (url) => /^turn:/i.test(url) && !/transport=tcp/i.test(url)
      )
      return urls.length ? [{ ...server, urls }] : []
    })
    // A short UDP-only first attempt; TCP/TLS are retained and restored on timeout/failure.
    const preferUdp = firstInstall && udp.length > 0
    const hasTcp = credentials.iceServers.some((server) =>
      (Array.isArray(server.urls) ? server.urls : [server.urls]).some(
        (url) => /^turns:/i.test(url) || /transport=tcp/i.test(url)
      )
    )
    this.pc.setConfiguration({
      iceServers: [
        ...directIceServers(this.options.iceServers),
        ...(preferUdp ? udp : credentials.iceServers)
      ],
      iceTransportPolicy: this.options.testOnlyForceRelay ? 'relay' : 'all'
    })
    this.relayServers = credentials.iceServers
    this.tcpFallbackAt = preferUdp && hasTcp ? Date.now() + RTC_TIMING.udpPreferenceMs : null
    this.diagnostic.tcpFallbackEnabled = hasTcp && !preferUdp
    this.relayExpiresAt = credentials.expiresAt
    this.diagnostic.turnConfigured = true
    this.diagnostic.iceTransportPolicy = this.pc.getConfiguration().iceTransportPolicy ?? 'all'
    this.turnRefreshLeadMs = Math.min(
      90_000,
      Math.max(1_000, (credentials.expiresAt - Date.now()) / 3)
    )
    this.diagnostic.turn = 'ready'
    this.diagnostic.expiresAt = credentials.expiresAt
    this.diagnostic.turnRequestedTtl = nonnegative(payload.requestedTtl)
    this.diagnostic.turnActualTtl = nonnegative(payload.ttl)
    this.diagnostic.turnTtlReason = enumValue(payload.ttlReason, [
      'PROVIDER_TTL_MISMATCH_REASON_NOT_SUPPLIED',
      'HOST_AUTH_EXPIRING',
      'CONFIG_OVERRIDE'
    ])
    this.diagnostic.turnApiDomain = enumValue(payload.apiDomain, [
      'wtn.volcvideo.com',
      'wtn-lf.volcvideo.com',
      'wtn-va.volcvideos.com',
      'wtn-fr.volcvideos.com',
      'wtn-sg.volcvideos.com'
    ])
    this.diagnostic.turnServers = credentials.iceServers
      .flatMap((server) => (Array.isArray(server.urls) ? server.urls : [server.urls]))
      .map(iceServerEndpoint)
      .filter((url): url is string => url !== null)
    this.diagnostic.reason = null
    this.diagnostic.turnRequestMs =
      this.turnRequestedAt === null ? null : Date.now() - this.turnRequestedAt
    this.diagnostic.turnProtocols = [
      ...new Set(
        credentials.iceServers.flatMap((server) =>
          (Array.isArray(server.urls) ? server.urls : [server.urls]).map((url) =>
            /^turns:/i.test(url) ? 'tls' : /transport=tcp/i.test(url) ? 'tcp' : 'udp'
          )
        )
      )
    ]
    this.log('room TURN credentials installed', {
      expiresAt: credentials.expiresAt
    })
    return true
  }

  private enableTcpFallback(): boolean {
    if (this.tcpFallbackAt === null) return false
    this.tcpFallbackAt = null
    this.diagnostic.tcpFallbackEnabled = true
    this.pc.setConfiguration({
      iceServers: [...directIceServers(this.options.iceServers), ...this.relayServers],
      iceTransportPolicy: this.options.testOnlyForceRelay ? 'relay' : 'all'
    })
    this.log('TURN TCP fallback enabled')
    return true
  }

  turnRequested(): void {
    this.turnRequestedAt = Date.now()
    this.diagnostic.turn = 'requesting'
    this.log('TURN credentials requested')
  }
  setTurnProvider(value: unknown): void {
    if (!value || typeof value !== 'object') return
    const d = value as Record<string, unknown>
    this.diagnostic.turnAppId =
      typeof d.appId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(d.appId) ? d.appId : null
    this.diagnostic.turnAppIdSource = enumValue(d.appIdSource, ['env.WTN_APP_ID'])
    this.diagnostic.turnApiDomain = enumValue(d.apiDomain, [
      'wtn.volcvideo.com',
      'wtn-lf.volcvideo.com',
      'wtn-va.volcvideos.com',
      'wtn-fr.volcvideos.com',
      'wtn-sg.volcvideos.com'
    ])
  }
  private recordTurnRequest(
    value: unknown,
    result: 'ok' | 'error',
    code: string | null = null
  ): void {
    this.setTurnProvider(value)
    const d = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
    this.diagnostic.turnRequests.push({
      at: Date.now(),
      result,
      code,
      appId: typeof d.appId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(d.appId) ? d.appId : null,
      appIdSource: enumValue(d.appIdSource, ['env.WTN_APP_ID']),
      apiDomain: enumValue(d.apiDomain, [
        'wtn.volcvideo.com',
        'wtn-lf.volcvideo.com',
        'wtn-va.volcvideos.com',
        'wtn-fr.volcvideos.com',
        'wtn-sg.volcvideos.com'
      ]),
      httpStatus: nonnegative(d.httpStatus),
      providerCode: nonnegative(d.providerCode),
      ttl: nonnegative(d.ttl),
      source: enumValue(d.source, ['provider', 'cache', 'none'])
    })
    if (this.diagnostic.turnRequests.length > 50) this.diagnostic.turnRequests.shift()
  }
  turnFailed(code: string, diagnostic?: unknown): void {
    if (!this.active) return
    this.diagnostic.turn = 'failed'
    this.diagnostic.reason = /^TURN_[A-Z_]+$/.test(code) ? code : 'TURN_UNAVAILABLE'
    this.diagnostic.errorCode = this.diagnostic.reason
    this.recordTurnRequest(diagnostic, 'error', this.diagnostic.errorCode)
    this.diagnostic.errorMessage = this.diagnostic.reason
    this.diagnostic.turnRequestMs =
      this.turnRequestedAt === null ? null : Date.now() - this.turnRequestedAt
    this.log('TURN credentials unavailable', {
      code: this.diagnostic.errorCode
    })
    if (
      this.options.testOnlyForceRelay &&
      (this.relayExpiresAt === null || this.relayExpiresAt <= Date.now())
    )
      this.fail(
        `强制 TURN 无法取得有效凭证：${this.diagnostic.errorCode}`,
        this.diagnostic.errorCode
      )
  }
  clearTurn(reason: string, expired = false): void {
    if (!this.active) return
    const installed = this.relayExpiresAt !== null
    this.relayExpiresAt = null
    this.relayServers = []
    this.tcpFallbackAt = null
    this.diagnostic.tcpFallbackEnabled = false
    this.diagnostic.turn = expired ? 'expired' : 'disabled'
    this.diagnostic.expiresAt = null
    this.diagnostic.turnConfigured = false
    this.diagnostic.reason = reason
    this.pc.setConfiguration({
      iceServers: directIceServers(this.options.iceServers),
      iceTransportPolicy: this.options.testOnlyForceRelay ? 'relay' : 'all'
    })
    if (this.options.testOnlyForceRelay) {
      this.fail(`强制 TURN 已停止：${reason}`, expired ? 'TURN_EXPIRED' : 'TURN_REQUIRED')
      return
    }
    if (
      installed &&
      (this.diagnostic.relay || this.options.testOnlyForceRelay || this.phase !== 'connected')
    )
      this.requestRestart(reason)
  }

  private async inspectSelectedPair(): Promise<void> {
    if (this.statsPending || typeof this.pc.getStats !== 'function') return
    this.statsPending = true
    const generation = this.generation
    try {
      const stats = await this.pc.getStats()
      if (!this.active || generation !== this.generation) return
      let pairId: string | null = null
      let source: 'transport' | 'nominated' = 'transport'
      const transportPairs = new Set<string>()
      stats.forEach((report) => {
        if (report.type === 'transport' && report.selectedCandidatePairId)
          transportPairs.add(report.selectedCandidatePairId)
      })
      if (transportPairs.size === 1) pairId = [...transportPairs][0]!
      // A nominated pair is only a fallback when it is unambiguous.
      if (!pairId && transportPairs.size === 0) {
        source = 'nominated'
        const nominated: string[] = []
        stats.forEach((report) => {
          if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated)
            nominated.push(report.id)
        })
        if (nominated.length === 1) pairId = nominated[0]!
      }
      let selected = pairId ? stats.get(pairId) : undefined
      // transport identifies the pair actually in use. A new check can briefly
      // report in-progress on that pair; nomination alone is a weaker fallback.
      if (
        !selected ||
        selected.type !== 'candidate-pair' ||
        (selected.state !== 'succeeded' &&
          !(
            source === 'transport' &&
            selected.state === 'in-progress' &&
            this.pc.connectionState === 'connected'
          ))
      ) {
        pairId = null
        selected = undefined
      }
      const localReport = pairId ? stats.get(selected.localCandidateId) : undefined
      const remoteReport = pairId ? stats.get(selected.remoteCandidateId) : undefined
      const allowed = ['host', 'srflx', 'prflx', 'relay']
      const local = enumValue(localReport?.candidateType, allowed)
      const remote = enumValue(remoteReport?.candidateType, allowed)
      if (!pairId || (!local && !remote)) {
        this.markStatsUnavailable(
          !pairId ? 'SELECTED_PAIR_UNAVAILABLE' : 'CANDIDATE_STATS_INCOMPLETE'
        )
        return
      }
      if (this.diagnostic.statsMissingSince !== null) this.log('selected pair statistics restored')
      this.diagnostic.statsStatus = 'current'
      this.diagnostic.statsMissingSince = null
      this.diagnostic.statsUnavailableReason = null
      const pairType = local && remote ? `${local} / ${remote}` : null
      this.diagnostic.localCandidateType = local
      this.diagnostic.remoteCandidateType = remote
      this.diagnostic.protocol = enumValue(localReport?.protocol, ['udp', 'tcp'])
      this.diagnostic.localRelayProtocol =
        local === 'relay' ? enumValue(localReport?.relayProtocol, ['udp', 'tcp', 'tls']) : null
      this.diagnostic.remoteRelayProtocol =
        remote === 'relay' ? enumValue(remoteReport?.relayProtocol, ['udp', 'tcp', 'tls']) : null
      const rtt = nonnegative(selected?.currentRoundTripTime)
      this.diagnostic.rttMs = rtt === null ? null : Math.round(rtt * 1000)
      const sent = nonnegative(selected?.bytesSent),
        received = nonnegative(selected?.bytesReceived)
      let assetSent: number | null = null
      stats.forEach((report) => {
        if (report.type === 'data-channel' && report.label === 'xqb-remote-bp-assets-v1')
          assetSent = nonnegative(report.bytesSent)
      })
      const now = Date.now(),
        previous = this.sample
      const interval = previous ? (now - previous.at) / 1000 : 0
      const delta = (current: number | null, before: number): number | null =>
        current !== null && current >= before && previous?.pairId === pairId && interval > 0
          ? (current - before) / interval
          : null
      this.diagnostic.bytesSent = sent
      this.diagnostic.bytesReceived = received
      this.diagnostic.assetBytesSent = assetSent
      this.diagnostic.sendBytesPerSecond = delta(sent, previous?.sent ?? 0)
      this.diagnostic.receiveBytesPerSecond = delta(received, previous?.received ?? 0)
      this.diagnostic.assetBytesPerSecond = delta(assetSent, previous?.assetSent ?? 0)
      const packetsSent = nonnegative(selected?.packetsSent)
      const packetsDiscarded = nonnegative(selected?.packetsDiscardedOnSend)
      const packetDelta =
        previous?.pairId === pairId && packetsSent !== null && previous.packetsSent !== null
          ? packetsSent - previous.packetsSent
          : 0
      const discardDelta =
        packetsDiscarded !== null && previous?.packetsDiscarded != null
          ? packetsDiscarded - previous.packetsDiscarded
          : -1
      this.diagnostic.sendDiscardRatio =
        packetDelta > 0 && discardDelta >= 0 ? Math.min(1, discardDelta / packetDelta) : null
      this.sample =
        pairId && sent !== null && received !== null
          ? {
              pairId,
              at: now,
              sent,
              received,
              assetSent: assetSent ?? 0,
              packetsSent,
              packetsDiscarded
            }
          : null
      this.diagnostic.relay = local === 'relay' || remote === 'relay'
      this.diagnostic.turnUsage = this.diagnostic.relay
        ? 'relay'
        : local && remote
          ? 'direct'
          : 'unknown'
      this.diagnostic.iceTransportPolicy = this.pc.getConfiguration().iceTransportPolicy ?? 'all'
      this.diagnostic.relayVerified = this.diagnostic.relay
      if (this.diagnostic.relayVerified) this.diagnostic.relayVerifiedAt = now
      this.verifiedGeneration =
        this.remoteGeneration === this.generation && this.pc.signalingState === 'stable'
          ? this.generation
          : -1
      this.verifiedAt = now
      this.diagnostic.pair = pairType
      this.diagnostic.trafficSamples.push({
        at: now,
        negotiationId: this.generation,
        pairId,
        rttMs: this.diagnostic.rttMs,
        bytesSent: sent,
        bytesReceived: received,
        sentDelta:
          this.diagnostic.sendBytesPerSecond === null
            ? null
            : this.diagnostic.sendBytesPerSecond * interval,
        receivedDelta:
          this.diagnostic.receiveBytesPerSecond === null
            ? null
            : this.diagnostic.receiveBytesPerSecond * interval,
        assetRateLimit: this.diagnostic.assetRateLimit,
        assetBufferedAmount: this.assetChannel?.bufferedAmount ?? 0,
        controlBufferedAmount: this.channel?.bufferedAmount ?? 0,
        timerLagMs: this.diagnostic.timerLagMs,
        visibility: typeof document === 'undefined' ? null : document.visibilityState
      })
      if (this.diagnostic.trafficSamples.length > 300) this.diagnostic.trafficSamples.shift()
      if (pairId) {
        const pair = {
          at: now,
          id: pairId,
          localId: selected.localCandidateId ?? null,
          remoteId: selected.remoteCandidateId ?? null,
          localType: local,
          remoteType: remote,
          protocol: this.diagnostic.protocol,
          localRelayProtocol: this.diagnostic.localRelayProtocol,
          remoteRelayProtocol: this.diagnostic.remoteRelayProtocol,
          server: iceServerEndpoint(localReport?.url),
          remoteServer: iceServerEndpoint(remoteReport?.url),
          remoteProtocol: enumValue(remoteReport?.protocol, ['udp', 'tcp']),
          source,
          state: enumValue(selected.state, ['succeeded', 'in-progress']),
          negotiationId: this.generation
        }
        const previousPair = this.diagnostic.selectedPair
        this.diagnostic.selectedPair = pair
        if (
          JSON.stringify({ ...pair, at: 0, state: null }) !==
          JSON.stringify({ ...previousPair, at: 0, state: null })
        ) {
          this.diagnostic.pairHistory.push(pair)
          if (this.diagnostic.pairHistory.length > 50) this.diagnostic.pairHistory.shift()
          this.log('selected candidate pair', {
            pair: pairType,
            relay: this.diagnostic.relay
          })
        }
      }
      if (!pairId) this.diagnostic.selectedPair = null
      this.options.onDiagnostics?.(this.getDiagnostic())
    } catch {
      if (!this.active || generation !== this.generation) return
      this.markStatsUnavailable('GET_STATS_FAILED')
    } finally {
      this.statsPending = false
    }
  }

  private markStatsUnavailable(reason: string): void {
    if (this.diagnostic.statsMissingSince === null)
      this.log('selected pair statistics unavailable', { code: reason })
    this.diagnostic.statsMissingSince ??= Date.now()
    this.diagnostic.statsUnavailableReason = reason
    this.diagnostic.statsStatus = this.diagnostic.selectedPair ? 'stale' : 'unavailable'
    this.diagnostic.sendBytesPerSecond = null
    this.diagnostic.receiveBytesPerSecond = null
    this.diagnostic.assetBytesPerSecond = null
    this.sample = null
    this.options.onDiagnostics?.(this.getDiagnostic())
  }

  private log(event: string, details: Record<string, unknown> = {}): void {
    this.diagnostic.events.push({
      at: Date.now(),
      event,
      phase: this.phase,
      negotiationId: this.generation,
      signalingState: this.pc.signalingState,
      iceGatheringState: this.pc.iceGatheringState,
      iceState: this.pc.iceConnectionState,
      connectionState: this.pc.connectionState,
      dataChannelState: this.channel?.readyState ?? null,
      dtlsState: this.pc.sctp?.transport.state ?? null,
      sctpState: this.pc.sctp?.state ?? null,
      pair: this.diagnostic.pair,
      ...(typeof details.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(details.code)
        ? { code: details.code }
        : {})
    })
    if (this.diagnostic.events.length > 300) this.diagnostic.events.shift()
    console.info('[Remote BP RTC]', {
      event,
      roomId: this.options.roomId,
      peerId: this.options.peerId,
      connectionId: this.connectionId,
      negotiationId: this.generation,
      phase: this.phase,
      signalingState: this.pc.signalingState,
      iceGatheringState: this.pc.iceGatheringState,
      iceConnectionState: this.pc.iceConnectionState,
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

  start(): Promise<void> {
    return this.enqueue(async () => {
      if (
        this.options.testOnlyForceRelay &&
        (this.relayExpiresAt === null || this.relayExpiresAt <= Date.now())
      ) {
        this.fail('强制 TURN 测试缺少有效凭证', 'TURN_REQUIRED')
        return
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
        if (this.options.offerer && generation === this.generation)
          this.requestRestart('远端请求 ICE Restart')
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
          this.diagnostic.candidates.duplicates += 1
          this.log('duplicate candidate ignored', candidateDetails(candidate))
          return
        }
        if (
          this.candidates.length >= RTC_TIMING.maxCandidates ||
          this.seenCandidates.size >= RTC_TIMING.maxCandidates * 2
        ) {
          this.diagnostic.candidates.rejected += 1
          this.log('candidate buffer limit reached')
          return
        }
        this.seenCandidates.add(key)
        if (candidateDetails(candidate).candidateType === 'relay')
          this.diagnostic.candidates.remoteRelay++
        this.diagnostic.candidates.received += 1
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
      // Policy is negotiated on every SDP round; it can only become stricter for this PC.
      if (payload.forceRelay === true && !this.options.testOnlyForceRelay) {
        this.options.testOnlyForceRelay = true
        this.diagnostic.forceRelay = true
        this.pc.setConfiguration({
          ...this.pc.getConfiguration(),
          iceTransportPolicy: 'relay'
        })
        this.diagnostic.iceTransportPolicy = 'relay'
      }
      if (this.options.testOnlyForceRelay && payload.forceRelay !== true) {
        this.fail('对端未确认强制 TURN 策略，请更新双方客户端和信令服务', 'TURN_POLICY_UNCONFIRMED')
        return
      }
      if (
        this.options.testOnlyForceRelay &&
        (this.relayExpiresAt === null || this.relayExpiresAt <= Date.now())
      ) {
        this.fail('强制 TURN 协商缺少有效凭证', 'TURN_REQUIRED')
        return
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
      this.markMilestone('sdp')
      await this.drainCandidates()
      if (!this.active) return
      if (!this.options.offerer) {
        this.log('ANSWER create')
        const answer = await this.pc.createAnswer()
        if (!this.active) return
        await this.setLocalAndSend('ANSWER', answer)
      }
      this.reconcile()
    })
  }

  private beginRound(generation: number): void {
    this.verifiedGeneration = -1
    this.relayVerificationStartedAt = null
    this.diagnostic.relayVerified = false
    this.diagnostic.statsStatus = 'unavailable'
    this.diagnostic.statsMissingSince = null
    this.diagnostic.statsUnavailableReason = null
    this.generation = generation
    this.roundStartedAt = Date.now()
    this.iceConnectedAt = null
    this.localReady = false
    this.localSignals = []
    this.localCandidates = []
    this.diagnostic.candidates.localComplete = false
    this.diagnostic.candidates.remoteComplete = false
    this.candidates = this.candidates.filter(
      (entry) =>
        entry.generation >= generation && Date.now() - entry.receivedAt <= RTC_TIMING.signalTtlMs
    )
    // Retain duplicate detection for early candidates belonging to the new round.
    this.seenCandidates = new Set(
      this.candidates.map(({ generation: id, candidate: c }) =>
        JSON.stringify([id, c.candidate, c.sdpMid, c.sdpMLineIndex, c.usernameFragment])
      )
    )
    if (this.episodeStartedAt === null) this.episodeStartedAt = Date.now()
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

  private async setLocalAndSend(
    type: 'OFFER' | 'ANSWER',
    description: RTCSessionDescriptionInit
  ): Promise<void> {
    this.log('setLocalDescription start', { type })
    await this.pc.setLocalDescription(description)
    if (!this.active) return
    this.log('setLocalDescription success', { type })
    this.localReady = true
    const local = this.pc.localDescription ?? description
    this.rememberAndSend(type, {
      description: { type: local.type, sdp: local.sdp },
      forceRelay: Boolean(this.options.testOnlyForceRelay)
    })
    this.flushLocalCandidates()
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
    if (sent && signal.type === 'ICE_CANDIDATE') this.diagnostic.candidates.sent += 1
    this.log(
      `${signal.type === 'ICE_CANDIDATE' ? 'candidate' : signal.type} ${sent ? 'sent' : 'cached for signaling recovery'}`,
      signal.type === 'ICE_CANDIDATE'
        ? candidateDetails(signal.payload.candidate as RTCIceCandidateInit)
        : {}
    )
  }

  /** Readiness/resume handshake replays only this round, SDP before candidates. */
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
        if (this.active) {
          this.diagnostic.candidates.applied += 1
          if (!entry.candidate.candidate) this.diagnostic.candidates.remoteComplete = true
        }
        if (this.active) this.log('addIceCandidate success', candidateDetails(entry.candidate))
      } catch (error) {
        this.diagnostic.candidates.rejected += 1
        this.recordError('ADD_CANDIDATE_FAILED', '部分 ICE 候选应用失败，详见候选计数')
        // One duplicate, obsolete or malformed candidate must not discard the rest of the queue.
        if (this.active)
          this.log('addIceCandidate failure', {
            ...candidateDetails(entry.candidate),
            reason: error instanceof DOMException ? error.name : 'ADD_CANDIDATE_FAILED'
          })
      }
    }
  }

  requestRestart(reason: string, roundTimedOut = false): void {
    if (!this.active || this.restartQueued || (this.restartInFlight && !roundTimedOut)) return
    if (this.restartCount >= RTC_TIMING.maxRestarts) {
      this.fail(
        this.options.testOnlyForceRelay
          ? '强制 TURN 未能建立中继路径，ICE 重试次数已用尽'
          : 'ICE Restart 已达到最大重试次数',
        this.options.testOnlyForceRelay ? 'TURN_RELAY_UNREACHABLE' : 'ICE_RESTART_EXHAUSTED'
      )
      return
    }
    this.restartCount += 1
    this.totalRestartCount += 1
    this.diagnostic.restartCount = this.totalRestartCount
    this.restartQueued = true
    this.restartInFlight = true
    if (this.episodeStartedAt === null) this.episodeStartedAt = Date.now()
    this.roundStartedAt = Date.now()
    this.transition('reconnecting', reason)
    this.log('ICE Restart started', { attempt: this.restartCount, reason })
    void this.enqueue(async () => {
      if (this.options.offerer) {
        // Retain an existing valid credential while a replacement is being obtained.
        if (this.options.prepareRestart && this.needsTurnRefresh)
          await this.options.prepareRestart()
        if (!this.active) return
        if (
          this.options.testOnlyForceRelay &&
          (this.relayExpiresAt === null || this.relayExpiresAt <= Date.now())
        ) {
          this.fail('强制 TURN 测试无法取得有效凭证', 'TURN_REQUIRED')
          return
        }
        await this.makeOffer(true)
      } else {
        // HOST remains the sole offerer; this avoids glare between recovery events on both peers.
        const payload = {
          connectionId: this.connectionId,
          negotiationId: this.generation
        }
        this.transmit({
          type: 'ICE_RESTART_REQUEST',
          payload,
          createdAt: Date.now()
        })
      }
      this.restartQueued = false
    })
  }

  private installChannel(channel: RTCDataChannel): void {
    this.channel = channel
    channel.bufferedAmountLowThreshold = 16 * 1024
    this.log(`DataChannel ${channel.readyState}`)
    for (const event of ['open', 'closing', 'close', 'error']) {
      channel.addEventListener(event, () => {
        if (!this.active || this.channel !== channel) return
        this.log(`DataChannel ${event === 'close' ? 'closed' : event}`, {
          ...(event === 'error' ? { reason: 'DATA_CHANNEL_ERROR' } : {})
        })
        this.reconcile()
        // Only new players initiate this optional stream. Old hosts close it and
        // continue transferring assets on the original control channel.
        if (event === 'open' && !this.options.offerer && !this.assetChannel) {
          this.installAssetChannel(
            this.pc.createDataChannel('xqb-remote-bp-assets-v1', {
              ordered: true
            })
          )
        }
      })
    }
    channel.addEventListener('message', (event) => {
      if (this.active && this.channel === channel) this.options.onMessage(event.data, 'control')
    })
    this.reconcile()
  }

  private installAssetChannel(channel: RTCDataChannel): void {
    this.assetChannel = channel
    channel.bufferedAmountLowThreshold = 16 * 1024
    channel.addEventListener('message', (event) => {
      if (!this.active || this.assetChannel !== channel) return
      if (this.options.offerer) this.receiveAssetReceipt(event.data)
      else this.options.onMessage(event.data, 'assets')
    })
    for (const event of ['open', 'close', 'error'])
      channel.addEventListener(event, () => {
        if (!this.active || this.assetChannel !== channel) return
        this.log(`asset channel ${event}`)
        if (event === 'close') this.options.onAssetChannelClosed?.()
        this.reconcile()
      })
  }

  private markMilestone(name: string): void {
    this.diagnostic.milestones[name] ??= Date.now() - this.diagnostic.startedAt
  }

  private reconcile(): void {
    if (!this.active) return
    const now = Date.now()
    Object.assign(this.diagnostic, {
      updatedAt: now,
      phase: this.phase,
      signalingState: this.pc.signalingState,
      iceGatheringState: this.pc.iceGatheringState,
      connectionState: this.pc.connectionState,
      dataChannelState: this.channel?.readyState ?? null,
      assetChannelState: this.assetChannel?.readyState ?? null,
      dtlsState: this.pc.sctp?.transport.state ?? null,
      sctpState: this.pc.sctp?.state ?? null,
      bufferedAmount: this.channel?.bufferedAmount ?? 0,
      assetBufferedAmount: this.assetChannel?.bufferedAmount ?? 0,
      restartCount: this.totalRestartCount,
      negotiationId: this.generation
    })
    this.diagnostic.iceState = this.pc.iceConnectionState
    if (this.diagnostic.statsStatus === 'current' && now - this.verifiedAt > 5000)
      this.markStatsUnavailable('STATS_SAMPLE_TIMEOUT')
    if (now - this.lastStatsAt >= 1_000) {
      this.lastStatsAt = now
      void this.inspectSelectedPair()
    }
    this.localSignals = this.localSignals.filter(
      (signal) => now - signal.createdAt <= RTC_TIMING.signalTtlMs
    )
    this.candidates = this.candidates.filter(
      (entry) => now - entry.receivedAt <= RTC_TIMING.signalTtlMs
    )
    const ice = this.pc.iceConnectionState
    const connection = this.pc.connectionState
    const healthyIce = ice === 'connected' || ice === 'completed'
    if (healthyIce) this.markMilestone('ice')
    if (this.diagnostic.dtlsState === 'connected') this.markMilestone('dtls')
    if (this.diagnostic.sctpState === 'connected') this.markMilestone('sctp')
    if (this.channel?.readyState === 'open') this.markMilestone('channel')
    if (connection === 'closed' || ice === 'closed' || this.channel?.readyState === 'closed') {
      this.fail('点对点连接或 DataChannel 已关闭')
      return
    }
    if (this.relayExpiresAt !== null && now >= this.relayExpiresAt) {
      // clearTurn only restarts when the expired relay is relevant to this path.
      // A healthy direct connection must not be disturbed by an unused credential.
      this.clearTurn('中继凭证已到期，需重新获取凭证', true)
      this.log('TURN credentials expired')
      if (!this.active) return
    }
    if (this.episodeStartedAt !== null && now - this.episodeStartedAt >= RTC_TIMING.totalMs) {
      this.fail(
        this.options.testOnlyForceRelay
          ? '强制 TURN 中继连接超过 120 秒总恢复时限'
          : '点对点连接超过 120 秒总恢复时限',
        this.options.testOnlyForceRelay ? 'TURN_RELAY_TIMEOUT' : 'RTC_TIMEOUT'
      )
      return
    }
    if (
      healthyIce &&
      connection === 'connected' &&
      this.channel?.readyState === 'open' &&
      this.remoteGeneration === this.generation &&
      this.pc.signalingState === 'stable' &&
      !this.restartQueued
    ) {
      if (this.options.testOnlyForceRelay) {
        const observed =
          this.diagnostic.statsStatus === 'current' &&
          this.verifiedGeneration === this.generation &&
          now - this.verifiedAt <= 5_000
        if (
          observed &&
          (this.diagnostic.iceTransportPolicy !== 'relay' ||
            (this.diagnostic.localCandidateType !== null &&
              this.diagnostic.localCandidateType !== 'relay') ||
            (this.diagnostic.remoteCandidateType !== null &&
              this.diagnostic.remoteCandidateType !== 'relay'))
        ) {
          this.fail('强制 TURN 校验失败：实际选中路径并非双方 relay', 'TURN_PATH_NOT_RELAY')
          return
        }
        if (
          !observed ||
          this.diagnostic.localCandidateType !== 'relay' ||
          this.diagnostic.remoteCandidateType !== 'relay'
        ) {
          this.relayVerificationStartedAt ??= now
          if (now - this.relayVerificationStartedAt >= RTC_TIMING.dataChannelMs)
            this.fail('强制 TURN 无法从 getStats 确认选中的中继路径', 'TURN_PATH_UNVERIFIED')
          // A missing statistics sample does not disconnect healthy transport or
          // re-run the adapters' connected callback (which requests state again).
          else if (this.phase !== 'connected')
            this.transition('connecting', '数据通道已打开，正在核实实际 TURN 路径')
          return
        }
        this.relayVerificationStartedAt = null
      }
      if (this.restartInFlight) this.log('ICE Restart success')
      this.restartInFlight = false
      this.restartCount = 0
      this.episodeStartedAt = null
      this.disconnectedAt = null
      this.iceConnectedAt = null
      // UDP succeeded. Keep TCP available for a future restart, without letting
      // the expired preference timer bypass the normal transient-disconnect grace.
      this.enableTcpFallback()
      this.transition('connected', null)
      if (
        this.options.offerer &&
        this.relayExpiresAt !== null &&
        this.needsTurnRefresh &&
        (this.diagnostic.relay || this.options.testOnlyForceRelay) &&
        !this.refreshingRelay &&
        this.options.prepareRestart &&
        now - this.lastRelayRefreshAt >= Math.min(30_000, this.turnRefreshLeadMs)
      ) {
        this.lastRelayRefreshAt = now
        this.refreshingRelay = true
        const previousExpiry = this.relayExpiresAt
        // A failed provider call must not restart a working match with the same credential.
        void this.options
          .prepareRestart()
          .then(() => {
            if (
              this.active &&
              this.relayExpiresAt !== null &&
              this.relayExpiresAt !== previousExpiry
            )
              this.requestRestart('中继凭证已更新，正在切换 ICE')
          })
          .catch(() => this.turnFailed('TURN_UNAVAILABLE'))
          .finally(() => {
            this.refreshingRelay = false
          })
      }
      return
    }
    if (this.episodeStartedAt === null) {
      this.episodeStartedAt = now
      this.roundStartedAt = now
    }
    if (ice === 'failed' || connection === 'failed') {
      const code =
        ice === 'failed'
          ? 'ICE_FAILED'
          : this.diagnostic.dtlsState === 'failed'
            ? 'DTLS_FAILED'
            : 'PEER_CONNECTION_FAILED'
      if (!this.restartInFlight) this.recordError(code, '网络传输建立失败，正在受控恢复')
      const promoted = this.enableTcpFallback()
      this.requestRestart(code, promoted)
    } else if (ice === 'disconnected' || connection === 'disconnected') {
      if (this.disconnectedAt === null) this.disconnectedAt = now
      this.transition('reconnecting', '网络暂时中断，等待恢复')
      if (now - this.disconnectedAt >= RTC_TIMING.disconnectedGraceMs)
        this.requestRestart('网络中断超过 15 秒')
    } else {
      this.disconnectedAt = null
      if (!this.restartInFlight)
        this.transition(
          healthyIce ? 'connecting' : ice === 'checking' ? 'ice-checking' : 'signaling',
          null
        )
    }
    if (
      !healthyIce &&
      this.generation > 0 &&
      this.tcpFallbackAt !== null &&
      now >= this.tcpFallbackAt
    ) {
      this.enableTcpFallback()
      if (this.options.offerer) {
        this.requestRestart('TURN UDP 尚未连通，加入 TCP 备用', true)
        return
      }
    }
    if (
      !healthyIce &&
      this.options.offerer &&
      this.options.prepareRestart &&
      !this.triedEarlyRelay &&
      !this.restartInFlight &&
      this.generation > 0 &&
      this.relayExpiresAt === null &&
      now - this.roundStartedAt >= RTC_TIMING.relayFallbackMs
    ) {
      this.triedEarlyRelay = true
      this.requestRestart('直连尚未建立，提前尝试 TURN')
      return
    }
    if (
      healthyIce &&
      this.remoteGeneration === this.generation &&
      this.pc.signalingState === 'stable'
    ) {
      if (this.iceConnectedAt === null) this.iceConnectedAt = now
      if (now - this.iceConnectedAt >= RTC_TIMING.dataChannelMs) {
        const code =
          this.diagnostic.dtlsState && this.diagnostic.dtlsState !== 'connected'
            ? 'DTLS_TIMEOUT'
            : this.diagnostic.sctpState && this.diagnostic.sctpState !== 'connected'
              ? 'SCTP_TIMEOUT'
              : 'DATA_CHANNEL_TIMEOUT'
        this.recordError(code, 'ICE 已连通，但后续数据通道未就绪')
        this.iceConnectedAt = now
        this.requestRestart(code, true)
      }
    } else {
      this.iceConnectedAt = null
      if (now - this.roundStartedAt >= RTC_TIMING.iceRoundMs) {
        this.recordError(
          this.remoteGeneration !== this.generation ? 'SDP_SIGNALING_TIMEOUT' : 'ICE_TIMEOUT',
          '本轮协商未在时限内完成'
        )
        if (this.restartInFlight) this.log('ICE Restart failure', { reason: 'round timeout' })
        this.requestRestart('本轮 ICE / SDP 建连超过 45 秒', true)
      }
    }
  }

  private transition(phase: RtcPhase, reason: string | null): void {
    if (this.phase === phase) return
    this.phase = phase
    this.diagnostic.phase = phase
    if (reason) this.diagnostic.reason = reason
    this.log('state transition', { reason })
    this.options.onState(phase, reason)
  }

  private fail(reason: string, code?: string): void {
    if (!this.active) return
    if (this.restartInFlight) this.log('ICE Restart failure', { reason })
    this.dispose('ASSET_NETWORK_INTERRUPTED')
    if (code) this.recordError(code, reason)
    this.transition('failed', reason)
  }

  close(reason = 'ASSET_CANCELLED'): void {
    if (!this.active) return
    this.dispose(reason)
    this.transition('closed', null)
  }

  private dispose(reason: string): void {
    this.active = false
    // Preserve the last observed path as historical evidence, explicitly closed.
    this.diagnostic.statsStatus = 'closed'
    for (const entry of this.diagnostic.transfers)
      if (entry.status === 'transferring')
        this.finishTransfer(entry.id, reason === 'ASSET_CANCELLED' ? 'cancelled' : 'failed', reason)
    window.clearInterval(this.timer)
    this.candidates = []
    this.seenCandidates.clear()
    this.localSignals = []
    this.localCandidates = []
    this.channel?.close()
    this.assetChannel?.close()
    this.pc.close()
    Object.assign(this.diagnostic, {
      connectionState: this.pc.connectionState,
      iceState: this.pc.iceConnectionState,
      dataChannelState: this.channel?.readyState ?? null,
      assetChannelState: this.assetChannel?.readyState ?? null,
      updatedAt: Date.now()
    })
    this.log('PeerConnection destroyed')
  }
}
