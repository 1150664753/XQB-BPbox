import type { ReceivedAsset } from "../../types/assets";
import type { AssetCache } from "./AssetCache";

export class MemoryAssetCache implements AssetCache {
  private readonly assets = new Map<string, ReceivedAsset>();

  async has(assetId: string, hash: string): Promise<boolean> {
    return this.assets.get(assetId)?.descriptor.hash === hash;
  }

  async get(assetId: string, hash?: string): Promise<ReceivedAsset | null> {
    const asset = this.assets.get(assetId);
    return asset && (!hash || asset.descriptor.hash === hash) ? asset : null;
  }

  async save(asset: ReceivedAsset): Promise<void> {
    this.assets.delete(asset.descriptor.assetId);
    this.assets.set(asset.descriptor.assetId, asset);
    let size = [...this.assets.values()].reduce(
      (sum, entry) => sum + entry.data.size,
      0,
    );
    while (this.assets.size > 256 || size > 128 * 1024 * 1024) {
      const first = this.assets.keys().next().value!;
      size -= this.assets.get(first)!.data.size;
      this.assets.delete(first);
    }
  }

  async remove(assetId: string): Promise<void> {
    this.assets.delete(assetId);
  }

  async clear(): Promise<void> {
    this.assets.clear();
  }
}
