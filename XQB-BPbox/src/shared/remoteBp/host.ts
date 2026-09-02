import type { BpActionDispatchSnapshot, BpActionExecutor } from './dispatcher'
import { BpActionDispatcher } from './dispatcher'
import { serializeRemoteBpState, type RemoteBpStateSerializeInput } from './serializer'
import type { RemoteHostPeer, RemoteHostTransport } from './transport'
import type {
  AssetManifest,
  RemoteBpAction,
  RemoteBpActionResult,
  RemoteBpRoomState,
  RemoteAssetBinary,
  RemoteRoomPlayerState,
  RemoteBpState,
  RemotePlayerSide,
  RemoteSideMapping
} from './types'

export interface RemoteBpHostDependencies {
  dispatcher: BpActionDispatcher
  transport: RemoteHostTransport
  getDispatchSnapshot: () => BpActionDispatchSnapshot
  getExecutor: () => BpActionExecutor
  getSerializerInput: () => Omit<
    RemoteBpStateSerializeInput,
    'revision' | 'roomId' | 'sessionId' | 'mapping'
  >
  getAssetManifest: () => Promise<AssetManifest>
  getAsset: (assetId: string) => Promise<RemoteAssetBinary>
}

export interface StartRemoteRoomOptions {
  roomId?: string
  mapping: RemoteSideMapping
}

type RoomListener = (state: RemoteBpRoomState) => void

const ASSET_CHUNK_SIZE = 128 * 1024
const BASE64_BLOCK_SIZE = 32 * 1024

function bytesToBase64(bytes: Uint8Array): string {
  const blocks: string[] = []
  for (let offset = 0; offset < bytes.byteLength; offset += BASE64_BLOCK_SIZE) {
    blocks.push(String.fromCharCode(...bytes.subarray(offset, offset + BASE64_BLOCK_SIZE)))
  }
  return globalThis.btoa(blocks.join(''))
}

function emptyPlayer(side: RemotePlayerSide): RemoteRoomPlayerState {
  return {
    side,
    peerId: null,
    displayName: null,
    connectionState: 'empty' as const,
    joinedAt: null
  }
}

export class RemoteBpHost {
  private readonly listeners = new Set<RoomListener>()
  private readonly unsubscribers: Array<() => void>
  private readonly assetTransferQueues = new Map<string, Promise<void>>()
  private assetManifestRefresh: Promise<AssetManifest | null> | null = null
  private lastAssetManifestRevision: number | null = null
  private state: RemoteBpRoomState

  constructor(private readonly dependencies: RemoteBpHostDependencies) {
    this.state = {
      lifecycle: 'idle',
      roomId: null,
      createdAt: null,
      transport: dependencies.transport.kind,
      connectionState: 'offline',
      mapping: { first: 'star', second: 'rail' },
      firstPlayer: emptyPlayer('first'),
      secondPlayer: emptyPlayer('second'),
      expiresAt: null,
      assetCount: 0,
      lastPublishedRevision: null,
      error: null
    }
    this.unsubscribers = [
      dependencies.transport.onMessage((message) => {
        switch (message.type) {
          case 'ACTION_REQUEST':
            void this.handleRemoteAction(message.action, {
              peerId: message.peerId,
              side: message.side
            })
            break
          case 'STATE_REQUEST':
            void this.sendStateToPeer(message.peerId)
            break
          case 'ASSET_REQUEST':
            this.enqueueAssetRequest(message.peerId, message.assetIds)
            break
          case 'PING':
            void dependencies.transport.send(message.peerId, {
              type: 'PONG',
              payload: { clientTime: message.clientTime, hostTime: new Date().toISOString() }
            })
            break
        }
      }),
      dependencies.transport.onPeerConnected((peer) => {
        this.updatePeer(peer, true)
        void Promise.all([
          this.broadcastState('STATE_UPDATE'),
          this.sendManifestToPeer(peer.peerId)
        ])
      }),
      dependencies.transport.onPeerDisconnected((peer) => this.updatePeer(peer, false)),
      dependencies.transport.onStatusChange((status) => {
        this.patch({
          connectionState: status.connectionState,
          ...(status.error !== undefined ? { error: status.error } : {})
        })
      }),
      dependencies.dispatcher.subscribe((event) => {
        if (
          event.source === 'local' &&
          event.result.stateChanged &&
          this.state.lifecycle === 'active'
        ) {
          void this.broadcastState('STATE_UPDATE')
        }
      }),
      dependencies.dispatcher.subscribeAuthorityChanges(() => {
        if (this.state.lifecycle === 'active') void this.broadcastState('STATE_UPDATE')
      })
    ]
  }

