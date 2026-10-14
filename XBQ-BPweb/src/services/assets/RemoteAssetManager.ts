import type {
  AssetManifest,
  AssetManifestEntry,
  AssetLoadState,
  ReceivedAsset,
} from "../../types/assets";
import type { RemoteBpConnection } from "../RemoteBpConnection";
import type { AssetCache } from "./AssetCache";
import type { PreviewTiming } from "../../../../shared/remoteBpDiagnostics";

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
  private readonly installedDescriptors = new Map<string, AssetManifestEntry>();
  private readonly states = new Map<string, AssetLoadState>();
  private readonly pendingRequestIds = new Set<string>();
  private readonly cacheLookups = new Map<string, Promise<void>>();
  private readonly unsubscribers: Array<() => void>;
  private manifest: AssetManifest | null = null;
  private requestFlushScheduled = false;
  private manifestApplyToken = 0;
  private connected: boolean;
  private destroyed = false;
  private readonly wanted = new Set<string>();
  private readonly retries = new Map<string, number>();
  private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>();
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
    this.connected = connection.getSnapshot().state === "connected";
    this.unsubscribers = [
      connection.on("assetTransfersReset", () => {
        ++this.manifestApplyToken;
        this.manifest = null;
        this.pendingRequestIds.clear();
        this.retries.clear();
        for (const [id, state] of this.states)
          if (state === "loading" || state === "failed")
            this.states.set(id, "idle");
        this.publish();
      }),
      connection.on("connectionStateChanged", (state) => {
        const recovered = !this.connected && state.state === "connected";
        this.connected = state.state === "connected";
        if (recovered) void this.request([...this.wanted]);
      }),
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
        const id = error.assetId,
          epoch = this.manifestApplyToken;
        const attempts = this.retries.get(id) ?? 0;
        if (attempts >= 2 || !this.wanted.has(id)) return;
        this.retries.set(id, attempts + 1);
        const timer = setTimeout(
          () => {
            this.retryTimers.delete(timer);
            if (!this.destroyed && epoch === this.manifestApplyToken)
              void this.request([id]);
          },
          1000 * (attempts + 1),
        );
        this.retryTimers.add(timer);
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
  recordActionUi(id: string): void {
    this.connection.recordActionStage?.(id, "uiCommitMs");
  }
  recordPreview(value: PreviewTiming): void {
    this.connection.recordPreview?.(value);
  }

  async request(assetIds: string[]): Promise<void> {
    assetIds.forEach((id) => this.wanted.add(id));
    if (!this.connected || this.destroyed) return;
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
    });
    this.publish();
    // Resolve only wanted assets, once per hash. The old manifest loop scanned
    // every cached image serially while UI requests could race it onto the wire.
    await Promise.all(missing.map((id) => this.resolveCachedOrRequest(id)));
  }

  destroy(): void {
    this.destroyed = true;
    ++this.manifestApplyToken;
    this.retryTimers.forEach((timer) => clearTimeout(timer));
    this.unsubscribers.forEach((unsubscribe) => unsubscribe());
    this.urls.forEach((url) => URL.revokeObjectURL(url));
    this.urls.clear();
    this.pendingRequestIds.clear();
    this.listeners.clear();
  }

  private async applyManifest(manifest: AssetManifest): Promise<void> {
    if (this.manifest && manifest.revision < this.manifest.revision) return;
    if (
      this.manifest?.revision === manifest.revision &&
      JSON.stringify(this.manifest.assets) === JSON.stringify(manifest.assets)
    )
      return;
    const applyToken = ++this.manifestApplyToken;
    const previousDescriptors = new Map(
      (this.manifest?.assets ?? [...this.installedDescriptors.values()]).map(
        (descriptor) => [descriptor.assetId, descriptor],
      ) ?? [],
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
      this.installedDescriptors.delete(assetId);
      this.wanted.delete(assetId);
    }

    for (const descriptor of manifest.assets) {
      const previous = previousDescriptors.get(descriptor.assetId);
      const descriptorChanged = Boolean(
        previous &&
        (previous.hash !== descriptor.hash ||
          previous.size !== descriptor.size ||
          previous.mimeType !== descriptor.mimeType ||
          previous.type !== descriptor.type ||
          previous.ownerId !== descriptor.ownerId ||
          previous.characterId !== descriptor.characterId ||
          previous.lightConeId !== descriptor.lightConeId),
      );
      if (descriptorChanged) {
        const url = this.urls.get(descriptor.assetId);
        if (url) URL.revokeObjectURL(url);
        this.urls.delete(descriptor.assetId);
        this.states.set(descriptor.assetId, "idle");
        this.pendingRequestIds.delete(descriptor.assetId);
        this.retries.delete(descriptor.assetId);
      }
      if (applyToken !== this.manifestApplyToken) return;
      if (
        !descriptorChanged &&
        this.states.get(descriptor.assetId) === "ready" &&
        this.urls.has(descriptor.assetId)
      )
        continue;
      const installed = this.installedDescriptors.get(descriptor.assetId);
      if (
        this.states.get(descriptor.assetId) === "ready" &&
        installed &&
        this.matchesManifest(installed)
      )
        continue;
      if (
        !descriptorChanged &&
        this.states.get(descriptor.assetId) === "loading" &&
        ![...this.cacheLookups.keys()].some((key) =>
          key.endsWith(`:${descriptor.assetId}:${descriptor.hash}`),
        )
      )
        continue;
      this.states.set(descriptor.assetId, "idle");
    }

    this.publish();
    void this.request([...this.wanted]);
  }

  private async resolveCachedOrRequest(id: string): Promise<void> {
    const descriptor = this.manifest?.assets.find(
      (item) => item.assetId === id,
    );
    if (!descriptor) return;
    const key = `${this.manifestApplyToken}:${id}:${descriptor.hash}`;
    const existing = this.cacheLookups.get(key);
    if (existing) return existing;
    const epoch = this.manifestApplyToken;
    const lookup = (async () => {
      const cached = await this.cache
        .get(id, descriptor.hash)
        .catch(() => null);
      if (
        this.destroyed ||
        epoch !== this.manifestApplyToken ||
        !this.matchesManifest(descriptor)
      )
        return;
      // A validated network result may have arrived while IndexedDB was reading.
      if (this.states.get(id) === "ready" && this.urls.has(id)) return;
      if (cached && this.matchesManifest(cached.descriptor))
        this.installUrl(cached);
      else if (this.states.get(id) !== "ready") {
        this.pendingRequestIds.add(id);
        this.scheduleRequestFlush();
      }
      this.publish();
    })();
    this.cacheLookups.set(key, lookup);
    try {
      await lookup;
    } finally {
      this.cacheLookups.delete(key);
    }
  }

  private async acceptAsset(asset: ReceivedAsset): Promise<void> {
    if (!this.matchesManifest(asset.descriptor)) {
      return;
    }
    if (this.destroyed) return;
    void this.cache.save(asset).catch(() => undefined);
    this.retries.delete(asset.descriptor.assetId);
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
    this.installedDescriptors.set(asset.descriptor.assetId, asset.descriptor);
    this.pendingRequestIds.delete(asset.descriptor.assetId);
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
    if (this.destroyed || !this.connected) {
      assetIds.forEach((id) => {
        if (this.states.get(id) === "loading") this.states.set(id, "idle");
      });
      return;
    }
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
