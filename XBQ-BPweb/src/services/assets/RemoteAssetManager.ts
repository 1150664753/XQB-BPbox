import type {
  AssetManifest,
  AssetManifestEntry,
  AssetLoadState,
  ReceivedAsset,
} from "../../types/assets";
import type { RemoteBpConnection } from "../RemoteBpConnection";
import type { AssetCache } from "./AssetCache";

export interface AssetManagerSnapshot {
  manifest: AssetManifest | null;
  states: ReadonlyMap<string, AssetLoadState>;
  readyCount: number;
  totalCount: number;
}

type AssetManagerListener = () => void;

/** Resolves transport assets into browser-safe object URLs without exposing Blob logic to React. */
export class RemoteAssetManager {
  private readonly listeners = new Set<AssetManagerListener>();
  private readonly urls = new Map<string, string>();
  private readonly states = new Map<string, AssetLoadState>();
  private readonly pendingRequestIds = new Set<string>();
  private readonly unsubscribers: Array<() => void>;
  private manifest: AssetManifest | null = null;
  private requestFlushScheduled = false;
  private manifestApplyToken = 0;
  private snapshot: AssetManagerSnapshot = {
    manifest: null,
    states: this.states,
    readyCount: 0,
    totalCount: 0,
  };

  constructor(
    private readonly connection: RemoteBpConnection,
    private readonly cache: AssetCache,
  ) {
    this.unsubscribers = [
      connection.on("assetManifestReceived", (manifest) => {
        void this.applyManifest(manifest);
      }),
      connection.on("assetReceived", (asset) => {
        void this.acceptAsset(asset);
      }),
      connection.on("error", (error) => {
        if (!error.assetId) return;
        this.states.set(error.assetId, "failed");
        this.publish();
      }),
    ];
  }

  subscribe(listener: AssetManagerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): AssetManagerSnapshot {
    return this.snapshot;
  }

  getUrl(assetId: string | null | undefined): string | null {
    return assetId ? (this.urls.get(assetId) ?? null) : null;
  }

  getState(assetId: string | null | undefined): AssetLoadState {
    return assetId ? (this.states.get(assetId) ?? "idle") : "missing";
  }

  async request(assetIds: string[]): Promise<void> {
    const manifestIds = new Set(
      this.manifest?.assets.map((descriptor) => descriptor.assetId) ?? [],
    );
    const missing = assetIds.filter(
      (assetId) =>
        manifestIds.has(assetId) &&
        this.states.get(assetId) !== "ready" &&
        this.states.get(assetId) !== "loading",
    );
    if (missing.length === 0) return;
    missing.forEach((assetId) => {
      this.states.set(assetId, "loading");
      this.pendingRequestIds.add(assetId);
    });
    this.publish();
    this.scheduleRequestFlush();
  }

  destroy(): void {
    this.unsubscribers.forEach((unsubscribe) => unsubscribe());
    this.urls.forEach((url) => URL.revokeObjectURL(url));
    this.urls.clear();
    this.pendingRequestIds.clear();
    this.listeners.clear();
  }

  private async applyManifest(manifest: AssetManifest): Promise<void> {
    if (this.manifest && manifest.revision < this.manifest.revision) return;
    const applyToken = ++this.manifestApplyToken;
    const previousDescriptors = new Map(
      this.manifest?.assets.map((descriptor) => [
        descriptor.assetId,
        descriptor,
      ]) ?? [],
    );
    this.manifest = manifest;
    const nextIds = new Set(
      manifest.assets.map((descriptor) => descriptor.assetId),
    );

    for (const assetId of [...this.states.keys()]) {
      if (nextIds.has(assetId)) continue;
      this.states.delete(assetId);
      this.pendingRequestIds.delete(assetId);
      const url = this.urls.get(assetId);
      if (url) URL.revokeObjectURL(url);
      this.urls.delete(assetId);
      await this.cache.remove(assetId);
    }

    for (const descriptor of manifest.assets) {
      const previous = previousDescriptors.get(descriptor.assetId);
      const descriptorChanged = Boolean(
        previous &&
        (previous.hash !== descriptor.hash ||
          previous.size !== descriptor.size ||
          previous.mimeType !== descriptor.mimeType),
      );
      if (descriptorChanged) {
        const url = this.urls.get(descriptor.assetId);
        if (url) URL.revokeObjectURL(url);
        this.urls.delete(descriptor.assetId);
        this.states.set(descriptor.assetId, "idle");
        this.pendingRequestIds.delete(descriptor.assetId);
        await this.cache.remove(descriptor.assetId);
      }
      if (applyToken !== this.manifestApplyToken) return;
      if (await this.cache.has(descriptor.assetId, descriptor.hash)) {
        const cached = await this.cache.get(descriptor.assetId);
        if (cached) {
          this.installUrl(cached);
          continue;
        }
      }
      if (
        !descriptorChanged &&
        this.states.get(descriptor.assetId) === "loading"
      )
        continue;
      this.states.set(descriptor.assetId, "idle");
    }

    this.publish();
  }

  private async acceptAsset(asset: ReceivedAsset): Promise<void> {
    if (!this.matchesManifest(asset.descriptor)) {
      this.states.set(asset.descriptor.assetId, "failed");
      this.publish();
      return;
    }
    await this.cache.save(asset);
    this.installUrl(asset);
    this.publish();
  }

  private matchesManifest(descriptor: AssetManifestEntry): boolean {
    const expected = this.manifest?.assets.find(
      (asset) => asset.assetId === descriptor.assetId,
    );
    return Boolean(
      expected &&
      expected.type === descriptor.type &&
      expected.hash === descriptor.hash &&
      expected.size === descriptor.size &&
      expected.mimeType === descriptor.mimeType &&
      expected.characterId === descriptor.characterId &&
      expected.lightConeId === descriptor.lightConeId &&
      expected.ownerId === descriptor.ownerId,
    );
  }

  private installUrl(asset: ReceivedAsset): void {
    const previousUrl = this.urls.get(asset.descriptor.assetId);
    if (previousUrl) URL.revokeObjectURL(previousUrl);
    this.urls.set(asset.descriptor.assetId, URL.createObjectURL(asset.data));
    this.states.set(asset.descriptor.assetId, "ready");
  }

  private publish(): void {
    const requestedStates = [...this.states.values()].filter(
      (state) => state !== "idle" && state !== "missing",
    );
    const totalCount = requestedStates.length;
    const readyCount = requestedStates.filter(
      (state) => state === "ready",
    ).length;
    this.snapshot = {
      manifest: this.manifest,
      states: new Map(this.states),
      readyCount,
      totalCount,
    };
    this.listeners.forEach((listener) => listener());
  }

  private scheduleRequestFlush(): void {
    if (this.requestFlushScheduled) return;
    this.requestFlushScheduled = true;
    queueMicrotask(() => {
      this.requestFlushScheduled = false;
      const assetIds = [...this.pendingRequestIds];
      this.pendingRequestIds.clear();
      void this.flushRequests(assetIds);
    });
  }

  private async flushRequests(assetIds: string[]): Promise<void> {
    try {
      for (let offset = 0; offset < assetIds.length; offset += 128) {
        await this.connection.requestAssets(
          assetIds.slice(offset, offset + 128),
        );
      }
    } catch {
      assetIds.forEach((assetId) => {
        if (this.states.get(assetId) === "loading")
          this.states.set(assetId, "failed");
      });
      this.publish();
    }
  }
}
