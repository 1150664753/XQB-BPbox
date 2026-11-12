// Real loopback WebSockets + production adapters/business logic. No Sakura account or public tunnel.
const assert = require('node:assert/strict')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { WebSocket } = require('ws')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '../..')
const outfile = path.join(root, 'XQB-BPbox/.tmp/sakura-self-check.cjs')
buildSync({
  stdin: {
    contents: `
export * from './XQB-BPbox/src/main/remoteBp/SakuraRoomServer';
export * from './XQB-BPbox/src/renderer/src/services/remoteBp/SakuraRemoteHostTransport';
export * from './XQB-BPbox/src/renderer/src/services/remoteBp/SelectableRemoteHostTransport';
export * from './XQB-BPbox/src/shared/remoteBp';
export * from './XBQ-BPweb/src/services/SakuraRemoteBpConnection';
export * from './XBQ-BPweb/src/services/sakuraInvitation';
export * from './XBQ-BPweb/src/services/assets/RemoteAssetManager';
export * from './XBQ-BPweb/src/services/assets/MemoryAssetCache';
export * from './shared/sakuraBp';
`,
    resolveDir: root,
    loader: 'ts'
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile,
  external: ['ws'],
  logLevel: 'silent'
})
const {
  SakuraRoomServer,
  SakuraRemoteHostTransport,
  SelectableRemoteHostTransport,
  RemoteBpHost,
  BpActionDispatcher,
  MockRemoteHostTransport,
  DEFAULT_REMOTE_SIDE_MAPPING,
  REMOTE_BP_PROTOCOL_VERSION,
  SakuraRemoteBpConnection,
  RemoteAssetManager,
  MemoryAssetCache,
  SAKURA_WIRE_VERSION,
  normalizeSakuraEndpoint,
  createSakuraInvitationLink,
  parseSakuraInvitation,
  getSakuraEntry
} = require(outfile)
const origin = 'https://bp.xqbbp.dpdns.org'
global.WebSocket = class extends WebSocket {
  constructor(url) {
    super(url, { origin })
  }
}
const storage = new Map()
global.sessionStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
  removeItem: (key) => storage.delete(key)
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(predicate, label, timeout = 5000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (predicate()) return
    await delay(10)
  }
  throw new Error(`Timed out: ${label}`)
}
const now = () => new Date().toISOString()
const roster = [1, 2].map((id) => ({
  id,
  code: String(id),
  chinese_name: `角色${id}`,
  english_name: `Character ${id}`,
  rarity: 5,
  element: '火',
  path: '毁灭',
  created_at: now(),
  updated_at: now(),
  left_head_image: null,
  right_head_image: null,
  avatar_small_image: null,
  full_body_image: null
}))

