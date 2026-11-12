import { runtimeConfig } from "../config/runtime";
import { MockRemoteBpConnection } from "./MockRemoteBpConnection";
import type { RemoteBpConnection } from "./RemoteBpConnection";
import { WebRtcRemoteBpConnection } from "./WebRtcRemoteBpConnection";
import { SakuraRemoteBpConnection } from './SakuraRemoteBpConnection';
import { getSakuraEntry } from './sakuraInvitation';

export function createRemoteBpConnection(): RemoteBpConnection {
  const entry = getSakuraEntry();
  if (entry.invitation || entry.error) return new SakuraRemoteBpConnection(entry.invitation, entry.error);
  switch (runtimeConfig.transport) {
    case "mock":
      return new MockRemoteBpConnection();
    case "webrtc":
      return new WebRtcRemoteBpConnection({
        signalingUrl: runtimeConfig.signalingUrl,
        iceServers: runtimeConfig.iceServers,
      });
  }
}
