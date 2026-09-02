import { useEffect, useSyncExternalStore } from "react";
import type {
  AssetManagerSnapshot,
  RemoteAssetManager,
} from "../services/assets/RemoteAssetManager";

export function useAssetManagerSnapshot(
  assetManager: RemoteAssetManager,
): AssetManagerSnapshot {
  return useSyncExternalStore(
    (listener) => assetManager.subscribe(listener),
    () => assetManager.getSnapshot(),
    () => assetManager.getSnapshot(),
  );
}

export function useAssetUrl(
  assetManager: RemoteAssetManager,
  assetId: string | null | undefined,
): { url: string | null; state: string } {
  const snapshot = useAssetManagerSnapshot(assetManager);
  const state = assetManager.getState(assetId);
  useEffect(() => {
    if (!assetId || state !== "idle") return;
    void assetManager.request([assetId]);
  }, [assetId, assetManager, snapshot.manifest?.revision, state]);
  return {
    url: assetManager.getUrl(assetId),
    state,
  };
}