async function main() {
  assert.equal(normalizeSakuraEndpoint('example.com:1234'), 'wss://example.com:1234/bp')
  for (const invalid of [
    'ws://example.com',
    'https://localhost',
    'https://127.0.0.1',
    'https://user:secret@example.com',
    'https://example.com?token=x'
  ])
    assert.throws(() => normalizeSakuraEndpoint(invalid))
  const eventListeners = new Set(),
    statusListeners = new Set()
  let server, url
  const api = {
    onEvent: (listener) => {
      eventListeners.add(listener)
      return () => eventListeners.delete(listener)
    },
    onStatus: (listener) => {
      statusListeners.add(listener)
      return () => statusListeners.delete(listener)
    },
    status: async () => ({ publicConnection: 'unchecked', error: null }),
    start: async () => {
      server = new SakuraRoomServer(
        (event) => eventListeners.forEach((listener) => listener(event)),
        [origin]
      )
      await server.listen(0)
      assert.equal(server.server.address().address, '127.0.0.1')
      url = `ws://127.0.0.1:${server.server.address().port}/bp`
      return { roomId: server.roomId, invitationLink: 'test-only' }
    },
    stop: async () => {
      await server?.close()
    },
    send: (roomId, peerId, message) => {
      assert.equal(roomId, server.roomId)
      return peerId ? server.send(peerId, message) : server.broadcast(message)
    },
    kick: async (_roomId, side) => server.kick(side)
  }
  const transport = new SelectableRemoteHostTransport(
    (mode) =>
      mode === 'sakura' ? new SakuraRemoteHostTransport(api) : new MockRemoteHostTransport(),
    new SakuraRemoteHostTransport(api)
  )
  const dispatcher = new BpActionDispatcher(1)
  const steps = [
    { index: 1, side: 'star', action: 'ban', targetType: 'character' },
    { index: 2, side: 'rail', action: 'pick', targetType: 'character' }
  ]
  let selected = null
  const runtime = {
    flowName: 'Sakura transport integration',
    createdAt: now(),
    stepCursor: 0,
    status: 'running',
    currentStep: steps[0],
    followingStep: steps[1],
    slotCounts: { star: { picks: 1, bans: 1 }, rail: { picks: 1, bans: 1 } },
    starTeam: { name: '星', picks: [], bans: [] },
    railTeam: { name: '穹', picks: [], bans: [] },
    actions: []
  }
  const commit = (target) => {
    const character = roster.find((c) => c.id === Number(target.id)),
      step = runtime.currentStep
    runtime.actions.push({
      stepIndex: step.index,
      side: step.side,
      action: step.action,
      targetType: 'character',
      targetId: character.id,
      targetName: character.chinese_name,
      target: character
    })
    runtime[`${step.side}Team`][step.action === 'ban' ? 'bans' : 'picks'].push(character)
    runtime.stepCursor++
    runtime.currentStep = steps[runtime.stepCursor] ?? null
    runtime.followingStep = null
    runtime.status = runtime.currentStep ? 'running' : 'complete'
    selected = null
    return { stateChanged: true }
  }
  const bytes = Buffer.alloc(512 * 1024, 123)
  const descriptor = {
    assetId: 'character:1:avatar',
    type: 'avatar',
    hash: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    mimeType: 'image/png',
    characterId: '1',
    ownerId: '1'
  }
  let assetReads = 0
  const host = new RemoteBpHost({
    dispatcher,
    transport,
    getDispatchSnapshot: () => ({
      started: true,
      currentStep: runtime.currentStep,
      availableCharacterIds: roster
        .filter((c) => !runtime.actions.some((a) => a.targetId === c.id))
        .map((c) => String(c.id)),
      availableLightConeIds: [],
      pickedCharacterIds: [],
      pickedCharacterIdsBySide: { star: [], rail: [] },
      availablePairedTargetIdsBySide: { star: [], rail: [] },
      selectedTarget: selected,
      selectedTargetsBySide: { star: null, rail: null }
    }),
    getExecutor: () => ({
      selectTarget: async (target) => {
        selected = target
        return { stateChanged: true }
      },
      deselectTarget: async () => {
        selected = null
        return { stateChanged: true }
      },
      confirmTarget: async (target) => commit(target),
      commitTargets: async (_kind, targets) => commit(targets[0])
    }),
    getSerializerInput: () => ({
      runtime,
      characters: roster,
      lightCones: [],
      flowStepCount: steps.length,
      selectedCharacterId: selected ? Number(selected.id) : null,
      canConfirm: !!selected
    }),
    getAssetManifest: async () => ({ revision: 1, generatedAt: now(), assets: [descriptor] }),
    getAsset: async () => {
      assetReads++
      return { descriptor, data: bytes }
    }
  })
  const players = [],
    assetManagers = []
  try {
    await host.startRoom({ mapping: DEFAULT_REMOTE_SIDE_MAPPING })
    assert.equal(
      host.getRoomState().connectionState,
      'connecting',
      'local listener is not public verification'
    )
    const invite = {
      version: SAKURA_WIRE_VERSION,
      roomId: server.roomId,
      endpoint: url,
      credential: server.credential
    }
    const publicInvite = { ...invite, endpoint: 'wss://example.com:1234/bp' }
    const link = new URL(createSakuraInvitationLink(publicInvite))
    global.window = {
      location: { hash: link.hash, pathname: link.pathname },
      history: {
        replaceState: (_state, _unused, location) => {
          assert.equal(location, link.pathname)
          window.location.hash = ''
        }
      }
    }
    assert.deepEqual(getSakuraEntry().invitation, publicInvite)
    assert.equal(window.location.hash, '', 'invitation fragment must be consumed before joining')
    assert.equal(link.search, '')
    assert.ok(!link.pathname.includes(server.credential))
    assert.deepEqual(
      parseSakuraInvitation(JSON.parse(decodeURIComponent(link.hash.slice(8)))),
      publicInvite
    )
    for (const side of ['first', 'second']) {
      const player = new SakuraRemoteBpConnection(invite)
      players.push(player)
      const manager = new RemoteAssetManager(player, new MemoryAssetCache())
      assetManagers.push(manager)
      await player.connect({ roomId: server.roomId, side, clientId: side, displayName: side })
    }
    assert.equal(host.getRoomState().firstPlayer.connectionState, 'connected')
    assert.equal(host.getRoomState().secondPlayer.connectionState, 'connected')
    console.log(
      'PASS two players over real loopback WebSockets, separate authenticated asset streams, no WebRTC'
    )

    async function rawCheck(message, expected, requestedOrigin = origin) {
      const ws = new WebSocket(url, { origin: requestedOrigin })
      ws.on('error', () => {})
      if (expected === 'origin') {
        const error = await new Promise((resolve) => ws.once('error', resolve))
        assert.match(error.message, /403/)
        return
      }
      await new Promise((resolve, reject) => {
        ws.once('open', resolve)
        ws.once('error', reject)
      })
      const response = new Promise((resolve) =>
        ws.once('message', (raw) => resolve(JSON.parse(raw)))
      )
      ws.send(
        JSON.stringify({
          type: 'SAKURA_JOIN',
          version: SAKURA_WIRE_VERSION,
          protocolVersion: REMOTE_BP_PROTOCOL_VERSION,
          roomId: server.roomId,
          credential: server.credential,
          side: 'first',
          displayName: 'outsider',
          ...message
        })
      )
      assert.equal((await response).code, expected)
      ws.close()
    }
    await rawCheck({}, 'origin', 'https://attacker.example')
    await rawCheck({ credential: 'x'.repeat(43) }, 'AUTH_FAILED')
    await rawCheck({ protocolVersion: '0' }, 'UNSUPPORTED_PROTOCOL_VERSION')
    await rawCheck({}, 'SEAT_OCCUPIED')
    const oversized = new WebSocket(url, { origin })
    oversized.on('error', () => {})
    await new Promise((resolve) => oversized.once('open', resolve))
    const oversizedClosed = new Promise((resolve) => oversized.once('close', resolve))
    oversized.send('x'.repeat(64 * 1024 + 1))
    assert.equal(await oversizedClosed, 1009)
    console.log('PASS Origin, room credentials, protocol compatibility and occupied-seat rejection')

    const results = [],
      states = []
    players[0].on('actionResult', (r) => results.push(r))
    players[1].on('actionResult', (r) => results.push(r))
    players[0].on('bpStateUpdated', (s) => states.push(s))
    const makeAction = (kind, side, id, revision = dispatcher.getRevision()) => ({
      kind,
      actorSide: side,
      actionId: crypto.randomUUID(),
      expectedRevision: revision,
      stepIndex: runtime.currentStep?.index ?? null,
      createdAt: now(),
      targets: id ? [{ kind: 'CHARACTER', id }] : []
    })
    async function action(player, value) {
      const length = results.length
      await player.sendAction(value)
      await until(() => results.length > length, value.kind)
      return results.at(-1)
    }
    assert.equal(
      (await action(players[1], makeAction('SELECT', 'second', '2'))).code,
      'NOT_YOUR_TURN'
    )
    assert.equal(
      (await action(players[0], makeAction('SELECT', 'first', '1', 99))).code,
      'REVISION_CONFLICT'
    )
    await until(() => assetManagers[0].getSnapshot().manifest, 'manifest')
    const ready = new Promise((resolve) => players[0].on('assetReceived', resolve))
    await assetManagers[0].request([descriptor.assetId])
    const select = makeAction('SELECT', 'first', '1')
    assert.equal((await action(players[0], select)).accepted, true)
    assert.equal((await action(players[0], select)).code, 'ALREADY_PROCESSED')
    assert.equal((await action(players[0], makeAction('DESELECT', 'first'))).accepted, true)
    assert.equal((await action(players[0], makeAction('SELECT', 'first', '1'))).accepted, true)
    assert.equal((await action(players[0], makeAction('CONFIRM', 'first'))).accepted, true)
    assert.equal(runtime.actions[0].action, 'ban')
    const received = await ready
    assert.equal(received.descriptor.hash, descriptor.hash)
    await until(() => assetManagers[0].getState(descriptor.assetId) === 'ready', 'image cache')
    await assetManagers[0].request([descriptor.assetId])
    assert.equal(assetReads, 1)
    console.log(
      'PASS selection, deselection, confirmation, turn/revision validation, deduplication and verified cached image transfer'
    )

    const peerId = host.getRoomState().firstPlayer.peerId
    server.lastSeen.set(server.peers.get('first').control, Date.now() - 46_000)
    server.heartbeat._onTimeout()
    await until(() => players[0].getSnapshot().state === 'reconnecting', 'disconnect detected')
    await until(() => players[0].getSnapshot().state === 'connected', 'automatic reconnect')
    assert.equal(host.getRoomState().firstPlayer.peerId, peerId)
    assert.equal(states.at(-1).revision, dispatcher.getRevision())
    await assetManagers[0].request([descriptor.assetId])
    assert.equal(assetReads, 1)
    assert.equal((await action(players[1], makeAction('PICK', 'second', '2'))).accepted, true)
    assert.equal(runtime.status, 'complete')
    console.log(
      'PASS resumed seat, fresh authoritative state, cached resources and complete two-turn BP'
    )

    const revisionBeforeForgery = dispatcher.getRevision()
    players[0].control.send(
      JSON.stringify({
        type: 'ACTION_REQUEST',
        protocolVersion: REMOTE_BP_PROTOCOL_VERSION,
        messageId: crypto.randomUUID(),
        sentAt: now(),
        payload: { action: makeAction('SELECT', 'second', '2') }
      })
    )
    await until(() => players[0].getSnapshot().state === 'failed', 'forged side rejected')
    assert.equal(dispatcher.getRevision(), revisionBeforeForgery)
    await players[0].connect({
      roomId: server.roomId,
      side: 'first',
      clientId: 'first',
      displayName: 'first'
    })
    await host.kickPlayer('first')
    await until(() => players[0].getSnapshot().state === 'kicked', 'kick notification')
    await assert.rejects(host.setTransportMode('webrtc'), /先关闭/)
    assert.equal(host.getRoomState().lifecycle, 'active')
    await host.stopRoom()
    await host.setTransportMode('webrtc')
    await until(
      () => players[1].getSnapshot().state === 'room-closed',
      'explicit close notifies peers before mode switch'
    )
    assert.equal(server.sockets.size, 0)
    assert.equal(eventListeners.size, 0)
    assert.equal(statusListeners.size, 0)
    console.log(
      'PASS room close/mode switch clears sockets and subscriptions; no public Sakura connectivity claimed'
    )
  } finally {
    for (const player of players) await player.disconnect()
    for (const manager of assetManagers) manager.destroy()
    await host.stopRoom()
    host.destroy()
    await server?.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
