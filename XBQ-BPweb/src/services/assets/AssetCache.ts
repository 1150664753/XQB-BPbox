import type { ReceivedAsset } from "../../types/assets";

/** Cache contract prepared for a future IndexedDB-backed implementation. */
export interface AssetCache {
  has(assetId: string, hash: string): Promise<boolean>;
  get(assetId: string): Promise<ReceivedAsset | null>;
  save(asset: ReceivedAsset): Promise<void>;
  remove(assetId: string): Promise<void>;
  clear(): Promise<void>;
}
