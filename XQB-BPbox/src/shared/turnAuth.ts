export interface TurnAuthStatus {
  authorized: boolean
  expiresAt: number | null
  pendingRevocation: boolean
  message: string | null
}
export interface TurnAuthAPI {
  status: () => Promise<TurnAuthStatus>
  authorize: (password: string) => Promise<TurnAuthStatus>
  revoke: () => Promise<TurnAuthStatus>
  binding: (signalingUrl: string) => Promise<string | null>
  onChanged: (callback: () => void) => () => void
  onOpen: (callback: () => void) => () => void
}
