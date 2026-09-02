import { DurableObject } from "cloudflare:workers";

const MAX_SIGNALING_MESSAGE_BYTES = 64 * 1024;

const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_ROOM_CONNECTIONS = 3;
const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_CODE_PATTERN = /^[A-Z2-9]{6}$/;
const CLIENT_MESSAGE_TYPES = new Set([
  "CREATE_ROOM",
  "JOIN_ROOM",
  "LEAVE_ROOM",
  "OFFER",
  "ANSWER",
  "ICE_CANDIDATE",
]);
const PLAYER_ROLES = new Set(["FIRST", "SECOND"]);
const ALL_ROLES = new Set(["HOST", "FIRST", "SECOND"]);

type SignalingRole = "HOST" | "FIRST" | "SECOND";
type ConnectionMode = "CREATE" | "JOIN";

interface SessionDescription {
  type: "offer" | "answer";
  sdp: string;
}

interface IceCandidate {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment: string | null;
}

interface ConnectionAttachment {
  roomCode: string;
  mode: ConnectionMode;
  role: SignalingRole | null;
  sessionId: string | null;
  displayName: string | null;
  joinedAt: number | null;
  createdAt: number | null;
  expiresAt: number | null;
}

interface SignalingMessage {
  type: string;
  requestId?: string;
  payload: Record<string, unknown>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

function normalizeRoomCode(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function createRoomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes]
    .map((byte) => ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length])
    .join("");
}

function parseDescription(
  value: unknown,
  expectedType: "offer" | "answer",
): SessionDescription | null {
  if (
    !isObject(value) ||
    value.type !== expectedType ||
    !isString(value.sdp, 1, 48 * 1024)
  ) {
    return null;
  }
  return { type: expectedType, sdp: value.sdp };
}

function parseCandidate(value: unknown): IceCandidate | null {
  if (!isObject(value) || !isString(value.candidate, 0, 8 * 1024)) return null;
  if (
    value.sdpMid !== null &&
    value.sdpMid !== undefined &&
    !isString(value.sdpMid, 0, 256)
  ) {
    return null;
  }
  if (
    value.sdpMLineIndex !== null &&
    value.sdpMLineIndex !== undefined &&
    (!Number.isInteger(value.sdpMLineIndex) ||
      Number(value.sdpMLineIndex) < 0 ||
      Number(value.sdpMLineIndex) > 1024)
  ) {
    return null;
  }
  if (
    value.usernameFragment !== null &&
    value.usernameFragment !== undefined &&
    !isString(value.usernameFragment, 0, 512)
  ) {
    return null;
  }
  return {
    candidate: value.candidate,
    sdpMid: (value.sdpMid as string | null | undefined) ?? null,
    sdpMLineIndex: (value.sdpMLineIndex as number | null | undefined) ?? null,
    usernameFragment:
      (value.usernameFragment as string | null | undefined) ?? null,
  };
}

