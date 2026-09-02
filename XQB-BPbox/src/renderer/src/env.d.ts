/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_REMOTE_BP_HOST_TRANSPORT?: 'mock' | 'webrtc'
  readonly VITE_REMOTE_BP_SIGNALING_URL?: string
  readonly VITE_REMOTE_BP_ICE_SERVERS?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
