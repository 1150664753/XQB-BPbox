/** Optional v1 extensions, advertised in STATE_REQUEST. Legacy peers keep JSON/full states. */
export const REMOTE_BP_CAPABILITIES = ['state-delta-v1', 'asset-binary-v1']
type State = { sessionId: string; revision: number; [key: string]: unknown }
type Row = { id: string }
type Delta = {
  base: number
  sequence: number
  fields: Record<string, unknown>
  rows: Record<string, Row[]>
}
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

export class StateDeltaSender {
  private state: State | null = null
  private sequence = 0

  encode(
    type: string,
    input: { sessionId: string; revision: number }
  ): { type: string; payload: Record<string, unknown> } | null {
    const state = input as State
    const previous = this.state
    const sequence = this.sequence + 1
    const delta: Delta = { base: this.sequence, sequence, fields: {}, rows: {} }
    if (type === 'STATE_UPDATE' && previous?.sessionId === state.sessionId) {
      for (const key of Object.keys(state)) {
        if (same(previous[key], state[key])) continue
        if (key === 'characters' || key === 'lightCones') {
          const before = previous[key] as Row[],
            after = state[key] as Row[]
          if (before.length === after.length && before.every((row, i) => row.id === after[i]?.id)) {
            delta.rows[key] = after.filter((row, i) => !same(row, before[i]))
            continue
          }
        }
        delta.fields[key] = state[key]
      }
      // updatedAt is serialization time, not a change of authority/state.
      if (
        Object.keys(delta.fields).every((key) => key === 'updatedAt') &&
        !Object.keys(delta.rows).length
      )
        return null
    }
    const full = { type, payload: { state, stateSequence: sequence } }
    const result =
      previous?.sessionId === state.sessionId &&
      type === 'STATE_UPDATE' &&
      JSON.stringify(delta).length < JSON.stringify(full.payload).length
        ? { type: 'STATE_DELTA_V1', payload: delta as unknown as Record<string, unknown> }
        : full
    this.state = state
    this.sequence = sequence
    return result
  }
}

export class StateDeltaReceiver {
  private state: State | null = null
  private sequence: number | null = null

  /** The reconstructed state must still pass the normal complete state validator. */
  expand(payload: unknown): State {
    if (
      !object(payload) ||
      !this.state ||
      payload.base !== this.sequence ||
      !Number.isSafeInteger(payload.sequence) ||
      Number(payload.sequence) !== Number(payload.base) + 1 ||
      !object(payload.fields) ||
      !object(payload.rows)
    )
      throw new Error('STATE_DELTA_BASE_MISMATCH')
    const next = { ...this.state }
    for (const [key, value] of Object.entries(payload.fields)) {
      if (!Object.hasOwn(this.state, key) || key === '__proto__' || key === 'constructor')
        throw new Error('INVALID_STATE_DELTA')
      next[key] = value
    }
    for (const [key, changes] of Object.entries(payload.rows)) {
      if (
        (key !== 'characters' && key !== 'lightCones') ||
        !Array.isArray(changes) ||
        !Array.isArray(next[key])
      )
        throw new Error('INVALID_STATE_DELTA')
      const rows = next[key] as Row[],
        byId = new Map(rows.map((row, i) => [row.id, i]))
      const seen = new Set<string>(),
        updated = [...rows]
      for (const row of changes) {
        if (!object(row) || typeof row.id !== 'string' || !byId.has(row.id) || seen.has(row.id))
          throw new Error('INVALID_STATE_DELTA')
        seen.add(row.id)
        updated[byId.get(row.id)!] = row as Row
      }
      next[key] = updated
    }
    if (next.sessionId !== this.state.sessionId || next.revision < this.state.revision)
      throw new Error('INVALID_STATE_DELTA')
    return next
  }

  commit(state: { sessionId: string; revision: number }, sequence: unknown): void {
    this.state = state as State
    this.sequence = Number.isSafeInteger(sequence) && Number(sequence) > 0 ? Number(sequence) : null
  }
}

export interface BinaryAssetChunk {
  transferId: string
  assetId: string
  index: number
  total: number
  bytes: Uint8Array<ArrayBuffer>
}
const MAGIC = 0x58514231 // XQB1
export function encodeBinaryAssetChunk(
  chunk: Omit<BinaryAssetChunk, 'bytes'> & { data: string }
): ArrayBuffer {
  const { data, ...metadata } = chunk
  const header = new TextEncoder().encode(JSON.stringify(metadata))
  const binary = atob(data)
  const frame = new Uint8Array(8 + header.length + binary.length)
  const view = new DataView(frame.buffer)
  view.setUint32(0, MAGIC)
  view.setUint32(4, header.length)
  frame.set(header, 8)
  for (let i = 0; i < binary.length; i++) frame[8 + header.length + i] = binary.charCodeAt(i)
  if (header.length > 2048 || frame.length > 16 * 1024) throw new Error('ASSET_BINARY_TOO_LARGE')
  return frame.buffer
}

export function decodeBinaryAssetChunk(frame: ArrayBuffer): BinaryAssetChunk {
  if (frame.byteLength < 9 || frame.byteLength > 16 * 1024) throw new Error('INVALID_ASSET_BINARY')
  const view = new DataView(frame),
    length = view.getUint32(4)
  if (view.getUint32(0) !== MAGIC || length < 1 || length > 2048 || 8 + length >= frame.byteLength)
    throw new Error('INVALID_ASSET_BINARY')
  const value: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(frame, 8, length))
  )
  if (
    !object(value) ||
    typeof value.transferId !== 'string' ||
    !value.transferId.length ||
    value.transferId.length > 128 ||
    typeof value.assetId !== 'string' ||
    !value.assetId.length ||
    value.assetId.length > 256 ||
    !Number.isInteger(value.index) ||
    Number(value.index) < 0 ||
    Number(value.index) > 1_000_000 ||
    !Number.isInteger(value.total) ||
    Number(value.total) < 1 ||
    Number(value.total) > 1_000_000
  )
    throw new Error('INVALID_ASSET_BINARY')
  return {
    transferId: value.transferId,
    assetId: value.assetId,
    index: Number(value.index),
    total: Number(value.total),
    bytes: new Uint8Array(frame, 8 + length)
  }
}
