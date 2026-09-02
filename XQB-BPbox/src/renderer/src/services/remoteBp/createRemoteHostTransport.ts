import { MockRemoteHostTransport, type RemoteHostTransport } from '../../../../shared/remoteBp'
import { remoteBpRuntimeConfig } from '../../config/remoteBp'
import { WebRtcRemoteHostTransport } from './WebRtcRemoteHostTransport'

export function createRemoteHostTransport(): RemoteHostTransport {
  if (remoteBpRuntimeConfig.transport === 'mock') return new MockRemoteHostTransport()
  return new WebRtcRemoteHostTransport({
    signalingUrl: remoteBpRuntimeConfig.signalingUrl,
    iceServers: remoteBpRuntimeConfig.iceServers
  })
}
