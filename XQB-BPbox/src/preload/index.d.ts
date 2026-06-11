import type { BpAPI } from './types'

declare global {
  interface Window {
    bpAPI: BpAPI
  }
}
