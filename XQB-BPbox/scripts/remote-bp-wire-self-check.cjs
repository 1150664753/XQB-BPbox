const assert = require('node:assert/strict')
const path = require('node:path')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '../..')
const outfile = path.join(root, 'XQB-BPbox/.tmp/remote-bp-wire-self-check.cjs')
buildSync({
  stdin: {
    contents: `
  export * from './shared/remoteBpWire';
  export * from './XBQ-BPweb/src/services/assets/IncomingAssetTransfers';
  export * from './XBQ-BPweb/src/services/WebRtcRemoteBpConnection';
  export * from './XQB-BPbox/src/renderer/src/services/remoteBp/WebRtcRemoteHostTransport';
  export { createInitialMockState } from './XBQ-BPweb/src/mocks/mockData';
  export { parseHostMessage } from './XBQ-BPweb/src/protocol';
`,
    resolveDir: root,
    loader: 'ts'
  },
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent'
})
const {
  StateDeltaSender,
  StateDeltaReceiver,
  encodeBinaryAssetChunk,
  decodeBinaryAssetChunk,
  IncomingAssetTransfers,
  WebRtcRemoteBpConnection,
  WebRtcRemoteHostTransport,
  createInitialMockState,
  parseHostMessage
} = require(outfile)
const envelope = (type, payload) =>
  JSON.stringify({
    type,
    payload,
    protocolVersion: '1.0',
    messageId: crypto.randomUUID(),
    sentAt: new Date().toISOString()
  })

