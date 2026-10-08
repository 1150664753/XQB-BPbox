/** Connection-layer only: BP messages and asset transfer stay in the existing adapters. */
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
  maxCandidates: 256
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
    candidateType: parts.includes('typ') ? parts[parts.indexOf('typ') + 1] : 'unknown',
    protocol: parts[2]?.toLowerCase() ?? 'unknown',
    endOfCandidates: !candidate.candidate,
    sdpMid: candidate.sdpMid,
    usernameFragment:
      candidate.usernameFragment ??
      (parts.includes('ufrag') ? parts[parts.indexOf('ufrag') + 1] : null)
  }
}

function ufrags(description: RTCSessionDescriptionInit | null): string[] {
  return [...(description?.sdp ?? '').matchAll(/^a=ice-ufrag:(.+)$/gm)].map((match) =>
    match[1]!.trim()
  )
}

interface RtcSessionOptions {
  connectionId: string
  peerId: string
  roomId: string
  offerer: boolean
  iceServers: RTCIceServer[]
  send: (type: RtcSignalType, payload: Record<string, unknown>) => boolean
  onState: (state: RtcPhase, reason: string | null) => void
  onMessage: (data: unknown) => void
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
  private episodeStartedAt: number | null = Date.now()
  private roundStartedAt = Date.now()
  private iceConnectedAt: number | null = null
  private disconnectedAt: number | null = null
  private readonly timer: number

