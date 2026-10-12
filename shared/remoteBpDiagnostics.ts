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
  status: 'transferring' | 'submitted' | 'verified' | 'failed' | 'cancelled'
  durationMs: number | null
  reason: string | null
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
  }>
  // SCTP/DataChannel has no interoperable packetsLost statistic. Do not substitute RTP or STUN loss.
  packetLossRatio: number | null
  packetLossSource: 'unavailable'
  sendDiscardRatio: number | null
  actionResponseMs: number | null
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
  assets: { requested: number; submitted: number; totalBytes: number; queuedBytes: number }
  candidates: {
    generated: number
    sent: number
    received: number
    applied: number
    duplicates: number
    rejected: number
    localComplete: boolean
    remoteComplete: boolean
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
    rttMs: null,
    selectedPair: null,
    pairHistory: [],
    iceServerErrors: [],
    packetLossRatio: null,
    packetLossSource: 'unavailable',
    sendDiscardRatio: null,
    actionResponseMs: null,
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
      remoteComplete: false
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
      schemaVersion: 2,
      exportedAt: new Date().toISOString(),
      note: 'Includes credential-free ICE server endpoints and opaque selected pair IDs, never peer addresses, SDP, tokens or credentials. Submitted assets are not receipt acknowledgements; verified means receiver SHA-256 passed. DataChannel packet loss is unavailable; sendDiscardRatio measures local send discards only.',
      connections: getRtcDiagnostics(roomId)
    },
    null,
    2
  )
}
