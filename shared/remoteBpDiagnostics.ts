/** Only credential-free STUN/TURN endpoints may be retained, never SDP or peer addresses. */
export function iceServerEndpoint(value: unknown): string | null {
  return typeof value === 'string' &&
    value.length <= 512 &&
    /^(?:stun|stuns|turn|turns):[a-z0-9.\-\[\]:]+(?:\?transport=(?:udp|tcp))?$/i.test(value)
    ? value
    : null
}
export interface AssetTransferDiagnostic {
  id: string
  direction: 'send' | 'receive'
  startedAt: number
  updatedAt: number
  totalBytes: number
  bytes: number
  status: 'transferring' | 'submitted' | 'received' | 'verified' | 'failed' | 'cancelled'
  durationMs: number | null
  reason: string | null
  submittedAt: number | null
  receivedAt: number | null
  verifiedAt: number | null
  wireBytes: number
  payloadBytesPerSecond: number | null
  waitMs: { queue: number; buffer: number; control: number; pacing: number }
  receiptSource: 'local' | 'peer' | null
}
export interface CandidatePairDiagnostic {
  at: number
  id: string
  localId: string | null
  remoteId: string | null
  localType: string | null
  remoteType: string | null
  protocol: string | null
  localRelayProtocol: string | null
  remoteRelayProtocol: string | null
  server: string | null
  remoteServer: string | null
  remoteProtocol: string | null
  source: 'transport' | 'nominated'
  state: string | null
  negotiationId: number
}
export interface TurnRequestDiagnostic {
  at: number
  appId: string | null
  appIdSource: string | null
  apiDomain: string | null
  httpStatus: number | null
  providerCode: number | null
  ttl: number | null
  source: string | null
  result: 'ok' | 'error'
  code: string | null
}
export interface RtcDiagnostics {
  connectionId: string
  roomId: string
  peerId: string
  role: 'host' | 'player'
  startedAt: number
  updatedAt: number
  phase: string
  signalingState: string
  iceGatheringState: string
  iceState: string
  connectionState: string
  dataChannelState: string | null
  assetChannelState: string | null
  dtlsState: string | null
  sctpState: string | null
  pair: string | null
  localCandidateType: string | null
  remoteCandidateType: string | null
  protocol: string | null
  localRelayProtocol: string | null
  remoteRelayProtocol: string | null
  relay: boolean
  forceRelay: boolean
  iceTransportPolicy: RTCIceTransportPolicy
  turnConfigured: boolean
  turnUsage: 'unknown' | 'direct' | 'relay'
  relayVerified: boolean
  relayVerifiedAt: number | null
  statsStatus: 'unavailable' | 'current' | 'stale' | 'closed'
  statsMissingSince: number | null
  statsUnavailableReason: string | null
  tcpFallbackEnabled: boolean
  timerLagMs: number
  turnRequests: TurnRequestDiagnostic[]
  trafficSamples: Array<{
    at: number
    negotiationId: number
    pairId: string | null
    rttMs: number | null
    bytesSent: number | null
    bytesReceived: number | null
    sentDelta: number | null
    receivedDelta: number | null
    assetRateLimit: number
    assetBufferedAmount: number
    controlBufferedAmount: number
    timerLagMs: number
    visibility: string | null
  }>
  rttMs: number | null
  selectedPair: CandidatePairDiagnostic | null
  pairHistory: CandidatePairDiagnostic[]
  iceServerErrors: Array<{
    server: string | null
    protocol: string | null
    code: number
    reason: string
    count: number
    firstAt: number
    lastAt: number
    impact: 'gathering' | 'connection-unhealthy' | 'connected-probe-failure'
    selectedServer: boolean | null
  }>
  // SCTP/DataChannel has no interoperable packetsLost statistic. Do not substitute RTP or STUN loss.
  packetLossRatio: number | null
  packetLossSource: 'unavailable'
  sendDiscardRatio: number | null
  actionResponseMs: number | null
  applicationPingMs: number | null
  actionResponses: Array<{ at: number; durationMs: number }>
  transfers: AssetTransferDiagnostic[]
  bytesSent: number | null
  bytesReceived: number | null
  sendBytesPerSecond: number | null
  receiveBytesPerSecond: number | null
  bufferedAmount: number
  assetBufferedAmount: number
  assetBytesSent: number | null
  assetBytesPerSecond: number | null
  assetRateLimit: number
  assets: {
    requested: number
    submitted: number
    totalBytes: number
    queuedBytes: number
  }
  candidates: {
    generated: number
    sent: number
    received: number
    applied: number
    duplicates: number
    rejected: number
    localComplete: boolean
    remoteComplete: boolean
    localRelay: number
    remoteRelay: number
  }
  milestones: Record<string, number>
  restartCount: number
  negotiationId: number
  turn: 'not-requested' | 'requesting' | 'ready' | 'failed' | 'expired' | 'disabled'
  expiresAt: number | null
  turnRequestMs: number | null
  turnProtocols: string[]
  turnServers: string[]
  turnApiDomain: string | null
  turnAppId: string | null
  turnAppIdSource: string | null
  turnRequestedTtl: number | null
  turnActualTtl: number | null
  turnTtlReason: string | null
  reason: string | null
  errorCode: string | null
  errorMessage: string | null
  events: Array<{
    at: number
    event: string
    phase: string
    code?: string
    negotiationId: number
    signalingState: string
    iceGatheringState: string
    iceState: string
    connectionState: string
    dataChannelState: string | null
    dtlsState: string | null
    sctpState: string | null
    pair: string | null
  }>
}

