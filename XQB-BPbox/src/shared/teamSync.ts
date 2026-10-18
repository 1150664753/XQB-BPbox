/** Local Profile adapters describe JSON collections; the wire format is game independent. */
export interface ProfileCollection {
  type: string
  label: string
  store: string
  idField: string
  nameFields: string[]
  assetFields: Record<string, string>
  thumbnailField?: string
  dependenciesField?: string
}
export interface TeamProfile {
  id: string
  name: string
  /** Existing local registry identity; id remains the remote/legacy identity. */
  localProfileId?: string
  collections: ProfileCollection[]
}
export interface TeamRepository {
  owner: string
  repo: string
  branch: string
  clientId: string
}
export interface ResourceFile {
  path: string
  /** Canonical local assets/... path. Absent on legacy blob descriptors. */
  relativePath?: string
  sha256: string
  size: number
  extension: string
}
export interface TeamResource {
  id: string
  type: string
  name: string
  version: number
  hash: string
  properties: Record<string, unknown>
  files: Record<string, ResourceFile>
  dependencies: string[]
  thumbnail?: ResourceFile
}
export interface TeamManifest {
  schema: 1 | 2
  profileId: string
  objects: Record<string, TeamResource>
  stores?: Record<string, ResourceFile>
}
export type SyncStatus = 'added' | 'modified' | 'deleted' | 'conflict' | 'unchanged' | 'missing'
export type SyncDirection = 'upload' | 'download'
export function isDocumentResourceType(type: string | undefined): boolean {
  return type === 'configuration' || type === 'result'
}
export type ConflictChoice = 'local' | 'remote' | 'copy'
export interface ResourceDifference {
  field: string
  label: string
  kind: 'file' | 'property'
  local: unknown
  remote: unknown
}
export interface ResourceRow {
  id: string
  type: string
  typeLabel: string
  name: string
  upload: SyncStatus
  download: SyncStatus
  differences: ResourceDifference[]
  local?: TeamResource
  remote?: TeamResource
  problems: string[]
  fields?: ResourceField[]
}
export interface ResourceField {
  field: string
  label: string
  state: 'ready' | 'missing' | 'external' | 'excluded' | 'tooLarge' | 'invalid' | 'empty'
  message?: string
  localPath?: string
  remotePath?: string
  targetPath?: string
  needsTarget?: boolean
  upload: SyncStatus
  download: SyncStatus
}
/** A previously published file can be explicitly deleted even when its bytes are now missing. */
export function canPublishField(field: ResourceField): boolean {
  return (
    ['ready', 'empty'].includes(field.state) ||
    (field.state === 'missing' && ['deleted', 'conflict'].includes(field.upload))
  )
}
export interface SyncSnapshot {
  token: string
  head: string
  rows: ResourceRow[]
  offline: boolean
  warning?: string
  remoteState?: RemoteIndexState
  pending: number
  busyReason: string | null
}
export interface RemoteIndexState {
  status:
    | 'ready'
    | 'empty'
    | 'uninitialized'
    | 'index_missing'
    | 'index_invalid'
    | 'network_error'
    | 'permission_denied'
    | 'repository_unavailable'
    | 'branch_unavailable'
    | 'rate_limited'
    | 'remote_error'
  indexPath: string
  canInitialize: boolean
  head?: string
  existingFiles?: number
  resourceFiles?: string[]
  conflictRisk?: boolean
  previouslySynced?: boolean
}
export interface InitializeIndexRequest {
  profileId: string
  token: string
  acknowledgeConflictRisk: boolean
}
export interface SyncSelection {
  id: string
  resolution?: ConflictChoice
  /** Explicit resource fields, plus $properties for attributes. Undefined selects changed usable fields. */
  fields?: string[]
  /** User-confirmed destinations for legacy blobs that lost their original filenames. */
  paths?: Record<string, string>
}
export interface SyncRequest {
  profileId: string
  token: string
  direction: SyncDirection
  selections: SyncSelection[]
}
export interface SyncResult {
  message: string
  pending: boolean
  commit?: string
}
export interface SyncProgress {
  operationId: string
  profileId: string
  direction: SyncDirection
  stage:
    | 'scanning'
    | 'checking'
    | 'validating'
    | 'uploading'
    | 'committing'
    | 'downloading'
    | 'applying'
    | 'completed'
    | 'failed'
    | 'cancelled'
  total: number
  /** Successfully processed paths, including skipped paths. */
  completed: number
  skipped: number
  failed: number
  currentFile: string
  message: string
  cancellable: boolean
  /** Current network activity; separate from the phase description. */
  activity?: string
  elapsedSeconds?: number
  waitingSeconds?: number
}
export interface TeamSyncAPI {
  settings: () => Promise<{
    profiles: TeamProfile[]
    repository: TeamRepository
    authorized: boolean
  }>
  configure: (repository: TeamRepository) => Promise<void>
  authorize: () => Promise<{ userCode: string; verificationUri: string; expiresAt: number }>
  pollAuthorization: () => Promise<'pending' | 'authorized'>
  logout: () => Promise<void>
  inspect: (profileId: string) => Promise<SyncSnapshot>
  initialize: (request: InitializeIndexRequest) => Promise<SyncResult>
  preview: (
    token: string,
    id: string,
    side: 'local' | 'remote',
    field?: string
  ) => Promise<string | null>
  sync: (request: SyncRequest) => Promise<SyncResult>
  onProgress: (callback: (progress: SyncProgress) => void) => () => void
  cancel: (profileId: string, operationId: string) => Promise<boolean>
  applyPending: (profileId: string) => Promise<SyncResult>
  discardPending: (profileId: string) => Promise<void>
  importResource: (
    profileId: string,
    token: string,
    id: string,
    field: string,
    target: string
  ) => Promise<void>
}

