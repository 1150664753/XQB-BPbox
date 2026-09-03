import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

import WebSocket from "ws";

const projectDirectory = fileURLToPath(new URL("..", import.meta.url));
const wranglerCli = fileURLToPath(
  new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
);

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (port === null)
          reject(new Error("Unable to reserve a test port"));
        else resolve(port);
      });
    });
  });
}

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

function expectUpgradeStatus(url, expectedStatus) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => {
      socket.close();
      reject(new Error(`WebSocket upgrade unexpectedly succeeded for ${url}`));
    });
    socket.once("unexpected-response", (_request, response) => {
      response.on("error", () => undefined);
      response.socket?.on("error", () => undefined);
      response.resume();
      try {
        assert.equal(response.statusCode, expectedStatus);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", () => undefined);
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

async function waitUntilReady(baseUrl, child, logs) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`wrangler dev exited early\n${logs.join("")}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Wrangler is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`wrangler dev did not become ready\n${logs.join("")}`);
}

async function main() {
  const port = await reservePort();
  const httpUrl = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/`;
  const logs = [];
  const child = spawn(
    process.execPath,
    [wranglerCli, "dev", "--ip", "127.0.0.1", "--port", String(port)],
    { cwd: projectDirectory, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.on("data", (chunk) => logs.push(chunk.toString()));
  child.stderr.on("data", (chunk) => logs.push(chunk.toString()));

  const sockets = [];
  try {
    await waitUntilReady(httpUrl, child, logs);
    const health = await (await fetch(`${httpUrl}/health`)).json();
    assert.equal(health.ok, true);
    assert.equal((await fetch(httpUrl)).status, 426);

    const host = await connect(wsUrl);
    sockets.push(host);
    const createdMessage = nextMessage(host);
    host.send(
      JSON.stringify({ type: "CREATE_ROOM", requestId: "create", payload: {} }),
    );
    const created = await createdMessage;
    assert.equal(created.type, "ROOM_CREATED");
    assert.match(created.payload.roomCode, /^[A-Z2-9]{6}$/);
    assert.match(created.payload.resumeToken, /^[0-9a-f-]{36}$/i);
    const roomUrl = `${wsUrl}?roomId=${created.payload.roomCode}`;

    const heartbeatAck = nextMessage(host);
    host.send(
      JSON.stringify({
        type: "HEARTBEAT",
        payload: { sentAt: new Date().toISOString() },
      }),
    );
    assert.equal((await heartbeatAck).type, "HEARTBEAT_ACK");

    const first = await connect(roomUrl);
    sockets.push(first);
    const joinedMessage = nextMessage(first);
    const peerJoinedMessage = nextMessage(host);
    first.send(
      JSON.stringify({
        type: "JOIN_ROOM",
        requestId: "join-first",
        payload: { roomCode: created.payload.roomCode, side: "FIRST" },
      }),
    );
    const [joined, peerJoined] = await Promise.all([
      joinedMessage,
      peerJoinedMessage,
    ]);
    assert.equal(joined.payload.role, "FIRST");
    assert.equal(peerJoined.payload.role, "FIRST");

    const duplicate = await connect(roomUrl);
    sockets.push(duplicate);
    const occupiedMessage = nextMessage(duplicate);
    duplicate.send(
      JSON.stringify({
        type: "JOIN_ROOM",
        requestId: "duplicate-first",
        payload: { roomCode: created.payload.roomCode, side: "FIRST" },
      }),
    );
    const occupied = await occupiedMessage;
    assert.equal(occupied.type, "ERROR");
    assert.equal(occupied.payload.code, "FIRST_OCCUPIED");

    const unknownMessage = nextMessage(host);
    host.send(JSON.stringify({ type: "UNKNOWN", payload: {} }));
    const unknown = await unknownMessage;
    assert.equal(unknown.type, "ERROR");
    assert.equal(unknown.payload.code, "UNKNOWN_MESSAGE_TYPE");

    const offerMessage = nextMessage(first);
    host.send(
      JSON.stringify({
        type: "OFFER",
        payload: {
          targetRole: "FIRST",
          description: { type: "offer", sdp: "test-offer" },
        },
      }),
    );
    const offer = await offerMessage;
    assert.equal(offer.payload.fromRole, "HOST");

    const answerMessage = nextMessage(host);
    first.send(
      JSON.stringify({
        type: "ANSWER",
        payload: {
          targetRole: "HOST",
          description: { type: "answer", sdp: "test-answer" },
        },
      }),
    );
    const answer = await answerMessage;
    assert.equal(answer.payload.fromRole, "FIRST");

    const hostCandidateMessage = nextMessage(first);
    host.send(
      JSON.stringify({
        type: "ICE_CANDIDATE",
        payload: {
          targetRole: "FIRST",
          candidate: {
            candidate: "host-candidate",
            sdpMid: "0",
            sdpMLineIndex: 0,
          },
        },
      }),
    );
    assert.equal((await hostCandidateMessage).payload.fromRole, "HOST");

    const firstCandidateMessage = nextMessage(host);
    first.send(
      JSON.stringify({
        type: "ICE_CANDIDATE",
        payload: {
          targetRole: "HOST",
          candidate: {
            candidate: "first-candidate",
            sdpMid: "0",
            sdpMLineIndex: 0,
          },
        },
      }),
    );
    assert.equal((await firstCandidateMessage).payload.fromRole, "FIRST");

    const peerLeftMessage = nextMessage(host);
    first.close(1000, "release first slot");
    const peerLeft = await peerLeftMessage;
    assert.equal(peerLeft.type, "PEER_LEFT");
    assert.equal(peerLeft.payload.role, "FIRST");

    const replacement = await connect(roomUrl);
    sockets.push(replacement);
    const replacementJoinedMessage = nextMessage(replacement);
    const replacementPeerJoinedMessage = nextMessage(host);
    replacement.send(
      JSON.stringify({
        type: "JOIN_ROOM",
        payload: { roomCode: created.payload.roomCode, side: "FIRST" },
      }),
    );
    assert.equal((await replacementJoinedMessage).payload.role, "FIRST");
    assert.equal((await replacementPeerJoinedMessage).payload.role, "FIRST");

    const second = await connect(roomUrl);
    sockets.push(second);
    const secondJoinedMessage = nextMessage(second);
    const secondPeerJoinedMessage = nextMessage(host);
    second.send(
      JSON.stringify({
        type: "JOIN_ROOM",
        payload: { roomCode: created.payload.roomCode, side: "SECOND" },
      }),
    );
    assert.equal((await secondJoinedMessage).payload.role, "SECOND");
    assert.equal((await secondPeerJoinedMessage).payload.role, "SECOND");
    await expectUpgradeStatus(roomUrl, 429);

    const firstHostDisconnected = nextMessage(replacement);
    const secondHostDisconnected = nextMessage(second);
    host.close(1000, "temporary host disconnect");
    const [firstDisconnected, secondDisconnected] = await Promise.all([
      firstHostDisconnected,
      secondHostDisconnected,
    ]);
    assert.equal(firstDisconnected.type, "HOST_DISCONNECTED");
    assert.equal(secondDisconnected.type, "HOST_DISCONNECTED");

    const resumedHost = await connect(`${roomUrl}&mode=resume`);
    sockets.push(resumedHost);
    const resumedMessages = nextMessages(resumedHost, 3);
    const firstHostReconnected = nextMessage(replacement);
    const secondHostReconnected = nextMessage(second);
    resumedHost.send(
      JSON.stringify({
        type: "RESUME_ROOM",
        payload: {
          roomCode: created.payload.roomCode,
          resumeToken: created.payload.resumeToken,
        },
      }),
    );
    const [roomResumed, firstResumedPeer, secondResumedPeer] =
      await resumedMessages;
    assert.equal(roomResumed.type, "ROOM_RESUMED");
    assert.deepEqual(
      new Set([firstResumedPeer.payload.role, secondResumedPeer.payload.role]),
      new Set(["FIRST", "SECOND"]),
    );
    assert.equal((await firstHostReconnected).type, "HOST_RECONNECTED");
    assert.equal((await secondHostReconnected).type, "HOST_RECONNECTED");

    const kicked = nextMessage(replacement);
    const kickedPeerLeft = nextMessage(resumedHost);
    resumedHost.send(
      JSON.stringify({ type: "KICK_PEER", payload: { side: "FIRST" } }),
    );
    assert.equal((await kicked).payload.code, "KICKED");
    assert.equal((await kickedPeerLeft).payload.reason, "kicked");

    const newFirst = await connect(roomUrl);
    sockets.push(newFirst);
    const newFirstJoined = nextMessage(newFirst);
    const newFirstPeerJoined = nextMessage(resumedHost);
    newFirst.send(
      JSON.stringify({
        type: "JOIN_ROOM",
        payload: { roomCode: created.payload.roomCode, side: "FIRST" },
      }),
    );
    assert.equal((await newFirstJoined).payload.role, "FIRST");
    assert.equal((await newFirstPeerJoined).payload.role, "FIRST");

    const firstClosedMessage = nextMessage(newFirst);
    const secondClosedMessage = nextMessage(second);
    resumedHost.send(JSON.stringify({ type: "LEAVE_ROOM", payload: {} }));
    const [firstClosed, secondClosed] = await Promise.all([
      firstClosedMessage,
      secondClosedMessage,
    ]);
    assert.equal(firstClosed.payload.code, "ROOM_CLOSED");
    assert.equal(secondClosed.payload.code, "ROOM_CLOSED");

    console.log(
      "Cloudflare signaling self-check passed: persistent room, resume, kick, heartbeat, cleanup",
    );
  } finally {
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) socket.close();
    }
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      if (child.exitCode !== null) resolve();
      else {
        child.once("exit", resolve);
        setTimeout(resolve, 5_000);
      }
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
