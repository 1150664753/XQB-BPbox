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
import {
  REMOTE_BP_CAPABILITIES,
  StateDeltaReceiver,
  decodeBinaryAssetChunk,
} from "../../../shared/remoteBpWire";
import type {
  ActionTiming,
  PreviewTiming,
} from "../../../shared/remoteBpDiagnostics";

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
  private roomForceRelay = false;
  private turnProvider: unknown;
  private hostAvailable = true;
  private lifecycle = 0;
  private get dataChannel(): RTCDataChannel | null {
    return this.rtc?.channel ?? null;
  }
  private confirmed: RemoteBpConnectResult | null = null;
  private assetEpoch = 0;
  private assetStreamTransfers = new Map<string, string>();
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
  private actionStartedAt = new Map<
    string,
    { at: number; kind: string; revision?: number; stateRecorded?: boolean }
  >();
  private lastStateArrival: { revision: number; at: number } | null = null;
  private stateDelta = new StateDeltaReceiver();
  private stateResyncPending = false;

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
    const startedAt = performance.now();
    this.actionStartedAt.set(action.actionId, {
      at: startedAt,
      kind: action.kind,
    });
    this.rtc?.recordActionTiming(action.actionId, action.kind, {
      sendBufferedBytes: this.dataChannel?.bufferedAmount ?? 0,
    });
    this.sendData(CLIENT_MESSAGE_TYPES.ACTION_REQUEST, { action });
    while (this.actionStartedAt.size > 100)
      this.actionStartedAt.delete(this.actionStartedAt.keys().next().value!);
  }

  recordActionTiming(
    id: string,
    kind: string,
    fields: Partial<ActionTiming>,
  ): void {
    this.rtc?.recordActionTiming(id, kind, fields);
  }
  recordActionStage(id: string, stage: "stateApplyMs" | "uiCommitMs"): void {
    const action = this.actionStartedAt.get(id);
    if (action)
      this.rtc?.recordActionTiming(id, action.kind, {
        [stage]: performance.now() - action.at,
      });
  }
  recordPreview(value: PreviewTiming): void {
    this.rtc?.recordPreview(value);
  }
  private recordStateArrival(revision: number): void {
    this.lastStateArrival = { revision, at: performance.now() };
    for (const [id, action] of this.actionStartedAt) {
      if (
        action.stateRecorded ||
        action.revision === undefined ||
        revision < action.revision
      )
        continue;
      action.stateRecorded = true;
      this.rtc?.recordActionTiming(id, action.kind, {
        stateReturnedMs: this.lastStateArrival.at - action.at,
      });
    }
  }

  async requestState(lastKnownRevision?: number): Promise<void> {
    this.sendData(CLIENT_MESSAGE_TYPES.STATE_REQUEST, {
      capabilities: REMOTE_BP_CAPABILITIES,
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
          error: "SIGNALING_MESSAGE_FAILED",
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
        this.roomForceRelay = message.payload.forceRelay === true;
        this.turnProvider = message.payload.turnDiagnostic;
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
        if (!message.payload.turnAuthorizedUntil)
          this.rtc?.clearTurn("房主 TURN 授权已撤销或到期");
        return;
      }
      case "TURN_CREDENTIALS": {
        if (
          this.confirmed &&
          this.rtc &&
          message.payload.roomId === this.confirmed.roomId &&
          message.payload.peerId === this.confirmed.sessionId &&
          message.payload.connectionId === this.rtc.connectionId
        ) {
          try {
            this.rtc.applyTurn(message.payload);
          } catch {
            this.rtc.turnFailed(
              "TURN_PROVIDER_INVALID",
              message.payload.turnDiagnostic,
            );
          }
        }
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
        // The RTC queue owns SDP/candidate ordering. Do not block credential
        // installation or signaling heartbeat behind slow native SDP operations.
        void this.rtc.receive(message.type, message.payload);
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
          if (
            message.payload.connectionId &&
            message.payload.connectionId !== this.rtc?.connectionId
          )
            return;
          this.rtc?.turnFailed(code, message.payload.turnDiagnostic);
          this.events.emit("error", {
            code,
            message: text,
            recoverable: true,
          });
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
    this.closePeer("peer-replaced");
    if (!this.confirmed) return;
    let rtc: RemoteBpRtcSession | null = null;
    rtc = new RemoteBpRtcSession({
      connectionId: createMessageId(),
      peerId: this.confirmed.sessionId,
      roomId: this.confirmed.roomId,
      offerer: false,
      testOnlyForceRelay: Boolean(
        this.options.testOnlyForceRelay || this.roomForceRelay,
      ),
      turnProvider: this.turnProvider,
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
            this.closePeer("signaling-recovery");
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
      onDiagnostics: (diagnostic) => {
        if (this.rtc !== rtc) return;
        const transport = diagnostic.pair
          ? diagnostic.relay
            ? "turn-relay"
            : "p2p"
          : "unknown";
        if (this.snapshot.transport !== transport) {
          this.snapshot = { ...this.snapshot, transport };
          this.events.emit("connectionStateChanged", this.snapshot);
        }
      },
      onAssetChannelClosed: () => {
        for (const [transferId, assetId] of this.assetStreamTransfers) {
          this.incomingAssets.abort(transferId);
          rtc?.finishTransfer(
            transferId,
            "failed",
            "ASSET_NETWORK_INTERRUPTED",
          );
          this.emitAssetError(assetId, new Error("ASSET_CHANNEL_CLOSED"));
        }
        this.assetStreamTransfers.clear();
      },
      onMessage: (data, stream) => {
        if (this.rtc === rtc) this.handleDataMessage(data, stream);
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
      forceRelay: this.rtc.getDiagnostic().forceRelay,
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
    if (this.snapshot.state === "connected") return;
    this.reconnectAttempt = 0;
    this.hasEverConnected = true;
    this.setConnectionState("connected", null);
    this.connectResolve?.(this.confirmed);
    this.clearConnectWaiter();
    this.startPing();
    void this.requestState();
  }

  private handleDataMessage(data: unknown, stream = "control"): void {
    if (stream === "assets" && data instanceof ArrayBuffer) {
      try {
        const chunk = decodeBinaryAssetChunk(data);
        try {
          if (this.assetStreamTransfers.get(chunk.transferId) !== chunk.assetId)
            throw new Error("ASSET_TRANSFER_NOT_FOUND");
          this.incomingAssets.addBinaryChunk(chunk);
          this.rtc?.advanceTransfer(chunk.transferId, chunk.bytes.byteLength);
          this.rtc?.recordTransferWireBytes(chunk.transferId, data.byteLength);
          this.rtc?.recordTransferEncoding(chunk.transferId, "binary-v1");
        } catch (error) {
          this.assetStreamTransfers.delete(chunk.transferId);
          this.incomingAssets.abort(chunk.transferId);
          this.emitAssetError(chunk.assetId, error, chunk.transferId);
        }
      } catch {
        this.rtc?.recordError("INVALID_ASSET_BINARY", "资源二进制帧无效");
      }
      return;
    }
    if (typeof data !== "string") {
      this.events.emit("error", {
        code: "BINARY_NOT_ALLOWED",
        message: "BP 控制通道收到非文本消息",
        recoverable: false,
      });
      return;
    }
    try {
      if (
        new TextEncoder().encode(data).byteLength > MAX_REMOTE_BP_MESSAGE_BYTES
      )
        throw new Error("MESSAGE_TOO_LARGE");
      const wire = JSON.parse(data);
      let sequence: unknown = wire?.payload?.stateSequence;
      if (wire?.type === "STATE_DELTA_V1") {
        if (stream !== "control") throw new Error("UNEXPECTED_ASSET_MESSAGE");
        if (this.stateResyncPending) return;
        try {
          const state = this.stateDelta.expand(wire.payload);
          sequence = wire.payload.sequence;
          data = JSON.stringify({
            ...wire,
            type: "STATE_UPDATE",
            payload: { state },
          });
        } catch (error) {
          this.stateResyncPending = true;
          this.rtc?.recordError(
            "STATE_DELTA_RESYNC",
            "增量基线无效，正在请求完整状态",
          );
          void this.requestState().catch(() => {
            this.stateResyncPending = false;
          });
          return;
        }
      }
      const message = parseHostMessage(data as string);
      if (
        stream === "assets" &&
        !["ASSET_START", "ASSET_CHUNK", "ASSET_COMPLETE"].includes(message.type)
      )
        throw new Error("UNEXPECTED_ASSET_MESSAGE");
      switch (message.type) {
        case "INITIAL_STATE":
          this.assertRoom(message.payload.state.roomId);
          this.stateDelta.commit(message.payload.state, sequence);
          this.stateResyncPending = false;
          this.recordStateArrival(message.payload.state.revision);
          this.events.emit("bpStateReceived", message.payload.state);
          break;
        case "STATE_UPDATE":
          this.assertRoom(message.payload.state.roomId);
          this.stateDelta.commit(message.payload.state, sequence);
          this.recordStateArrival(message.payload.state.revision);
          this.events.emit("bpStateUpdated", message.payload.state);
          break;
        case "ACTION_RESULT":
          {
            const started = this.actionStartedAt.get(message.payload.actionId);
            if (started !== undefined) {
              const responseMs = performance.now() - started.at;
              const hostMs = message.payload.hostProcessingMs;
              this.rtc?.recordActionResponse(responseMs);
              this.rtc?.recordActionTiming(
                message.payload.actionId,
                started.kind,
                {
                  responseMs,
                  ...(typeof hostMs === "number" &&
                  Number.isFinite(hostMs) &&
                  hostMs >= 0
                    ? {
                        hostProcessingMs: hostMs,
                        networkAndQueueMs: Math.max(0, responseMs - hostMs),
                      }
                    : {}),
                },
              );
              if (message.payload.accepted) {
                started.revision = message.payload.resultingRevision;
                if (
                  this.lastStateArrival &&
                  this.lastStateArrival.revision >= started.revision
                ) {
                  started.stateRecorded = true;
                  this.rtc?.recordActionTiming(
                    message.payload.actionId,
                    started.kind,
                    {
                      stateReturnedMs: Math.max(
                        0,
                        this.lastStateArrival.at - started.at,
                      ),
                    },
                  );
                }
              }
            }
          }
          this.events.emit("actionResult", message.payload);
          break;
        case "ASSET_MANIFEST":
          this.incomingAssets.setManifest(message.payload.manifest);
          this.events.emit("assetManifestReceived", message.payload.manifest);
          break;
        case "ASSET_START":
          this.rtc?.beginTransfer(
            message.payload.transferId,
            "receive",
            message.payload.asset.size,
          );
          try {
            this.incomingAssets.start(message.payload);
            this.rtc?.recordTransferWireBytes(
              message.payload.transferId,
              new TextEncoder().encode(data as string).byteLength,
            );
            if (stream === "assets")
              this.assetStreamTransfers.set(
                message.payload.transferId,
                message.payload.asset.assetId,
              );
          } catch (error) {
            this.assetStreamTransfers.delete(message.payload.transferId);
            this.incomingAssets.abort(message.payload.transferId);
            this.emitAssetError(
              message.payload.asset.assetId,
              error,
              message.payload.transferId,
            );
          }
          break;
        case "ASSET_CHUNK":
          try {
            this.incomingAssets.addChunk(message.payload);
            this.rtc?.recordTransferEncoding(
              message.payload.transferId,
              "base64-json",
            );
            this.rtc?.recordTransferWireBytes(
              message.payload.transferId,
              new TextEncoder().encode(data as string).byteLength,
            );
            this.rtc?.advanceTransfer(
              message.payload.transferId,
              Math.floor((message.payload.data.length * 3) / 4) -
                (message.payload.data.endsWith("==")
                  ? 2
                  : message.payload.data.endsWith("=")
                    ? 1
                    : 0),
            );
          } catch (error) {
            this.assetStreamTransfers.delete(message.payload.transferId);
            this.incomingAssets.abort(message.payload.transferId);
            this.emitAssetError(
              message.payload.assetId,
              error,
              message.payload.transferId,
            );
          }
          break;
        case "ASSET_COMPLETE":
          this.rtc?.recordTransferWireBytes(
            message.payload.transferId,
            new TextEncoder().encode(data as string).byteLength,
          );
          this.assetStreamTransfers.delete(message.payload.transferId);
          {
            const epoch = this.assetEpoch;
            void this.incomingAssets
              .complete(message.payload, () => {
                if (epoch === this.assetEpoch)
                  this.rtc?.finishTransfer(
                    message.payload.transferId,
                    "received",
                  );
              })
              .then((asset) => {
                if (epoch === this.assetEpoch) {
                  this.rtc?.finishTransfer(
                    message.payload.transferId,
                    "verified",
                  );
                  this.events.emit("assetReceived", asset);
                }
              })
              .catch((error: unknown) => {
                if (epoch === this.assetEpoch)
                  this.emitAssetError(
                    message.payload.assetId,
                    error,
                    message.payload.transferId,
                  );
              });
          }
          break;
        case "PONG": {
          const latencyMs = Math.max(
            0,
            Date.now() - Date.parse(message.payload.clientTime),
          );
          this.rtc?.recordApplicationPing(latencyMs);
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
    this.rtc?.recordControlMessage(
      type,
      new TextEncoder().encode(raw).byteLength,
      this.dataChannel.bufferedAmount,
    );
    if (type === CLIENT_MESSAGE_TYPES.ACTION_REQUEST) {
      const { action } = payload as ClientPayloadMap["ACTION_REQUEST"];
      this.rtc?.recordActionTiming(action.actionId, action.kind, {
        requestBytes: new TextEncoder().encode(raw).byteLength,
      });
    }
  }

  private emitAssetError(
    assetId: string,
    error: unknown,
    transferId?: string,
  ): void {
    const code =
      error instanceof Error && /^[A-Z0-9_]{1,64}$/.test(error.message)
        ? error.message
        : "ASSET_RECEIVE_FAILED";
    if (transferId) this.rtc?.finishTransfer(transferId, "failed", code);
    this.rtc?.recordError(code, "资源接收失败或校验未通过");
    this.events.emit("error", {
      code,
      message: `资源 ${assetId} 接收失败：${code}`,
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
      for (const { transferId, assetId } of this.incomingAssets.expireIdle()) {
        this.assetStreamTransfers.delete(transferId);
        this.emitAssetError(
          assetId,
          new Error("ASSET_RECEIVE_TIMEOUT"),
          transferId,
        );
      }
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
    this.pingTimer = window.setInterval(ping, 5_000);
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
      transport: this.rtc?.getDiagnostic().pair
        ? this.rtc.getDiagnostic().relay
          ? "turn-relay"
          : "p2p"
        : "unknown",
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

  private closePeer(initiator = "client-cleanup"): void {
    this.assetEpoch += 1;
    this.assetStreamTransfers.clear();
    this.incomingAssets.reset();
    this.events.emit("assetTransfersReset", undefined);
    const rtc = this.rtc;
    this.rtc = null;
    this.actionStartedAt.clear();
    this.lastStateArrival = null;
    this.stateDelta = new StateDeltaReceiver();
    this.stateResyncPending = false;
    rtc?.close(
      this.intentionalClose ? "ASSET_CANCELLED" : "ASSET_NETWORK_INTERRUPTED",
      this.intentionalClose ? "client-intentional-cleanup" : initiator,
    );
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
