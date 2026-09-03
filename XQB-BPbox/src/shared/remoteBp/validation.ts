import type { RemoteBpAction } from './types'

export const REMOTE_BP_PROTOCOL_VERSION = '1.2.1' as const
export const MAX_REMOTE_BP_MESSAGE_BYTES = 512 * 1024

export type ValidatedRemoteClientMessage =
  | { type: 'ACTION_REQUEST'; payload: { action: RemoteBpAction } }
  | { type: 'STATE_REQUEST'; payload: { lastKnownRevision?: number } }
  | { type: 'ASSET_REQUEST'; payload: { assetIds: string[] } }
  | { type: 'PING'; payload: { clientTime: string } }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max
}

function isInteger(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isInteger(value) && Number(value) >= min && Number(value) <= max
}

function isRemoteSide(value: unknown): value is 'first' | 'second' {
  return value === 'first' || value === 'second'
}

function isIsoDate(value: unknown): value is string {
  return isString(value, 10, 64) && Number.isFinite(Date.parse(value))
}

function parseTarget(value: unknown): RemoteBpAction['targets'][number] | null {
  if (!isObject(value) || (value.kind !== 'CHARACTER' && value.kind !== 'LIGHT_CONE')) return null
  if (!isString(value.id, 1, 128)) return null
  if (value.side !== undefined && !isRemoteSide(value.side)) return null
  return {
    kind: value.kind,
    id: value.id,
    ...(value.side ? { side: value.side } : {})
  }
}

function parseAction(value: unknown): RemoteBpAction | null {
  if (!isObject(value)) return null
  if (!isString(value.actionId, 1, 128) || !isRemoteSide(value.actorSide)) return null
  if (!isInteger(value.expectedRevision, 0, 1_000_000_000)) return null
  if (value.stepIndex !== null && !isInteger(value.stepIndex, 0, 100_000)) return null
  if (!isIsoDate(value.createdAt) || !Array.isArray(value.targets)) return null

  const base = {
    actionId: value.actionId,
    actorSide: value.actorSide,
    expectedRevision: value.expectedRevision,
    stepIndex: value.stepIndex,
    createdAt: value.createdAt
  }
  const targets = value.targets.map(parseTarget)
  if (targets.some((target) => target === null)) return null

  switch (value.kind) {
    case 'SELECT':
    case 'BAN':
    case 'PICK':
      if (targets.length !== 1 || !targets[0]) return null
      return { ...base, kind: value.kind, targets: [targets[0]] }
    case 'DESELECT':
    case 'CONFIRM':
      if (targets.length !== 0) return null
      return { ...base, kind: value.kind, targets: [] }
    case 'PROTECT':
    case 'BORROW':
      if (targets.length !== 2 || !targets[0] || !targets[1]) return null
      return { ...base, kind: value.kind, targets: [targets[0], targets[1]] }
    case 'CUSTOM': {
      if (targets.length > 8 || !isObject(value.extension)) return null
      if (!isString(value.extension.name, 1, 64) || !isObject(value.extension.data)) return null
      if (Object.keys(value.extension.data).length > 32) return null
      const safeData: Record<string, string | number | boolean | null> = {}
      for (const [key, item] of Object.entries(value.extension.data)) {
        if (!isString(key, 1, 64)) return null
        if (
          item !== null &&
          typeof item !== 'string' &&
          typeof item !== 'number' &&
          typeof item !== 'boolean'
        )
          return null
        if (typeof item === 'string' && item.length > 512) return null
        if (typeof item === 'number' && !Number.isFinite(item)) return null
        safeData[key] = item
      }
      return {
        ...base,
        kind: 'CUSTOM',
        targets: targets as RemoteBpAction['targets'],
        extension: { name: value.extension.name, data: safeData }
      } as RemoteBpAction
    }
    default:
      return null
  }
}

export function parseRemoteClientMessage(raw: string): ValidatedRemoteClientMessage {
  if (new TextEncoder().encode(raw).byteLength > MAX_REMOTE_BP_MESSAGE_BYTES) {
    throw new Error('MESSAGE_TOO_LARGE')
  }
  let envelope: unknown
  try {
    envelope = JSON.parse(raw)
  } catch {
    throw new Error('INVALID_JSON')
  }
  if (!isObject(envelope)) throw new Error('INVALID_ENVELOPE')
  if (envelope.protocolVersion !== REMOTE_BP_PROTOCOL_VERSION) {
    throw new Error('UNSUPPORTED_PROTOCOL_VERSION')
  }
  if (!isString(envelope.messageId, 1, 128) || !isIsoDate(envelope.sentAt)) {
    throw new Error('INVALID_ENVELOPE')
  }
  if (!isObject(envelope.payload)) throw new Error('INVALID_PAYLOAD')

  switch (envelope.type) {
    case 'ACTION_REQUEST': {
      const action = parseAction(envelope.payload.action)
      if (!action) throw new Error('INVALID_ACTION')
      return { type: 'ACTION_REQUEST', payload: { action } }
    }
    case 'STATE_REQUEST': {
      const revision = envelope.payload.lastKnownRevision
      if (revision !== undefined && !isInteger(revision, 0, 1_000_000_000)) {
        throw new Error('INVALID_REVISION')
      }
      return {
        type: 'STATE_REQUEST',
        payload: revision === undefined ? {} : { lastKnownRevision: revision }
      }
    }
    case 'ASSET_REQUEST': {
      const assetIds = envelope.payload.assetIds
      if (
        !Array.isArray(assetIds) ||
        assetIds.length < 1 ||
        assetIds.length > 128 ||
        !assetIds.every((assetId) => isString(assetId, 1, 256))
      )
        throw new Error('INVALID_ASSET_REQUEST')
      return { type: 'ASSET_REQUEST', payload: { assetIds: [...new Set(assetIds)] } }
    }
    case 'PING':
      if (!isIsoDate(envelope.payload.clientTime)) throw new Error('INVALID_PING')
      return { type: 'PING', payload: { clientTime: envelope.payload.clientTime } }
    default:
      throw new Error('UNKNOWN_MESSAGE_TYPE')
  }
}
