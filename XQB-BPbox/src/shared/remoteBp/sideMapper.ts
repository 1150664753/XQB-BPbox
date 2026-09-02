import type { BpSide } from '../types'
import type { RemotePlayerSide, RemoteSideMapping } from './types'

export const DEFAULT_REMOTE_SIDE_MAPPING: RemoteSideMapping = {
  first: 'star',
  second: 'rail'
}

export const SWAPPED_REMOTE_SIDE_MAPPING: RemoteSideMapping = {
  first: 'rail',
  second: 'star'
}

export function validateRemoteSideMapping(mapping: RemoteSideMapping): RemoteSideMapping {
  if (mapping.first === mapping.second) {
    throw new Error('先手和后手不能映射到同一个内部阵营')
  }
  return { ...mapping }
}

export function internalSideToRemoteSide(
  side: BpSide,
  mapping: RemoteSideMapping
): RemotePlayerSide {
  validateRemoteSideMapping(mapping)
  return mapping.first === side ? 'first' : 'second'
}

export function remoteSideToInternalSide(
  side: RemotePlayerSide,
  mapping: RemoteSideMapping
): BpSide {
  validateRemoteSideMapping(mapping)
  return mapping[side]
}
