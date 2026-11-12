import {
  SAKURA_WIRE_VERSION,
  SAKURA_HEARTBEAT_MS,
  SAKURA_TIMEOUT_MS,
  type SakuraInvitation,
} from "../../../shared/sakuraBp";
import {
  createEnvelope,
  parseHostMessage,
  PROTOCOL_VERSION,
  MAX_REMOTE_BP_MESSAGE_BYTES,
  type ClientMessageType,
  type ClientPayloadMap,
} from "../protocol";
import type { BpAction } from "../types/bp";
import type {
  ConnectionSnapshot,
  RemoteBpConnectionEvents,
} from "../types/connection";
import type {
  RemoteBpConnection,
  RemoteBpConnectOptions,
  RemoteBpConnectResult,
} from "./RemoteBpConnection";
import { TypedEventEmitter } from "./TypedEventEmitter";
import { IncomingAssetTransfers } from "./assets/IncomingAssetTransfers";

const errors: Record<string, string> = {
  AUTH_FAILED: "邀请或席位凭证已失效，请重新获取邀请",
  ROOM_NOT_FOUND: "房间不存在或已被关闭",
  SEAT_OCCUPIED: "该席位已被占用，请选择另一侧或请房主释放席位",
  UNSUPPORTED_PROTOCOL_VERSION:
    "网页与 BPbox 协议不兼容，请刷新网页或更新 BPbox",
  INVALID_SIDE: "选手身份校验失败",
  RATE_LIMITED: "请求过于频繁",
};
export class SakuraRemoteBpConnection implements RemoteBpConnection {
  private readonly events = new TypedEventEmitter<RemoteBpConnectionEvents>();
  private assets = new IncomingAssetTransfers();
  private snapshot: ConnectionSnapshot = {
    state: "idle",
    transport: "sakura",
    reason: null,
  };
  private control: WebSocket | null = null;
  private assetSocket: WebSocket | null = null;
  private requested: RemoteBpConnectOptions | null = null;
  private confirmed: RemoteBpConnectResult | null = null;
  private resumeToken: string | null = null;
  private stopped = true;
  private generation = 0;
  private retries = 0;
  private lastSeen = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private resolve: ((value: RemoteBpConnectResult) => void) | null = null;
  private reject: ((error: Error) => void) | null = null;

