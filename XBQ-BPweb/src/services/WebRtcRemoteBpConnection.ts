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
}

const MAX_SIGNALING_MESSAGE_BYTES = 64 * 1024;

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

function parseOffer(value: unknown): RTCSessionDescriptionInit {
  if (
    !isObject(value) ||
    value.type !== "offer" ||
    !isString(value.sdp, 1, 48 * 1024)
  ) {
    throw new Error("房主 SDP offer 无效");
  }
  return { type: "offer", sdp: value.sdp };
}

function parseCandidate(value: unknown): RTCIceCandidateInit {
  if (!isObject(value) || !isString(value.candidate, 0, 8 * 1024)) {
    throw new Error("房主 ICE candidate 无效");
  }
  return {
    candidate: value.candidate,
    sdpMid: typeof value.sdpMid === "string" ? value.sdpMid : null,
    sdpMLineIndex: Number.isInteger(value.sdpMLineIndex)
      ? Number(value.sdpMLineIndex)
      : null,
    usernameFragment:
      typeof value.usernameFragment === "string"
        ? value.usernameFragment
        : null,
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
  private peerConnection: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private confirmed: RemoteBpConnectResult | null = null;
  private requested: RemoteBpConnectOptions | null = null;
  private connectResolve: ((result: RemoteBpConnectResult) => void) | null =
    null;
  private connectReject: ((error: Error) => void) | null = null;
  private connectTimer: number | null = null;
  private pingTimer: number | null = null;
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
    this.intentionalClose = true;
    this.cleanup(false);
    this.intentionalClose = false;
    this.requested = {
      ...options,
      roomId: options.roomId.trim().toUpperCase(),
    };
    this.confirmed = null;
    this.setConnectionState("connecting", "正在连接信令服务器");
    const socket = new WebSocket(this.options.signalingUrl);
    this.socket = socket;
    socket.addEventListener("message", (event) =>
      this.handleSignalingRaw(event.data),
    );
    socket.addEventListener("close", () => this.handleSocketClose());

    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(
        () => reject(new Error("连接信令服务器超时")),
        this.options.connectTimeoutMs ?? 10_000,
      );
      socket.addEventListener(
        "open",
        () => {
          window.clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          window.clearTimeout(timer);
          reject(new Error("连接服务器失败"));
        },
        { once: true },
      );
    }).catch((error: unknown) => {
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      this.intentionalClose = true;
      this.cleanup(false);
      this.setConnectionState("failed", normalized.message);
      throw normalized;
    });

    const connected = new Promise<RemoteBpConnectResult>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
      this.connectTimer = window.setTimeout(() => {
        if (this.connectReject === reject) {
          this.connectResolve = null;
          this.connectReject = null;
          this.setConnectionState("failed", "建立 WebRTC DataChannel 超时");
          reject(new Error("建立 WebRTC DataChannel 超时"));
        }
      }, this.options.connectTimeoutMs ?? 20_000);
    });
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
    return connected;
  }

  async disconnect(): Promise<void> {
    this.intentionalClose = true;
    if (this.socket?.readyState === WebSocket.OPEN)
      this.sendSignal("LEAVE_ROOM", {});
    this.cleanup(true);
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

  private handleSignalingRaw(data: unknown): void {
    if (typeof data !== "string") {
      this.fail(new Error("信令服务器返回了非文本消息"));
      return;
    }
    try {
      const message = parseSignalingMessage(data);
      void this.handleSignalingMessage(message).catch((error: unknown) => {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      });
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
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
          !assignedSide
        ) {
          throw new Error("信令服务器返回的加入结果无效");
        }
        this.confirmed = { roomId, sessionId, assignedSide };
        this.createPeerConnection();
        this.setConnectionState(
          "connecting",
          "房间验证成功，正在建立点对点连接",
        );
        return;
      }
      case "OFFER": {
        if (
          message.payload.fromRole !== "HOST" ||
          !this.peerConnection ||
          !this.confirmed
        ) {
          throw new Error("收到未授权的 SDP offer");
        }
        await this.peerConnection.setRemoteDescription(
          parseOffer(message.payload.description),
        );
        for (const candidate of this.pendingCandidates.splice(0)) {
          await this.peerConnection.addIceCandidate(candidate);
        }
        const answer = await this.peerConnection.createAnswer();
        await this.peerConnection.setLocalDescription(answer);
        this.sendSignal("ANSWER", {
          targetRole: "HOST",
          description: { type: answer.type, sdp: answer.sdp ?? "" },
        });
        return;
      }
      case "ICE_CANDIDATE": {
        if (message.payload.fromRole !== "HOST" || !this.peerConnection) {
          throw new Error("收到未授权的 ICE candidate");
        }
        const candidate = parseCandidate(message.payload.candidate);
        if (this.peerConnection.remoteDescription)
          await this.peerConnection.addIceCandidate(candidate);
        else this.pendingCandidates.push(candidate);
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
        this.events.emit("error", {
          code,
          message: text,
          recoverable: message.payload.recoverable !== false,
        });
        if (this.connectReject) {
          this.connectReject(error);
          this.clearConnectWaiter();
          this.setConnectionState("failed", text);
        }
        if (code === "ROOM_CLOSED" || code === "ROOM_EXPIRED") {
          this.setConnectionState("failed", text);
        }
        return;
      }
      case "ROOM_LEFT":
        return;
      default:
        throw new Error(`未知信令消息：${message.type}`);
    }
  }

  private createPeerConnection(): void {
    this.peerConnection?.close();
    const peerConnection = new RTCPeerConnection({
      iceServers: this.options.iceServers,
    });
    this.peerConnection = peerConnection;
    this.pendingCandidates = [];
    peerConnection.addEventListener("datachannel", (event) => {
      if (event.channel.label !== "xqb-remote-bp") {
        event.channel.close();
        return;
      }
      this.installDataChannel(event.channel);
    });
    peerConnection.addEventListener("icecandidate", (event) => {
      if (!event.candidate) return;
      this.sendSignal("ICE_CANDIDATE", {
        targetRole: "HOST",
        candidate: event.candidate.toJSON(),
      });
    });
    peerConnection.addEventListener("connectionstatechange", () => {
      switch (peerConnection.connectionState) {
        case "connected":
          if (this.dataChannel?.readyState === "open")
            this.onDataChannelReady();
          break;
        case "disconnected":
          this.setConnectionState(
            "reconnecting",
            "点对点连接暂时中断，正在恢复",
          );
          break;
        case "failed":
          this.setConnectionState("failed", "WebRTC 连接失败");
          break;
        case "closed":
          if (!this.intentionalClose)
            this.setConnectionState("disconnected", "WebRTC 连接已关闭");
          break;
      }
    });
  }

  private installDataChannel(channel: RTCDataChannel): void {
    this.dataChannel?.close();
    this.dataChannel = channel;
    channel.addEventListener("open", () => this.onDataChannelReady());
    channel.addEventListener("close", () => {
      if (!this.intentionalClose)
        this.setConnectionState("reconnecting", "DataChannel 已断开");
    });
    channel.addEventListener("message", (event) =>
      this.handleDataMessage(event.data),
    );
  }

  private onDataChannelReady(): void {
    if (!this.confirmed || this.dataChannel?.readyState !== "open") return;
    const wasReconnecting = this.snapshot.state === "reconnecting";
    this.setConnectionState("connected", null);
    this.connectResolve?.(this.confirmed);
    this.clearConnectWaiter();
    this.startPing();
    void this.requestState();
    if (wasReconnecting) void this.requestState();
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

  private handleSocketClose(): void {
    if (this.intentionalClose) return;
    if (!this.confirmed) {
      const error = new Error("连接服务器失败");
      this.connectReject?.(error);
      this.clearConnectWaiter();
      this.setConnectionState("failed", error.message);
      return;
    }
    if (this.dataChannel?.readyState !== "open") {
      this.setConnectionState("reconnecting", "信令连接中断");
      window.setTimeout(() => {
        if (!this.intentionalClose && this.dataChannel?.readyState !== "open") {
          this.setConnectionState("failed", "无法恢复远程连接，请重新加入房间");
        }
      }, 3_000);
    }
  }

  private fail(error: Error): void {
    this.events.emit("error", {
      code: "CONNECTION_ERROR",
      message: error.message,
      recoverable: false,
    });
    this.connectReject?.(error);
    this.clearConnectWaiter();
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

  private cleanup(emitPeerState: boolean): void {
    if (this.connectTimer !== null) window.clearTimeout(this.connectTimer);
    if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
    this.connectTimer = null;
    this.pingTimer = null;
    this.dataChannel?.close();
    this.peerConnection?.close();
    this.socket?.close(1000, "client cleanup");
    this.dataChannel = null;
    this.peerConnection = null;
    this.socket = null;
    this.pendingCandidates = [];
    this.incomingAssets.reset();
    this.confirmed = null;
    this.requested = null;
    this.connectResolve = null;
    this.connectReject = null;
    if (emitPeerState)
      this.events.emit("connectionStateChanged", this.snapshot);
  }
}
