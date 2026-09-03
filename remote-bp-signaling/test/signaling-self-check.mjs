import assert from "node:assert/strict";

import WebSocket from "ws";

import { createSignalingServer, parseClientMessage } from "../src/server.mjs";

function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    const onMessage = (data) => {
      cleanup();
      resolve(JSON.parse(data.toString("utf8")));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    socket.on("message", onMessage);
    socket.on("error", onError);
  });
}

function nextMessages(socket, count) {
  return new Promise((resolve, reject) => {
    const messages = [];
    const onMessage = (data) => {
      messages.push(JSON.parse(data.toString("utf8")));
      if (messages.length === count) {
        cleanup();
        resolve(messages);
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    socket.on("message", onMessage);
    socket.on("error", onError);
  });
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

async function main() {
  assert.throws(() => parseClientMessage("{"), /INVALID_JSON/);
  assert.throws(
    () => parseClientMessage(JSON.stringify({ type: "UNKNOWN", payload: {} })),
    /UNKNOWN_MESSAGE_TYPE/,
  );

  const server = createSignalingServer({
    host: "127.0.0.1",
    port: 0,
  });
  const port = await server.listen();
  const url = `ws://127.0.0.1:${port}`;
  const host = await connect(url);
  const first = await connect(url);
  const second = await connect(url);
  const duplicate = await connect(url);

  host.send(
    JSON.stringify({ type: "CREATE_ROOM", requestId: "create", payload: {} }),
  );
  const created = await nextMessage(host);
  assert.equal(created.type, "ROOM_CREATED");
  assert.match(created.payload.roomCode, /^[A-Z2-9]{6}$/);
  assert.match(created.payload.resumeToken, /^[0-9a-f-]{36}$/i);

  const heartbeatAck = nextMessage(host);
  host.send(
    JSON.stringify({
      type: "HEARTBEAT",
      payload: { sentAt: new Date().toISOString() },
    }),
  );
  assert.equal((await heartbeatAck).type, "HEARTBEAT_ACK");

  first.send(
    JSON.stringify({
      type: "JOIN_ROOM",
      requestId: "join-first",
      payload: { roomCode: created.payload.roomCode, side: "FIRST" },
    }),
  );
  const joined = await nextMessage(first);
  const peerJoined = await nextMessage(host);
  assert.equal(joined.payload.role, "FIRST");
  assert.equal(peerJoined.payload.role, "FIRST");

  duplicate.send(
    JSON.stringify({
      type: "JOIN_ROOM",
      requestId: "duplicate-first",
      payload: { roomCode: created.payload.roomCode, side: "FIRST" },
    }),
  );
  const occupied = await nextMessage(duplicate);
  assert.equal(occupied.payload.code, "FIRST_OCCUPIED");

  host.send(
    JSON.stringify({
      type: "OFFER",
      payload: {
        targetRole: "FIRST",
        description: { type: "offer", sdp: "test-offer" },
      },
    }),
  );
  const offer = await nextMessage(first);
  assert.equal(offer.type, "OFFER");
  assert.equal(offer.payload.fromRole, "HOST");

  first.close();
  const peerLeft = await nextMessage(host);
  assert.equal(peerLeft.type, "PEER_LEFT");
  assert.equal(peerLeft.payload.role, "FIRST");

  second.send(
    JSON.stringify({
      type: "JOIN_ROOM",
      requestId: "join-second",
      payload: { roomCode: created.payload.roomCode, side: "SECOND" },
    }),
  );
  const secondJoined = await nextMessage(second);
  const secondPeerJoined = await nextMessage(host);
  assert.equal(secondJoined.payload.role, "SECOND");
  assert.equal(secondPeerJoined.payload.role, "SECOND");

  const hostDisconnected = nextMessage(second);
  host.close();
  assert.equal((await hostDisconnected).type, "HOST_DISCONNECTED");

  const resumedHost = await connect(url);
  const resumedMessages = nextMessages(resumedHost, 2);
  const hostReconnected = nextMessage(second);
  resumedHost.send(
    JSON.stringify({
      type: "RESUME_ROOM",
      requestId: "resume-host",
      payload: {
        roomCode: created.payload.roomCode,
        resumeToken: created.payload.resumeToken,
      },
    }),
  );
  const [roomResumed, resumedPeer] = await resumedMessages;
  assert.equal(roomResumed.type, "ROOM_RESUMED");
  assert.equal(resumedPeer.payload.role, "SECOND");
  assert.equal((await hostReconnected).type, "HOST_RECONNECTED");

  const kicked = nextMessage(second);
  const kickedPeerLeft = nextMessage(resumedHost);
  resumedHost.send(
    JSON.stringify({ type: "KICK_PEER", payload: { side: "SECOND" } }),
  );
  assert.equal((await kicked).payload.code, "KICKED");
  assert.equal((await kickedPeerLeft).payload.reason, "kicked");

  const replacementSecond = await connect(url);
  const replacementJoined = nextMessage(replacementSecond);
  const replacementPeerJoined = nextMessage(resumedHost);
  replacementSecond.send(
    JSON.stringify({
      type: "JOIN_ROOM",
      payload: { roomCode: created.payload.roomCode, side: "SECOND" },
    }),
  );
  assert.equal((await replacementJoined).payload.role, "SECOND");
  assert.equal((await replacementPeerJoined).payload.role, "SECOND");

  const roomClosed = nextMessage(replacementSecond);
  resumedHost.send(JSON.stringify({ type: "LEAVE_ROOM", payload: {} }));
  assert.equal((await roomClosed).payload.code, "ROOM_CLOSED");
  replacementSecond.close();
  resumedHost.close();
  duplicate.close();
  await server.close();
  console.log(
    "Signaling self-check passed: persistent room, resume, kick, heartbeat, cleanup",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