  constructor(private readonly options: RtcSessionOptions) {
    this.pc = new RTCPeerConnection({ iceServers: options.iceServers })
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
        this.log('candidate gathering complete')
        return
      }
      const candidate = event.candidate.toJSON()
      this.log('candidate generated', candidateDetails(candidate))
      if (this.localCandidates.length >= RTC_TIMING.maxCandidates) {
        this.log('candidate buffer limit reached')
        return
      }
      this.localCandidates.push(candidate)
      this.flushLocalCandidates()
    })
    this.pc.addEventListener('icecandidateerror', (event) => {
      if (this.active)
        this.log('candidate gathering error', {
          errorCode: event.errorCode,
          errorText: event.errorText
        })
    })
    this.pc.addEventListener('datachannel', (event) => {
      if (!this.active || event.channel.label !== 'xqb-remote-bp' || this.channel) {
        event.channel.close()
        return
      }
      this.installChannel(event.channel)
    })
    if (options.offerer)
      this.installChannel(this.pc.createDataChannel('xqb-remote-bp', { ordered: true }))
    this.timer = window.setInterval(() => this.reconcile(), 1_000)
    this.transition('signaling', null)
  }

  get connectionId(): string {
    return this.options.connectionId
  }

  private log(event: string, details: Record<string, unknown> = {}): void {
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
        this.log('negotiation error', { error: String(error) })
        this.restartQueued = false
        this.restartInFlight = false
        this.requestRestart('SDP 协商失败')
      })
    return this.chain
  }

  start(): Promise<void> {
    return this.enqueue(async () => {
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
    if (generation < 0 || generation > RTC_TIMING.maxRestarts + 1) {
      this.log('out-of-window signal ignored', { type, receivedGeneration: generation })
      return Promise.resolve()
    }
    return this.enqueue(async () => {
      if (generation < this.generation) {
        this.log('old negotiation ignored', { type, receivedGeneration: generation })
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
    })
  }

  private beginRound(generation: number): void {
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
    this.rememberAndSend(type, { description: { type: local.type, sdp: local.sdp } })
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
    if (this.localSignals.length >= RTC_TIMING.maxCandidates + 1) {
      this.log('signal buffer limit reached')
      return
    }
    const payload = { ...data, connectionId: this.connectionId, negotiationId: this.generation }
    const signal = { type, payload, createdAt: Date.now() }
    this.localSignals.push(signal)
    this.transmit(signal)
  }

  private transmit(signal: LocalSignal): void {
    let sent = false
    try {
      sent = this.options.send(signal.type, signal.payload)
    } catch (error) {
      this.log('signal send deferred', { error: String(error) })
    }
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
        payload: { connectionId: this.connectionId, negotiationId: this.generation },
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
        // One duplicate, obsolete or malformed candidate must not discard the rest of the queue.
        if (this.active)
          this.log('addIceCandidate failure', {
            ...candidateDetails(entry.candidate),
            error: String(error)
          })
      }
    }
  }

  requestRestart(reason: string, roundTimedOut = false): void {
    if (!this.active || this.restartQueued || (this.restartInFlight && !roundTimedOut)) return
    if (this.restartCount >= RTC_TIMING.maxRestarts) {
      this.fail('ICE Restart 已达到最大重试次数')
      return
    }
    this.restartCount += 1
    this.restartQueued = true
    this.restartInFlight = true
    if (this.episodeStartedAt === null) this.episodeStartedAt = Date.now()
    this.roundStartedAt = Date.now()
    this.transition('reconnecting', reason)
    this.log('ICE Restart started', { attempt: this.restartCount, reason })
    void this.enqueue(async () => {
      if (this.options.offerer) await this.makeOffer(true)
      else {
        // HOST remains the sole offerer; this avoids glare between recovery events on both peers.
        const payload = { connectionId: this.connectionId, negotiationId: this.generation }
        this.transmit({ type: 'ICE_RESTART_REQUEST', payload, createdAt: Date.now() })
      }
      this.restartQueued = false
    })
  }

  private installChannel(channel: RTCDataChannel): void {
    this.channel = channel
    channel.bufferedAmountLowThreshold = 256 * 1024
    this.log(`DataChannel ${channel.readyState}`)
    for (const event of ['open', 'closing', 'close', 'error']) {
      channel.addEventListener(event, (detail) => {
        if (!this.active || this.channel !== channel) return
        this.log(`DataChannel ${event === 'close' ? 'closed' : event}`, {
          ...(event === 'error' ? { error: (detail as RTCErrorEvent).error?.message } : {})
        })
        this.reconcile()
      })
    }
    channel.addEventListener('message', (event) => {
      if (this.active && this.channel === channel) this.options.onMessage(event.data)
    })
    this.reconcile()
  }

  private reconcile(): void {
    if (!this.active) return
    const now = Date.now()
    this.localSignals = this.localSignals.filter(
      (signal) => now - signal.createdAt <= RTC_TIMING.signalTtlMs
    )
    this.candidates = this.candidates.filter(
      (entry) => now - entry.receivedAt <= RTC_TIMING.signalTtlMs
    )
    const ice = this.pc.iceConnectionState
    const connection = this.pc.connectionState
    const healthyIce = ice === 'connected' || ice === 'completed'
    if (connection === 'closed' || ice === 'closed' || this.channel?.readyState === 'closed') {
      this.fail('点对点连接或 DataChannel 已关闭')
      return
    }
    if (this.episodeStartedAt !== null && now - this.episodeStartedAt >= RTC_TIMING.totalMs) {
      this.fail('点对点连接超过 120 秒总恢复时限')
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
      if (this.restartInFlight) this.log('ICE Restart success')
      this.restartInFlight = false
      this.episodeStartedAt = null
      this.disconnectedAt = null
      this.iceConnectedAt = null
      this.transition('connected', null)
      return
    }
    if (this.episodeStartedAt === null) {
      this.episodeStartedAt = now
      this.roundStartedAt = now
    }
    if (ice === 'failed' || connection === 'failed') {
      this.requestRestart('ICE / PeerConnection 进入 failed')
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
      healthyIce &&
      this.remoteGeneration === this.generation &&
      this.pc.signalingState === 'stable'
    ) {
      if (this.iceConnectedAt === null) this.iceConnectedAt = now
      if (now - this.iceConnectedAt >= RTC_TIMING.dataChannelMs)
        this.fail('ICE 已连通，但 DataChannel / DTLS 建立超过 20 秒')
    } else {
      this.iceConnectedAt = null
      if (now - this.roundStartedAt >= RTC_TIMING.iceRoundMs) {
        if (this.restartInFlight) this.log('ICE Restart failure', { reason: 'round timeout' })
        this.requestRestart('本轮 ICE / SDP 建连超过 45 秒', true)
      }
    }
  }

  private transition(phase: RtcPhase, reason: string | null): void {
    if (this.phase === phase) return
    this.phase = phase
    this.log('state transition', { reason })
    this.options.onState(phase, reason)
  }

  private fail(reason: string): void {
    if (!this.active) return
    if (this.restartInFlight) this.log('ICE Restart failure', { reason })
    this.dispose()
    this.transition('failed', reason)
  }

  close(): void {
    if (!this.active) return
    this.dispose()
    this.transition('closed', null)
  }

  private dispose(): void {
    this.active = false
    window.clearInterval(this.timer)
    this.candidates = []
    this.seenCandidates.clear()
    this.localSignals = []
    this.localCandidates = []
    this.channel?.close()
    this.pc.close()
    this.log('PeerConnection destroyed')
  }
}