function parseClientMessage(raw: string): SignalingMessage {
  if (new TextEncoder().encode(raw).byteLength > MAX_SIGNALING_MESSAGE_BYTES) {
    throw new Error("MESSAGE_TOO_LARGE");
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("INVALID_JSON");
  }
  if (
    !isObject(value) ||
    !isString(value.type, 1, 32) ||
    !CLIENT_MESSAGE_TYPES.has(value.type)
  ) {
    throw new Error("UNKNOWN_MESSAGE_TYPE");
  }
  if (value.requestId !== undefined && !isString(value.requestId, 1, 128)) {
    throw new Error("INVALID_REQUEST_ID");
  }
  if (!isObject(value.payload)) throw new Error("INVALID_PAYLOAD");

  const payload = value.payload;
  switch (value.type) {
    case "CREATE_ROOM":
      if (payload.displayName !== undefined && !isString(payload.displayName, 1, 64)) {
        throw new Error("INVALID_DISPLAY_NAME");
      }
      return {
        type: value.type,
        ...(value.requestId ? { requestId: value.requestId } : {}),
        payload: { displayName: payload.displayName },
      };
    case "JOIN_ROOM": {
      const roomCode = normalizeRoomCode(payload.roomCode);
      if (!ROOM_CODE_PATTERN.test(roomCode)) throw new Error("INVALID_ROOM_CODE");
      if (!PLAYER_ROLES.has(String(payload.side))) throw new Error("INVALID_SIDE");
      if (payload.displayName !== undefined && !isString(payload.displayName, 1, 64)) {
        throw new Error("INVALID_DISPLAY_NAME");
      }
      return {
        type: value.type,
        ...(value.requestId ? { requestId: value.requestId } : {}),
        payload: {
          roomCode,
          side: payload.side,
          displayName: payload.displayName,
        },
      };
    }
    case "LEAVE_ROOM":
      return {
        type: value.type,
        ...(value.requestId ? { requestId: value.requestId } : {}),
        payload: {},
      };
    case "OFFER":
    case "ANSWER": {
      if (!ALL_ROLES.has(String(payload.targetRole))) {
        throw new Error("INVALID_TARGET_ROLE");
      }
      const description = parseDescription(
        payload.description,
        value.type === "OFFER" ? "offer" : "answer",
      );
      if (!description) throw new Error("INVALID_DESCRIPTION");
      return {
        type: value.type,
        ...(value.requestId ? { requestId: value.requestId } : {}),
        payload: { targetRole: payload.targetRole, description },
      };
    }
    case "ICE_CANDIDATE": {
      if (!ALL_ROLES.has(String(payload.targetRole))) {
        throw new Error("INVALID_TARGET_ROLE");
      }
      const candidate = parseCandidate(payload.candidate);
      if (!candidate) throw new Error("INVALID_ICE_CANDIDATE");
      return {
        type: value.type,
        ...(value.requestId ? { requestId: value.requestId } : {}),
        payload: { targetRole: payload.targetRole, candidate },
      };
    }
    default:
      throw new Error("UNKNOWN_MESSAGE_TYPE");
  }
}

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      if (request.method !== "GET") {
        return jsonResponse({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);
      }
      return jsonResponse(
        { ok: true, service: "xqb-bp-signaling", durableObjects: true },
        200,
      );
    }
    if (url.pathname !== "/") {
      return jsonResponse({ ok: false, error: "NOT_FOUND" }, 404);
    }
    if (request.method !== "GET") {
      return jsonResponse({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return jsonResponse({ ok: false, error: "WEBSOCKET_UPGRADE_REQUIRED" }, 426);
    }

    const roomParameters = url.searchParams.getAll("roomId");
    if (roomParameters.length > 1) {
      return jsonResponse({ ok: false, error: "INVALID_ROOM_CODE" }, 400);
    }
    const requestedRoomCode = normalizeRoomCode(roomParameters[0]);
    if (roomParameters.length === 1 && !ROOM_CODE_PATTERN.test(requestedRoomCode)) {
      return jsonResponse({ ok: false, error: "INVALID_ROOM_CODE" }, 400);
    }

    const roomCode = requestedRoomCode || createRoomCode();
    const mode: ConnectionMode = requestedRoomCode ? "JOIN" : "CREATE";
    const roomId = env.BP_ROOMS.idFromName(roomCode);
    const room = env.BP_ROOMS.get(roomId);
    const headers = new Headers(request.headers);
    headers.set("X-XQB-Room-Code", roomCode);
    headers.set("X-XQB-Connection-Mode", mode);
    return room.fetch(new Request(request, { headers }));
  },
} satisfies ExportedHandler<Env>;

