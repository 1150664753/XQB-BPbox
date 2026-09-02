import type { ReceivedAsset } from "../../types/assets";
import type { AssetCache } from "./AssetCache";

export class MemoryAssetCache implements AssetCache {
  private readonly assets = new Map<string, ReceivedAsset>();

  async has(assetId: string, hash: string): Promise<boolean> {
    return this.assets.get(assetId)?.descriptor.hash === hash;
  }

  async get(assetId: string): Promise<ReceivedAsset | null> {
    return this.assets.get(assetId) ?? null;
  }

  async save(asset: ReceivedAsset): Promise<void> {
    this.assets.set(asset.descriptor.assetId, asset);
  }

  async remove(assetId: string): Promise<void> {
    this.assets.delete(assetId);
  }

  async clear(): Promise<void> {
    this.assets.clear();
  }
}
