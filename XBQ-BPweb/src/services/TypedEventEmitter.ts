import type {
  ConnectionEventListener,
  Unsubscribe,
} from "./RemoteBpConnection";

export class TypedEventEmitter<TEvents extends object> {
  private readonly listeners: Partial<{
    [K in keyof TEvents]: Set<ConnectionEventListener<TEvents[K]>>;
  }> = {};

  on<K extends keyof TEvents>(
    event: K,
    listener: ConnectionEventListener<TEvents[K]>,
  ): Unsubscribe {
    const existing = this.listeners[event];
    const eventListeners =
      existing ?? new Set<ConnectionEventListener<TEvents[K]>>();
    eventListeners.add(listener);
    this.listeners[event] = eventListeners;

    return () => {
      eventListeners.delete(listener);
    };
  }

  emit<K extends keyof TEvents>(event: K, payload: TEvents[K]): void {
    this.listeners[event]?.forEach((listener) => listener(payload));
  }

  clear(): void {
    (Object.keys(this.listeners) as Array<keyof TEvents>).forEach((event) => {
      this.listeners[event]?.clear();
    });
  }
}
