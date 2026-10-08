import {
  RemoteBpRtcSession,
  waitForSignalingSocket,
  bufferRtcSignal,
  RTC_TIMING,
  type BufferedRtcSignal,
} from "../../../shared/remoteBpRtc";
import {
  CLIENT_MESSAGE_TYPES,
  MAX_REMOTE_BP_MESSAGE_BYTES,
  createEnvelope,
  createMessageId,
  parseHostMessage,
  type ClientMessageType,
  type ClientPayloadMap,
} from "../protocol";
import type { BpAction, PlayerSide } from "../types/bp";
import type {
  ConnectionSnapshot,
  RemoteBpConnectionEvents,
} from "../types/connection";
import type {
  ConnectionEventListener,
  RemoteBpConnectOptions,
  RemoteBpConnectResult,
  RemoteBpConnection,
  Unsubscribe,
} from "./RemoteBpConnection";
import { IncomingAssetTransfers } from "./assets/IncomingAssetTransfers";
import { TypedEventEmitter } from "./TypedEventEmitter";

interface SignalingEnvelope {
  type: string;
  requestId?: string;
  payload: Record<string, unknown>;
}

export interface WebRtcRemoteBpConnectionOptions {
  signalingUrl: string;
  iceServers: RTCIceServer[];
  connectTimeoutMs?: number;
  testOnlyForceRelay?: boolean;
}

const MAX_SIGNALING_MESSAGE_BYTES = 64 * 1024;
const SIGNALING_HEARTBEAT_INTERVAL_MS = 20_000;
const MAX_RECONNECT_DELAY_MS = 15_000;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown, min = 1, max = 256): value is string {
  return (
    typeof value === "string" && value.length >= min && value.length <= max
  );
}

function roleToSide(role: unknown): PlayerSide | null {
  if (role === "FIRST") return "first";
  if (role === "SECOND") return "second";
  return null;
}

function sideToRole(side: PlayerSide): "FIRST" | "SECOND" {
  return side === "first" ? "FIRST" : "SECOND";
}

function createSignalingUrl(baseUrl: string, roomId: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set("roomId", roomId);
  return url.toString();
}

function parseSignalingMessage(raw: string): SignalingEnvelope {
  if (new TextEncoder().encode(raw).byteLength > MAX_SIGNALING_MESSAGE_BYTES) {
    throw new Error("信令消息超过大小限制");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("信令服务器返回了非法 JSON");
  }
  if (
    !isObject(value) ||
    !isString(value.type, 1, 32) ||
    !isObject(value.payload)
  ) {
    throw new Error("信令服务器消息结构无效");
  }
  if (value.requestId !== undefined && !isString(value.requestId, 1, 128)) {
    throw new Error("信令 requestId 无效");
  }
  return {
    type: value.type,
    ...(value.requestId ? { requestId: value.requestId } : {}),
    payload: value.payload,
  };
}

export class WebRtcRemoteBpConnection implements RemoteBpConnection {
  private readonly events = new TypedEventEmitter<RemoteBpConnectionEvents>();
  private readonly incomingAssets = new IncomingAssetTransfers();
  private snapshot: ConnectionSnapshot = {
    state: "idle",
    transport: "unknown",
    latencyMs: null,
    lastPingAt: null,
    reason: null,
  };
  private socket: WebSocket | null = null;
  private rtc: RemoteBpRtcSession | null = null;
  private signalChain: Promise<void> = Promise.resolve();
  private earlySignals: BufferedRtcSignal[] = [];
  private lastSignalAt = Date.now();
  private roomReady = false;
  private hostAvailable = true;
  private lifecycle = 0;
  private get dataChannel(): RTCDataChannel | null {
    return this.rtc?.channel ?? null;
  }
  private confirmed: RemoteBpConnectResult | null = null;
  private requested: RemoteBpConnectOptions | null = null;
  private connectResolve: ((result: RemoteBpConnectResult) => void) | null =
    null;
  private connectReject: ((error: Error) => void) | null = null;
  private connectTimer: number | null = null;
  private pingTimer: number | null = null;
  private signalingHeartbeatTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private roomAckTimer: number | null = null;
  private reconnectAttempt = 0;
  private hasEverConnected = false;
  private terminalState: "kicked" | "room-closed" | null = null;
  private intentionalClose = false;