export class BpRoom extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (
      request.method !== "GET" ||
      request.headers.get("Upgrade")?.toLowerCase() !== "websocket"
    ) {
      return jsonResponse({ ok: false, error: "WEBSOCKET_UPGRADE_REQUIRED" }, 426);
    }

    const roomCode = normalizeRoomCode(request.headers.get("X-XQB-Room-Code"));
    const mode = request.headers.get("X-XQB-Connection-Mode");
    if (!ROOM_CODE_PATTERN.test(roomCode) || (mode !== "CREATE" && mode !== "JOIN")) {
      return jsonResponse({ ok: false, error: "INVALID_ROUTING_CONTEXT" }, 400);
    }

    const sockets = this.ctx.getWebSockets();
    if (sockets.length >= MAX_ROOM_CONNECTIONS) {
      return jsonResponse({ ok: false, error: "ROOM_CONNECTION_LIMIT" }, 429);
    }
    if (
      mode === "CREATE" &&
      sockets.some((socket) => {
        const attachment = this.getAttachment(socket);
        return attachment?.mode === "CREATE" || attachment?.role === "HOST";
      })
    ) {
      return jsonResponse({ ok: false, error: "HOST_OCCUPIED" }, 409);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    this.setAttachment(server, {
      roomCode,
      mode,
      role: null,
      sessionId: null,
      displayName: null,
      joinedAt: null,
      createdAt: null,
      expiresAt: null,
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, data: string | ArrayBuffer): Promise<void> {
    if (typeof data !== "string") {
      this.sendError(socket, "BINARY_NOT_ALLOWED", "信令服务只接受 JSON 文本消息");
      if (!this.getAttachment(socket)?.role) this.closeUnassigned(socket);
      return;
    }

    let message: SignalingMessage;
    try {
      message = parseClientMessage(data);
    } catch (error) {
      const code = error instanceof Error ? error.message : "INVALID_MESSAGE";
      this.sendError(socket, code, this.validationMessage(code));
      if (!this.getAttachment(socket)?.role) this.closeUnassigned(socket);
      return;
    }

    try {
      switch (message.type) {
        case "CREATE_ROOM":
          await this.createRoom(socket, message);
          return;
        case "JOIN_ROOM":
          await this.joinRoom(socket, message);
          return;
        case "LEAVE_ROOM":
          await this.leave(socket, "left", message.requestId, true);
          return;
        case "OFFER":
        case "ANSWER":
        case "ICE_CANDIDATE":
          this.relay(socket, message);
          return;
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : "SIGNALING_ERROR";
      this.sendError(socket, code, this.processingMessage(code), message.requestId);
      if (!this.getAttachment(socket)?.role) this.closeUnassigned(socket);
    }
  }

  async webSocketClose(
    socket: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    await this.leave(socket, "disconnected");
  }

  async webSocketError(socket: WebSocket, _error: unknown): Promise<void> {
    await this.leave(socket, "connection-error");
    try {
      socket.close(1011, "signaling connection error");
    } catch {
      // The runtime may already have closed the socket.
    }
  }

  async alarm(): Promise<void> {
    await this.closeRoom("ROOM_EXPIRED", "房间已失效");
  }

  private async createRoom(socket: WebSocket, message: SignalingMessage): Promise<void> {
    const attachment = this.requireAttachment(socket);
    if (attachment.role) throw new Error("ALREADY_IN_ROOM");
    if (attachment.mode !== "CREATE") throw new Error("INVALID_CONNECTION_MODE");
    if (this.findByRole("HOST", socket)) throw new Error("HOST_OCCUPIED");

    const now = Date.now();
    const expiresAt = now + ROOM_TTL_MS;
    const sessionId = crypto.randomUUID();
    this.setAttachment(socket, {
      ...attachment,
      role: "HOST",
      sessionId,
      displayName:
        typeof message.payload.displayName === "string"
          ? message.payload.displayName
          : "XQB-BPBox",
      joinedAt: now,
      createdAt: now,
      expiresAt,
    });
    await this.ctx.storage.setAlarm(expiresAt);
    this.send(
      socket,
      "ROOM_CREATED",
      {
        roomCode: attachment.roomCode,
        sessionId,
        role: "HOST",
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
      },
      message.requestId,
    );
  }

  private async joinRoom(socket: WebSocket, message: SignalingMessage): Promise<void> {
    const attachment = this.requireAttachment(socket);
    if (attachment.role) throw new Error("ALREADY_IN_ROOM");
    if (attachment.mode !== "JOIN") throw new Error("INVALID_CONNECTION_MODE");
    if (message.payload.roomCode !== attachment.roomCode) {
      throw new Error("ROOM_ID_MISMATCH");
    }

    const hostSocket = this.findByRole("HOST");
    if (!hostSocket) throw new Error("ROOM_NOT_FOUND");
    const host = this.requireAttachment(hostSocket);
    if (!host.expiresAt || host.expiresAt <= Date.now()) {
      await this.closeRoom("ROOM_EXPIRED", "房间已失效");
      return;
    }

    const role = message.payload.side as "FIRST" | "SECOND";
    if (this.findByRole(role)) throw new Error(`${role}_OCCUPIED`);

    const now = Date.now();
    const sessionId = crypto.randomUUID();
    const displayName =
      typeof message.payload.displayName === "string"
        ? message.payload.displayName
        : role === "FIRST"
          ? "先手选手"
          : "后手选手";
    this.setAttachment(socket, {
      ...attachment,
      role,
      sessionId,
      displayName,
      joinedAt: now,
      createdAt: host.createdAt,
      expiresAt: host.expiresAt,
    });
    this.send(
      socket,
      "ROOM_JOINED",
      {
        roomCode: attachment.roomCode,
        sessionId,
        role,
        expiresAt: new Date(host.expiresAt).toISOString(),
      },
      message.requestId,
    );
    this.send(hostSocket, "PEER_JOINED", {
      role,
      sessionId,
      displayName,
      joinedAt: new Date(now).toISOString(),
    });
  }

  private relay(socket: WebSocket, message: SignalingMessage): void {
    const sender = this.requireAttachment(socket);
    if (!sender.role) throw new Error("NOT_IN_ROOM");
    const targetRole = message.payload.targetRole as SignalingRole;
    const allowed =
      (sender.role === "HOST" && PLAYER_ROLES.has(targetRole)) ||
      (PLAYER_ROLES.has(sender.role) && targetRole === "HOST");
    if (!allowed) throw new Error("INVALID_RELAY_TARGET");
    if (message.type === "OFFER" && sender.role !== "HOST") {
      throw new Error("INVALID_RELAY_DIRECTION");
    }
    if (message.type === "ANSWER" && sender.role === "HOST") {
      throw new Error("INVALID_RELAY_DIRECTION");
    }
    const target = this.findByRole(targetRole);
    if (!target) throw new Error("PEER_NOT_CONNECTED");
    this.send(
      target,
      message.type,
      message.type === "ICE_CANDIDATE"
        ? { fromRole: sender.role, candidate: message.payload.candidate }
        : { fromRole: sender.role, description: message.payload.description },
      message.requestId,
    );
  }

  private async leave(
    socket: WebSocket,
    reason: string,
    requestId?: string,
    acknowledge = false,
  ): Promise<void> {
    const attachment = this.getAttachment(socket);
    if (!attachment?.role) {
      if (acknowledge) this.send(socket, "ROOM_LEFT", {}, requestId);
      return;
    }

    this.clearIdentity(socket, attachment);
    if (attachment.role === "HOST") {
      if (acknowledge) this.send(socket, "ROOM_LEFT", {}, requestId);
      await this.closeRoom("ROOM_CLOSED", "房主已离开，房间失效", socket);
    } else {
      const host = this.findByRole("HOST");
      if (host) {
        this.send(host, "PEER_LEFT", {
          role: attachment.role,
          sessionId: attachment.sessionId,
          reason,
        });
      }
      if (acknowledge) this.send(socket, "ROOM_LEFT", {}, requestId);
    }
    if (acknowledge) {
      try {
        socket.close(1000, "left room");
      } catch {
        // The client may have already closed the connection.
      }
    }
  }

  private async closeRoom(
    code: "ROOM_CLOSED" | "ROOM_EXPIRED",
    message: string,
    excluded?: WebSocket,
  ): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === excluded) continue;
      const attachment = this.getAttachment(socket);
      if (!attachment) continue;
      this.sendError(socket, code, message, undefined, false);
      this.clearIdentity(socket, attachment);
      try {
        socket.close(1000, code);
      } catch {
        // The runtime may already have closed the socket.
      }
    }
    await this.ctx.storage.deleteAlarm();
  }

  private closeUnassigned(socket: WebSocket): void {
    try {
      socket.close(1008, "invalid signaling session");
    } catch {
      // The runtime may already have closed the socket.
    }
  }

  private findByRole(role: SignalingRole, excluded?: WebSocket): WebSocket | null {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === excluded) continue;
      if (this.getAttachment(socket)?.role === role) return socket;
    }
    return null;
  }

  private requireAttachment(socket: WebSocket): ConnectionAttachment {
    const attachment = this.getAttachment(socket);
    if (!attachment) throw new Error("INVALID_CONNECTION_STATE");
    return attachment;
  }

  private getAttachment(socket: WebSocket): ConnectionAttachment | null {
    const value: unknown = socket.deserializeAttachment();
    if (!isObject(value) || !isString(value.roomCode, 6, 6)) return null;
    return value as unknown as ConnectionAttachment;
  }

  private setAttachment(socket: WebSocket, attachment: ConnectionAttachment): void {
    socket.serializeAttachment(attachment);
  }

  private clearIdentity(socket: WebSocket, attachment: ConnectionAttachment): void {
    this.setAttachment(socket, {
      ...attachment,
      role: null,
      sessionId: null,
      displayName: null,
      joinedAt: null,
    });
  }

  private send(
    socket: WebSocket,
    type: string,
    payload: Record<string, unknown>,
    requestId?: string,
  ): void {
    try {
      socket.send(
        JSON.stringify({
          type,
          ...(requestId ? { requestId } : {}),
          sentAt: new Date().toISOString(),
          payload,
        }),
      );
    } catch {
      // Close/error callbacks perform slot cleanup.
    }
  }

  private sendError(
    socket: WebSocket,
    code: string,
    message: string,
    requestId?: string,
    recoverable = true,
  ): void {
    this.send(socket, "ERROR", { code, message, recoverable }, requestId);
  }

  private validationMessage(code: string): string {
    const messages: Record<string, string> = {
      INVALID_JSON: "信令消息不是合法 JSON",
      MESSAGE_TOO_LARGE: "信令消息超过大小限制",
      UNKNOWN_MESSAGE_TYPE: "未知信令消息类型",
      INVALID_ROOM_CODE: "房间码格式无效",
      INVALID_SIDE: "请选择先手或后手",
    };
    return messages[code] ?? "信令消息格式无效";
  }

  private processingMessage(code: string): string {
    const messages: Record<string, string> = {
      ROOM_NOT_FOUND: "房间不存在",
      ROOM_EXPIRED: "房间已失效",
      FIRST_OCCUPIED: "先手已被占用",
      SECOND_OCCUPIED: "后手已被占用",
      HOST_OCCUPIED: "房主已存在",
      PEER_NOT_CONNECTED: "目标客户端尚未连接",
      ALREADY_IN_ROOM: "当前连接已经加入房间",
      NOT_IN_ROOM: "当前连接尚未加入房间",
      ROOM_ID_MISMATCH: "连接路由与房间码不一致",
      INVALID_CONNECTION_MODE: "当前连接不允许执行此房间操作",
      INVALID_RELAY_TARGET: "不允许向该角色转发信令",
      INVALID_RELAY_DIRECTION: "不允许以该身份发送此类 WebRTC 信令",
    };
    return messages[code] ?? "信令服务处理失败";
  }
}
