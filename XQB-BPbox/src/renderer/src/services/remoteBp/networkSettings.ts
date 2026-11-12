import { useSyncExternalStore } from 'react'
import type { RemoteBpHost } from '../../../../shared/remoteBp'
import type { SakuraSettings } from '../../../../shared/sakura'

interface NetworkSnapshot {
  settings: SakuraSettings
  ready: boolean
  busy: boolean
  roomOpen: boolean
  error: string | null
}

/** Coordinates the global dialog and BP panel, including startup hydration. */
class NetworkSettings {
  private snapshot: NetworkSnapshot = {
    settings: { mode: 'webrtc', publicUrl: '', localPort: 18787 },
    ready: false,
    busy: false,
    roomOpen: false,
    error: null
  }
  private listeners = new Set<() => void>()
  private loading: Promise<void> | null = null
  private host: RemoteBpHost | null = null
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  getSnapshot = (): NetworkSnapshot => this.snapshot
  private patch(value: Partial<NetworkSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...value }
    this.listeners.forEach((listener) => listener())
  }
  private fail(error: unknown): void {
    this.patch({ error: error instanceof Error ? error.message : '网络设置操作失败' })
  }
  initialize(): Promise<void> {
    if (!this.loading) {
      this.loading = window.bpAPI.sakura
        .settings()
        .then(async (settings) => {
          await this.applyMode(settings)
          this.patch({ settings, ready: true, error: null })
        })
        .catch((error) => {
          this.loading = null
          this.fail(error)
        })
    }
    return this.loading
  }
  private async applyMode(settings: SakuraSettings): Promise<void> {
    if (
      this.host &&
      this.host.getRoomState().transport !== 'mock' &&
      this.host.getRoomState().transport !== settings.mode
    ) {
      await this.host.setTransportMode(settings.mode)
    }
  }
  bind(host: RemoteBpHost): () => void {
    this.host = host
    const update = (): void => this.patch({ roomOpen: host.getRoomState().lifecycle !== 'idle' })
    update()
    const unsubscribe = host.subscribe(update)
    void this.initialize()
      .then(async () => {
        if (this.host === host && this.snapshot.ready) await this.applyMode(this.snapshot.settings)
      })
      .catch((error) => this.fail(error))
    return () => {
      unsubscribe()
      if (this.host === host) {
        this.host = null
        this.patch({ roomOpen: false })
      }
    }
  }
  async configure(settings: SakuraSettings): Promise<void> {
    if (this.snapshot.busy || !this.snapshot.ready) return
    if (this.snapshot.roomOpen) {
      this.fail(new Error('请先关闭当前远程房间再修改网络设置'))
      return
    }
    this.patch({ busy: true, error: null })
    try {
      const saved = await window.bpAPI.sakura.configure(settings)
      await this.applyMode(saved)
      this.patch({ settings: saved })
    } catch (error) {
      this.fail(error)
    } finally {
      this.patch({ busy: false })
    }
  }
  async startRoom(
    host: RemoteBpHost,
    options: Parameters<RemoteBpHost['startRoom']>[0]
  ): Promise<void> {
    await this.initialize()
    if (!this.snapshot.ready || this.snapshot.busy) return
    this.patch({ busy: true, error: null })
    try {
      await this.applyMode(this.snapshot.settings)
      await host.startRoom(options)
    } catch (error) {
      this.fail(error)
    } finally {
      this.patch({ busy: false })
    }
  }
}

export const networkSettings = new NetworkSettings()
export function useNetworkSettings(): NetworkSnapshot {
  return useSyncExternalStore(networkSettings.subscribe, networkSettings.getSnapshot)
}
