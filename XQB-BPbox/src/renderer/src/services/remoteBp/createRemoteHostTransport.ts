import { MockRemoteHostTransport, type RemoteHostTransport } from '../../../../shared/remoteBp'
import { remoteBpRuntimeConfig } from '../../config/remoteBp'
import { WebRtcRemoteHostTransport } from './WebRtcRemoteHostTransport'

export function createRemoteHostTransport(): RemoteHostTransport {
  console.info('[Remote BP] host transport selected', {
    transport: remoteBpRuntimeConfig.transport,
    signalingUrl: remoteBpRuntimeConfig.signalingUrl
  })
  if (remoteBpRuntimeConfig.transport === 'mock') return new MockRemoteHostTransport()
  return new WebRtcRemoteHostTransport({
    signalingUrl: remoteBpRuntimeConfig.signalingUrl,
    turnAuth: window.bpAPI.turnAuth,
    testOnlyForceRelay: import.meta.env.DEV && import.meta.env.VITE_REMOTE_BP_TEST_FORCE_RELAY === '1',
    iceServers: remoteBpRuntimeConfig.iceServers
  })
}
