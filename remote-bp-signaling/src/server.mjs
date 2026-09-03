import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

import { WebSocket, WebSocketServer } from "ws";

export const MAX_SIGNALING_MESSAGE_BYTES = 64 * 1024;
const PERSISTENT_ROOM_EXPIRES_AT = "9999-12-31T23:59:59.999Z";
const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CLIENT_MESSAGE_TYPES = new Set([
  "CREATE_ROOM",
  "RESUME_ROOM",
  "JOIN_ROOM",
  "LEAVE_ROOM",
  "KICK_PEER",
  "HEARTBEAT",
  "OFFER",
  "ANSWER",
  "ICE_CANDIDATE",
]);
const PLAYER_ROLES = new Set(["FIRST", "SECOND"]);
const ALL_ROLES = new Set(["HOST", "FIRST", "SECOND"]);

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value, min, max) {
  return (
    typeof value === "string" && value.length >= min && value.length <= max
  );
}

function normalizeRoomCode(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function parseDescription(value, expectedType) {
  if (
    !isObject(value) ||
    value.type !== expectedType ||
    !isString(value.sdp, 1, 48 * 1024)
  ) {
    return null;
  }
  return { type: expectedType, sdp: value.sdp };
}

function parseCandidate(value) {
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
      value.sdpMLineIndex < 0 ||
      value.sdpMLineIndex > 1024)
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
    sdpMid: value.sdpMid ?? null,
    sdpMLineIndex: value.sdpMLineIndex ?? null,
    usernameFragment: value.usernameFragment ?? null,
  };
}

export function parseClientMessage(raw) {
  if (
    typeof raw !== "string" ||
    Buffer.byteLength(raw, "utf8") > MAX_SIGNALING_MESSAGE_BYTES
  ) {
    throw new Error("MESSAGE_TOO_LARGE");
  }
  let value;
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
  const payload = value.payload;
  if (!isObject(payload)) throw new Error("INVALID_PAYLOAD");

  switch (value.type) {
    case "CREATE_ROOM": {
      if (
        payload.displayName !== undefined &&
        !isString(payload.displayName, 1, 64)
      ) {
        throw new Error("INVALID_DISPLAY_NAME");
      }
      return {
        type: value.type,
        requestId: value.requestId,
        payload: { displayName: payload.displayName },
      };
    }
    case "RESUME_ROOM": {
      const roomCode = normalizeRoomCode(payload.roomCode);
      if (!/^[A-Z2-9]{6}$/.test(roomCode)) throw new Error("INVALID_ROOM_CODE");
      if (!isString(payload.resumeToken, 16, 128)) {
        throw new Error("INVALID_RESUME_TOKEN");
      }
      return {
        type: value.type,
        requestId: value.requestId,
        payload: { roomCode, resumeToken: payload.resumeToken },
      };
    }
    case "JOIN_ROOM": {
      const roomCode = normalizeRoomCode(payload.roomCode);
      const side = payload.side;
      if (!/^[A-Z2-9]{6}$/.test(roomCode)) throw new Error("INVALID_ROOM_CODE");
      if (!PLAYER_ROLES.has(side)) throw new Error("INVALID_SIDE");
      if (
        payload.displayName !== undefined &&
        !isString(payload.displayName, 1, 64)
      ) {
        throw new Error("INVALID_DISPLAY_NAME");
      }
      return {
        type: value.type,
        requestId: value.requestId,
        payload: { roomCode, side, displayName: payload.displayName },
      };
    }
    case "LEAVE_ROOM":
      return { type: value.type, requestId: value.requestId, payload: {} };
    case "KICK_PEER":
      if (!PLAYER_ROLES.has(payload.side)) throw new Error("INVALID_SIDE");
      return {
        type: value.type,
        requestId: value.requestId,
        payload: { side: payload.side },
      };
    case "HEARTBEAT":
      return {
        type: value.type,
        requestId: value.requestId,
        payload: {
          sentAt: isString(payload.sentAt, 10, 64) ? payload.sentAt : "",
        },
      };
    case "OFFER":
    case "ANSWER": {
      if (!ALL_ROLES.has(payload.targetRole))
        throw new Error("INVALID_TARGET_ROLE");
      const description = parseDescription(
        payload.description,
        value.type === "OFFER" ? "offer" : "answer",
      );
      if (!description) throw new Error("INVALID_DESCRIPTION");
      return {
        type: value.type,
        requestId: value.requestId,
        payload: { targetRole: payload.targetRole, description },
      };
    }
    case "ICE_CANDIDATE": {
      if (!ALL_ROLES.has(payload.targetRole))
        throw new Error("INVALID_TARGET_ROLE");
      const candidate = parseCandidate(payload.candidate);
      if (!candidate) throw new Error("INVALID_ICE_CANDIDATE");
      return {
        type: value.type,
        requestId: value.requestId,
        payload: { targetRole: payload.targetRole, candidate },
      };
    }
  }
}

