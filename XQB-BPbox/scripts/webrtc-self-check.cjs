const assert = require('node:assert/strict')
const path = require('node:path')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '../..')
const output = path.join(root, 'XQB-BPbox/.tmp/webrtc-self-check.cjs')
buildSync({
  stdin: {
    contents: `export * from './shared/remoteBpRtc'; export * from './shared/remoteBpFlowControl'; export * from './shared/remoteBpWire'; export * from './XBQ-BPweb/src/services/assets/IncomingAssetTransfers'; export * from './XQB-BPbox/src/renderer/src/services/remoteBp/WebRtcRemoteHostTransport'; export * from './XBQ-BPweb/src/services/WebRtcRemoteBpConnection';`,
    resolveDir: root,
    loader: 'ts'
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent'
})
const {
  RemoteBpRtcSession,
  WebRtcRemoteHostTransport,
  WebRtcRemoteBpConnection,
  bufferRtcSignal,
  getRtcDiagnostics,
  RTC_TIMING,
  AssetPacer,
  IncomingAssetTransfers,
  decodeBinaryAssetChunk
} = require(output)

let now = 0
let nextTimer = 1
const timers = new Map()
const realNow = Date.now
Date.now = () => now
global.window = {
  setTimeout(fn, ms) {
    const id = nextTimer++
    timers.set(id, { fn, at: now + ms })
    return id
  },
  clearTimeout(id) {
    timers.delete(id)
  },
  setInterval(fn, ms) {
    const id = nextTimer++
    timers.set(id, { fn, at: now + ms, interval: ms })
    return id
  },
  clearInterval(id) {
    timers.delete(id)
  }
}
const flush = async () => {
  for (let n = 0; n < 80; n++) await Promise.resolve()
}
async function tick(ms) {
  await flush()
  const end = now + ms
  while (true) {
    const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
    if (!next) break
    const [id, timer] = next
    now = timer.at
    if (timer.interval) timer.at += timer.interval
    else timers.delete(id)
    timer.fn()
    await flush()
  }
  now = end
  await flush()
}
function emit(target, type, props = {}) {
  const event = new Event(type)
  Object.assign(event, props)
  target.dispatchEvent(event)
}
function deferred() {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}
function candidate(name, fragment = 'remote-1') {
  return {
    candidate: `candidate:${name} 1 udp 123 192.0.2.1 1234 typ srflx ufrag ${fragment}`,
    sdpMid: '0',
    sdpMLineIndex: 0,
    usernameFragment: fragment
  }
}
function signal(connectionId, negotiationId, rest) {
  return { connectionId, negotiationId, ...rest }
}
const description = (type, fragment) => ({ type, sdp: `v=0\r\na=ice-ufrag:${fragment}\r\n` })
function selectedStats(local = 'relay', remote = 'relay', id = 'selected') {
  return new Map([
    ['transport', { type: 'transport', selectedCandidatePairId: id }],
    [
      id,
      {
        id,
        type: 'candidate-pair',
        state: 'succeeded',
        nominated: true,
        localCandidateId: 'local',
        remoteCandidateId: 'remote',
        bytesSent: 1000,
        bytesReceived: 2000,
        currentRoundTripTime: 0.04
      }
    ],
    [
      'local',
      {
        type: 'local-candidate',
        candidateType: local,
        protocol: 'udp',
        relayProtocol: 'udp',
        url: 'turn:relay.test:3478'
      }
    ],
    ['remote', { type: 'remote-candidate', candidateType: remote, protocol: 'udp' }]
  ])
}
const turnFixture = () => ({
  expiresAt: now + 14400000,
  iceServers: [
    { urls: 'turn:relay.test', username: 'SECRET_USER', credential: 'SECRET_CREDENTIAL' }
  ]
})

class Channel extends EventTarget {
  constructor(label = 'xqb-remote-bp') {
    super()
    this.label = label
  }
  label = 'xqb-remote-bp'
  readyState = 'connecting'
  bufferedAmount = 0
  sent = []
  send(raw) {
    this.sent.push(JSON.parse(raw))
  }
  open() {
    this.readyState = 'open'
    emit(this, 'open')
  }
  close() {
    if (this.readyState === 'closed') return
    this.readyState = 'closed'
    emit(this, 'close')
  }
}
class Peer extends EventTarget {
  static all = []
  signalingState = 'stable'
  iceGatheringState = 'new'
  iceConnectionState = 'new'
  connectionState = 'new'
  remoteDescription = null
  localDescription = null
  offers = []
  additions = []
  remoteCalls = 0
  localCalls = 0
  remoteGate = null
  addGate = null
  emitDuringLocal = false
  constructor(config) {
    super()
    this.config = config
    Peer.all.push(this)
  }
  setConfiguration(config) {
    this.config = config
  }
  getConfiguration() {
    return this.config
  }
  createDataChannel(label = 'xqb-remote-bp') {
    const channel = new Channel(label)
    if (label === 'xqb-remote-bp') this.channel = channel
    else this.assetChannel = channel
    return channel
  }
  async createOffer(options) {
    this.offers.push(options)
    return description('offer', `local-${this.offers.length}`)
  }
  async createAnswer() {
    return description('answer', `local-answer-${this.remoteCalls}`)
  }
  async setLocalDescription(value) {
    this.localCalls++
    if (value.type === 'rollback') {
      this.signalingState = 'stable'
      return
    }
    this.localDescription = value
    this.signalingState = value.type === 'offer' ? 'have-local-offer' : 'stable'
    if (this.emitDuringLocal) {
      const fragment = /a=ice-ufrag:(\S+)/.exec(value.sdp)[1]
      const c = candidate('early-local', fragment)
      emit(this, 'icecandidate', { candidate: { toJSON: () => c } })
    }
    emit(this, 'signalingstatechange')
  }
  async setRemoteDescription(value) {
    this.remoteCalls++
    if (this.remoteGate) await this.remoteGate.promise
    assert.notEqual(this.signalingState, 'closed')
    this.remoteDescription = value
    this.signalingState = value.type === 'offer' ? 'have-remote-offer' : 'stable'
    emit(this, 'signalingstatechange')
  }
  async addIceCandidate(c) {
    assert.ok(this.remoteDescription, 'candidate must wait for remoteDescription')
    if (this.addGate) await this.addGate.promise
    this.additions.push(c.candidate)
    if (c.candidate.includes('bad')) throw new Error('OperationError')
  }
  network(ice, connection = ice === 'completed' ? 'connected' : ice) {
    this.iceConnectionState = ice
    this.connectionState = connection
    emit(this, 'iceconnectionstatechange')
    emit(this, 'connectionstatechange')
  }
  close() {
    this.signalingState = 'closed'
    this.connectionState = 'closed'
    this.iceConnectionState = 'closed'
    emit(this, 'connectionstatechange')
  }
}
global.RTCPeerConnection = Peer
class Socket extends EventTarget {
  static OPEN = 1
  static all = []
  readyState = 0
  sent = []
  constructor(url) {
    super()
    this.url = url
    Socket.all.push(this)
    queueMicrotask(() => {
      if (this.readyState === 0) {
        this.readyState = 1
        emit(this, 'open')
      }
    })
  }
  send(raw) {
    assert.equal(this.readyState, 1)
    this.sent.push(JSON.parse(raw))
  }
  message(type, payload, requestId) {
    emit(this, 'message', { data: JSON.stringify({ type, payload, requestId }) })
  }
  close(code = 1000, reason = '') {
    if (this.readyState === 3) return
    this.readyState = 3
    emit(this, 'close', { code, reason, wasClean: true })
  }
}
global.WebSocket = Socket
const logs = []
const realInfo = console.info
console.info = (...args) => logs.push(args)
const sessions = []
function session(offerer = false, id = 'connection-1', options = {}) {
  const sent = [],
    states = [],
    messages = []
  const rtc = new RemoteBpRtcSession({
    connectionId: id,
    peerId: 'peer-1',
    roomId: 'ABCDEF',
    offerer,
    iceServers: [
      { urls: 'stun:example.test' },
      { urls: 'turn:example.test', username: 'u', credential: 'c' }
    ],
    send: (type, payload) => {
      sent.push({ type, payload })
      return true
    },
    onState: (state) => states.push(state),
    onMessage: (data) => messages.push(data),
    ...options
  })
  sessions.push(rtc)
  return { rtc, pc: rtc.pc, sent, states, messages }
}
let runningCase = ''
let suiteFinished = false
process.on('beforeExit', () => {
  if (!suiteFinished) {
    console.error(`Unfinished fake-clock test: ${runningCase}`, {
      now,
      timers: [...timers.values()].map((t) => t.at)
    })
    process.exitCode = 1
  }
})
async function run(name, test) {
  runningCase = name
  try {
    await test()
    realInfo(`PASS ${name}`)
  } finally {
    sessions.splice(0).forEach((rtc) => rtc.close())
    timers.clear()
    now = 0
  }
}

async function main() {
  await run(
    'channel close records pre-destroy SCTP/ICE evidence without a false connecting phase',
    async () => {
      const { rtc, pc } = session(true, 'channel-close-evidence')
      await rtc.start()
      await rtc.receive(
        'ANSWER',
        signal(rtc.connectionId, 1, { description: description('answer', 'remote-1') })
      )
      pc.network('connected')
      pc.channel.open()
      assert.equal(rtc.phase, 'connected')
      pc.channel.readyState = 'closing'
      emit(pc.channel, 'closing')
      assert.equal(rtc.phase, 'connected', 'closing cannot transition back to connecting')
      pc.channel.readyState = 'closed'
      emit(pc.channel, 'error', {
        error: { errorDetail: 'sctp-failure', sctpCauseCode: 12, message: 'SECRET_SDP_PASSWORD' }
      })
      const diagnostic = rtc.getDiagnostic()
      assert.equal(diagnostic.phase, 'failed')
      const failure = diagnostic.closures.find((item) => item.event === 'error')
      assert.equal(failure.iceState, 'connected')
      assert.equal(failure.connectionState, 'connected')
      assert.equal(failure.errorDetail, 'sctp-failure')
      assert.equal(failure.sctpCauseCode, 12)
      assert.ok(!JSON.stringify(diagnostic).includes('SECRET_'))
      const voluntary = session(true, 'voluntary-close')
      voluntary.rtc.close('ASSET_CANCELLED', 'host-room-stop')
      assert.equal(voluntary.rtc.getDiagnostic().closures.at(-1).cause, 'host-room-stop')
      const stalled = session(true, 'closing-timeout')
      stalled.pc.channel.readyState = 'closing'
      emit(stalled.pc.channel, 'closing')
      await tick(11000)
      assert.equal(stalled.rtc.getDiagnostic().errorCode, 'DATA_CHANNEL_CLOSE_TIMEOUT')
    }
  )
  await run(
    'room relay policy reaches Web PC, is retained on rejoin, and errors never become P2P',
    async () => {
      const client = new WebRtcRemoteBpConnection({ signalingUrl: 'ws://test', iceServers: [] })
      const connected = client.connect({
        roomId: 'ABCDEF',
        side: 'first',
        clientId: 'policy-client'
      })
      const outcome = connected.catch((error) => error)
      await flush()
      let ws = Socket.all.at(-1)
      const provider = {
        appId: 'test-app',
        appIdSource: 'env.WTN_APP_ID',
        apiDomain: 'wtn.volcvideo.com'
      }
      ws.message('ROOM_JOINED', {
        roomCode: 'ABCDEF',
        role: 'FIRST',
        sessionId: 'forced-player',
        forceRelay: true,
        turnDiagnostic: provider
      })
      await flush()
      let pc = Peer.all.at(-1)
      assert.equal(pc.config.iceTransportPolicy, 'relay')
      let ready = ws.sent.find((message) => message.type === 'PEER_READY')
      assert.equal(ready.payload.forceRelay, true)
      const identity = {
        roomId: 'ABCDEF',
        peerId: 'forced-player',
        connectionId: ready.payload.connectionId
      }
      ws.message('TURN_CREDENTIALS', {
        ...turnFixture(),
        ...identity,
        turnDiagnostic: {
          ...provider,
          httpStatus: 200,
          providerCode: 200,
          source: 'provider',
          ttl: 14400
        }
      })
      ws.message(
        'OFFER',
        signal(identity.connectionId, 1, {
          fromRole: 'HOST',
          targetSessionId: 'forced-player',
          forceRelay: true,
          description: description('offer', 'remote-1')
        })
      )
      await flush()
      pc.getStats = async () => selectedStats()
      const channel = new Channel()
      emit(pc, 'datachannel', { channel })
      pc.network('connected')
      channel.open()
      await tick(2000)
      assert.equal(client.getSnapshot().state, 'connected')
      assert.equal((await outcome).sessionId, 'forced-player')
      ws.close()
      await tick(1000)
      ws = Socket.all.at(-1)
      ws.message('ROOM_JOINED', {
        roomCode: 'ABCDEF',
        role: 'FIRST',
        sessionId: 'forced-rejoined',
        forceRelay: true,
        turnDiagnostic: provider
      })
      await flush()
      pc = Peer.all.at(-1)
      ready = ws.sent.find((message) => message.type === 'PEER_READY')
      assert.equal(pc.config.iceTransportPolicy, 'relay')
      ws.message('ERROR', {
        code: 'TURN_PROVIDER_DENIED',
        message: 'TURN denied',
        connectionId: ready.payload.connectionId,
        turnDiagnostic: { ...provider, httpStatus: 403 }
      })
      await flush()
      assert.equal(client.getSnapshot().state, 'failed')
      assert.equal(pc.config.iceTransportPolicy, 'relay')
      assert.equal(pc.remoteCalls, 0)
      await client.disconnect()
    }
  )
  await run(
    'forced TURN requires the selected pair, rejects direct/unknown paths, and revalidates restarts',
    async () => {
      for (const [local, remote, code] of [
        ['host', 'srflx', 'TURN_PATH_NOT_RELAY'],
        ['relay', 'host', 'TURN_PATH_NOT_RELAY'],
        ['host', null, 'TURN_PATH_NOT_RELAY'],
        ['relay', null, 'TURN_PATH_UNVERIFIED'],
        [null, null, 'TURN_PATH_UNVERIFIED'],
        ['relay', 'relay', null]
      ]) {
        const { rtc, pc } = session(true, `proof-${local}-${remote}`, { testOnlyForceRelay: true })
        rtc.applyTurn(turnFixture())
        let stats = selectedStats(local, remote)
        // Collected/nominated relay decoy is never proof if transport selects direct.
        stats.set('decoy', {
          id: 'decoy',
          type: 'candidate-pair',
          state: 'succeeded',
          nominated: true,
          localCandidateId: 'relay-decoy',
          remoteCandidateId: 'relay-decoy'
        })
        stats.set('relay-decoy', { type: 'local-candidate', candidateType: 'relay' })
        pc.getStats = async () => stats
        await rtc.start()
        await rtc.receive(
          'ANSWER',
          signal(rtc.connectionId, 1, {
            description: description('answer', 'remote-1'),
            forceRelay: true
          })
        )
        pc.network('connected')
        pc.channel.open()
        assert.notEqual(rtc.phase, 'connected', 'channel open alone cannot prove relay')
        await tick(23000)
        if (code) {
          assert.equal(rtc.phase, 'failed')
          assert.equal(rtc.getDiagnostic().errorCode, code)
        } else {
          assert.equal(rtc.phase, 'connected')
          assert.equal(rtc.getDiagnostic().relayVerified, true)
          stats.get('selected').bytesSent += 50000
          await tick(1000)
          assert.equal(rtc.getDiagnostic().trafficSamples.at(-1).sentDelta, 50000)
          rtc.requestRestart('test')
          await flush()
          assert.equal(pc.config.iceTransportPolicy, 'relay')
          assert.equal(rtc.getDiagnostic().relayVerified, false)
          stats = selectedStats('relay', 'relay', 'after-restart')
          await rtc.receive(
            'ANSWER',
            signal(rtc.connectionId, 2, {
              description: description('answer', 'remote-2'),
              forceRelay: true
            })
          )
          await tick(2000)
          assert.equal(rtc.phase, 'connected')
          assert.deepEqual(
            rtc.getDiagnostic().pairHistory.map((p) => p.id),
            ['selected', 'after-restart']
          )
          rtc.clearTurn('revoked')
          assert.equal(rtc.phase, 'failed')
          assert.equal(pc.config.iceTransportPolicy, 'relay')
        }
        rtc.close()
      }
    }
  )
  await run(
    'answerer installs forced policy before SDP and cannot answer without credentials',
    async () => {
      const missing = session(false, 'answer-missing')
      await missing.rtc.receive(
        'OFFER',
        signal('answer-missing', 1, {
          description: description('offer', 'remote-1'),
          forceRelay: true
        })
      )
      assert.equal(missing.rtc.phase, 'failed')
      assert.equal(missing.pc.remoteCalls, 0)
      assert.equal(missing.pc.config.iceTransportPolicy, 'relay')
      const ready = session(false, 'answer-ready')
      ready.rtc.applyTurn(turnFixture())
      await ready.rtc.receive(
        'OFFER',
        signal('answer-ready', 1, {
          description: description('offer', 'remote-1'),
          forceRelay: true
        })
      )
      assert.equal(ready.pc.config.iceTransportPolicy, 'relay')
      assert.equal(ready.sent.find((s) => s.type === 'ANSWER').payload.forceRelay, true)
      const old = session(true, 'old-client', { testOnlyForceRelay: true })
      old.rtc.applyTurn(turnFixture())
      await old.rtc.start()
      await old.rtc.receive(
        'ANSWER',
        signal('old-client', 1, { description: description('answer', 'remote-1') })
      )
      assert.equal(old.rtc.getDiagnostic().errorCode, 'TURN_POLICY_UNCONFIRMED')
    }
  )
  await run(
    'TURN response metadata is allowlisted and equal-expiry credential replacement is installed',
    async () => {
      const { rtc, pc } = session(true, 'metadata')
      const payload = {
        ...turnFixture(),
        turnDiagnostic: {
          appId: 'test-app',
          appIdSource: 'env.WTN_APP_ID',
          httpStatus: 200,
          providerCode: 200,
          ttl: 14400,
          source: 'provider',
          token: 'SECRET_TOKEN',
          username: 'SECRET_USER'
        }
      }
      rtc.applyTurn(payload)
      assert.equal(rtc.getDiagnostic().turnRequests.at(-1).appId, 'test-app')
      rtc.applyTurn({
        ...payload,
        iceServers: [{ urls: 'turn:other.test', username: 'u2', credential: 'c2' }]
      })
      assert.ok(JSON.stringify(pc.config).includes('other.test'))
      rtc.turnFailed('TURN_PROVIDER_DENIED', {
        ...payload.turnDiagnostic,
        httpStatus: 401,
        providerCode: 402
      })
      assert.equal(rtc.getDiagnostic().turnRequests.at(-1).httpStatus, 401)
      assert.ok(!JSON.stringify(rtc.getDiagnostic()).includes('SECRET_'))
    }
  )
  await run(
    'successful UDP does not leave a fallback timer that restarts on a brief outage',
    async () => {
      const { rtc, pc } = session(true, 'udp-success', { testOnlyForceRelay: true })
      pc.getStats = async () => selectedStats()
      rtc.applyTurn({
        expiresAt: 14_400_000,
        iceServers: [
          {
            urls: ['turn:relay.test?transport=udp', 'turn:relay.test?transport=tcp'],
            username: 'u',
            credential: 'p'
          }
        ]
      })
      await rtc.start()
      await rtc.receive(
        'ANSWER',
        signal(rtc.connectionId, 1, {
          description: description('answer', 'remote-1'),
          forceRelay: true
        })
      )
      pc.network('connected')
      pc.channel.open()
      await tick(4000)
      pc.network('disconnected')
      await tick(5000)
      assert.equal(pc.offers.length, 1)
      pc.network('connected')
      assert.equal(rtc.phase, 'connected')
    }
  )
  await run('UDP first, bounded TCP fallback and transient disconnect grace', async () => {
    const { rtc, pc } = session(true, 'udp-first', { testOnlyForceRelay: true })
    pc.getStats = async () => selectedStats()
    rtc.applyTurn({
      expiresAt: 14_400_000,
      requestedTtl: 14400,
      ttl: 14400,
      apiDomain: 'wtn.volcvideo.com',
      iceServers: [
        {
          urls: ['turn:relay.test:3479?transport=tcp', 'turn:relay.test:3478?transport=udp'],
          username: 'SECRET_TURN_USER',
          credential: 'SECRET_TURN_PASSWORD'
        }
      ]
    })
    assert.ok(!JSON.stringify(pc.config).includes('transport=tcp'))
    assert.equal(rtc.getDiagnostic().turnActualTtl, 14400)
    await rtc.start()
    await rtc.receive(
      'ANSWER',
      signal(rtc.connectionId, 1, {
        description: description('answer', 'remote-1'),
        forceRelay: true
      })
    )
    pc.network('checking', 'connecting')
    await tick(RTC_TIMING.udpPreferenceMs)
    assert.ok(JSON.stringify(pc.config).includes('transport=tcp'))
    assert.equal(pc.offers.length, 2)
    assert.equal(pc.config.iceTransportPolicy, 'relay')
    await rtc.receive(
      'ANSWER',
      signal(rtc.connectionId, 2, {
        description: description('answer', 'remote-2'),
        forceRelay: true
      })
    )
    pc.network('connected')
    pc.channel.open()
    pc.network('disconnected')
    await tick(5000)
    pc.network('connected')
    assert.equal(pc.offers.length, 2, 'short interruptions must not churn ICE')
  })
  await run(
    'automatic mode adds TURN after five seconds, failed refresh preserves live ICE',
    async () => {
      let requested = 0
      const early = session(true, 'early-relay', {
        prepareRestart: async () => {
          requested++
        }
      })
      await early.rtc.start()
      await tick(5000)
      assert.equal(requested, 1)
      early.rtc.close()
      const { rtc, pc } = session(true, 'refresh-failed', {
        testOnlyForceRelay: true,
        prepareRestart: async () => {
          requested++
          rtc.turnFailed('TURN_UNAVAILABLE')
        }
      })
      rtc.applyTurn({
        expiresAt: now + 120_000,
        iceServers: [{ urls: 'turn:relay.test', username: 'u', credential: 'p' }]
      })
      pc.getStats = async () => selectedStats()
      await rtc.start()
      await rtc.receive(
        'ANSWER',
        signal(rtc.connectionId, 1, {
          description: description('answer', 'remote-1'),
          forceRelay: true
        })
      )
      pc.network('connected')
      pc.channel.open()
      await tick(90_000)
      assert.equal(pc.offers.length, 1)
      assert.equal(rtc.phase, 'connected')
      assert.ok(requested > 1)
    }
  )
  await run(
    'ICE 701 logs safe server/protocol/cause, suppresses repeats and never restarts on its own',
    async () => {
      const { rtc, pc } = session(true, '701')
      const before = logs.length
      for (let i = 0; i < 30; i++)
        emit(pc, 'icecandidateerror', {
          url: 'turn:relay.test:3478?transport=udp',
          errorCode: 701,
          errorText: 'STUN host lookup received error.'
        })
      assert.equal(rtc.getDiagnostic().iceServerErrors[0].count, 30)
      assert.equal(rtc.getDiagnostic().iceServerErrors[0].reason, 'DNS_LOOKUP_FAILED')
      assert.equal(rtc.getDiagnostic().iceServerErrors[0].protocol, 'udp')
      assert.equal(
        logs.slice(before).filter((x) => x[1]?.event === 'candidate gathering error').length,
        1
      )
      emit(pc, 'icecandidateerror', {
        url: 'turn:user:SECRET_TOKEN@relay.test?password=SECRET_KEY',
        errorCode: 701,
        errorText: 'SECRET_PASSWORD'
      })
      assert.ok(!JSON.stringify(rtc.getDiagnostic()).includes('SECRET_'))
      assert.equal(pc.offers.length, 0)
    }
  )
  await run(
    'adaptive pacing grows on stable high RTT, reduces on congestion and always has a ceiling',
    async () => {
      const pacer = new AssetPacer()
      for (let at = 1000; at <= 12000; at += 1000) pacer.sample(at, 256 * 1024, 650, 0)
      assert.equal(pacer.rate, 256 * 1024)
      pacer.sample(13000, 256 * 1024, 950, 64 * 1024)
      assert.equal(pacer.rate, 256 * 1024, 'one delayed sample is not sustained congestion')
      for (let at = 14000; at <= 60000; at += 1000) pacer.sample(at, 256 * 1024, 1200, 64 * 1024)
      assert.equal(pacer.rate, 16 * 1024)
      assert.ok(pacer.sample(61000, 64 * 1024, 650, 0) <= 64 * 1024)
      const healthy = new AssetPacer()
      for (let at = 1000; at <= 60000; at += 1000)
        healthy.sample(at, 256 * 1024, 500, 24 * 1024, 'udp-relay')
      assert.equal(healthy.rate, 256 * 1024, 'normal high-RTT queue must not collapse to 16 KiB/s')
    }
  )
  await run(
    'stats gaps do not flap a verified connection; persistent loss still fails forced TURN',
    async () => {
      const { rtc, pc, states } = session(true, 'stats-gaps', { testOnlyForceRelay: true })
      rtc.applyTurn(turnFixture())
      let reports = selectedStats()
      pc.getStats = async () => reports
      await rtc.start()
      await rtc.receive(
        'ANSWER',
        signal(rtc.connectionId, 1, {
          description: description('answer', 'remote-1'),
          forceRelay: true
        })
      )
      pc.network('connected')
      pc.channel.open()
      await tick(2000)
      assert.equal(rtc.phase, 'connected')
      const transitions = states.length
      reports.get('selected').state = 'in-progress'
      await tick(1000)
      assert.equal(
        rtc.getDiagnostic().statsStatus,
        'current',
        'transport selection is authoritative during checks'
      )
      reports = new Map()
      await tick(4000)
      assert.equal(rtc.phase, 'connected')
      assert.equal(rtc.getDiagnostic().statsStatus, 'stale')
      reports = selectedStats()
      await tick(2000)
      assert.equal(states.length, transitions, 'no redundant ready callback or STATE_REQUEST')
      emit(pc, 'icecandidateerror', {
        url: 'turn:relay.test:3478',
        errorCode: 701,
        errorText: 'STUN timeout'
      })
      assert.equal(rtc.getDiagnostic().errorCode, null)
      assert.equal(rtc.getDiagnostic().iceServerErrors.at(-1).impact, 'connected-probe-failure')
      assert.equal(rtc.getDiagnostic().iceServerErrors.at(-1).selectedServer, true)
      reports = new Map()
      await tick(23000)
      assert.equal(rtc.phase, 'failed')
      assert.equal(rtc.getDiagnostic().errorCode, 'TURN_PATH_UNVERIFIED')
      assert.equal(rtc.getDiagnostic().statsStatus, 'closed')
      assert.equal(
        rtc.getDiagnostic().relayVerified,
        true,
        'close retains timestamped historical proof'
      )
    }
  )
  await run(
    '500 ms relay model: two independent bulk senders preserve control priority and bounded pacing',
    async () => {
      const transport = new WebRtcRemoteHostTransport({
        signalingUrl: 'ws://test',
        iceServers: [],
        assetRateKiBps: 256
      })
      const peers = []
      for (const side of ['first', 'second']) {
        const { rtc, pc } = session(true, `slow-${side}`)
        await rtc.start()
        await rtc.receive(
          'ANSWER',
          signal(rtc.connectionId, 1, { description: description('answer', 'remote-1') })
        )
        pc.network('connected')
        pc.channel.open()
        const stats = selectedStats()
        stats.get('selected').currentRoundTripTime = 0.5
        pc.getStats = async () => stats
        const assets = new Channel('xqb-remote-bp-assets-v1')
        emit(pc, 'datachannel', { channel: assets })
        assets.open()
        let wireEnd = now
        assets.maxBuffered = 0
        assets.send = (raw) => {
          const bytes = typeof raw === 'string' ? Buffer.byteLength(raw) : raw.byteLength
          assets.sent.push(
            typeof raw === 'string'
              ? JSON.parse(raw)
              : { type: 'BINARY_CHUNK', payload: decodeBinaryAssetChunk(raw) }
          )
          assets.bufferedAmount += bytes
          assets.maxBuffered = Math.max(assets.maxBuffered, assets.bufferedAmount)
          wireEnd = Math.max(wireEnd, now) + (bytes / (128 * 1024)) * 1000
          window.setTimeout(
            () => {
              assets.bufferedAmount -= bytes
              if (assets.bufferedAmount <= assets.bufferedAmountLowThreshold)
                emit(assets, 'bufferedamountlow')
            },
            wireEnd + 500 - now
          )
        }
        const peer = {
          side,
          peerId: side,
          rtc,
          assetTransfers: new Map(),
          nextAssetAt: 0,
          controlUntil: 0,
          capabilities: side === 'first' ? new Set(['asset-binary-v1']) : new Set()
        }
        transport.peers.set(side, peer)
        peers.push({ ...peer, pc, assets })
      }
      await tick(1000)
      const started = now
      const image = async (peer, id, size) => {
        await transport.send(peer.peerId, {
          type: 'ASSET_START',
          payload: { transferId: id, asset: { size } }
        })
        let total = 0
        while (total < size) {
          const bytes = Math.min(11520, size - total)
          await transport.send(peer.peerId, {
            type: 'ASSET_CHUNK',
            payload: {
              transferId: id,
              assetId: 'asset',
              index: Math.floor(total / 11520),
              total: Math.ceil(size / 11520),
              data: Buffer.alloc(bytes).toString('base64')
            }
          })
          total += bytes
        }
        await transport.send(peer.peerId, { type: 'ASSET_COMPLETE', payload: { transferId: id } })
      }
      const jobs = peers.map((peer) => image(peer, peer.peerId, 300 * 1024))
      await tick(500)
      for (const peer of peers) {
        await transport.send(peer.peerId, {
          type: 'ACTION_RESULT',
          payload: { actionId: 'priority' }
        })
        await transport.send(peer.peerId, { type: 'PONG', payload: {} })
        assert.deepEqual(
          peer.pc.channel.sent.map((m) => m.type),
          ['ACTION_RESULT', 'PONG']
        )
        assert.ok(peer.rtc.getDiagnostic().transfers[0].bytes < 300 * 1024)
      }
      await tick(9000)
      await Promise.all(jobs)
      for (const peer of peers) {
        const entry = peer.rtc.getDiagnostic().transfers[0]
        assert.ok(entry.durationMs < 8000, `300 KiB queued in ${entry.durationMs} ms`)
        assert.ok(entry.wireBytes > entry.totalBytes, 'wire overhead is explicitly measured')
        if (peer.side === 'first') {
          assert.equal(entry.encoding, 'binary-v1')
          assert.ok(entry.wireBytes < entry.totalBytes * 1.05)
        } else assert.equal(entry.encoding, 'base64-json')
        assert.ok(peer.rtc.getDiagnostic().assetRateLimit > 16 * 1024)
        assert.ok(peer.assets.maxBuffered <= 144 * 1024, 'bounded image queue throughout transfer')
        assert.equal(entry.status, 'submitted', 'send is not receipt')
        emit(peer.assets, 'message', {
          data: JSON.stringify({
            type: 'ASSET_RECEIPT_V1',
            id: peer.peerId,
            status: 'verified',
            bytes: 1
          })
        })
        assert.equal(
          peer.rtc.getDiagnostic().transfers[0].status,
          'submitted',
          'reject wrong-length receipt'
        )
        for (const status of ['received', 'verified'])
          emit(peer.assets, 'message', {
            data: JSON.stringify({
              type: 'ASSET_RECEIPT_V1',
              id: peer.peerId,
              status,
              bytes: 300 * 1024
            })
          })
        assert.equal(peer.rtc.getDiagnostic().transfers[0].receiptSource, 'peer')
      }
      const tiny = image(peers[0], 'tiny', 3 * 1024)
      await tick(1000)
      await tiny
      assert.ok(peers[0].rtc.getDiagnostic().transfers.at(-1).durationMs < 1000)
      realInfo(
        `MODEL binary/legacy 300 KiB submissions: ${peers.map((p) => p.rtc.getDiagnostic().transfers[0].submittedAt - started).join('/')} ms (synthetic 500 ms RTT, 128 KiB/s per link; not WTN)`
      )
    }
  )
  await run('receiver idle timeout is distinct and drops partial bytes for retry', async () => {
    const store = new IncomingAssetTransfers()
    const asset = {
      assetId: 'asset',
      size: 6,
      hash: 'a'.repeat(64),
      type: 'avatar',
      mimeType: 'image/png'
    }
    store.setManifest({ assets: [asset] })
    store.start({ transferId: 'idle', asset, chunkSize: 3, totalChunks: 2 })
    await tick(20000)
    store.addChunk({ transferId: 'idle', assetId: 'asset', index: 0, total: 2, data: 'AQID' })
    await tick(20000)
    assert.equal(
      store.expireIdle().length,
      0,
      'active transfer must not expire from its start time'
    )
    await tick(10000)
    assert.deepEqual(store.expireIdle(), [{ transferId: 'idle', assetId: 'asset' }])
    store.start({ transferId: 'retry', asset, chunkSize: 3, totalChunks: 2 })
    store.reset()
  })
  await run(
    'sender stalls have a timeout diagnosis, independent of room-close cancellation',
    async () => {
      const { rtc, pc } = session(true, 'send-timeout')
      await rtc.start()
      await rtc.receive(
        'ANSWER',
        signal(rtc.connectionId, 1, { description: description('answer', 'remote-1') })
      )
      pc.network('connected')
      pc.channel.open()
      const transport = new WebRtcRemoteHostTransport({ signalingUrl: 'ws://test', iceServers: [] })
      transport.peers.set('first', {
        peerId: 'p',
        side: 'first',
        rtc,
        assetTransfers: new Map(),
        nextAssetAt: 0,
        controlUntil: 0
      })
      pc.channel.bufferedAmount = 64 * 1024
      const send = transport
        .send('p', {
          type: 'ASSET_START',
          payload: { transferId: 'stalled', asset: { size: 100 } }
        })
        .catch((e) => e)
      await flush()
      await tick(31000)
      assert.equal((await send).message, 'ASSET_SEND_TIMEOUT')
      assert.equal(rtc.getDiagnostic().transfers[0].reason, 'ASSET_SEND_TIMEOUT')
      assert.equal(rtc.phase, 'connected')
    }
  )
  await run(
    'TURN denial is a separate warning and does not mark a connected room as failed',
    async () => {
      const host = new WebRtcRemoteHostTransport({ signalingUrl: 'ws://test', iceServers: [] })
      const statuses = []
      host.onStatusChange((status) => statuses.push(status))
      const started = host.start()
      await flush()
      const ws = Socket.all.at(-1)
      ws.message('ROOM_CREATED', {
        roomCode: 'ABCDEF',
        createdAt: '2026-10-11T00:00:00Z',
        expiresAt: '9999-12-31T00:00:00Z',
        resumeToken: '0123456789abcdef',
        turnAuthorizedUntil: 3_600_000
      })
      await started
      ws.message('PEER_JOINED', { role: 'FIRST', sessionId: 'warning-player' })
      ws.message(
        'PEER_READY',
        signal('warning-ready', 0, { fromRole: 'FIRST', fromSessionId: 'warning-player' })
      )
      await flush()
      ws.message(
        'ANSWER',
        signal('warning-ready', 1, {
          fromRole: 'FIRST',
          fromSessionId: 'warning-player',
          description: description('answer', 'remote-1')
        })
      )
      await flush()
      const peer = host.peers.get('first'),
        pc = peer.rtc.pc
      pc.network('connected')
      pc.channel.open()
      const denied = host.prepareTurn(peer)
      await flush()
      const request = ws.sent.filter((message) => message.type === 'TURN_REQUEST').at(-1)
      ws.message(
        'ERROR',
        { code: 'TURN_PROVIDER_DENIED', message: 'WTN 拒绝请求' },
        request.requestId
      )
      await denied
      assert.equal(statuses.at(-1).turnWarning, 'WTN 拒绝请求')
      assert.equal(statuses.at(-1).error, undefined)
      assert.equal(peer.rtc.phase, 'connected')
      assert.equal(pc.channel.readyState, 'open')
      assert.equal(peer.rtc.getDiagnostic().errorCode, 'TURN_PROVIDER_DENIED')
      const retry = host.prepareTurn(peer)
      await flush()
      const next = ws.sent.filter((message) => message.type === 'TURN_REQUEST').at(-1)
      ws.message(
        'TURN_CREDENTIALS',
        {
          roomId: 'ABCDEF',
          peerId: 'warning-player',
          connectionId: 'warning-ready',
          expiresAt: 3_600_000,
          iceServers: [{ urls: 'turn:relay.test', username: 'u', credential: 'c' }]
        },
        next.requestId
      )
      await retry
      assert.equal(statuses.at(-1).turnWarning, null)
      await host.stop()
    }
  )
  await run(
    'selected pair statistics, safe protocol fields, counter resets and ambiguity',
    async () => {
      const { rtc, pc } = session(true, 'statistics')
      await rtc.start()
      await rtc.receive(
        'ANSWER',
        signal(rtc.connectionId, 1, { description: description('answer', 'remote-1') })
      )
      pc.network('connected')
      pc.channel.open()
      const selected = {
        id: 'pair',
        type: 'candidate-pair',
        state: 'succeeded',
        nominated: true,
        localCandidateId: 'local',
        remoteCandidateId: 'remote',
        currentRoundTripTime: 0.125,
        bytesSent: 1000,
        bytesReceived: 2000
      }
      const reports = new Map([
        ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }],
        ['pair', selected],
        [
          'local',
          {
            type: 'local-candidate',
            candidateType: 'relay',
            protocol: 'udp',
            relayProtocol: 'tls',
            address: '192.0.2.99',
            url: 'turns:SECRET_URL',
            username: 'SECRET_USERNAME'
          }
        ],
        ['remote', { type: 'remote-candidate', candidateType: 'srflx', protocol: 'udp' }],
        ['asset', { type: 'data-channel', label: 'xqb-remote-bp-assets-v1', bytesSent: 500 }]
      ])
      pc.getStats = async () => reports
      await tick(1000)
      assert.equal(rtc.getDiagnostic().pair, 'relay / srflx')
      assert.equal(rtc.getDiagnostic().localRelayProtocol, 'tls')
      assert.equal(rtc.getDiagnostic().remoteRelayProtocol, null)
      assert.equal(rtc.getDiagnostic().rttMs, 125)
      assert.equal(rtc.getDiagnostic().sendBytesPerSecond, null)
      selected.bytesSent += 3000
      selected.bytesReceived += 1000
      reports.get('asset').bytesSent += 2000
      await tick(1000)
      assert.equal(rtc.getDiagnostic().sendBytesPerSecond, 3000)
      assert.equal(rtc.getDiagnostic().receiveBytesPerSecond, 1000)
      assert.equal(rtc.getDiagnostic().assetBytesPerSecond, 2000)
      selected.bytesSent = 1
      await tick(1000)
      assert.equal(
        rtc.getDiagnostic().sendBytesPerSecond,
        null,
        'counter reset must not produce negative speed'
      )
      reports.delete('transport')
      reports.set('pair-2', { ...selected, id: 'pair-2' })
      await tick(1000)
      assert.equal(
        rtc.getDiagnostic().statsStatus,
        'stale',
        'ambiguous nominated pairs must not be guessed'
      )
      assert.equal(
        rtc.getDiagnostic().selectedPair.id,
        'pair',
        'retain only explicitly stale historical evidence'
      )
      reports.set('transport', { type: 'transport', selectedCandidatePairId: 'pair-2' })
      await tick(1000)
      assert.deepEqual(
        rtc.getDiagnostic().pairHistory.map((pair) => pair.id),
        ['pair', 'pair-2'],
        'same candidate types on a new pair must still record the route change'
      )
      assert.equal(rtc.getDiagnostic().packetLossRatio, null, 'missing SCTP loss is not zero loss')
      assert.ok(!/SECRET_|192\.0\.2\.99/.test(JSON.stringify(rtc.getDiagnostic())))
    }
  )
  await run('end-of-candidates is exchanged after SDP, buffered and deduplicated', async () => {
    const { rtc, pc, sent } = session(true, 'completion')
    pc.emitDuringLocal = true
    await rtc.start()
    emit(pc, 'icecandidate', { candidate: null })
    assert.equal(sent[0].type, 'OFFER')
    assert.equal(sent.at(-1).payload.candidate.candidate, '')
    const complete = signal(rtc.connectionId, 1, { candidate: { candidate: '' } })
    await rtc.receive(
      'ICE_CANDIDATE',
      signal(rtc.connectionId, 1, { candidate: candidate('early') })
    )
    await rtc.receive('ICE_CANDIDATE', complete)
    assert.equal(pc.additions.length, 0)
    await rtc.receive(
      'ANSWER',
      signal(rtc.connectionId, 1, { description: description('answer', 'remote-1') })
    )
    await rtc.receive('ICE_CANDIDATE', complete)
    assert.deepEqual(pc.additions, [candidate('early').candidate, ''])
    const counters = rtc.getDiagnostic().candidates
    assert.equal(counters.applied, 2)
    assert.equal(counters.duplicates, 1)
    assert.equal(counters.localComplete, true)
    assert.equal(counters.remoteComplete, true)
  })
  for (const [dtls, sctp, code] of [
    ['connecting', 'connecting', 'DTLS_TIMEOUT'],
    ['connected', 'connecting', 'SCTP_TIMEOUT'],
    ['connected', 'connected', 'DATA_CHANNEL_TIMEOUT']
  ]) {
    await run(`${code} has a distinct diagnosis and bounded restart`, async () => {
      const { rtc, pc } = session(true, code)
      pc.sctp = { state: sctp, transport: { state: dtls } }
      await rtc.start()
      await rtc.receive(
        'ANSWER',
        signal(rtc.connectionId, 1, { description: description('answer', 'remote-1') })
      )
      pc.network('connected')
      await tick(20_000)
      assert.equal(rtc.getDiagnostic().errorCode, code)
      assert.equal(pc.offers.length, 2)
      await tick(100_000)
      assert.equal(rtc.phase, 'failed')
      assert.ok(pc.offers.length <= 3)
    })
  }
  await run(
    'forced TURN cannot offer without credentials; unused expiry does not interrupt P2P',
    async () => {
      const forced = session(true, 'force-missing', { testOnlyForceRelay: true })
      await forced.rtc.start()
      assert.equal(forced.rtc.phase, 'failed')
      assert.equal(forced.rtc.getDiagnostic().errorCode, 'TURN_REQUIRED')
      assert.equal(forced.pc.offers.length, 0)
      const { rtc, pc } = session(true, 'direct-expiry')
      rtc.applyTurn({
        iceServers: [{ urls: 'turn:relay.test', username: 'u', credential: 'c' }],
        expiresAt: 3000
      })
      await rtc.start()
      await rtc.receive(
        'ANSWER',
        signal(rtc.connectionId, 1, { description: description('answer', 'remote-1') })
      )
      pc.network('connected')
      pc.channel.open()
      await tick(4000)
      assert.equal(rtc.phase, 'connected')
      assert.equal(pc.offers.length, 1)
      assert.equal(rtc.getDiagnostic().turn, 'expired')
    }
  )
  await run(
    'asynchronous TURN authorization and credentials do not block the signaling inbox',
    async () => {
      const binding = deferred()
      const host = new WebRtcRemoteHostTransport({
        signalingUrl: 'ws://test',
        iceServers: [],
        testOnlyForceRelay: true,
        turnAuth: { binding: () => binding.promise, onChanged: () => () => {} }
      })
      const started = host.start()
      await flush()
      const ws = Socket.all.at(-1)
      ws.message('ROOM_CREATED', {
        roomCode: 'ABCDEF',
        createdAt: '2026-10-11T00:00:00Z',
        expiresAt: '9999-12-31T00:00:00Z',
        resumeToken: '0123456789abcdef'
      })
      await started
      ws.message('PEER_JOINED', { role: 'FIRST', sessionId: 'async-player' })
      ws.message(
        'PEER_READY',
        signal('async-ready', 0, { fromRole: 'FIRST', fromSessionId: 'async-player' })
      )
      await flush()
      const pc = Peer.all.at(-1)
      assert.equal(pc.offers.length, 0)
      binding.resolve('SECRET_BINDING')
      await flush()
      ws.message('TURN_STATUS', { turnAuthorizedUntil: 3_600_000 })
      await flush()
      const request = ws.sent.find((message) => message.type === 'TURN_REQUEST')
      assert.ok(request, 'TURN status was blocked by pending peer startup')
      assert.equal(pc.offers.length, 0)
      ws.message(
        'TURN_CREDENTIALS',
        {
          roomId: 'ABCDEF',
          peerId: 'async-player',
          connectionId: 'async-ready',
          expiresAt: 3_600_000,
          iceServers: [
            { urls: 'turns:relay.test', username: 'SECRET_USER', credential: 'SECRET_PASSWORD' }
          ]
        },
        request.requestId
      )
      await flush()
      assert.equal(pc.offers.length, 1)
      assert.equal(pc.config.iceTransportPolicy, 'relay')
      assert.equal(pc.config.iceServers[0].credential, 'SECRET_PASSWORD')
      assert.ok(!/SECRET_BINDING|SECRET_PASSWORD/.test(JSON.stringify(logs)))
      await host.stop()
    }
  )
  await run(
    'image transfer pins its stream when optional channel opens late; close fails queued send',
    async () => {
      const { rtc, pc } = session(true, 'streams')
      await rtc.start()
      pc.channel.open()
      const host = new WebRtcRemoteHostTransport({ signalingUrl: 'ws://test', iceServers: [] })
      const peer = {
        peerId: 'peer-1',
        side: 'first',
        role: 'FIRST',
        rtc,
        announced: true,
        assetTransfers: new Map(),
        nextAssetAt: 0,
        controlUntil: 0
      }
      host.peers.set('first', peer)
      await host.send(peer.peerId, {
        type: 'ASSET_START',
        payload: { transferId: 'first', asset: { size: 3 } }
      })
      const assets = new Channel('xqb-remote-bp-assets-v1')
      emit(pc, 'datachannel', { channel: assets })
      assets.open()
      const completion = host.send(peer.peerId, {
        type: 'ASSET_COMPLETE',
        payload: { transferId: 'first' }
      })
      await tick(200)
      await completion
      assert.equal(assets.sent.length, 0)
      assert.equal(pc.channel.sent.at(-1).type, 'ASSET_COMPLETE')
      const second = host.send(peer.peerId, {
        type: 'ASSET_START',
        payload: { transferId: 'second', asset: { size: 3 } }
      })
      await tick(200)
      await second
      assert.equal(assets.sent.length, 1)
      assets.bufferedAmount = 128 * 1024
      const blocked = host
        .send(peer.peerId, { type: 'ASSET_COMPLETE', payload: { transferId: 'second' } })
        .catch((error) => error)
      await flush()
      assets.close()
      await tick(20)
      assert.match((await blocked).message, /ASSET_NETWORK_INTERRUPTED/)
      assert.equal(peer.assetTransfers.size, 0)
    }
  )
  await run(
    'TURN refresh keeps DataChannel, removes expired/revoked relays, and redacts diagnostics',
    async () => {
      let refreshed = 0,
        authorized = true
      const credentials = {
        iceServers: [
          {
            urls: ['turn:relay.example.test:3478'],
            username: 'SECRET_TURN_USER',
            credential: 'SECRET_TURN_CREDENTIAL'
          }
        ],
        expiresAt: 100_000
      }
      const { rtc, pc } = session(true, 'turn-refresh', {
        prepareRestart: async () => {
          if (!authorized) return
          refreshed++
          rtc.applyTurn({ ...credentials, expiresAt: now + 3_600_000 })
        }
      })
      assert.equal(pc.config.iceTransportPolicy, 'all')
      assert.equal(
        pc.config.iceServers.some((s) => String(s.urls).includes('turn:')),
        false
      )
      rtc.turnRequested()
      rtc.applyTurn(credentials)
      assert.equal(pc.config.iceServers.length, 2)
      assert.equal(pc.config.iceTransportPolicy, 'all')
      const channel = rtc.channel
      await rtc.start()
      await rtc.receive(
        'ANSWER',
        signal(rtc.connectionId, 1, { description: description('answer', 'remote-1') })
      )
      pc.network('connected')
      pc.channel.open()
      await flush()
      pc.getStats = async () =>
        new Map([
          ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }],
          [
            'pair',
            {
              type: 'candidate-pair',
              state: 'succeeded',
              localCandidateId: 'local',
              remoteCandidateId: 'remote'
            }
          ],
          [
            'local',
            {
              type: 'local-candidate',
              candidateType: 'relay',
              username: credentials.iceServers[0].username
            }
          ],
          ['remote', { type: 'remote-candidate', candidateType: 'host' }]
        ])
      await tick(70_000)
      assert.equal(refreshed, 1)
      assert.equal(rtc.channel, channel)
      assert.equal(pc.offers[1].iceRestart, true)
      assert.equal(getRtcDiagnostics().find((d) => d.connectionId === 'turn-refresh').relay, true)
      await rtc.receive(
        'ANSWER',
        signal(rtc.connectionId, 2, { description: description('answer', 'remote-2') })
      )
      await flush()
      authorized = false
      rtc.clearTurn('撤销测试')
      await flush()
      assert.equal(pc.config.iceTransportPolicy, 'all')
      assert.equal(pc.config.iceServers.length, 1)
      assert.equal(JSON.stringify(getRtcDiagnostics()).includes('SECRET_TURN'), false)
      assert.equal(JSON.stringify(logs).includes('SECRET_TURN'), false)
    }
  )
  await run('relay policy is opt-in and requires temporary credentials', async () => {
    const { rtc, pc } = session(false, 'test-relay', { testOnlyForceRelay: true })
    assert.equal(pc.config.iceTransportPolicy, 'relay')
    rtc.applyTurn({
      iceServers: [
        { urls: ['turn:relay.example.test'], username: 'mock-user', credential: 'mock-credential' }
      ],
      expiresAt: 2_000
    })
    assert.equal(pc.config.iceTransportPolicy, 'relay')
    await tick(2_000)
    assert.equal(
      pc.config.iceTransportPolicy,
      'relay',
      'forced mode must never silently test direct connectivity'
    )
    assert.equal(rtc.relayExpiresAt, null)
    assert.equal(getRtcDiagnostics().find((d) => d.connectionId === 'test-relay').turn, 'expired')
    assert.equal(
      rtc.phase,
      'failed',
      'expired forced relay must close instead of retaining a direct path'
    )
  })
  await run(
    'signaling outage can skip an offer generation and late socket errors still reconnect',
    async () => {
      const { rtc, pc } = session()
      await rtc.receive(
        'ICE_CANDIDATE',
        signal(rtc.connectionId, 2, { candidate: candidate('generation-two', 'remote-2') })
      )
      await rtc.receive(
        'OFFER',
        signal(rtc.connectionId, 2, { description: description('offer', 'remote-2') })
      )
      assert.equal(pc.remoteCalls, 1)
      assert.equal(pc.additions.length, 1)

      const client = new WebRtcRemoteBpConnection({ signalingUrl: 'ws://test', iceServers: [] })
      const connected = client.connect({ roomId: 'ABCDEF', side: 'first', clientId: 'client' })
      const rejected = connected.catch((error) => error)
      await flush()
      const oldSocket = Socket.all.at(-1)
      oldSocket.message('ROOM_JOINED', {
        roomCode: 'ABCDEF',
        role: 'FIRST',
        sessionId: 'old-player'
      })
      await flush()
      const oldPc = Peer.all.at(-1)
      // A handshake error listener must not null out this.socket before the close handler.
      emit(oldSocket, 'error')
      assert.equal(oldSocket.readyState, 1)
      oldSocket.close()
      oldPc.close()
      await tick(1_000)
      const newSocket = Socket.all.at(-1)
      assert.notEqual(newSocket, oldSocket)
      assert.ok(newSocket.sent.some((message) => message.type === 'JOIN_ROOM'))
      newSocket.message('ROOM_JOINED', {
        roomCode: 'ABCDEF',
        role: 'FIRST',
        sessionId: 'new-player'
      })
      await flush()
      assert.notEqual(Peer.all.at(-1), oldPc)
      assert.ok(newSocket.sent.some((message) => message.type === 'PEER_READY'))
      await client.disconnect()
      await rejected
    }
  )
  await run(
    'candidate before SDP, duplicates, one bad candidate, and serialized drain',
    async () => {
      const { rtc, pc } = session()
      const bad = signal(rtc.connectionId, 1, { candidate: candidate('bad') })
      const good = signal(rtc.connectionId, 1, { candidate: candidate('good') })
      await rtc.receive('ICE_CANDIDATE', bad)
      await rtc.receive('ICE_CANDIDATE', good)
      await rtc.receive('ICE_CANDIDATE', good)
      assert.equal(pc.additions.length, 0)
      pc.remoteGate = deferred()
      const offer = rtc.receive(
        'OFFER',
        signal(rtc.connectionId, 1, { description: description('offer', 'remote-1') })
      )
      await flush()
      const last = rtc.receive(
        'ICE_CANDIDATE',
        signal(rtc.connectionId, 1, { candidate: candidate('last') })
      )
      assert.equal(pc.additions.length, 0)
      pc.remoteGate.resolve()
      await Promise.all([offer, last])
      assert.deepEqual(pc.additions, [
        bad.candidate.candidate,
        good.candidate.candidate,
        candidate('last').candidate
      ])
      assert.notEqual(rtc.phase, 'failed')
    }
  )
  await run(
    'local SDP precedes candidates, duplicate SDP replay, old generation rejected',
    async () => {
      const { rtc, pc, sent } = session(true)
      pc.emitDuringLocal = true
      await rtc.start()
      assert.deepEqual(
        sent.map((m) => m.type),
        ['OFFER', 'ICE_CANDIDATE']
      )
      const answer = signal(rtc.connectionId, 1, { description: description('answer', 'remote-1') })
      await rtc.receive('ANSWER', answer)
      await rtc.receive('ANSWER', answer)
      assert.equal(pc.remoteCalls, 1)
      rtc.requestRestart('test')
      await flush()
      assert.equal(pc.offers[1].iceRestart, true)
      await rtc.receive(
        'ICE_CANDIDATE',
        signal(rtc.connectionId, 2, { candidate: candidate('new', 'remote-2') })
      )
      assert.equal(
        pc.additions.length,
        0,
        'new ICE generation must wait for its answer despite old remoteDescription'
      )
      await rtc.receive('ANSWER', answer)
      assert.equal(pc.remoteCalls, 1)
      await rtc.receive(
        'ANSWER',
        signal(rtc.connectionId, 2, { description: description('answer', 'remote-2') })
      )
      assert.equal(pc.additions.length, 1)
      assert.deepEqual(
        pc.config.iceServers,
        [{ urls: ['stun:example.test'] }],
        'public/static TURN configuration must never grant paid access'
      )
    }
  )
  await run(
    'slow ICE survives 20 seconds, restarts twice, total deadline closes resources',
    async () => {
      const { rtc, pc } = session(true)
      await rtc.start()
      pc.network('checking', 'connecting')
      await tick(21_000)
      assert.notEqual(rtc.phase, 'failed')
      assert.equal(pc.offers.length, 1)
      await tick(24_000)
      assert.equal(pc.offers.length, 2)
      await tick(45_000)
      assert.equal(pc.offers.length, 3)
      await tick(30_000)
      assert.equal(rtc.phase, 'failed')
      await tick(200_000)
      assert.equal(pc.offers.length, 3)
    }
  )
  await run(
    'disconnected grace, failed event coalescing, successful restart uses same PC/channel',
    async () => {
      const { rtc, pc, states } = session(true)
      await rtc.start()
      await rtc.receive(
        'ANSWER',
        signal(rtc.connectionId, 1, { description: description('answer', 'remote-1') })
      )
      pc.network('connected')
      rtc.channel.open()
      assert.equal(rtc.phase, 'connected')
      await tick(180_000)
      pc.network('disconnected')
      await tick(10_000)
      assert.equal(pc.offers.length, 1)
      pc.network('connected')
      assert.equal(rtc.phase, 'connected')
      pc.network('failed')
      await flush()
      assert.equal(pc.offers.length, 2)
      emit(pc, 'iceconnectionstatechange')
      emit(pc, 'connectionstatechange')
      await flush()
      assert.equal(pc.offers.length, 2)
      await rtc.receive(
        'ANSWER',
        signal(rtc.connectionId, 2, { description: description('answer', 'remote-2') })
      )
      pc.network('connected')
      assert.equal(rtc.phase, 'connected')
      assert.equal(rtc.channel, pc.channel)
      assert.equal(states.filter((s) => s === 'connected').length, 3)
      pc.network('disconnected')
      await tick(15_000)
      assert.equal(pc.offers.length, 3)
    }
  )
  await run(
    'DataChannel deadline starts only after ICE, answerer requests restart without closing',
    async () => {
      const { rtc, pc, sent } = session()
      await rtc.receive(
        'OFFER',
        signal(rtc.connectionId, 1, { description: description('offer', 'remote-1') })
      )
      pc.network('failed')
      await flush()
      assert.equal(sent.at(-1).type, 'ICE_RESTART_REQUEST')
      assert.notEqual(pc.signalingState, 'closed')
      await rtc.receive(
        'OFFER',
        signal(rtc.connectionId, 2, { description: description('offer', 'remote-2') })
      )
      pc.network('connected')
      await tick(19_000)
      assert.notEqual(rtc.phase, 'failed')
      await tick(1_000)
      assert.equal(rtc.phase, 'reconnecting')
      assert.equal(sent.at(-1).type, 'ICE_RESTART_REQUEST')
      await tick(100_000)
      assert.equal(
        rtc.phase,
        'failed',
        'data transport recovery is still bounded by the total deadline'
      )
    }
  )
  await run('old connection callbacks and in-flight SDP cannot send after close', async () => {
    const { rtc, pc, sent, messages } = session()
    pc.remoteGate = deferred()
    const pending = rtc.receive(
      'OFFER',
      signal(rtc.connectionId, 1, { description: description('offer', 'remote-1') })
    )
    await flush()
    rtc.close()
    pc.remoteGate.resolve()
    await pending
    emit(pc, 'icecandidate', { candidate: { toJSON: () => candidate('obsolete') } })
    const channel = new Channel()
    emit(pc, 'datachannel', { channel })
    emit(channel, 'message', { data: 'obsolete' })
    assert.equal(sent.length, 0)
    assert.equal(messages.length, 0)
    assert.equal(channel.readyState, 'closed')
  })
  await run('pre-room inbox and negotiation replay have size / age bounds', async () => {
    const queue = []
    for (let n = 0; n < 400; n++) bufferRtcSignal(queue, 'ICE_CANDIDATE', { n })
    assert.equal(queue.length, RTC_TIMING.maxCandidates)
    now += RTC_TIMING.signalTtlMs + 1
    bufferRtcSignal(queue, 'OFFER', {})
    assert.equal(queue.length, 1)
    now = 0
    const { rtc, pc, sent } = session(true)
    await rtc.start()
    pc.emitDuringLocal = true
    rtc.replay()
    assert.equal(sent.filter((m) => m.type === 'OFFER').length, 2)
    now += RTC_TIMING.signalTtlMs + 1
    const before = sent.length
    rtc.replay()
    assert.equal(sent.length, before)
  })
  await run(
    'host readiness barrier, early candidate queue, duplicate joins and stale peer leave',
    async () => {
      const host = new WebRtcRemoteHostTransport({ signalingUrl: 'ws://test', iceServers: [] })
      const started = host.start()
      await flush()
      const ws = Socket.all.at(-1)
      ws.message('ROOM_CREATED', {
        roomCode: 'ABCDEF',
        createdAt: '2026-10-06T00:00:00Z',
        expiresAt: '9999-12-31T23:59:59Z',
        resumeToken: '0123456789abcdef'
      })
      await started
      const peerCount = Peer.all.length
      ws.message('PEER_JOINED', { role: 'FIRST', sessionId: 'player-1' })
      await flush()
      assert.equal(Peer.all.length, peerCount, 'no offer or PC before player readiness')
      ws.message(
        'ICE_CANDIDATE',
        signal('ready-1', 1, {
          fromRole: 'FIRST',
          fromSessionId: 'player-1',
          candidate: candidate('early')
        })
      )
      ws.message(
        'PEER_READY',
        signal('ready-1', 0, { fromRole: 'FIRST', fromSessionId: 'player-1' })
      )
      await flush()
      const pc = Peer.all.at(-1)
      assert.equal(Peer.all.length, peerCount + 1)
      ws.message('PEER_JOINED', { role: 'FIRST', sessionId: 'player-1' })
      ws.message(
        'PEER_READY',
        signal('ready-1', 0, { fromRole: 'FIRST', fromSessionId: 'player-1' })
      )
      ws.message('PEER_LEFT', { role: 'FIRST', sessionId: 'obsolete-player' })
      ws.message(
        'ANSWER',
        signal('ready-1', 1, {
          fromRole: 'FIRST',
          fromSessionId: 'player-1',
          description: description('answer', 'remote-1')
        })
      )
      await flush()
      assert.equal(Peer.all.length, peerCount + 1)
      assert.equal(pc.remoteCalls, 1)
      assert.equal(pc.additions.length, 1)
      pc.channel.open()
      assert.equal(pc.channel.bufferedAmountLowThreshold, 16 * 1024)
      pc.channel.bufferedAmount = 48 * 1024
      const image = host.send('player-1', {
        type: 'ASSET_START',
        payload: { transferId: 'asset-1', asset: { size: 3 } }
      })
      const nextImage = host.send('player-1', {
        type: 'ASSET_COMPLETE',
        payload: { transferId: 'asset-1' }
      })
      await flush()
      assert.equal(pc.channel.sent.length, 0, 'bulk transfer must pause on a congested relay')
      await host.send('player-1', { type: 'ACTION_RESULT', payload: { actionId: 'select-1' } })
      await host.send('player-1', { type: 'STATE_UPDATE', payload: { state: { revision: 2 } } })
      await host.send('player-1', { type: 'PONG', payload: {} })
      assert.deepEqual(
        pc.channel.sent.map((m) => m.type),
        ['ACTION_RESULT', 'STATE_UPDATE', 'PONG'],
        'controls must pass waiting images, preserving acknowledgement/state order'
      )
      pc.channel.bufferedAmount = 0
      emit(pc.channel, 'bufferedamountlow')
      await tick(200)
      await Promise.all([image, nextImage])
      assert.deepEqual(
        pc.channel.sent.slice(-2).map((m) => m.type),
        ['ASSET_START', 'ASSET_COMPLETE']
      )
      pc.channel.bufferedAmount = 48 * 1024
      const interruptedImage = host.send('player-1', {
        type: 'ASSET_START',
        payload: { transferId: 'asset-2', asset: { size: 3 } }
      })
      const interruptedResult = interruptedImage.catch((error) => error)
      await flush()
      await host.stop()
      await tick(20)
      assert.match((await interruptedResult).message, /ASSET_CANCELLED/)
    }
  )
  await run(
    'client duplicate ROOM_JOINED, failure requests restart, old socket messages ignored',
    async () => {
      const client = new WebRtcRemoteBpConnection({ signalingUrl: 'ws://test', iceServers: [] })
      const connected = client.connect({ roomId: 'ABCDEF', side: 'first', clientId: 'client' })
      const rejected = connected.catch((error) => error)
      await flush()
      const ws = Socket.all.at(-1)
      const joined = { roomCode: 'ABCDEF', role: 'FIRST', sessionId: 'player-1' }
      ws.message('ROOM_JOINED', joined)
      await flush()
      const pc = Peer.all.at(-1),
        peerCount = Peer.all.length
      const ready = ws.sent.find((m) => m.type === 'PEER_READY')
      assert.ok(ready)
      ws.message('ROOM_JOINED', joined)
      ws.message(
        'OFFER',
        signal(ready.payload.connectionId, 1, {
          fromRole: 'HOST',
          targetSessionId: 'player-1',
          description: description('offer', 'remote-1')
        })
      )
      await flush()
      assert.equal(Peer.all.length, peerCount)
      pc.network('failed')
      await flush()
      assert.equal(ws.readyState, 1)
      assert.ok(ws.sent.some((m) => m.type === 'ICE_RESTART_REQUEST'))
      await client.disconnect()
      await rejected
      ws.message('ROOM_JOINED', joined)
      emit(pc, 'connectionstatechange')
      await flush()
      assert.equal(client.getSnapshot().state, 'disconnected')
      assert.equal(Peer.all.length, peerCount)
    }
  )
}
main()
  .then(() => realInfo('WebRTC self-check completed'))
  .catch((error) => {
    console.error(error)
    console.error('Recent RTC logs:', logs.slice(-12))
    process.exitCode = 1
  })
  .finally(() => {
    suiteFinished = true
    Date.now = realNow
    console.info = realInfo
  })