async function main() {
  const state = createInitialMockState('ABCDEF')
  // Use the real serializer-shaped catalogue and grow it to expose full-state overhead.
  state.characters = Array.from({ length: 300 }, (_, i) => ({
    ...state.characters[0],
    id: String(i + 1)
  }))
  const next = structuredClone(state)
  next.revision++
  next.selectionTargets.first = { kind: 'CHARACTER', id: '1' }
  next.selections.first = '1'
  next.characters[0].selected = true
  next.characters[0].selectedBy = 'first'
  const sender = new StateDeltaSender(),
    receiver = new StateDeltaReceiver()
  const full = sender.encode('INITIAL_STATE', state)
  receiver.commit(state, full.payload.stateSequence)
  const delta = sender.encode('STATE_UPDATE', next)
  assert.equal(delta.type, 'STATE_DELTA_V1')
  const restored = receiver.expand(delta.payload)
  assert.deepEqual(restored, next)
  assert.ok(JSON.stringify(delta).length < JSON.stringify(next).length / 10)
  assert.equal(
    sender.encode('STATE_UPDATE', { ...next, updatedAt: new Date().toISOString() }),
    null
  )
  receiver.commit(restored, delta.payload.sequence)
  assert.throws(() => receiver.expand(delta.payload), /BASE_MISMATCH/)
  const sameRevision = {
    ...next,
    playerConnections: { first: 'connected', second: 'reconnecting' }
  }
  const seatDelta = sender.encode('STATE_UPDATE', sameRevision)
  assert.deepEqual(receiver.expand(seatDelta.payload), sameRevision)
  assert.throws(
    () => receiver.expand({ ...seatDelta.payload, fields: JSON.parse('{"__proto__":{}}') }),
    /INVALID_STATE_DELTA/
  )
  assert.throws(
    () => receiver.expand({ ...seatDelta.payload, rows: { characters: [{ id: 'absent' }] } }),
    /INVALID_STATE_DELTA/
  )
  console.log(
    `PASS state delta exact reconstruction, equal-revision changes, replay/base/prototype rejection: ${Buffer.byteLength(JSON.stringify(next))} -> ${Buffer.byteLength(JSON.stringify(delta))} bytes`
  )

  const wires = [],
    metrics = []
  const channel = { readyState: 'open', bufferedAmount: 0, send: (data) => wires.push(data) }
  const rtc = {
    channel,
    recordControlMessage: (...args) => metrics.push(args),
    recordActionTiming() {}
  }
  const transport = new WebRtcRemoteHostTransport({ signalingUrl: 'ws://unused', iceServers: [] })
  const peer = { peerId: 'p', side: 'first', rtc, controlUntil: 0 }
  transport.peers.set('first', peer)
  await transport.send('p', { type: 'INITIAL_STATE', payload: { state } })
  await transport.send('p', { type: 'STATE_UPDATE', payload: { state: next } })
  assert.equal(
    JSON.parse(wires.pop()).type,
    'STATE_UPDATE',
    'unadvertised old player must receive a full state'
  )
  const protocolVersion = JSON.parse(wires[0]).protocolVersion
  const message = (type, payload) =>
    JSON.stringify({ ...JSON.parse(envelope(type, payload)), protocolVersion })
  transport.handleDataMessage(
    peer,
    message('STATE_REQUEST', { capabilities: ['state-delta-v1', 'asset-binary-v1'] })
  )
  await transport.send('p', { type: 'INITIAL_STATE', payload: { state } })
  const fullWire = wires.at(-1)
  await transport.send('p', { type: 'STATE_UPDATE', payload: { state: next } })
  const deltaWire = wires.at(-1)
  assert.equal(JSON.parse(deltaWire).type, 'STATE_DELTA_V1')
  const client = new WebRtcRemoteBpConnection({ signalingUrl: 'ws://unused', iceServers: [] })
  const received = [],
    errors = [],
    requests = []
  client.confirmed = { roomId: 'ABCDEF', sessionId: 'p', assignedSide: 'first' }
  client.snapshot.state = 'connected'
  client.rtc = {
    channel: { ...channel, send: (raw) => requests.push(JSON.parse(raw)) },
    recordControlMessage() {},
    recordError() {}
  }
  client.on('bpStateReceived', (value) => received.push(value))
  client.on('bpStateUpdated', (value) => received.push(value))
  client.on('error', (error) => errors.push(error))
  client.handleDataMessage(fullWire)
  client.handleDataMessage(deltaWire)
  assert.equal(errors.length, 0, JSON.stringify(errors))
  assert.deepEqual(
    received.at(-1),
    parseHostMessage(message('STATE_UPDATE', { state: next })).payload.state
  )
  client.handleDataMessage(deltaWire)
  client.handleDataMessage(deltaWire)
  assert.equal(
    requests.length,
    1,
    'broken delta baseline must request one full state, not a request storm'
  )
  await transport.send('p', { type: 'INITIAL_STATE', payload: { state: next } })
  client.handleDataMessage(wires.at(-1))
  assert.equal(client.stateResyncPending, false)
  // An old host returns plain full messages even though the new player advertised extensions.
  client.handleDataMessage(message('STATE_UPDATE', { state: next }))
  assert.equal(errors.length, 0)
  console.log(
    `PASS production adapters: new/new delta, old/new full state, one-shot resync and legacy validation; full ${Buffer.byteLength(fullWire)} -> delta ${Buffer.byteLength(deltaWire)} wire bytes`
  )

  const bytes = new Uint8Array(11520).fill(37)
  const hash = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex')
  const asset = {
    assetId: 'character:1:portrait',
    type: 'portrait',
    hash,
    size: bytes.length,
    mimeType: 'image/png'
  }
  const incoming = new IncomingAssetTransfers()
  incoming.setManifest({ revision: 1, generatedAt: new Date().toISOString(), assets: [asset] })
  const payload = {
    transferId: 'binary',
    assetId: asset.assetId,
    index: 0,
    total: 1,
    data: Buffer.from(bytes).toString('base64')
  }
  const frame = encodeBinaryAssetChunk(payload),
    chunk = decodeBinaryAssetChunk(frame)
  const start = (id) =>
    incoming.start({ transferId: id, asset, chunkSize: bytes.length, totalChunks: 1 })
  start('binary')
  incoming.addBinaryChunk(chunk)
  assert.throws(() => incoming.addBinaryChunk(chunk), /DUPLICATE/)
  const done = await incoming.complete({
    transferId: 'binary',
    assetId: asset.assetId,
    hash,
    totalBytes: bytes.length
  })
  assert.deepEqual(new Uint8Array(await done.data.arrayBuffer()), bytes)
  assert.throws(() => decodeBinaryAssetChunk(new ArrayBuffer(17 * 1024)), /INVALID/)
  assert.throws(() => decodeBinaryAssetChunk(frame.slice(0, 9)), /INVALID/)
  start('wrong-size')
  assert.throws(
    () => incoming.addBinaryChunk({ ...chunk, transferId: 'wrong-size', bytes: bytes.slice(1) }),
    /SIZE_MISMATCH/
  )
  start('corrupt')
  const corrupt = bytes.slice()
  corrupt[0]++
  incoming.addBinaryChunk({ ...chunk, transferId: 'corrupt', bytes: corrupt })
  await assert.rejects(
    incoming.complete({
      transferId: 'corrupt',
      assetId: asset.assetId,
      hash,
      totalBytes: bytes.length
    }),
    /HASH_MISMATCH/
  )
  console.log(
    `PASS binary bounds, duplicate, exact payload size and SHA-256 integrity: ${Buffer.byteLength(JSON.stringify(payload))} -> ${frame.byteLength} bytes/chunk`
  )
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