function send(socket, type, payload, requestId) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(
    JSON.stringify({
      type,
      ...(requestId ? { requestId } : {}),
      sentAt: new Date().toISOString(),
      payload,
    }),
  );
}

function sendError(socket, code, message, requestId, recoverable = true) {
  send(socket, "ERROR", { code, message, recoverable }, requestId);
}

function createRoomCode(rooms) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const bytes = randomBytes(6);
    let code = "";
    for (const byte of bytes)
      code += ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length];
    if (!rooms.has(code)) return code;
  }
  throw new Error("ROOM_CODE_EXHAUSTED");
}

function slotForRole(room, role) {
  if (role === "HOST") return room.host;
  return role === "FIRST" ? room.firstPlayer : room.secondPlayer;
}

export function createSignalingServer(options = {}) {
  const host = options.host ?? process.env.SIGNALING_HOST ?? "0.0.0.0";
  const configuredPort =
    options.port ?? Number(process.env.SIGNALING_PORT ?? 8787);
  const port =
    Number.isInteger(configuredPort) &&
    configuredPort >= 0 &&
    configuredPort <= 65_535
      ? configuredPort
      : 8787;
  const rooms = new Map();
  const clients = new WeakMap();
  const httpServer = createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify({ ok: true, rooms: rooms.size }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const webSocketServer = new WebSocketServer({
    server: httpServer,
    maxPayload: MAX_SIGNALING_MESSAGE_BYTES,
    perMessageDeflate: false,
  });

  const expireRoom = (room, code = "ROOM_EXPIRED", message = "房间已失效") => {
    rooms.delete(room.roomCode);
    for (const participant of [
      room.host,
      room.firstPlayer,
      room.secondPlayer,
    ]) {
      if (!participant) continue;
      clients.delete(participant.socket);
      sendError(participant.socket, code, message, undefined, false);
      participant.socket.close(1000, code);
    }
  };

  const leave = (socket, reason = "left", closeHostedRoom = false) => {
    const identity = clients.get(socket);
    if (!identity) return;
    const room = rooms.get(identity.roomCode);
    clients.delete(socket);
    if (!room) return;

    if (identity.role === "HOST") {
      room.host = null;
      if (closeHostedRoom) {
        expireRoom(room, "ROOM_CLOSED", "房主已关闭房间");
      } else {
        for (const participant of [room.firstPlayer, room.secondPlayer]) {
          if (participant)
            send(participant.socket, "HOST_DISCONNECTED", { reason });
        }
      }
      return;
    }

    if (identity.role === "FIRST") room.firstPlayer = null;
    else room.secondPlayer = null;
    if (room.host) {
      send(room.host.socket, "PEER_LEFT", {
        role: identity.role,
        sessionId: identity.sessionId,
        reason,
      });
    }
  };

  const resolveRelayTarget = (socket, targetRole) => {
    const identity = clients.get(socket);
    if (!identity) throw new Error("NOT_IN_ROOM");
    const room = rooms.get(identity.roomCode);
    if (!room) throw new Error("ROOM_NOT_FOUND");
    const allowed =
      (identity.role === "HOST" && PLAYER_ROLES.has(targetRole)) ||
      (PLAYER_ROLES.has(identity.role) && targetRole === "HOST");
    if (!allowed) throw new Error("INVALID_RELAY_TARGET");
    const target = slotForRole(room, targetRole);
    if (!target) throw new Error("PEER_NOT_CONNECTED");
    return { identity, target };
  };

  webSocketServer.on("connection", (socket) => {
    socket.on("error", () => undefined);
    socket.on("close", () => leave(socket, "disconnected"));
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        sendError(socket, "BINARY_NOT_ALLOWED", "信令服务只接受 JSON 文本消息");
        return;
      }
      let message;
      try {
        message = parseClientMessage(data.toString("utf8"));
      } catch (error) {
        const code = error instanceof Error ? error.message : "INVALID_MESSAGE";
        const validationMessages = {
          INVALID_JSON: "信令消息不是合法 JSON",
          MESSAGE_TOO_LARGE: "信令消息超过大小限制",
          UNKNOWN_MESSAGE_TYPE: "未知信令消息类型",
          INVALID_ROOM_CODE: "房间码格式无效",
          INVALID_SIDE: "请选择先手或后手",
        };
        sendError(socket, code, validationMessages[code] ?? "信令消息格式无效");
        return;
      }

      try {
        switch (message.type) {
          case "CREATE_ROOM": {
            if (clients.has(socket)) throw new Error("ALREADY_IN_ROOM");
            const now = Date.now();
            const roomCode = createRoomCode(rooms);
            const participant = {
              role: "HOST",
              sessionId: randomUUID(),
              displayName: message.payload.displayName ?? "XQB-BPBox",
              socket,
              joinedAt: now,
            };
            const room = {
              roomCode,
              host: participant,
              hostSessionId: participant.sessionId,
              firstPlayer: null,
              secondPlayer: null,
              createdAt: now,
              resumeToken: randomUUID(),
            };
            rooms.set(roomCode, room);
            clients.set(socket, {
              roomCode,
              role: "HOST",
              sessionId: participant.sessionId,
            });
            send(
              socket,
              "ROOM_CREATED",
              {
                roomCode,
                sessionId: participant.sessionId,
                role: "HOST",
                createdAt: new Date(room.createdAt).toISOString(),
                expiresAt: PERSISTENT_ROOM_EXPIRES_AT,
                resumeToken: room.resumeToken,
              },
              message.requestId,
            );
            return;
          }
          case "RESUME_ROOM": {
            if (clients.has(socket)) throw new Error("ALREADY_IN_ROOM");
            const room = rooms.get(message.payload.roomCode);
            if (!room) throw new Error("ROOM_NOT_FOUND");
            if (room.resumeToken !== message.payload.resumeToken) {
              throw new Error("INVALID_RESUME_TOKEN");
            }
            if (room.host) {
              clients.delete(room.host.socket);
              room.host.socket.close(4001, "host session resumed");
            }
            const participant = {
              role: "HOST",
              sessionId: room.hostSessionId,
              displayName: "XQB-BPBox",
              socket,
              joinedAt: Date.now(),
            };
            room.host = participant;
            clients.set(socket, {
              roomCode: room.roomCode,
              role: "HOST",
              sessionId: participant.sessionId,
            });
            send(
              socket,
              "ROOM_RESUMED",
              {
                roomCode: room.roomCode,
                sessionId: participant.sessionId,
                role: "HOST",
                createdAt: new Date(room.createdAt).toISOString(),
                expiresAt: PERSISTENT_ROOM_EXPIRES_AT,
              },
              message.requestId,
            );
            for (const player of [room.firstPlayer, room.secondPlayer]) {
              if (!player) continue;
              send(socket, "PEER_JOINED", {
                role: player.role,
                sessionId: player.sessionId,
                displayName: player.displayName,
                joinedAt: new Date(player.joinedAt).toISOString(),
              });
              send(player.socket, "HOST_RECONNECTED", {});
            }
            return;
          }
          case "JOIN_ROOM": {
            if (clients.has(socket)) throw new Error("ALREADY_IN_ROOM");
            const room = rooms.get(message.payload.roomCode);
            if (!room) throw new Error("ROOM_NOT_FOUND");
            if (!room.host) throw new Error("HOST_UNAVAILABLE");
            const slotKey =
              message.payload.side === "FIRST" ? "firstPlayer" : "secondPlayer";
            if (room[slotKey])
              throw new Error(`${message.payload.side}_OCCUPIED`);
            const participant = {
              role: message.payload.side,
              sessionId: randomUUID(),
              displayName:
                message.payload.displayName ??
                (message.payload.side === "FIRST" ? "先手选手" : "后手选手"),
              socket,
              joinedAt: Date.now(),
            };
            room[slotKey] = participant;
            clients.set(socket, {
              roomCode: room.roomCode,
              role: participant.role,
              sessionId: participant.sessionId,
            });
            send(
              socket,
              "ROOM_JOINED",
              {
                roomCode: room.roomCode,
                sessionId: participant.sessionId,
                role: participant.role,
                expiresAt: PERSISTENT_ROOM_EXPIRES_AT,
              },
              message.requestId,
            );
            send(room.host.socket, "PEER_JOINED", {
              role: participant.role,
              sessionId: participant.sessionId,
              displayName: participant.displayName,
              joinedAt: new Date(participant.joinedAt).toISOString(),
            });
            return;
          }
          case "LEAVE_ROOM":
            leave(socket, "left", true);
            send(socket, "ROOM_LEFT", {}, message.requestId);
            return;
          case "KICK_PEER": {
            const identity = clients.get(socket);
            if (!identity || identity.role !== "HOST")
              throw new Error("HOST_ONLY");
            const room = rooms.get(identity.roomCode);
            if (!room) throw new Error("ROOM_NOT_FOUND");
            const slotKey =
              message.payload.side === "FIRST" ? "firstPlayer" : "secondPlayer";
            const player = room[slotKey];
            if (!player) throw new Error("PEER_NOT_CONNECTED");
            room[slotKey] = null;
            clients.delete(player.socket);
            sendError(
              player.socket,
              "KICKED",
              "已被房主踢出",
              undefined,
              false,
            );
            send(socket, "PEER_LEFT", {
              role: player.role,
              sessionId: player.sessionId,
              reason: "kicked",
            });
            player.socket.close(4003, "KICKED");
            return;
          }
          case "HEARTBEAT":
            if (!clients.has(socket)) throw new Error("NOT_IN_ROOM");
            send(socket, "HEARTBEAT_ACK", { sentAt: message.payload.sentAt });
            return;
          case "OFFER":
          case "ANSWER":
          case "ICE_CANDIDATE": {
            const { identity, target } = resolveRelayTarget(
              socket,
              message.payload.targetRole,
            );
            if (message.type === "OFFER" && identity.role !== "HOST") {
              throw new Error("INVALID_RELAY_DIRECTION");
            }
            if (message.type === "ANSWER" && identity.role === "HOST") {
              throw new Error("INVALID_RELAY_DIRECTION");
            }
            const relayPayload =
              message.type === "ICE_CANDIDATE"
                ? {
                    fromRole: identity.role,
                    candidate: message.payload.candidate,
                  }
                : {
                    fromRole: identity.role,
                    description: message.payload.description,
                  };
            send(target.socket, message.type, relayPayload, message.requestId);
            return;
          }
        }
      } catch (error) {
        const code = error instanceof Error ? error.message : "SIGNALING_ERROR";
        const messages = {
          ROOM_NOT_FOUND: "房间不存在",
          ROOM_EXPIRED: "房间已失效",
          FIRST_OCCUPIED: "先手已被占用",
          SECOND_OCCUPIED: "后手已被占用",
          PEER_NOT_CONNECTED: "目标客户端尚未连接",
          ALREADY_IN_ROOM: "当前连接已经加入房间",
          NOT_IN_ROOM: "当前连接尚未加入房间",
          INVALID_RELAY_TARGET: "不允许向该角色转发信令",
          INVALID_RELAY_DIRECTION: "不允许以该身份发送此类 WebRTC 信令",
          HOST_UNAVAILABLE: "房主连接暂时不可用",
          HOST_ONLY: "只有房主可以执行此操作",
          INVALID_RESUME_TOKEN: "房主恢复凭证无效",
        };
        sendError(
          socket,
          code,
          messages[code] ?? "信令服务处理失败",
          message.requestId,
        );
      }
    });
  });

  return {
    rooms,
    async listen() {
      await new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, host, () => {
          httpServer.off("error", reject);
          resolve();
        });
      });
      const address = httpServer.address();
      return typeof address === "object" && address ? address.port : port;
    },
    async close() {
      for (const socket of webSocketServer.clients) socket.terminate();
      await new Promise((resolve) => webSocketServer.close(() => resolve()));
      if (httpServer.listening) {
        await new Promise((resolve, reject) =>
          httpServer.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  };
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const server = createSignalingServer();
  server
    .listen()
    .then((boundPort) => {
      console.log(
        `XQB Remote BP signaling server listening on ws://${process.env.SIGNALING_HOST ?? "0.0.0.0"}:${boundPort}`,
      );
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
