import type {
  AssetManifest,
  AssetManifestEntry,
  ReceivedAsset,
} from "../../types/assets";

interface AssetStartPayload {
  transferId: string;
  asset: AssetManifestEntry;
  chunkSize: number;
  totalChunks: number;
}

interface AssetChunkPayload {
  transferId: string;
  assetId: string;
  index: number;
  total: number;
  data: string;
}

interface AssetCompletePayload {
  transferId: string;
  assetId: string;
  hash: string;
  totalBytes: number;
}

interface IncomingTransfer {
  descriptor: AssetManifestEntry;
  chunkSize: number;
  totalChunks: number;
  chunks: Array<Uint8Array | undefined>;
  receivedBytes: number;
}

const MAX_CONCURRENT_TRANSFERS = 8;
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function descriptorsMatch(
  expected: AssetManifestEntry,
  actual: AssetManifestEntry,
): boolean {
  return (
    expected.assetId === actual.assetId &&
    expected.type === actual.type &&
    expected.hash.toLowerCase() === actual.hash.toLowerCase() &&
    expected.size === actual.size &&
    expected.mimeType === actual.mimeType &&
    expected.characterId === actual.characterId &&
    expected.ownerId === actual.ownerId
  );
}

function decodeBase64(value: string): Uint8Array {
  if (value.length % 4 !== 0 || !BASE64_PATTERN.test(value)) {
    throw new Error("ASSET_CHUNK_BASE64_INVALID");
  }
  let binary: string;
  try {
    binary = globalThis.atob(value);
  } catch {
    throw new Error("ASSET_CHUNK_BASE64_INVALID");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function sha256(data: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Reassembles only assets declared by the latest signed room manifest. */
export class IncomingAssetTransfers {
  private readonly expectedAssets = new Map<string, AssetManifestEntry>();
  private readonly transfers = new Map<string, IncomingTransfer>();

  setManifest(manifest: AssetManifest): void {
    const nextExpectedAssets = new Map<string, AssetManifestEntry>();
    for (const asset of manifest.assets) {
      nextExpectedAssets.set(asset.assetId, asset);
    }
    for (const [transferId, transfer] of this.transfers) {
      const nextDescriptor = nextExpectedAssets.get(
        transfer.descriptor.assetId,
      );
      if (
        !nextDescriptor ||
        !descriptorsMatch(nextDescriptor, transfer.descriptor)
      ) {
        this.transfers.delete(transferId);
      }
    }
    this.expectedAssets.clear();
    nextExpectedAssets.forEach((asset, assetId) =>
      this.expectedAssets.set(assetId, asset),
    );
  }

  start(payload: AssetStartPayload): void {
    const expected = this.expectedAssets.get(payload.asset.assetId);
    if (!expected || !descriptorsMatch(expected, payload.asset)) {
      throw new Error("ASSET_NOT_IN_MANIFEST");
    }
    if (this.transfers.has(payload.transferId)) {
      throw new Error("ASSET_TRANSFER_ID_DUPLICATE");
    }
    if (this.transfers.size >= MAX_CONCURRENT_TRANSFERS) {
      throw new Error("TOO_MANY_ASSET_TRANSFERS");
    }
    const expectedChunks = Math.ceil(payload.asset.size / payload.chunkSize);
    if (payload.totalChunks !== expectedChunks) {
      throw new Error("ASSET_CHUNK_COUNT_MISMATCH");
    }
    this.transfers.set(payload.transferId, {
      descriptor: payload.asset,
      chunkSize: payload.chunkSize,
      totalChunks: payload.totalChunks,
      chunks: new Array<Uint8Array | undefined>(payload.totalChunks),
      receivedBytes: 0,
    });
  }

  addChunk(payload: AssetChunkPayload): void {
    const transfer = this.transfers.get(payload.transferId);
    if (!transfer || transfer.descriptor.assetId !== payload.assetId) {
      throw new Error("ASSET_TRANSFER_NOT_FOUND");
    }
    if (
      payload.total !== transfer.totalChunks ||
      payload.index < 0 ||
      payload.index >= transfer.totalChunks
    ) {
      throw new Error("ASSET_CHUNK_INDEX_INVALID");
    }
    if (transfer.chunks[payload.index]) {
      throw new Error("ASSET_CHUNK_DUPLICATE");
    }

    const chunk = decodeBase64(payload.data);
    const expectedLength =
      payload.index === transfer.totalChunks - 1
        ? transfer.descriptor.size - transfer.chunkSize * payload.index
        : transfer.chunkSize;
    if (chunk.byteLength !== expectedLength) {
      throw new Error("ASSET_CHUNK_SIZE_MISMATCH");
    }
    if (transfer.receivedBytes + chunk.byteLength > transfer.descriptor.size) {
      throw new Error("ASSET_SIZE_LIMIT_EXCEEDED");
    }
    transfer.chunks[payload.index] = chunk;
    transfer.receivedBytes += chunk.byteLength;
  }

  async complete(payload: AssetCompletePayload): Promise<ReceivedAsset> {
    const transfer = this.transfers.get(payload.transferId);
    if (!transfer || transfer.descriptor.assetId !== payload.assetId) {
      throw new Error("ASSET_TRANSFER_NOT_FOUND");
    }
    this.transfers.delete(payload.transferId);
    if (
      payload.totalBytes !== transfer.descriptor.size ||
      transfer.receivedBytes !== transfer.descriptor.size ||
      payload.hash.toLowerCase() !== transfer.descriptor.hash.toLowerCase() ||
      transfer.chunks.some((chunk) => chunk === undefined)
    ) {
      throw new Error("ASSET_TRANSFER_INCOMPLETE");
    }

    const data = new Uint8Array(transfer.descriptor.size);
    let offset = 0;
    for (const chunk of transfer.chunks) {
      if (!chunk) throw new Error("ASSET_TRANSFER_INCOMPLETE");
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const actualHash = await sha256(data);
    if (actualHash !== transfer.descriptor.hash.toLowerCase()) {
      throw new Error("ASSET_HASH_MISMATCH");
    }
    return {
      descriptor: transfer.descriptor,
      data: new Blob([data.buffer], { type: transfer.descriptor.mimeType }),
    };
  }

  abort(transferId: string): void {
    this.transfers.delete(transferId);
  }

  reset(): void {
    this.expectedAssets.clear();
    this.transfers.clear();
  }
}
