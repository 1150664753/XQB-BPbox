import React from 'react'
import { createRoot } from 'react-dom/client'
import { RemoteBpRtcSession, exportRtcDiagnostics } from '../../shared/remoteBpRtc'
import { WebRtcRemoteHostTransport } from '../src/renderer/src/services/remoteBp/WebRtcRemoteHostTransport'
import { WebRtcRemoteBpConnection } from '../../XBQ-BPweb/src/services/WebRtcRemoteBpConnection'
import { IndexedDbAssetCache } from '../../XBQ-BPweb/src/services/assets/IndexedDbAssetCache'
import { MemoryAssetCache } from '../../XBQ-BPweb/src/services/assets/MemoryAssetCache'
import { RemoteAssetManager } from '../../XBQ-BPweb/src/services/assets/RemoteAssetManager'
import RemoteBpNetworkDiagnostics from '../src/renderer/src/components/remoteBp/RemoteBpNetworkDiagnostics'

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(test: () => boolean, message: string, ms = 10000) {
  const end = Date.now() + ms
  while (!test()) {
    if (Date.now() > end) throw new Error(message)
    await sleep(20)
  }
}
async function hash(blob: Blob) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}
async function main() {
  const checks: string[] = []
  const cache = new IndexedDbAssetCache()
  await cache.clear()
  const blob = new Blob([new Uint8Array(192 * 1024).fill(73)], { type: 'image/png' })
  const descriptor = {
    assetId: 'character:1:avatar',
    type: 'avatar' as const,
    hash: await hash(blob),
    size: blob.size,
    mimeType: blob.type,
    characterId: '1',
    ownerId: '1'
  }
  await cache.save({ descriptor, data: blob })
  const restored = await new IndexedDbAssetCache().get(descriptor.assetId, descriptor.hash)
  check(restored?.data.size === blob.size, 'persistent cache was not reused')
  check(
    (await new IndexedDbAssetCache().get(descriptor.assetId, '0'.repeat(64))) === null,
    'changed hash reused old cache'
  )
  await cache.save({ descriptor, data: new Blob([new Uint8Array(blob.size)], { type: blob.type }) })
  check(
    (await new IndexedDbAssetCache().get(descriptor.assetId, descriptor.hash)) === null,
    'corrupt disk cache bypassed SHA-256'
  )
  checks.push('IndexedDB reload, changed hash, corrupt payload rejection')

  let host: RemoteBpRtcSession, player: RemoteBpRtcSession
  const client = new WebRtcRemoteBpConnection({ signalingUrl: 'ws://unused', iceServers: [] })
  const arrivals: string[] = []
  let received = 0,
    actionAt = 0
  client.on('assetReceived', (asset) => {
    check(asset.descriptor.hash === descriptor.hash, 'transfer hash mismatch')
    received++
  })
  client.on('actionResult', () => {
    actionAt = performance.now()
  })
  client.on('error', (error) => {
    throw new Error(`client validation: ${error.code}`)
  })
  host = new RemoteBpRtcSession({
    connectionId: 'loopback',
    peerId: 'player',
    roomId: 'ABCDEF',
    offerer: true,
    iceServers: [],
    send: (type, payload) => {
      queueMicrotask(() => void player.receive(type, payload))
      return true
    },
    onState: () => {},
    onMessage: (data) => {
      const message = JSON.parse(String(data))
      if (message.type === 'ACTION_REQUEST') {
        peer.controlUntil = Date.now() + 150
        void transport.send('player', {
          type: 'ACTION_RESULT',
          payload: {
            actionId: message.payload.action.actionId,
            accepted: true,
            code: 'OK',
            message: 'OK',
            resultingRevision: 1,
            stateChanged: false
          }
        })
      }
    }
  })
  player = new RemoteBpRtcSession({
    connectionId: 'loopback',
    peerId: 'player',
    roomId: 'ABCDEF',
    offerer: false,
    iceServers: [],
    send: (type, payload) => {
      queueMicrotask(() => void host.receive(type, payload))
      return true
    },
    onState: () => {},
    onMessage: (data, stream) => {
      arrivals.push(`${stream}:${JSON.parse(String(data)).type}`)
      ;(client as any).handleDataMessage(data, stream)
    }
  })
  Object.assign(client as any, {
    confirmed: { roomId: 'ABCDEF', sessionId: 'player', assignedSide: 'first' },
    rtc: player
  })
  const transport = new WebRtcRemoteHostTransport({
    signalingUrl: 'ws://unused',
    iceServers: [],
    assetRateKiBps: 64
  })
  const peer = {
    peerId: 'player',
    side: 'first',
    role: 'FIRST',
    rtc: host,
    announced: true,
    assetTransfers: new Map(),
    nextAssetAt: 0,
    controlUntil: 0
  }
  ;(transport as any).peers.set('first', peer)
  await host.start()
  await until(
    () =>
      host.phase === 'connected' &&
      player.phase === 'connected' &&
      host.assetChannel?.readyState === 'open',
    'real RTC/channel handshake failed'
  )
  ;(client as any).snapshot.state = 'connected'
  await transport.send('player', {
    type: 'ASSET_MANIFEST',
    payload: {
      manifest: { revision: 1, generatedAt: new Date().toISOString(), assets: [descriptor] }
    }
  })
  const bytes = new Uint8Array(await blob.arrayBuffer()),
    chunkSize = 12 * 1024 - 768,
    totalChunks = Math.ceil(bytes.length / chunkSize)
  const transfer = async (id: string) => {
    await transport.send('player', {
      type: 'ASSET_START',
      payload: { transferId: id, asset: descriptor, chunkSize, totalChunks }
    })
    for (let index = 0; index < totalChunks; index++) {
      const chunk = bytes.subarray(index * chunkSize, (index + 1) * chunkSize)
      await transport.send('player', {
        type: 'ASSET_CHUNK',
        payload: {
          transferId: id,
          assetId: descriptor.assetId,
          index,
          total: totalChunks,
          data: btoa(String.fromCharCode(...chunk))
        }
      })
    }
    await transport.send('player', {
      type: 'ASSET_COMPLETE',
      payload: {
        transferId: id,
        assetId: descriptor.assetId,
        hash: descriptor.hash,
        totalBytes: bytes.length
      }
    })
  }
  const sending = transfer('one')
  await until(
    () => arrivals.includes('assets:ASSET_CHUNK'),
    'dedicated stream did not receive chunks'
  )
  const sentAt = performance.now()
  await client.sendAction({
    actionId: 'test',
    actorSide: 'first',
    expectedRevision: 0,
    stepIndex: 0,
    createdAt: new Date().toISOString(),
    kind: 'CONFIRM',
    targets: []
  })
  await until(() => actionAt > 0, 'control result blocked behind image')
  check(received === 0, 'test did not exercise control during bulk transfer')
  check(
    player.getDiagnostic().actionResponseMs !== null,
    'end-to-end action response was not recorded'
  )
  // Simulate the client adapter's ready callback for the same PC during an ICE restart.
  ;(client as any).snapshot.state = 'reconnecting'
  ;(client as any).onDataChannelReady()
  host.requestRestart('loopback restart')
  await sending
  await until(
    () => received === 1 && host.phase === 'connected',
    'same-PC recovery discarded an active asset'
  )
  await sleep(1200)
  const diagnostic = host.getDiagnostic()
  check(
    player
      .getDiagnostic()
      .transfers.some(
        (t) =>
          t.id === 'one' && t.status === 'verified' && t.bytes === blob.size && t.durationMs! > 0
      ),
    'receiver completion was not SHA-256 verified and timed'
  )
  check(
    diagnostic.transfers.some((t) => t.id === 'one' && t.status === 'submitted'),
    'sender submission was not recorded'
  )
  check(diagnostic.pair && !diagnostic.relay, 'actual selected ICE pair not diagnosed')
  check(diagnostic.bytesSent! > 0 && diagnostic.assetBytesSent! > 0, 'actual byte counters missing')
  check(
    diagnostic.dtlsState === 'connected' && diagnostic.sctpState === 'connected',
    'transport stages unavailable'
  )
  checks.push(
    `real Chromium WebRTC, image integrity, action round trip during bulk (${player.getDiagnostic().actionResponseMs} ms), ICE restart continuation, getStats counters`
  )
  host.assetChannel!.close()
  await until(
    () => player.assetChannel?.readyState === 'closed',
    'optional asset channel did not close'
  )
  await transfer('legacy')
  await until(() => received === 2, 'legacy control-channel asset fallback failed')
  check(arrivals.includes('control:ASSET_CHUNK'), 'legacy stream was not used')
  checks.push('closed/unsupported optional asset stream falls back to existing JSON protocol')

  // Exercise cache lifecycle with production manager and a controlled connection.
  const listeners = new Map<string, Set<(value: any) => void>>()
  const requested: string[][] = []
  const connection = {
    getSnapshot: () => ({ state: 'connected' }),
    on: (name: string, fn: (v: any) => void) => {
      const set = listeners.get(name) ?? new Set()
      set.add(fn)
      listeners.set(name, set)
      return () => set.delete(fn)
    },
    requestAssets: async (ids: string[]) => {
      requested.push(ids)
    }
  } as any
  const emit = (name: string, value: any) => listeners.get(name)?.forEach((fn) => fn(value))
  const memory = new MemoryAssetCache()
  await memory.save({ descriptor, data: blob })
  const manager = new RemoteAssetManager(connection, memory)
  const manifest = { revision: 5, generatedAt: new Date().toISOString(), assets: [descriptor] }
  emit('assetManifestReceived', manifest)
  await until(
    () => manager.getState(descriptor.assetId) === 'ready',
    'manager did not reuse cached asset'
  )
  const url = manager.getUrl(descriptor.assetId)
  emit('assetManifestReceived', manifest)
  await sleep(20)
  check(
    manager.getUrl(descriptor.assetId) === url,
    'unchanged manifest unnecessarily replaced Blob URL'
  )
  emit('assetTransfersReset', undefined)
  const replacement = { ...descriptor, hash: 'a'.repeat(64) }
  emit('assetManifestReceived', { ...manifest, revision: 1, assets: [replacement] })
  await until(
    () => manager.getSnapshot().manifest?.revision === 1,
    'new session rejected a lower manifest revision'
  )
  await sleep(20)
  await manager.request([descriptor.assetId])
  await sleep(20)
  check(
    requested.length === 1 && manager.getUrl(descriptor.assetId) === null,
    'new session reused stale content or duplicated request'
  )
  emit('assetTransfersReset', undefined)
  emit('assetManifestReceived', { ...manifest, revision: 1, assets: [replacement] })
  await until(
    () => requested.length === 2,
    'new connection left interrupted image permanently loading'
  )
  manager.destroy()
  checks.push(
    'manifest reuse, Blob URL stability, session revision reset and interrupted transfer retry'
  )

  const room = {
    roomId: 'ABCDEF',
    lifecycle: 'idle',
    firstPlayer: { peerId: 'player' },
    secondPlayer: { peerId: null }
  } as any
  const mockHost = {
    getNetworkOptions: () => ({ forceRelay: false, assetRateKiBps: 512 }),
    configureNetwork: () => {}
  } as any
  createRoot(document.getElementById('root')!).render(
    <RemoteBpNetworkDiagnostics host={mockHost} room={room} />
  )
  await sleep(50)
  document.querySelector('details')!.open = true
  await sleep(1200)
  check(document.querySelector('dt')?.textContent === '候选路径', 'diagnostic panel did not render')
  check(
    document.documentElement.scrollWidth <= innerWidth,
    'diagnostic panel overflowed at narrow width'
  )
  const exported = exportRtcDiagnostics('ABCDEF')
  check(!exported.includes('candidate:') && !exported.includes('a=ice-pwd'), 'raw ICE data leaked')
  ;(window as any).__networkTest = {
    checks,
    diagnostics: JSON.parse(exported),
    controlLatencyMs: Math.round(actionAt - sentAt)
  }
  // Keep the real connection alive for the main-process screenshot; the test window closes it.
}
void main().catch((error) => {
  ;(window as any).__networkTest = { error: String(error.stack ?? error) }
})
