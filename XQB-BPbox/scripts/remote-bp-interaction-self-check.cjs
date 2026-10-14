const assert = require('node:assert/strict')
const path = require('node:path')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '../..')
const outfile = path.join(root, 'XQB-BPbox/.tmp/remote-bp-interaction-self-check.cjs')
buildSync({
  stdin: {
    contents: `export * from './XBQ-BPweb/src/stores/RemoteBpSessionStore'; export { createInitialMockState } from './XBQ-BPweb/src/mocks/mockData';`,
    resolveDir: root,
    loader: 'ts'
  },
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent'
})
const { RemoteBpSessionStore, createInitialMockState } = require(outfile)

class Connection {
  listeners = new Map()
  actions = []
  requests = 0
  getSnapshot() {
    return { state: 'connected', transport: 'turn-relay' }
  }
  async connect() {
    return { roomId: 'ABCDEF', sessionId: 'first', assignedSide: 'first' }
  }
  async disconnect() {}
  async sendAction(action) {
    this.actions.push(action)
  }
  async requestState() {
    this.requests++
  }
  on(event, listener) {
    const listeners = this.listeners.get(event) ?? new Set()
    listeners.add(listener)
    this.listeners.set(event, listeners)
    return () => listeners.delete(listener)
  }
  emit(event, payload) {
    this.listeners.get(event)?.forEach((listener) => listener(payload))
  }
}

async function setup() {
  const connection = new Connection()
  const store = new RemoteBpSessionStore(connection)
  await store.join({ roomId: 'ABCDEF', side: 'first', displayName: 'player' })
  let state = createInitialMockState('ABCDEF')
  connection.emit('bpStateReceived', state)
  const ack = (action, revision, accepted = true) =>
    connection.emit('actionResult', {
      actionId: action.actionId,
      accepted,
      resultingRevision: revision,
      code: accepted ? 'OK' : 'REVISION_CONFLICT',
      message: accepted ? 'OK' : 'conflict',
      stateChanged: accepted
    })
  const update = (target, revision, patch = {}) => {
    state = {
      ...state,
      revision,
      selectionTargets: { first: target, second: null },
      canConfirmBySide: { first: Boolean(target), second: false },
      ...patch
    }
    connection.emit('bpStateUpdated', state)
  }
  return { connection, store, ack, update }
}

async function main() {
  {
    const { connection, store, ack, update } = await setup()
    try {
      await store.selectTarget('CHARACTER', '1')
      await store.selectTarget('CHARACTER', '2')
      await store.selectTarget('CHARACTER', '3')
      assert.equal(connection.actions.length, 1, 'only one selection request may be in flight')
      assert.equal(
        store.getSnapshot().selectionPreview.id,
        '3',
        'latest click is visible before relay reply'
      )
      assert.equal(
        store.getSnapshot().bpState.selectionTargets.first,
        null,
        'preview cannot change host authority'
      )
      await store.confirm()
      assert.equal(connection.actions.length, 1, 'cannot confirm a preview using stale host state')
      const first = connection.actions[0]
      ack(first, 2)
      assert.equal(connection.actions.length, 1, 'ACK alone must not send with the old revision')
      update({ kind: 'CHARACTER', id: '1' }, 2)
      assert.equal(connection.actions.length, 2)
      const last = connection.actions[1]
      assert.equal(last.targets[0].id, '3', 'intermediate clicks are coalesced')
      assert.equal(last.expectedRevision, 2)
      update({ kind: 'CHARACTER', id: '3' }, 3)
      assert.equal(
        store.getSnapshot().pendingActionId,
        last.actionId,
        'state alone does not acknowledge the action'
      )
      ack(last, 3)
      assert.equal(store.getSnapshot().selectionPreview, undefined)
      assert.equal(store.getSnapshot().pendingActionId, null)
      await store.confirm()
      const confirm = connection.actions[2]
      assert.equal(confirm.kind, 'CONFIRM')
      assert.equal(confirm.expectedRevision, 3)
      connection.emit('error', { assetId: 'portrait', message: 'image failed', recoverable: true })
      await store.selectTarget('CHARACTER', '4')
      await store.confirm()
      assert.equal(
        connection.actions.length,
        3,
        'image errors and repeated clicks cannot unlock a pending confirmation'
      )
      ack(first, 2, false)
      assert.equal(
        store.getSnapshot().pendingActionId,
        confirm.actionId,
        'late replies cannot clear another request'
      )
    } finally {
      store.destroy()
    }
  }
  {
    const { connection, store, ack, update } = await setup()
    try {
      await store.selectTarget('CHARACTER', '1')
      await store.selectTarget('CHARACTER', '1')
      assert.equal(store.getSnapshot().selectionPreview, null)
      ack(connection.actions[0], 2)
      update({ kind: 'CHARACTER', id: '1' }, 2)
      assert.equal(connection.actions[1].kind, 'DESELECT')
      ack(connection.actions[1], 3)
      update(null, 3)
      assert.equal(store.getSnapshot().pendingActionId, null)
      assert.equal(store.getSnapshot().selectionPreview, undefined)
      await store.selectTarget('CHARACTER', '2')
      await store.selectTarget('CHARACTER', '3')
      ack(connection.actions[2], 4, false)
      assert.equal(store.getSnapshot().selectionPreview, undefined)
      assert.equal(connection.requests, 1, 'revision rejection requests authoritative state')
      assert.equal(connection.actions.length, 3, 'rejected intent is not silently replayed')
    } finally {
      store.destroy()
    }
  }
  {
    const { connection, store, ack, update } = await setup()
    try {
      await store.selectTarget('CHARACTER', '1')
      await store.selectTarget('CHARACTER', '2')
      update(null, 3, { currentStep: { id: 'next', index: 2 }, currentActor: 'second' })
      ack(connection.actions[0], 2)
      assert.equal(connection.actions.length, 1, 'queued intent cannot cross a BP step')
      assert.equal(store.getSnapshot().selectionPreview, undefined)
      assert.equal(store.getSnapshot().pendingActionId, null)
    } finally {
      store.destroy()
    }
  }
  {
    const { connection, store, ack } = await setup()
    try {
      await store.selectTarget('CHARACTER', '1')
      await store.selectTarget('CHARACTER', '2')
      connection.emit('connectionStateChanged', { state: 'reconnecting' })
      ack(connection.actions[0], 2)
      assert.equal(store.getSnapshot().selectionPreview, undefined)
      assert.equal(store.getSnapshot().pendingActionId, null)
      assert.equal(connection.actions.length, 1)
    } finally {
      store.destroy()
    }
  }
  {
    const { connection, store } = await setup()
    const realSetTimeout = global.setTimeout,
      realClearTimeout = global.clearTimeout
    let timeout
    global.setTimeout = (callback) => {
      timeout = callback
      return 123
    }
    global.clearTimeout = () => {}
    try {
      await store.selectTarget('CHARACTER', '1')
      timeout()
      assert.equal(
        store.getSnapshot().pendingActionId,
        null,
        'missing replies cannot lock selection indefinitely'
      )
      assert.equal(connection.requests, 1)
      assert.equal(store.getSnapshot().selectionPreview, undefined)
    } finally {
      store.destroy()
      global.setTimeout = realSetTimeout
      global.clearTimeout = realClearTimeout
    }
  }
  console.log(
    'PASS delayed relay selection, coalescing, ACK/state ordering, confirmation lock, rejection, step change, reconnect and timeout'
  )
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
