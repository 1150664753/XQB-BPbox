const assert = require('node:assert/strict')
const path = require('node:path')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '../..')
const output = path.join(root, 'XQB-BPbox/.tmp/webrtc-self-check.cjs')
buildSync({
  stdin: {
    contents: `export * from './shared/remoteBpRtc'; export * from './XQB-BPbox/src/renderer/src/services/remoteBp/WebRtcRemoteHostTransport'; export * from './XBQ-BPweb/src/services/WebRtcRemoteBpConnection';`,
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
  RTC_TIMING
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

class Channel extends EventTarget {
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
  createDataChannel() {
    this.channel = new Channel()
    return this.channel
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
  message(type, payload) {
    emit(this, 'message', { data: JSON.stringify({ type, payload }) })
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
function session(offerer = false, id = 'connection-1') {
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
    onMessage: (data) => messages.push(data)
  })
  sessions.push(rtc)
  return { rtc, pc: rtc.pc, sent, states, messages }
}
async function run(name, test) {
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
      assert.deepEqual(pc.config.iceServers[1], {
        urls: 'turn:example.test',
        username: 'u',
        credential: 'c'
      })
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
      assert.equal(rtc.phase, 'failed')
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
      await host.stop()
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
    Date.now = realNow
    console.info = realInfo
  })