  constructor(private readonly options: WebRtcRemoteBpConnectionOptions) {}

  getSnapshot(): ConnectionSnapshot {
    return this.snapshot;
  }

  on<K extends keyof RemoteBpConnectionEvents>(
    event: K,
    listener: ConnectionEventListener<RemoteBpConnectionEvents[K]>,
  ): Unsubscribe {
    return this.events.on(event, listener);
  }

  async connect(
    options: RemoteBpConnectOptions,
  ): Promise<RemoteBpConnectResult> {
    this.connectReject?.(new Error("连接已被新的加入请求替换"));
    this.intentionalClose = true;
    this.cleanup(false);
    this.intentionalClose = false;
    this.requested = {
      ...options,
      roomId: options.roomId.trim().toUpperCase(),
    };
    this.confirmed = null;
    this.terminalState = null;
    this.hasEverConnected = false;
    this.reconnectAttempt = 0;
    const lifecycle = this.lifecycle;
    this.hostAvailable = true;
    this.setConnectionState("connecting", "正在连接信令服务器");
    await this.openSignalingSocket().catch((error: unknown) => {
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      if (this.lifecycle === lifecycle) {
        this.intentionalClose = true;
        this.cleanup(false);
        this.setConnectionState("failed", normalized.message);
      }
      throw normalized;
    });

    if (this.lifecycle !== lifecycle || this.intentionalClose)
      throw new Error("加入请求已取消");
    const connected = new Promise<RemoteBpConnectResult>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
      this.connectTimer = window.setTimeout(() => {
        if (this.connectReject === reject) {
          this.fail(new Error("建立点对点连接超过 120 秒总时限"));
        }
      }, RTC_TIMING.totalMs);
    });
    try {
      this.sendJoin();
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
    return connected;
  }

  async disconnect(): Promise<void> {
    this.connectReject?.(new Error("已主动离开房间"));
    this.intentionalClose = true;
    if (this.socket?.readyState === WebSocket.OPEN)
      this.sendSignal("LEAVE_ROOM", {});
    this.cleanup(true);
    this.terminalState = null;
    this.setConnectionState("disconnected", "已主动离开房间");
  }

  async sendAction(action: BpAction): Promise<void> {
    if (!this.confirmed || action.actorSide !== this.confirmed.assignedSide) {
      throw new Error("操作身份与信令服务器确认的身份不一致");
    }
    this.sendData(CLIENT_MESSAGE_TYPES.ACTION_REQUEST, { action });
  }

  async requestState(lastKnownRevision?: number): Promise<void> {
    this.sendData(CLIENT_MESSAGE_TYPES.STATE_REQUEST, {
      ...(lastKnownRevision === undefined ? {} : { lastKnownRevision }),
    });
  }

  async requestAssets(assetIds: string[]): Promise<void> {
    const unique = [...new Set(assetIds)].slice(0, 128);
    if (unique.length === 0) return;
    this.sendData(CLIENT_MESSAGE_TYPES.ASSET_REQUEST, { assetIds: unique });
  }

  private handleSignalingRaw(data: unknown, socket: WebSocket): void {
    this.signalChain = this.signalChain
      .then(async () => {
        if (this.socket !== socket || this.intentionalClose) return;
        if (typeof data !== "string")
          throw new Error("信令服务器返回了非文本消息");
        this.lastSignalAt = Date.now();
        await this.handleSignalingMessage(parseSignalingMessage(data));
      })
      .catch((error: unknown) => {
        if (this.socket !== socket || this.intentionalClose) return;
        console.warn("[Remote BP signaling] message failure", {
          roomId: this.requested?.roomId,
          error: String(error),
        });
        if (!this.confirmed)
          this.fail(error instanceof Error ? error : new Error(String(error)));
      });
  }

  private async handleSignalingMessage(
    message: SignalingEnvelope,
  ): Promise<void> {
    switch (message.type) {
      case "ROOM_JOINED": {
        const roomId = message.payload.roomCode;
        const sessionId = message.payload.sessionId;
        const assignedSide = roleToSide(message.payload.role);
        if (
          !isString(roomId, 6, 6) ||
          !isString(sessionId, 1, 128) ||
          !assignedSide ||
          roomId !== this.requested?.roomId ||
          assignedSide !== this.requested?.side
        ) {
          throw new Error("信令服务器返回的加入结果无效");
        }
        if (this.roomAckTimer !== null) window.clearTimeout(this.roomAckTimer);
        this.roomAckTimer = null;
        this.roomReady = true;
        this.hostAvailable = true;
        const sameSession = this.confirmed?.sessionId === sessionId;
        this.confirmed = { roomId, sessionId, assignedSide };
        if (!sameSession || !this.rtc) this.createPeerConnection();
        this.startSignalingHeartbeat();
        this.sendReady();
        const signals = this.earlySignals;
        this.earlySignals = [];
        for (const signal of signals) {
          if (Date.now() - signal.receivedAt <= RTC_TIMING.signalTtlMs)
            await this.handleSignalingMessage(signal);
        }
        return;
      }
      case "TURN_STATUS": {
        if (!message.payload.turnAuthorizedUntil) this.rtc?.clearTurn("房主 TURN 授权已撤销或到期");
        return;
      }
      case "TURN_CREDENTIALS": {
        if (this.confirmed && this.rtc && message.payload.roomId === this.confirmed.roomId &&
          message.payload.peerId === this.confirmed.sessionId && message.payload.connectionId === this.rtc.connectionId)
          this.rtc.applyTurn(message.payload);
        return;
      }
      case "OFFER":
      case "ICE_CANDIDATE": {
        if (message.payload.fromRole !== "HOST") return;
        if (!this.confirmed || !this.rtc || !this.roomReady) {
          bufferRtcSignal(this.earlySignals, message.type, message.payload);
          console.info("[Remote BP RTC] signal buffered before ROOM_JOINED", {
            roomId: this.requested?.roomId,
            connectionId: message.payload.connectionId,
            type: message.type,
          });
          return;
        }
        if (message.payload.targetSessionId !== this.confirmed.sessionId)
          return;
        await this.rtc.receive(message.type, message.payload);
        return;
      }
      case "ERROR": {
        const code = isString(message.payload.code, 1, 64)
          ? message.payload.code
          : "SIGNALING_ERROR";
        const text = isString(message.payload.message, 1, 512)
          ? message.payload.message
          : "信令服务错误";
        const error = new Error(text);
        if (code.startsWith("TURN_")) {
          this.rtc?.turnFailed(code);
          this.events.emit("error", { code, message: text, recoverable: true });
          return;
        }
        this.events.emit("error", {
          code,
          message: text,
          recoverable: message.payload.recoverable !== false,
        });
        if (code === "KICKED") {
          this.terminate("kicked", "已被房主踢出");
          return;
        }
        if (code === "ROOM_CLOSED" || code === "ROOM_EXPIRED") {
          this.terminate(
            "room-closed",
            code === "ROOM_EXPIRED" ? "房间已失效" : "房间已关闭",
          );
          return;
        }
        if (
          code === "ROOM_NOT_FOUND" &&
          (this.hasEverConnected || this.snapshot.state === "reconnecting")
        ) {
          this.terminate("room-closed", "房间已关闭或不存在");
          return;
        }
        if (code === "PEER_NOT_CONNECTED" || code === "STALE_SIGNAL") {
          // Current negotiation is retained and replayed after HOST_RECONNECTED / readiness.
          return;
        }
        if (
          ["HOST_UNAVAILABLE", "FIRST_OCCUPIED", "SECOND_OCCUPIED"].includes(
            code,
          ) &&
          (code === "HOST_UNAVAILABLE" ||
            this.hasEverConnected ||
            this.snapshot.state === "reconnecting")
        ) {
          this.restartSignaling("房主连接暂时不可用，正在重连");
          return;
        }
        if (this.connectReject) {
          this.connectReject(error);
          this.clearConnectWaiter();
          this.intentionalClose = true;
          this.cleanup(false);
          this.setConnectionState("failed", text);
        }
        return;
      }
      case "HOST_DISCONNECTED":
        this.hostAvailable = false;
        if (this.rtc?.phase !== "connected")
          this.setConnectionState(
            "reconnecting",
            "房主信令连接暂时中断，正在等待恢复",
          );
        return;
      case "HOST_RECONNECTED":
        this.hostAvailable = true;
        this.sendReady();
        this.rtc?.replay();
        return;
      case "HEARTBEAT_ACK":
        return;
      case "ROOM_LEFT":
        return;
      default:
        throw new Error(`未知信令消息：${message.type}`);
    }
  }

  private createPeerConnection(): void {
    this.closePeer();
    if (!this.confirmed) return;
    let rtc: RemoteBpRtcSession | null = null;
    rtc = new RemoteBpRtcSession({
      connectionId: createMessageId(),
      peerId: this.confirmed.sessionId,
      roomId: this.confirmed.roomId,
      offerer: false,
      testOnlyForceRelay: this.options.testOnlyForceRelay,
      iceServers: this.options.iceServers,
      send: (type, payload) => {
        if (
          this.rtc !== rtc ||
          !this.roomReady ||
          !this.hostAvailable ||
          this.socket?.readyState !== WebSocket.OPEN
        )
          return false;
        this.sendSignal(type, { ...payload, targetRole: "HOST" });
        return true;
      },
      onState: (state, reason) => {
        if (!rtc || this.rtc !== rtc) return;
        if (state === "connected") this.onDataChannelReady();
        else if (state === "failed") {
          // A player WebSocket outage releases its server seat and the host closes that
          // old PC. Let the pending JOIN finish instead of cancelling signaling recovery.
          if (
            !this.intentionalClose &&
            this.requested &&
            (!this.roomReady || this.socket?.readyState !== WebSocket.OPEN)
          ) {
            this.closePeer();
            this.ensureRecoveryDeadline();
            this.setConnectionState(
              "reconnecting",
              "正在恢复信令会话和点对点连接",
            );
            this.scheduleReconnect();
          } else this.fail(new Error(reason ?? "点对点连接失败"));
        } else if (state !== "closed")
          this.setConnectionState(
            state === "reconnecting" || this.hasEverConnected
              ? "reconnecting"
              : "connecting",
            reason ??
              (state === "ice-checking"
                ? "正在检查 ICE 网络连通性"
                : "正在建立点对点连接"),
          );
      },
      onMessage: (data) => {
        if (this.rtc === rtc) this.handleDataMessage(data);
      },
    });
    this.rtc = rtc;
    this.setConnectionState(
      this.hasEverConnected ? "reconnecting" : "connecting",
      "房间验证成功，等待房主协商",
    );
  }

  private sendReady(): void {
    if (
      !this.roomReady ||
      !this.hostAvailable ||
      !this.rtc ||
      this.socket?.readyState !== WebSocket.OPEN
    )
      return;
    this.sendSignal("PEER_READY", {
      targetRole: "HOST",
      connectionId: this.rtc.connectionId,
      negotiationId: 0,
    });
  }

  private sendJoin(): void {
    if (!this.requested) return;
    this.roomReady = false;
    this.sendSignal(
      "JOIN_ROOM",
      {
        roomCode: this.requested.roomId,
        side: sideToRole(this.requested.side),
        displayName:
          this.requested.displayName ??
          (this.requested.side === "first" ? "先手网页选手" : "后手网页选手"),
      },
      createMessageId(),
    );
    if (this.roomAckTimer !== null) window.clearTimeout(this.roomAckTimer);
    const socket = this.socket;
    this.roomAckTimer = window.setTimeout(() => {
      if (this.socket === socket && !this.roomReady)
        this.restartSignaling("等待加入确认超时");
    }, this.options.connectTimeoutMs ?? 10_000);
  }

  private onDataChannelReady(): void {
    if (!this.confirmed || this.dataChannel?.readyState !== "open") return;
    const wasReconnecting = this.snapshot.state === "reconnecting";
    if (this.snapshot.state === "connected") return;
    this.reconnectAttempt = 0;
    this.hasEverConnected = true;
    this.setConnectionState("connected", null);
    this.connectResolve?.(this.confirmed);
    this.clearConnectWaiter();
    this.startPing();
    void this.requestState();
    if (wasReconnecting) this.incomingAssets.reset();
  }

  private handleDataMessage(data: unknown): void {
    if (typeof data !== "string") {
      this.events.emit("error", {
        code: "BINARY_NOT_ALLOWED",
        message: "BP 控制通道收到非文本消息",
        recoverable: false,
      });
      return;
    }
    try {
      const message = parseHostMessage(data);
      switch (message.type) {
        case "INITIAL_STATE":
          this.assertRoom(message.payload.state.roomId);
          this.events.emit("bpStateReceived", message.payload.state);
          break;
        case "STATE_UPDATE":
          this.assertRoom(message.payload.state.roomId);
          this.events.emit("bpStateUpdated", message.payload.state);
          break;
        case "ACTION_RESULT":
          this.events.emit("actionResult", message.payload);
          break;
        case "ASSET_MANIFEST":
          this.incomingAssets.setManifest(message.payload.manifest);
          this.events.emit("assetManifestReceived", message.payload.manifest);
          break;
        case "ASSET_START":
          try {
            this.incomingAssets.start(message.payload);
          } catch (error) {
            this.incomingAssets.abort(message.payload.transferId);
            this.emitAssetError(message.payload.asset.assetId, error);
          }
          break;
        case "ASSET_CHUNK":
          try {
            this.incomingAssets.addChunk(message.payload);
          } catch (error) {
            this.incomingAssets.abort(message.payload.transferId);
            this.emitAssetError(message.payload.assetId, error);
          }
          break;
        case "ASSET_COMPLETE":
          void this.incomingAssets
            .complete(message.payload)
            .then((asset) => this.events.emit("assetReceived", asset))
            .catch((error: unknown) =>
              this.emitAssetError(message.payload.assetId, error),
            );
          break;
        case "PONG": {
          const latencyMs = Math.max(
            0,
            Date.now() - Date.parse(message.payload.clientTime),
          );
          this.snapshot = {
            ...this.snapshot,
            latencyMs,
            lastPingAt: new Date().toISOString(),
          };
          this.events.emit("connectionStateChanged", this.snapshot);
          break;
        }
        case "KICKED":
          this.terminate("kicked", message.payload.message);
          break;
        case "ROOM_CLOSED":
          this.terminate("room-closed", message.payload.message);
          break;
        case "ERROR":
          this.events.emit("error", message.payload);
          break;
      }
    } catch (error) {
      this.events.emit("error", {
        code: error instanceof Error ? error.message : "INVALID_HOST_MESSAGE",
        message: "房主返回的网络消息未通过安全校验",
        recoverable: false,
      });
    }
  }

  private sendData<TType extends ClientMessageType>(
    type: TType,
    payload: ClientPayloadMap[TType],
  ): void {
    if (
      this.snapshot.state !== "connected" ||
      this.dataChannel?.readyState !== "open"
    ) {
      throw new Error("远程连接未就绪，当前不能提交操作");
    }
    const raw = JSON.stringify(createEnvelope(type, payload));
    if (
      new TextEncoder().encode(raw).byteLength > MAX_REMOTE_BP_MESSAGE_BYTES
    ) {
      throw new Error("远程 BP 消息超过大小限制");
    }
    this.dataChannel.send(raw);
  }

  private emitAssetError(assetId: string, error: unknown): void {
    this.events.emit("error", {
      code: error instanceof Error ? error.message : "ASSET_TRANSFER_INVALID",
      message: `角色资源 ${assetId} 未通过完整性校验`,
      recoverable: true,
      assetId,
    });
  }

  private sendSignal(
    type: string,
    payload: Record<string, unknown>,
    requestId?: string,
  ): void {
    if (this.socket?.readyState !== WebSocket.OPEN)
      throw new Error("信令服务器尚未连接");
    const raw = JSON.stringify({
      type,
      ...(requestId ? { requestId } : {}),
      payload,
    });
    if (
      new TextEncoder().encode(raw).byteLength > MAX_SIGNALING_MESSAGE_BYTES
    ) {
      throw new Error("信令消息超过大小限制");
    }
    this.socket.send(raw);
  }

  private startPing(): void {
    if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
    const ping = () => {
      if (this.snapshot.state !== "connected") return;
      try {
        this.sendData(CLIENT_MESSAGE_TYPES.PING, {
          clientTime: new Date().toISOString(),
        });
      } catch {
        // Connection state events provide the user-facing failure.
      }
    };
    ping();
    this.pingTimer = window.setInterval(ping, 15_000);
  }

  private assertRoom(roomId: string): void {
    if (!this.confirmed || roomId !== this.confirmed.roomId) {
      throw new Error("ROOM_ID_MISMATCH");
    }
  }

  private handleSocketClose(socket: WebSocket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.roomReady = false;
    this.stopSignalingHeartbeat();
    if (this.intentionalClose || this.terminalState || !this.requested) return;
    if (this.rtc?.phase !== "connected")
      this.setConnectionState("reconnecting", "信令连接中断，正在重连");
    this.scheduleReconnect();
  }

  private ensureRecoveryDeadline(): void {
    if (this.connectTimer !== null) return;
    this.connectTimer = window.setTimeout(() => {
      this.fail(new Error("恢复信令会话和点对点连接超过 120 秒总时限"));
    }, RTC_TIMING.totalMs);
  }

  private fail(error: Error): void {
    this.events.emit("error", {
      code: "CONNECTION_ERROR",
      message: error.message,
      recoverable: false,
    });
    this.connectReject?.(error);
    this.intentionalClose = true;
    this.cleanup(false);
    this.setConnectionState("failed", error.message);
  }

  private setConnectionState(
    state: ConnectionSnapshot["state"],
    reason: string | null,
  ): void {
    this.snapshot = {
      state,
      transport: state === "connected" ? "p2p" : this.snapshot.transport,
      latencyMs: state === "connected" ? this.snapshot.latencyMs : null,
      lastPingAt: state === "connected" ? this.snapshot.lastPingAt : null,
      reason,
    };
    this.events.emit("connectionStateChanged", this.snapshot);
  }

  private clearConnectWaiter(): void {
    if (this.connectTimer !== null) window.clearTimeout(this.connectTimer);
    this.connectTimer = null;
    this.connectResolve = null;
    this.connectReject = null;
  }

  private async openSignalingSocket(): Promise<void> {
    if (!this.requested) throw new Error("缺少房间连接信息");
    const socket = new WebSocket(
      createSignalingUrl(this.options.signalingUrl, this.requested.roomId),
    );
    const previous = this.socket;
    this.socket = socket;
    this.roomReady = false;
    this.signalChain = Promise.resolve();
    previous?.close(4000, "socket replaced");
    socket.addEventListener("message", (event) => {
      if (this.socket === socket) this.handleSignalingRaw(event.data, socket);
    });
    socket.addEventListener("close", () => this.handleSocketClose(socket));
    await waitForSignalingSocket(
      socket,
      this.options.connectTimeoutMs ?? 10_000,
      () => this.socket === socket,
    );
  }

  private scheduleReconnect(): void {
    if (
      this.intentionalClose ||
      this.terminalState ||
      !this.requested ||
      this.reconnectTimer !== null ||
      this.socket !== null
    )
      return;
    const delay = Math.min(
      MAX_RECONNECT_DELAY_MS,
      1_000 * 2 ** this.reconnectAttempt,
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect();
    }, delay);
  }

  private async reconnect(): Promise<void> {
    if (this.intentionalClose || this.terminalState || !this.requested) return;
    const lifecycle = this.lifecycle;
    try {
      await this.openSignalingSocket();
      if (this.lifecycle !== lifecycle || this.intentionalClose) return;
      this.sendJoin();
    } catch {
      if (this.lifecycle === lifecycle) this.scheduleReconnect();
    }
  }

  private restartSignaling(reason: string): void {
    if (this.intentionalClose || this.terminalState || !this.requested) return;
    if (this.rtc?.phase !== "connected")
      this.setConnectionState("reconnecting", reason);
    const socket = this.socket;
    this.socket = null;
    this.roomReady = false;
    this.stopSignalingHeartbeat();
    socket?.close(4000, "reconnect");
    this.scheduleReconnect();
  }

  private terminate(state: "kicked" | "room-closed", reason: string): void {
    if (this.terminalState) return;
    this.terminalState = state;
    this.connectReject?.(new Error(reason));
    this.intentionalClose = true;
    this.cleanup(false);
    this.setConnectionState(state, reason);
  }

  private startSignalingHeartbeat(): void {
    this.stopSignalingHeartbeat();
    const heartbeat = () => {
      if (this.socket?.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastSignalAt > 60_000) {
        this.socket.close(4000, "signaling heartbeat timeout");
        return;
      }
      try {
        this.sendSignal("HEARTBEAT", { sentAt: new Date().toISOString() });
        if (this.rtc?.phase !== "connected") this.sendReady();
      } catch {
        // The close event owns reconnect scheduling.
      }
    };
    heartbeat();
    this.signalingHeartbeatTimer = window.setInterval(
      heartbeat,
      SIGNALING_HEARTBEAT_INTERVAL_MS,
    );
  }

  private stopSignalingHeartbeat(): void {
    if (this.signalingHeartbeatTimer !== null)
      window.clearInterval(this.signalingHeartbeatTimer);
    this.signalingHeartbeatTimer = null;
  }

  private closePeer(): void {
    const rtc = this.rtc;
    this.rtc = null;
    rtc?.close();
  }

  private cleanup(emitPeerState: boolean): void {
    if (this.connectTimer !== null) window.clearTimeout(this.connectTimer);
    if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
    if (this.signalingHeartbeatTimer !== null)
      window.clearInterval(this.signalingHeartbeatTimer);
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    if (this.roomAckTimer !== null) window.clearTimeout(this.roomAckTimer);
    this.connectTimer = null;
    this.pingTimer = null;
    this.signalingHeartbeatTimer = null;
    this.reconnectTimer = null;
    this.roomAckTimer = null;
    this.closePeer();
    this.socket?.close(1000, "client cleanup");
    this.socket = null;
    this.earlySignals = [];
    this.roomReady = false;
    this.lifecycle += 1;
    this.incomingAssets.reset();
    this.confirmed = null;
    this.requested = null;
    this.connectResolve = null;
    this.connectReject = null;
    if (emitPeerState)
      this.events.emit("connectionStateChanged", this.snapshot);
  }
}
