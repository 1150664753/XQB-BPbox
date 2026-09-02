export type AssetId = string;

export type RemoteAssetType = "avatar" | "portrait" | "light-cone";

export interface AssetManifestEntry {
  assetId: AssetId;
  type: RemoteAssetType;
  hash: string;
  size: number;
  mimeType: string;
  characterId?: string;
  lightConeId?: string;
  ownerId?: string;
}

export interface AssetManifest {
  revision: number;
  generatedAt: string;
  assets: AssetManifestEntry[];
}

export interface ReceivedAsset {
  descriptor: AssetManifestEntry;
  data: Blob;
}

export type AssetLoadState =
  | "idle"
  | "loading"
  | "ready"
  | "missing"
  | "failed";
