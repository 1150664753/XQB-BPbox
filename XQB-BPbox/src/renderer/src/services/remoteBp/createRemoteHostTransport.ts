import { MockRemoteHostTransport, type RemoteHostTransport } from '../../../../shared/remoteBp'
import { remoteBpRuntimeConfig } from '../../config/remoteBp'
import { WebRtcRemoteHostTransport } from './WebRtcRemoteHostTransport'
import { SakuraRemoteHostTransport } from './SakuraRemoteHostTransport'
import { SelectableRemoteHostTransport } from './SelectableRemoteHostTransport'

export function createRemoteHostTransport(): RemoteHostTransport {
  console.info('[Remote BP] host transport selected', {
    transport: remoteBpRuntimeConfig.transport,
    signalingUrl: remoteBpRuntimeConfig.signalingUrl
  })
  const create = (mode: 'webrtc' | 'sakura'): RemoteHostTransport =>
    mode === 'sakura'
      ? new SakuraRemoteHostTransport(window.bpAPI.sakura)
      : new WebRtcRemoteHostTransport({
          signalingUrl: remoteBpRuntimeConfig.signalingUrl,
          turnAuth: window.bpAPI.turnAuth,
          iceServers: remoteBpRuntimeConfig.iceServers
        })
  return new SelectableRemoteHostTransport(
    create,
    remoteBpRuntimeConfig.transport === 'mock' ? new MockRemoteHostTransport() : create('webrtc')
  )
}