  constructor(
    private readonly invitation: SakuraInvitation | null,
    private readonly entryError: string | null = null,
  ) {}
  getSnapshot(): ConnectionSnapshot {
    return this.snapshot;
  }
  on<K extends keyof RemoteBpConnectionEvents>(
    event: K,
    listener: (value: RemoteBpConnectionEvents[K]) => void,
  ): () => void {
    return this.events.on(event, listener);
  }
  private state(
    state: ConnectionSnapshot["state"],
    reason: string | null,
  ): void {
    this.snapshot = { state, transport: "sakura", reason };
    this.events.emit("connectionStateChanged", this.snapshot);
  }
  private key(): string {
    return `xqb:sakura:seat:${this.invitation?.endpoint}:${this.invitation?.roomId}:${this.requested?.side}`;
  }
  async connect(
    options: RemoteBpConnectOptions,
  ): Promise<RemoteBpConnectResult> {
    await this.disconnect();
    if (!this.invitation || this.entryError)
      throw new Error(this.entryError ?? "缺少樱花邀请");
    if (options.roomId !== this.invitation.roomId)
      throw new Error("请使用邀请中指定的房间");
    this.requested = options;
    this.confirmed = null;
    this.resumeToken = null;
    try {
      this.resumeToken = sessionStorage.getItem(this.key());
    } catch {
      /* Optional storage. */
    }
    this.stopped = false;
    this.retries = 0;
    this.state("connecting", "正在通过樱花连接房主");
    const result = new Promise<RemoteBpConnectResult>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      this.connectTimer = setTimeout(
        () => this.terminal("failed", "连接超时，请检查邀请地址和房主隧道"),
        60_000,
      );
    });
    this.open();
    return result;
  }
  async disconnect(): Promise<void> {
    if (this.control?.readyState === WebSocket.OPEN && this.confirmed) {
      this.control.send(JSON.stringify({ type: "SAKURA_LEAVE" }));
      try {
        sessionStorage.removeItem(this.key());
      } catch {
        /* Optional storage. */
      }
    }
    this.stopped = true;
    this.cleanup();
    this.finish(new Error("已离开房间"));
    this.state("disconnected", "已离开房间");
  }
  async sendAction(action: BpAction): Promise<void> {
    if (action.actorSide !== this.confirmed?.assignedSide)
      throw new Error("操作身份不匹配");
    this.send("ACTION_REQUEST", { action });
  }
  async requestState(lastKnownRevision?: number): Promise<void> {
    this.send("STATE_REQUEST", { lastKnownRevision });
  }
  async requestAssets(assetIds: string[]): Promise<void> {
    const ids = [...new Set(assetIds)].slice(0, 128);
    if (ids.length) this.send("ASSET_REQUEST", { assetIds: ids });
  }
  private send<T extends ClientMessageType>(
    type: T,
    payload: ClientPayloadMap[T],
  ): void {
    if (
      this.snapshot.state !== "connected" ||
      this.control?.readyState !== WebSocket.OPEN
    )
      throw new Error("连接未就绪，请等待状态恢复");
    if (this.control.bufferedAmount > 64 * 1024)
      throw new Error("网络拥塞，请稍后重试");
    this.control.send(JSON.stringify(createEnvelope(type, payload)));
  }
  private open(): void {
    if (this.stopped || !this.invitation || !this.requested) return;
    this.cleanupSockets();
    const generation = this.generation;
    const ws = new WebSocket(this.invitation.endpoint);
    this.control = ws;
    const current = (): boolean =>
      !this.stopped && this.control === ws && this.generation === generation;
    this.handshakeTimer = setTimeout(() => {
      if (current()) this.reconnect();
    }, 15_000);
    ws.onopen = () => {
      if (!current()) return;
      ws.send(
        JSON.stringify({
          type: "SAKURA_JOIN",
          version: SAKURA_WIRE_VERSION,
          protocolVersion: PROTOCOL_VERSION,
          roomId: this.invitation!.roomId,
          credential: this.invitation!.credential,
          side: this.requested!.side,
          displayName: this.requested!.displayName ?? "选手",
          resumeToken: this.resumeToken,
        }),
      );
    };
    ws.onerror = () => {
      /* onclose schedules a bounded-backoff retry. */
    };
    ws.onclose = (event) => {
      if (!current()) return;
      if (event.code === 4004) this.terminal("room-closed", "房间已关闭");
      else if (event.code === 4003)
        this.terminal("failed", errors[event.reason] ?? "房主拒绝了连接");
      else this.reconnect();
    };
    ws.onmessage = (event) => {
      if (!current()) return;
      try {
        const message = this.parse(event.data);
        this.lastSeen = Date.now();
        if (message.type === "SAKURA_ERROR") {
          this.terminal("failed", errors[String(message.code)] ?? "连接认证失败");
          return;
        }
        if (message.type === "SAKURA_JOINED") {
          if (this.confirmed && this.assetSocket) throw new Error("重复握手");
          if (
            message.version !== SAKURA_WIRE_VERSION ||
            message.protocolVersion !== PROTOCOL_VERSION ||
            message.roomId !== this.invitation!.roomId ||
            typeof message.roomId !== "string" ||
            (message.side !== "first" && message.side !== "second") ||
            message.side !== this.requested!.side ||
            typeof message.peerId !== "string" ||
            message.peerId.length > 128 ||
            typeof message.resumeToken !== "string" ||
            !/^[A-Za-z0-9_-]{43}$/.test(message.resumeToken)
          )
            throw new Error("握手版本或身份无效");
          this.confirmed = {
            roomId: message.roomId,
            sessionId: message.peerId,
            assignedSide: message.side,
          };
          this.resumeToken = message.resumeToken;
          try {
            sessionStorage.setItem(this.key(), message.resumeToken);
          } catch {
            /* Memory-only resume still works. */
          }
          this.openAssets(generation);
          return;
        }
        this.handleBusiness(event.data, false, generation);
      } catch {
        this.terminal("failed", "房主消息格式或协议版本不兼容");
      }
    };
  }
  private parse(data: unknown): Record<string, unknown> {
    if (
      typeof data !== "string" ||
      new TextEncoder().encode(data).byteLength > MAX_REMOTE_BP_MESSAGE_BYTES
    )
      throw new Error("消息超过限制");
    const value = JSON.parse(data);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("消息无效");
    return value;
  }
  private openAssets(generation: number): void {
    const url = new URL(this.invitation!.endpoint);
    url.pathname = "/assets";
    const ws = new WebSocket(url);
    this.assetSocket = ws;
    const current = (): boolean =>
      this.generation === generation &&
      this.assetSocket === ws &&
      !this.stopped;
    ws.onopen = () => {
      if (current())
        ws.send(
          JSON.stringify({
            type: "SAKURA_ASSETS",
            version: SAKURA_WIRE_VERSION,
            protocolVersion: PROTOCOL_VERSION,
            roomId: this.invitation!.roomId,
            peerId: this.confirmed!.sessionId,
            resumeToken: this.resumeToken,
          }),
        );
    };
    ws.onerror = () => {
      /* Control and asset streams recover together. */
    };
    ws.onclose = () => {
      if (current()) this.reconnect();
    };
    ws.onmessage = (event) => {
      if (!current()) return;
      try {
        const message = this.parse(event.data);
        if (
          message.type === "SAKURA_ASSETS_READY" &&
          message.version === SAKURA_WIRE_VERSION
        ) {
          this.control?.send(JSON.stringify({ type: "SAKURA_READY" }));
          return;
        }
        if (message.type === "SAKURA_ERROR") {
          this.terminal("failed", "资源通道认证失败");
          return;
        }
        this.handleBusiness(event.data, true, generation);
      } catch {
        this.terminal("failed", "资源通道消息格式无效");
      }
    };
  }
  private handleBusiness(
    raw: string,
    assetStream: boolean,
    generation: number,
  ): void {
    const message = parseHostMessage(raw);
    if (
      assetStream &&
      !["ASSET_START", "ASSET_CHUNK", "ASSET_COMPLETE", "ROOM_CLOSED"].includes(
        message.type,
      )
    )
      throw new Error("错误的资源通道消息");
    switch (message.type) {
      case "INITIAL_STATE":
      case "STATE_UPDATE":
        if (
          !this.confirmed ||
          message.payload.state.roomId !== this.confirmed.roomId
        )
          throw new Error("房间不匹配");
        // Connected means authenticated and a complete authoritative BP snapshot was received.
        if (this.snapshot.state !== "connected") {
          this.retries = 0;
          if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
          this.handshakeTimer = null;
          this.state("connected", null);
          this.finish();
          this.startHeartbeat();
        }
        this.events.emit(
          message.type === "INITIAL_STATE"
            ? "bpStateReceived"
            : "bpStateUpdated",
          message.payload.state,
        );
        break;
      case "ACTION_RESULT":
        this.events.emit("actionResult", message.payload);
        break;
      case "ASSET_MANIFEST":
        this.assets.setManifest(message.payload.manifest);
        this.events.emit("assetManifestReceived", message.payload.manifest);
        break;
      case "ASSET_START":
        this.assets.start(message.payload);
        break;
      case "ASSET_CHUNK":
        this.assets.addChunk(message.payload);
        break;
      case "ASSET_COMPLETE":
        void this.assets
          .complete(message.payload)
          .then((asset) => {
            if (this.generation === generation)
              this.events.emit("assetReceived", asset);
          })
          .catch(() => {
            if (this.generation === generation)
              this.events.emit("error", {
                code: "ASSET_VERIFY_FAILED",
                message: "图片校验失败，请重试",
                recoverable: true,
                assetId: message.payload.assetId,
              });
          });
        break;
      case "ERROR":
        this.events.emit("error", message.payload);
        break;
      case "KICKED":
        this.terminal("kicked", message.payload.message);
        break;
      case "ROOM_CLOSED":
        this.terminal("room-closed", message.payload.message);
        break;
      case "PONG":
        break;
    }
  }
  private startHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastSeen > SAKURA_TIMEOUT_MS) {
        this.reconnect();
        return;
      }
      try {
        this.send("PING", { clientTime: new Date().toISOString() });
      } catch {
        this.reconnect();
      }
      for (const expired of this.assets.expireIdle())
        this.events.emit("error", {
          code: "ASSET_RECEIVE_TIMEOUT",
          message: "图片接收超时",
          recoverable: true,
          assetId: expired.assetId,
        });
    }, SAKURA_HEARTBEAT_MS);
  }
  private reconnect(): void {
    if (this.stopped || this.retryTimer) return;
    this.cleanupSockets();
    this.state("reconnecting", "连接中断，正在恢复席位和完整 BP 状态");
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = null;
        this.open();
      },
      Math.min(10_000, 500 * 2 ** Math.min(this.retries++, 5)) +
        Math.random() * 250,
    );
  }
  private terminal(
    state: "failed" | "kicked" | "room-closed",
    reason: string,
  ): void {
    this.stopped = true;
    this.cleanup();
    if (state !== "failed")
      try {
        sessionStorage.removeItem(this.key());
      } catch {
        /* Optional storage. */
      }
    this.finish(new Error(reason));
    this.state(state, reason);
    this.events.emit("error", {
      code: "SAKURA_CONNECTION_ENDED",
      message: reason,
      recoverable: false,
    });
  }
  private finish(error?: Error): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
    if (error) this.reject?.(error);
    else if (this.confirmed) this.resolve?.(this.confirmed);
    this.reject = null;
    this.resolve = null;
  }
  private cleanupSockets(): void {
    this.generation++;
    for (const socket of [this.control, this.assetSocket]) {
      if (!socket) continue;
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      socket.close();
    }
    this.control = this.assetSocket = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.heartbeat = this.handshakeTimer = null;
    this.assets = new IncomingAssetTransfers();
    this.events.emit("assetTransfersReset", undefined);
  }
  private cleanup(): void {
    this.cleanupSockets();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}
