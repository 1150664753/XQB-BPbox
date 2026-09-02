import { useSyncExternalStore } from "react";
import type { RemoteBpSessionStore } from "../stores/RemoteBpSessionStore";

export function useRemoteBpSession(store: RemoteBpSessionStore) {
  return useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.getSnapshot(),
    () => store.getSnapshot(),
  );
}