export function resourceStatus(
  local: TeamResource | undefined,
  remote: TeamResource | undefined,
  base: string | null | undefined
): { upload: SyncStatus; download: SyncStatus } {
  const l = local?.hash ?? null
  const r = remote?.hash ?? null
  if (l === r) return { upload: 'unchanged', download: 'unchanged' }
  const localChanged = l !== (base ?? null)
  const remoteChanged = r !== (base ?? null)
  if (localChanged && remoteChanged) return { upload: 'conflict', download: 'conflict' }
  return {
    upload: localChanged ? (!local ? 'deleted' : !remote ? 'added' : 'modified') : 'unchanged',
    download: remoteChanged ? (!remote ? 'deleted' : !local ? 'added' : 'modified') : 'unchanged'
  }
}

export function resourceDifferences(
  local?: TeamResource,
  remote?: TeamResource,
  labels: Record<string, string> = {}
): ResourceDifference[] {
  const result: ResourceDifference[] = []
  for (const field of new Set([
    ...Object.keys(local?.files ?? {}),
    ...Object.keys(remote?.files ?? {})
  ])) {
    const l = local?.files[field]
    const r = remote?.files[field]
    if (
      l?.sha256 !== r?.sha256 ||
      l?.extension !== r?.extension ||
      l?.relativePath !== r?.relativePath
    )
      result.push({
        field,
        label: labels[field] ?? field,
        kind: 'file',
        local: l ?? null,
        remote: r ?? null
      })
  }
  const lp = { ...local?.properties, dependencies: local?.dependencies ?? [] }
  const rp = { ...remote?.properties, dependencies: remote?.dependencies ?? [] }
  for (const field of new Set([...Object.keys(lp), ...Object.keys(rp)])) {
    if (JSON.stringify(lp[field]) !== JSON.stringify(rp[field]))
      result.push({
        field,
        label: field,
        kind: 'property',
        local: lp[field] ?? null,
        remote: rp[field] ?? null
      })
  }
  return result
}