  subscribe(listener: RoomListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getRoomState(): RemoteBpRoomState {
    return structuredClone(this.state)
  }

  async startRoom(options: StartRemoteRoomOptions): Promise<RemoteBpRoomState> {
    if (this.state.lifecycle !== 'idle' && this.state.lifecycle !== 'error') {
      return this.getRoomState()
    }
    this.patch({ lifecycle: 'starting', error: null })
    try {
      this.dependencies.dispatcher.startAuthoritySession(1)
      const manifest = await this.dependencies.getAssetManifest()
      this.lastAssetManifestRevision = manifest.revision
      const createdAt = new Date().toISOString()
      this.state = {
        ...this.state,
        lifecycle: 'starting',
        roomId: options.roomId ?? null,
        createdAt,
        connectionState: 'offline',
        mapping: { ...options.mapping },
        firstPlayer: emptyPlayer('first'),
        secondPlayer: emptyPlayer('second'),
        expiresAt: null,
        assetCount: manifest.assets.length,
        lastPublishedRevision: null,
        error: null
      }
      const started = await this.dependencies.transport.start(this.getRoomState())
      const roomId = started?.roomId ?? options.roomId
      if (!roomId) throw new Error('Transport 未返回房间码')
      this.patch({
        lifecycle: 'active',
        roomId,
        createdAt: started?.createdAt ?? createdAt,
        expiresAt: started?.expiresAt ?? null,
        connectionState:
          started?.connectionState ??
          (this.dependencies.transport.kind === 'mock' ? 'mock-active' : 'connected')
      })
      await this.broadcastState('INITIAL_STATE')
      await this.dependencies.transport.broadcast({
        type: 'ASSET_MANIFEST',
        payload: { manifest }
      })
      return this.getRoomState()
    } catch (error) {
      this.patch({
        lifecycle: 'error',
        connectionState: 'failed',
        error: error instanceof Error ? error.message : String(error)
      })
      return this.getRoomState()
    }
  }

  async stopRoom(): Promise<RemoteBpRoomState> {
    if (this.state.lifecycle === 'idle') return this.getRoomState()
    this.patch({ lifecycle: 'stopping' })
    await this.dependencies.transport.stop()
    this.assetTransferQueues.clear()
    this.assetManifestRefresh = null
    this.lastAssetManifestRevision = null
    this.state = {
      ...this.state,
      lifecycle: 'idle',
      roomId: null,
      createdAt: null,
      connectionState: 'offline',
      firstPlayer: emptyPlayer('first'),
      secondPlayer: emptyPlayer('second'),
      expiresAt: null,
      assetCount: 0,
      lastPublishedRevision: null,
      error: null
    }
    this.notify()
    return this.getRoomState()
  }

  async handleRemoteAction(
    action: RemoteBpAction,
    peer?: { peerId: string; side: RemotePlayerSide }
  ): Promise<RemoteBpActionResult> {
    if (this.state.lifecycle !== 'active') {
      return {
        actionId: action.actionId,
        accepted: false,
        code: 'SESSION_NOT_READY',
        message: '远程房间尚未开启',
        reason: '远程房间尚未开启',
        resultingRevision: this.dependencies.dispatcher.getRevision(),
        stateChanged: false
      }
    }
    if (peer && peer.side !== action.actorSide) {
      const rejected: RemoteBpActionResult = {
        actionId: action.actionId,
        accepted: false,
        code: 'INVALID_ACTION',
        message: 'Peer 身份与 action actorSide 不一致',
        reason: 'Peer 身份与 action actorSide 不一致',
        resultingRevision: this.dependencies.dispatcher.getRevision(),
        stateChanged: false
      }
      await this.dependencies.transport.send(peer.peerId, {
        type: 'ACTION_RESULT',
        payload: rejected
      })
      return rejected
    }

    const result = await this.dependencies.dispatcher.dispatch(
      action,
      'remote',
      this.dependencies.getDispatchSnapshot(),
      this.dependencies.getExecutor(),
      this.state.mapping
    )
    if (peer) {
      await this.dependencies.transport.send(peer.peerId, {
        type: 'ACTION_RESULT',
        payload: result
      })
    }
    if (result.stateChanged) await this.broadcastState('STATE_UPDATE')
    else if (peer && result.code === 'REVISION_CONFLICT') await this.sendStateToPeer(peer.peerId)
    return result
  }

  getCurrentRemoteState(): RemoteBpState | null {
    if (this.state.lifecycle !== 'active' || !this.state.roomId) return null
    return serializeRemoteBpState({
      ...this.dependencies.getSerializerInput(),
      revision: this.dependencies.dispatcher.getRevision(),
      roomId: this.state.roomId,
      sessionId: `host-${this.state.roomId}`,
      mapping: this.state.mapping,
      teamNames: {
        first: this.state.firstPlayer.displayName,
        second: this.state.secondPlayer.displayName
      }
    })
  }

  async getAssetManifest(): Promise<AssetManifest> {
    return this.dependencies.getAssetManifest()
  }

  async refreshAssetManifest(): Promise<AssetManifest | null> {
    if (this.state.lifecycle !== 'active') return null
    if (this.assetManifestRefresh) return this.assetManifestRefresh
    const refresh = this.refreshAssetManifestNow()
    this.assetManifestRefresh = refresh
    try {
      return await refresh
    } finally {
      if (this.assetManifestRefresh === refresh) this.assetManifestRefresh = null
    }
  }

  destroy(): void {
    this.unsubscribers.forEach((unsubscribe) => unsubscribe())
    this.assetTransferQueues.clear()
    this.listeners.clear()
  }

  private enqueueAssetRequest(peerId: string, requestedAssetIds: string[]): void {
    const previous = this.assetTransferQueues.get(peerId) ?? Promise.resolve()
    const queued = previous
      .catch(() => undefined)
      .then(() => this.sendAssetsToPeer(peerId, [...new Set(requestedAssetIds)]))
    this.assetTransferQueues.set(peerId, queued)
    void queued
      .catch(() => undefined)
      .finally(() => {
        if (this.assetTransferQueues.get(peerId) === queued) {
          this.assetTransferQueues.delete(peerId)
        }
      })
  }

  private async sendAssetsToPeer(peerId: string, assetIds: string[]): Promise<void> {
    for (const requestedAssetId of assetIds) {
      try {
        const asset = await this.dependencies.getAsset(requestedAssetId)
        if (
          asset.descriptor.assetId !== requestedAssetId ||
          asset.descriptor.size !== asset.data.byteLength
        ) {
          throw new Error('资源描述与实际内容不一致')
        }

        const transferId = globalThis.crypto.randomUUID()
        const totalChunks = Math.ceil(asset.data.byteLength / ASSET_CHUNK_SIZE)
        if (totalChunks < 1) throw new Error('不允许传输空资源')

        await this.dependencies.transport.send(peerId, {
          type: 'ASSET_START',
          payload: {
            transferId,
            asset: asset.descriptor,
            chunkSize: ASSET_CHUNK_SIZE,
            totalChunks
          }
        })
        for (let index = 0; index < totalChunks; index += 1) {
          const offset = index * ASSET_CHUNK_SIZE
          const chunk = asset.data.subarray(offset, offset + ASSET_CHUNK_SIZE)
          await this.dependencies.transport.send(peerId, {
            type: 'ASSET_CHUNK',
            payload: {
              transferId,
              assetId: requestedAssetId,
              index,
              total: totalChunks,
              data: bytesToBase64(chunk)
            }
          })
        }
        await this.dependencies.transport.send(peerId, {
          type: 'ASSET_COMPLETE',
          payload: {
            transferId,
            assetId: requestedAssetId,
            hash: asset.descriptor.hash,
            totalBytes: asset.data.byteLength
          }
        })
      } catch (error) {
        await this.dependencies.transport.send(peerId, {
          type: 'ERROR',
          payload: {
            code: 'ASSET_TRANSFER_FAILED',
            message: error instanceof Error ? error.message : '资源传输失败',
            recoverable: true,
            assetId: requestedAssetId
          }
        })
      }
    }
  }

  private async broadcastState(type: 'INITIAL_STATE' | 'STATE_UPDATE'): Promise<void> {
    const state = this.getCurrentRemoteState()
    if (!state) return
    await this.dependencies.transport.broadcast({ type, payload: { state } })
    this.patch({ lastPublishedRevision: state.revision })
  }

  private async sendStateToPeer(peerId: string): Promise<void> {
    const state = this.getCurrentRemoteState()
    if (!state) return
    await this.dependencies.transport.send(peerId, { type: 'INITIAL_STATE', payload: { state } })
  }

  private async sendManifestToPeer(peerId: string): Promise<void> {
    const manifest = await this.dependencies.getAssetManifest()
    const changed = manifest.revision !== this.lastAssetManifestRevision
    this.lastAssetManifestRevision = manifest.revision
    if (manifest.assets.length !== this.state.assetCount)
      this.patch({ assetCount: manifest.assets.length })
    if (changed) {
      await this.dependencies.transport.broadcast({
        type: 'ASSET_MANIFEST',
        payload: { manifest }
      })
    } else {
      await this.dependencies.transport.send(peerId, {
        type: 'ASSET_MANIFEST',
        payload: { manifest }
      })
    }
  }

  private async refreshAssetManifestNow(): Promise<AssetManifest | null> {
    if (this.state.lifecycle !== 'active') return null
    const manifest = await this.dependencies.getAssetManifest()
    if (this.state.lifecycle !== 'active') return null
    if (manifest.revision === this.lastAssetManifestRevision) return manifest
    this.lastAssetManifestRevision = manifest.revision
    if (manifest.assets.length !== this.state.assetCount)
      this.patch({ assetCount: manifest.assets.length })
    await this.dependencies.transport.broadcast({
      type: 'ASSET_MANIFEST',
      payload: { manifest }
    })
    return manifest
  }

  private updatePeer(peer: RemoteHostPeer, connected: boolean): void {
    const key = peer.side === 'first' ? 'firstPlayer' : 'secondPlayer'
    this.patch({
      [key]: connected
        ? {
            side: peer.side,
            peerId: peer.peerId,
            displayName: peer.displayName ?? null,
            connectionState: 'connected',
            joinedAt: new Date().toISOString()
          }
        : {
            ...this.state[key],
            connectionState: 'disconnected'
          }
    })
  }

  private patch(patch: Partial<RemoteBpRoomState>): void {
    this.state = { ...this.state, ...patch }
    this.notify()
  }

  private notify(): void {
    const snapshot = this.getRoomState()
    this.listeners.forEach((listener) => listener(snapshot))
  }
}
