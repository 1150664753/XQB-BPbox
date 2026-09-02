import { runtimeConfig } from "../config/runtime";
import { MockRemoteBpConnection } from "./MockRemoteBpConnection";
import type { RemoteBpConnection } from "./RemoteBpConnection";
import { WebRtcRemoteBpConnection } from "./WebRtcRemoteBpConnection";

export function createRemoteBpConnection(): RemoteBpConnection {
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