const diagnostics = new Map<string, RtcDiagnostics>()
export function createRtcDiagnostics(
  connectionId: string,
  roomId: string,
  peerId: string,
  offerer: boolean,
  forceRelay: boolean
): RtcDiagnostics {
  const now = Date.now()
  const value: RtcDiagnostics = {
    connectionId,
    roomId,
    peerId,
    role: offerer ? 'host' : 'player',
    startedAt: now,
    updatedAt: now,
    phase: 'idle',
    signalingState: 'stable',
    iceGatheringState: 'new',
    iceState: 'new',
    connectionState: 'new',
    dataChannelState: null,
    assetChannelState: null,
    dtlsState: null,
    sctpState: null,
    pair: null,
    localCandidateType: null,
    remoteCandidateType: null,
    protocol: null,
    localRelayProtocol: null,
    remoteRelayProtocol: null,
    relay: false,
    forceRelay,
    iceTransportPolicy: forceRelay ? 'relay' : 'all',
    turnConfigured: false,
    turnUsage: 'unknown',
    relayVerified: false,
    relayVerifiedAt: null,
    statsStatus: 'unavailable',
    statsMissingSince: null,
    statsUnavailableReason: null,
    tcpFallbackEnabled: false,
    timerLagMs: 0,
    turnRequests: [],
    trafficSamples: [],
    rttMs: null,
    selectedPair: null,
    pairHistory: [],
    iceServerErrors: [],
    packetLossRatio: null,
    packetLossSource: 'unavailable',
    sendDiscardRatio: null,
    actionResponseMs: null,
    applicationPingMs: null,
    actionResponses: [],
    transfers: [],
    bytesSent: null,
    bytesReceived: null,
    sendBytesPerSecond: null,
    receiveBytesPerSecond: null,
    bufferedAmount: 0,
    assetBufferedAmount: 0,
    assetBytesSent: null,
    assetBytesPerSecond: null,
    assetRateLimit: 0,
    assets: { requested: 0, submitted: 0, totalBytes: 0, queuedBytes: 0 },
    candidates: {
      generated: 0,
      sent: 0,
      received: 0,
      applied: 0,
      duplicates: 0,
      rejected: 0,
      localComplete: false,
      remoteComplete: false,
      localRelay: 0,
      remoteRelay: 0
    },
    milestones: {},
    restartCount: 0,
    negotiationId: 0,
    turn: 'not-requested',
    expiresAt: null,
    turnRequestMs: null,
    turnProtocols: [],
    turnServers: [],
    turnApiDomain: null,
    turnAppId: null,
    turnAppIdSource: null,
    turnRequestedTtl: null,
    turnActualTtl: null,
    turnTtlReason: null,
    reason: null,
    errorCode: null,
    errorMessage: null,
    events: []
  }
  diagnostics.set(`${value.role}:${connectionId}`, value)
  while (diagnostics.size > 16) diagnostics.delete(diagnostics.keys().next().value!)
  return value
}

export function getRtcDiagnostics(roomId?: string | null): RtcDiagnostics[] {
  return [...diagnostics.values()]
    .filter((value) => !roomId || value.roomId === roomId)
    .map((value) => structuredClone(value))
}

export function exportRtcDiagnostics(roomId?: string | null): string {
  return JSON.stringify(
    {
      schemaVersion: 4,
      exportedAt: new Date().toISOString(),
      note: 'Credential-free endpoints only; never peer addresses, SDP, tokens or credentials. relayVerified describes the last observed selected path; statsStatus and relayVerifiedAt identify freshness/closed history. submitted is browser enqueue only; received is complete payload before SHA-256; verified is receiver hash success, receiptSource=peer denotes its acknowledgement. Transfer payload rates exclude base64/protocol overhead; data-channel counters measure browser transmission, not receipt. Missing DataChannel loss is unavailable; sendDiscardRatio is local discards only. Configured TCP fallback is not selected TCP.',
      connections: getRtcDiagnostics(roomId)
    },
    null,
    2
  )
}
