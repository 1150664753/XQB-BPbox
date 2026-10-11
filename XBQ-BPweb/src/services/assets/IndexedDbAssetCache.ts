import type { ReceivedAsset } from "../../types/assets";
import type { AssetCache } from "./AssetCache";
import { MemoryAssetCache } from "./MemoryAssetCache";

const MAX_BYTES = 128 * 1024 * 1024;
const MAX_ITEMS = 256;
interface StoredAsset extends ReceivedAsset {
  usedAt: number;
}

/** Content is rehashed on a disk-cache hit before it can reach an image URL. */
export class IndexedDbAssetCache implements AssetCache {
  private readonly memory = new MemoryAssetCache();
  private database: Promise<IDBDatabase | null> | null = null;

  private open(): Promise<IDBDatabase | null> {
    if (!this.database)
      this.database = new Promise((resolve) => {
        try {
          const request = indexedDB.open("xqb-remote-assets-v1", 1);
          let settled = false;
          const finish = (db: IDBDatabase | null) => {
            if (settled) {
              db?.close();
              return;
            }
            settled = true;
            clearTimeout(timer);
            resolve(db);
          };
          const timer = setTimeout(() => finish(null), 2000);
          request.onupgradeneeded = () =>
            request.result.createObjectStore("assets", {
              keyPath: "descriptor.assetId",
            });
          request.onsuccess = () => {
            request.result.onversionchange = () => request.result.close();
            finish(request.result);
          };
          request.onerror = request.onblocked = () => finish(null);
        } catch {
          resolve(null);
        }
      });
    return this.database;
  }

  async has(assetId: string, hash: string): Promise<boolean> {
    return Boolean(await this.get(assetId, hash));
  }

  async get(assetId: string, hash?: string): Promise<ReceivedAsset | null> {
    const memory = await this.memory.get(assetId, hash);
    if (memory) return memory;
    try {
      const db = await this.open();
      if (!db) return null;
      const stored = await new Promise<StoredAsset | undefined>(
        (resolve, reject) => {
          const request = db
            .transaction("assets", "readonly")
            .objectStore("assets")
            .get(assetId);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        },
      );
      if (!stored || (hash && stored.descriptor.hash !== hash)) return null;
      if (
        !(stored.data instanceof Blob) ||
        stored.data.size !== stored.descriptor.size ||
        stored.data.type !== stored.descriptor.mimeType
      ) {
        await this.remove(assetId);
        return null;
      }
      const digest = await crypto.subtle.digest(
        "SHA-256",
        await stored.data.arrayBuffer(),
      );
      const actual = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      if (actual !== stored.descriptor.hash.toLowerCase()) {
        await this.remove(assetId);
        return null;
      }
      const asset = { descriptor: stored.descriptor, data: stored.data };
      await this.memory.save(asset);
      return asset;
    } catch {
      return null;
    }
  }

  async save(asset: ReceivedAsset): Promise<void> {
    await this.memory.save(asset);
    if (asset.data.size > MAX_BYTES) return;
    try {
      const db = await this.open();
      if (!db) return;
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction("assets", "readwrite");
        const store = transaction.objectStore("assets");
        const request = store.getAll();
        request.onsuccess = () => {
          const entries = (request.result as StoredAsset[])
            .filter(
              (entry) => entry.descriptor.assetId !== asset.descriptor.assetId,
            )
            .sort((a, b) => a.usedAt - b.usedAt);
          let bytes = entries.reduce(
            (sum, entry) => sum + entry.data.size,
            asset.data.size,
          );
          while (entries.length >= MAX_ITEMS || bytes > MAX_BYTES) {
            const first = entries.shift();
            if (!first) break;
            bytes -= first.data.size;
            store.delete(first.descriptor.assetId);
          }
          store.put({ ...asset, usedAt: Date.now() } satisfies StoredAsset);
        };
        transaction.oncomplete = () => resolve();
        transaction.onabort = transaction.onerror = () =>
          reject(transaction.error);
      });
    } catch {
      /* Quota/private browsing failure retains the memory cache. */
    }
  }

  async remove(assetId: string): Promise<void> {
    await this.memory.remove(assetId);
    await this.mutate((store) => store.delete(assetId));
  }
  async clear(): Promise<void> {
    await this.memory.clear();
    await this.mutate((store) => store.clear());
  }
  private async mutate(
    operation: (store: IDBObjectStore) => unknown,
  ): Promise<void> {
    try {
      const db = await this.open();
      if (!db) return;
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction("assets", "readwrite");
        operation(transaction.objectStore("assets"));
        transaction.oncomplete = () => resolve();
        transaction.onabort = transaction.onerror = () =>
          reject(transaction.error);
      });
    } catch {
      /* Persistent caching is optional. */
    }
  }
}
