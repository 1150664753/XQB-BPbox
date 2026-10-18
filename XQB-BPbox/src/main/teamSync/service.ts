import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { dirname, extname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  ResourceFile,
  ResourceField,
  SyncRequest,
  SyncResult,
  SyncSnapshot,
  TeamManifest,
  TeamProfile,
  TeamResource,
  SyncStatus,
  SyncProgress
} from '../../shared/teamSync'
import type { InitializeIndexRequest, RemoteIndexState } from '../../shared/teamSync'
import { canPublishField, isDocumentResourceType, resourceDifferences } from '../../shared/teamSync'
import {
  LocalProfile,
  atomicJson,
  inside,
  jsonRead,
  transaction,
  type LocalSnapshot
} from './localProfile'
import {
  digest,
  indexPath,
  legacyIndexPath,
  MAX_INDEX_BYTES,
  MAX_FILE_BYTES,
  validateManifest,
  validateFile,
  assetPath,
  sharedPath,
  isSyncDocument,
  isVideo,
  pathDescriptor,
  prefix,
  resourceHash,
  unitHash,
  assertShareable
} from './model'
import { GitHubError, type RemoteHead, type RemoteStore, type RemoteOperation } from './github'
import { sha256File } from '../fileHash'
import {
  configuration,
  configBytes,
  reconcileConfiguration,
  updateConfigDocument,
  validateConfiguration
} from './configuration'
import { sharedStores } from './sharedStores'

type Units = Record<string, Record<string, string | null>>
interface Pending {
  format: 2
  updates: Record<string, TeamResource | null>
  expected: Record<string, string | null>
  copies: string[]
  masks: Record<string, string[]>
  assets: { file: ResourceFile; target: string }[]
  targets: Record<string, string | null>
  units: Units
}
interface State {
  base: Record<string, string | null>
  units?: Units
  cached?: { manifest: TeamManifest; head: RemoteHead }
  pending?: Pending
}
interface View {
  result: SyncSnapshot
  local: LocalSnapshot
  remote: TeamManifest
  head: RemoteHead
  targets: Record<string, string | null>
}
class IndexUnavailable extends Error {
  constructor(
    message: string,
    public detail: RemoteIndexState,
    public head: RemoteHead
  ) {
    super(message)
  }
}
interface RemoteIndex {
  manifest: TeamManifest
  head: RemoteHead
  path: string
}
export interface TeamSyncDependencies {
  root: string
  profile: TeamProfile
  repositoryKey: string
  remote: RemoteStore
  busy: () => string | null
  resolveAsset?: (path: string) => string
  previewImage?: (bytes: Buffer) => Buffer | null
  changed?: () => void
  progress?: (progress: SyncProgress) => void
  log?: (entry: object) => void
}
function status(
  l: string | null,
  r: string | null,
  base: string | null | undefined
): { upload: SyncStatus; download: SyncStatus } {
  if (l === r) return { upload: 'unchanged', download: 'unchanged' }
  const lc = l !== (base ?? null),
    rc = r !== (base ?? null)
  if (lc && rc) return { upload: 'conflict', download: 'conflict' }
  return {
    upload: lc ? (!l ? 'deleted' : !r ? 'added' : 'modified') : 'unchanged',
    download: rc ? (!r ? 'deleted' : !l ? 'added' : 'modified') : 'unchanged'
  }
}
function mergeUnits(state: State, units: Units): void {
  state.units ??= {}
  for (const [id, fields] of Object.entries(units))
    state.units[id] = { ...state.units[id], ...fields }
}

export class TeamSyncService {
  private statePath: string
  private legacyStatePath: string
  private local: LocalProfile
  private view?: View
  private locked = false
  private task?: { controller: AbortController; progress: SyncProgress }
  constructor(private deps: TeamSyncDependencies) {
    this.local = new LocalProfile(deps.root, deps.profile, deps.resolveAsset)
    const dir = `.team-sync/${digest(deps.repositoryKey)}/${deps.profile.id}`
    this.statePath = inside(deps.root, `${dir}.paths-v2.json`)
    this.legacyStatePath = inside(deps.root, `${dir}.json`)
  }
  private state(): State {
    return jsonRead(this.statePath, jsonRead(this.legacyStatePath, { base: {} }))
  }
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.locked) throw new Error('团队资源正在处理，请等待当前操作完成')
    this.locked = true
    try {
      return await fn()
    } finally {
      this.locked = false
    }
  }
  private async remote(options?: RemoteOperation): Promise<RemoteIndex> {
    const head = await this.deps.remote.head(options)
    const path = indexPath(this.deps.profile.id),
      legacy = legacyIndexPath(this.deps.profile.id)
    const bytes = head.empty
      ? null
      : await this.deps.remote.read(path, head.sha, MAX_INDEX_BYTES, options)
    const oldBytes = head.empty
      ? null
      : await this.deps.remote.read(legacy, head.sha, MAX_INDEX_BYTES, options)
    if (bytes || oldBytes) {
      try {
        if (bytes && oldBytes) throw new Error('新旧位置同时存在索引，请人工核对并保留唯一权威索引')
        return {
          manifest: validateManifest(
            JSON.parse((bytes ?? oldBytes)!.toString()),
            this.deps.profile
          ),
          head,
          path: bytes ? path : legacy
        }
      } catch (error) {
        throw new IndexUnavailable(
          `远程索引格式损坏：${(error as Error).message}；请恢复有效索引`,
          { status: 'index_invalid', indexPath: bytes ? path : legacy, canInitialize: false },
          head
        )
      }
    }
    const paths = await this.deps.remote.inventory(head, options)
    const resourceFiles = paths.filter((p) => !/\.md$/i.test(p))
    const state = this.state()
    const previouslySynced = Boolean(
      state.cached ||
      Object.values(state.base).some(Boolean) ||
      Object.keys(state.units ?? {}).length
    )
    const status =
      head.empty || !paths.length
        ? 'empty'
        : previouslySynced || resourceFiles.length
          ? 'index_missing'
          : 'uninitialized'
    const conflictRisk = resourceFiles.length > 0
    throw new IndexUnavailable(
      `${previouslySynced ? '远程团队索引缺失（此前已同步，索引可能被删除）' : status === 'empty' ? '远程仓库为空，尚无团队索引' : status === 'uninitialized' ? '仓库仅有 Markdown 文件，尚无团队索引' : '远程团队索引缺失（可能被删除或尚未初始化）'}。` +
        (conflictRisk ? '仓库已有其他文件，存在数据冲突风险；请先备份并核对。' : '') +
        (head.writable
          ? '可手动初始化远程索引。'
          : '尚未确认仓库写入权限，无法初始化；请检查授权账号的 Contents 写入权限。') +
        '已保留本地资源和上次索引。',
      {
        status,
        indexPath: path,
        canInitialize: head.writable === true,
        head: head.sha,
        existingFiles: paths.length,
        resourceFiles: resourceFiles.slice(0, 20),
        conflictRisk,
        previouslySynced
      },
      head
    )
  }
  private fieldNames(l?: TeamResource, r?: TeamResource): string[] {
    const c = this.deps.profile.collections.find((c) => c.type === (l?.type ?? r?.type))
    return [
      '$properties',
      ...new Set([
        ...Object.keys(c?.assetFields ?? {}),
        ...Object.keys(l?.files ?? {}),
        ...Object.keys(r?.files ?? {})
      ])
    ]
  }
  private baseline(state: State, id: string, remote?: TeamResource): Record<string, string | null> {
    const fields = { ...state.units?.[id] }
    if (remote && state.base[id] === remote.hash)
      for (const f of this.fieldNames(undefined, remote))
        if (!Object.hasOwn(fields, f)) fields[f] = unitHash(remote, f)
    return fields
  }
  private async targetHash(path: string): Promise<string | null> {
    const target = inside(this.deps.root, sharedPath(path)),
      source =
        !path.startsWith('assets/') || existsSync(target)
          ? target
          : (this.deps.resolveAsset?.(path) ?? target)
    try {
      if (isSyncDocument(path))
        return digest(
          configBytes(
            configuration(JSON.parse((await readFile(source)).toString()), this.deps.root).content
          )
        )
      return await sha256File(source)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new Error(`本地目标不可读取：${path}`)
    }
  }
  inspect(): Promise<SyncSnapshot> {
    return this.exclusive(async () => {
      const local = await this.local.scan(),
        state = this.state()
      let remote: { manifest: TeamManifest; head: RemoteHead }, warning: string | undefined
      let remoteState: RemoteIndexState
      try {
        const current = await this.remote({ operationId: randomUUID() })
        remote = current
        remoteState = { status: 'ready', indexPath: current.path, canInitialize: false }
        state.cached = remote
        atomicJson(this.statePath, state)
      } catch (error) {
        warning = (error as Error).message
        remoteState =
          error instanceof IndexUnavailable
            ? error.detail
            : {
                status:
                  error instanceof GitHubError
                    ? [401, 403].includes(error.status) && error.kind !== 'rate_limited'
                      ? 'permission_denied'
                      : error.kind
                    : 'remote_error',
                indexPath: indexPath(this.deps.profile.id),
                canInitialize: false
              }
        remote = state.cached ?? {
          manifest: { schema: 2, profileId: this.deps.profile.id, objects: {} },
          head: { sha: '', tree: '' }
        }
        validateManifest(remote.manifest, this.deps.profile)
      }
      const targets: Record<string, string | null> = {},
        rows: SyncSnapshot['rows'] = []
      for (const id of new Set([
        ...Object.keys(local.objects),
        ...Object.keys(remote.manifest.objects),
        ...Object.keys(state.base),
        ...Object.keys(state.units ?? {})
      ])) {
        const l = local.objects[id],
          r = remote.manifest.objects[id]
        if (!l && !r) continue
        const c = this.deps.profile.collections.find(
            (c) => c.type === (l?.resource.type ?? r.type)
          ),
          base = this.baseline(state, id, r),
          fields: ResourceField[] = []
        for (const field of new Set([
          ...this.fieldNames(l?.resource, r),
          ...Object.keys(l?.fields ?? {})
        ])) {
          const f: ResourceField = {
            ...(l?.fields[field] ?? {
              field,
              label: field === '$properties' ? '属性配置' : (c?.assetFields[field] ?? field),
              state: 'empty'
            }),
            ...status(unitHash(l?.resource, field), unitHash(r, field), base[field])
          }
          if (field === '$properties' && !l?.fields[field]) {
            f.state = 'ready'
            // Recreating a locally deleted object also needs its metadata, even at the same head.
            if (!l && r && f.download === 'unchanged') f.download = 'missing'
          }
          const rf = r?.files[field]
          if (
            field !== '$properties' &&
            (isVideo(rf?.path ?? '', field) || f.state === 'excluded')
          ) {
            f.state = 'excluded'
            f.message = '视频不参与上传或下载'
            f.upload = f.download = 'unchanged'
          } else if (rf) {
            f.remotePath = rf.path
            f.targetPath = rf.relativePath ?? this.local.legacyTarget(local, id, field, r)
            f.needsTarget = !f.targetPath
            if (f.targetPath) {
              if (!Object.hasOwn(targets, f.targetPath))
                targets[f.targetPath] = await this.targetHash(f.targetPath)
              if (targets[f.targetPath] !== null && targets[f.targetPath] !== rf.sha256)
                f.download = 'conflict'
              else if (
                targets[f.targetPath] === null &&
                ['missing', 'empty'].includes(f.state) &&
                (l || base[field])
              ) {
                // A missing destination is recoverable independently of the three-way baseline.
                // A changed local reference still requires review before replacing that reference.
                f.download = f.localPath && f.localPath !== f.targetPath ? 'conflict' : 'missing'
              } else if (!l && f.download === 'unchanged') f.download = 'missing'
            } else if (
              !l?.resource.files[field] &&
              ['missing', 'empty'].includes(f.state) &&
              f.download === 'unchanged'
            ) {
              // Legacy manifests still require the user to confirm the original destination.
              f.download = 'missing'
            }
          }
          if (!canPublishField(f) && f.state !== 'excluded') f.upload = 'unchanged'
          // Without a valid index, cached differences are informational only. In
          // particular never present missing metadata as a remote deletion plan.
          if (warning) f.upload = f.download = 'unchanged'
          fields.push(f)
        }
        const aggregate = (direction: 'upload' | 'download'): SyncStatus => {
          const values = fields.map((f) => f[direction])
          if (values.includes('conflict')) return 'conflict'
          if (values.includes('missing')) return 'missing'
          if (values.every((v) => v === 'unchanged')) return 'unchanged'
          return !(direction === 'upload' ? l : r)
            ? 'deleted'
            : !(direction === 'upload' ? r : l)
              ? 'added'
              : 'modified'
        }
        rows.push({
          id,
          type: l?.resource.type ?? r.type,
          name: l?.resource.name ?? r.name,
          typeLabel:
            c?.label ?? ((l?.resource.type ?? r.type) === 'result' ? '结果文件' : '配置文件'),
          upload: aggregate('upload'),
          download: aggregate('download'),
          fields,
          local: l?.resource,
          remote: r,
          differences: resourceDifferences(l?.resource, r, c?.assetFields).filter(
            (d) => d.kind !== 'file' || !isVideo(r?.files[d.field]?.path ?? '', d.field)
          ),
          problems: [
            ...(l?.problems ?? []),
            ...(!c && !isDocumentResourceType(l?.resource.type ?? r.type)
              ? ['当前 Profile 未配置该对象类型映射']
              : [])
          ]
        })
      }
      const result: SyncSnapshot = {
        token: randomUUID(),
        head: remote.head.sha,
        rows,
        offline: Boolean(warning),
        warning,
        remoteState,
        pending: Object.keys(state.pending?.updates ?? {}).length,
        busyReason: this.deps.busy()
      }
      this.view = { result, local, remote: remote.manifest, head: remote.head, targets }
      return result
    })
  }
  private requireView(token: string): View {
    if (!this.view || this.view.result.token !== token) throw new Error('差异快照已过期，请刷新')
    return this.view
  }
  private cachePath(file: ResourceFile): string {
    return inside(this.deps.root, `.team-sync/downloads/${file.sha256}${file.extension}`)
  }
  private async download(
    file: ResourceFile,
    head: string,
    options?: RemoteOperation
  ): Promise<string> {
    validateFile(file, this.deps.profile.id)
    if (isVideo(file.path)) throw new Error('视频不参与同步')
    const path = this.cachePath(file)
    if (existsSync(path) && (await sha256File(path)) === file.sha256) return path
    const bytes = await this.deps.remote.read(file.path, head, file.size + 1, options)
    if (!bytes || bytes.length !== file.size || digest(bytes) !== file.sha256)
      throw new Error(`下载 SHA-256 校验失败：${file.path}`)
    mkdirSync(dirname(path), { recursive: true })
    const temp = `${path}.${randomUUID()}.tmp`
    writeFileSync(temp, bytes)
    renameSync(temp, path)
    return path
  }
  async preview(
    token: string,
    id: string,
    side: 'local' | 'remote',
    field?: string
  ): Promise<string | null> {
    const view = this.requireView(token),
      resource = side === 'local' ? view.local.objects[id]?.resource : view.remote.objects[id]
    if (!resource) return null
    const c = this.deps.profile.collections.find((c) => c.type === resource.type),
      key = field ?? c?.thumbnailField
    const file =
      side === 'remote' && !field ? resource.thumbnail : key ? resource.files[key] : undefined
    if (
      !file ||
      !/^\.(png|jpe?g|webp|gif|avif|apng)$/.test(file.extension) ||
      file.size > 20 * 1024 * 1024 ||
      (!field && side === 'remote' && file.size > 512 * 1024)
    )
      return null
    const source =
      side === 'remote'
        ? await this.download(file, view.head.sha)
        : key
          ? view.local.objects[id]?.sources[key]
          : undefined
    if (!source) return null
    const bytes = await readFile(source)
    if (digest(bytes) !== file.sha256) throw new Error('预览文件已变化，请刷新')
    const rendered = this.deps.previewImage?.(bytes)
    return rendered ? `data:image/png;base64,${rendered.toString('base64')}` : null
  }
  sync(request: SyncRequest): Promise<SyncResult> {
    return this.runTask(request.direction, (options) => this.performSync(request, options))
  }
  initialize(request: InitializeIndexRequest): Promise<SyncResult> {
    return this.runTask('upload', async (options) => {
      const view = this.requireView(request.token)
      if (request.profileId !== this.deps.profile.id || !view.result.remoteState?.canInitialize)
        throw new Error('请先刷新并确认远程索引缺失及仓库写入权限')
      if (this.state().pending) throw new Error('请先应用或取消待应用下载，再初始化')
      let missing: IndexUnavailable
      try {
        await this.remote(options)
        throw new Error('远程索引已存在，请刷新差异后正常同步')
      } catch (error) {
        if (!(error instanceof IndexUnavailable) || !error.detail.canInitialize) throw error
        missing = error
      }
      if (missing.head.sha !== view.result.remoteState.head)
        throw new Error('远程分支已变化，请刷新后重新确认初始化')
      if (missing.detail.conflictRisk && request.acknowledgeConflictRisk !== true)
        throw new Error('仓库已有资源但索引缺失，存在数据冲突风险；请先确认风险')
      const selections = view.result.rows
        .filter((row) => row.local)
        .map((row) => {
          const fields = row
            .fields!.filter((f) => ['ready', 'empty'].includes(f.state))
            .map((f) => f.field)
          if (!fields.includes('$properties'))
            throw new Error(`${row.name} 的属性不可共享，请修复后初始化`)
          return { id: row.id, fields, resolution: 'local' as const }
        })
      const initial: RemoteIndex = {
        head: missing.head,
        path: indexPath(this.deps.profile.id),
        manifest: { schema: 2, profileId: this.deps.profile.id, objects: {} }
      }
      const result = await this.performSync(
        { profileId: request.profileId, token: request.token, direction: 'upload', selections },
        { ...options, createOnly: true },
        initial
      )
      return {
        ...result,
        message: '远程索引初始化完成，已按原目录发布可共享的本地资源；已有文件保持原样'
      }
    })
  }
  private runTask(
    direction: SyncRequest['direction'],
    action: (options: RemoteOperation) => Promise<SyncResult>
  ): Promise<SyncResult> {
    return this.exclusive(async () => {
      const controller = new AbortController()
      const progress: SyncProgress = {
        operationId: randomUUID(),
        profileId: this.deps.profile.id,
        direction,
        stage: 'scanning',
        total: 0,
        completed: 0,
        skipped: 0,
        failed: 0,
        currentFile: '',
        message: '扫描并核对所选资源',
        cancellable: true
      }
      this.task = { controller, progress }
      const startedAt = Date.now()
      let updatedAt = startedAt
      const report = (update: Partial<SyncProgress>): void => {
        const previousStage = progress.stage
        updatedAt = Date.now()
        Object.assign(progress, update)
        progress.elapsedSeconds = Math.floor((updatedAt - startedAt) / 1000)
        progress.waitingSeconds = 0
        try {
          this.deps.progress?.({ ...progress })
          if (update.stage && (update.stage !== previousStage || update.stage === 'scanning'))
            this.deps.log?.({ event: 'sync-stage', ...progress })
        } catch {
          /* Diagnostics must not interrupt the task. */
        }
      }
      const heartbeat = setInterval(() => {
        progress.elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000)
        progress.waitingSeconds = Math.floor((Date.now() - updatedAt) / 1000)
        try {
          this.deps.progress?.({ ...progress })
        } catch {
          /* UI diagnostics are optional. */
        }
      }, 1000)
      heartbeat.unref()
      report({ stage: 'scanning' })
      try {
        const result = await action({
          signal: controller.signal,
          operationId: progress.operationId,
          onProgress: report
        })
        report({ stage: 'completed', currentFile: '', message: result.message, cancellable: false })
        return result
      } catch (error) {
        const cancelled = controller.signal.aborted
        report({
          stage: cancelled ? 'cancelled' : 'failed',
          message: cancelled ? '同步已取消，未发布的资源可重新选择上传' : (error as Error).message,
          failed: cancelled ? progress.failed : Math.max(1, progress.failed),
          cancellable: false
        })
        throw cancelled ? controller.signal.reason : error
      } finally {
        clearInterval(heartbeat)
        this.task = undefined
      }
    })
  }
  cancel(operationId: string): boolean {
    if (
      !this.task ||
      this.task.progress.operationId !== operationId ||
      !this.task.progress.cancellable
    )
      return false
    this.task.controller.abort(new Error('同步已取消，未更新远程分支'))
    return true
  }
  private async performSync(
    request: SyncRequest,
    options: RemoteOperation,
    initial?: RemoteIndex
  ): Promise<SyncResult> {
    const original = this.requireView(request.token)
    if (original.result.offline && !initial)
      throw new Error('远程索引未就绪，请刷新或手动初始化后再同步')
    const view = initial ? { ...original, remote: initial.manifest } : original
    if (
      request.profileId !== this.deps.profile.id ||
      !['upload', 'download'].includes(request.direction) ||
      !Array.isArray(request.selections) ||
      (!request.selections.length && !initial) ||
      request.selections.length > 2000
    )
      throw new Error('无效的同步选择')
    const selected = new Map(request.selections.map((s) => [s.id, s]))
    if (selected.size !== request.selections.length) throw new Error('选择了重复的对象')
    const state = this.state()
    if (state.pending) throw new Error('请先应用或取消待应用下载，再发起新的同步')
    const scanned = new Set<string>()
    let scanning = ''
    options.onProgress?.({
      stage: 'scanning',
      total: 0,
      completed: 0,
      skipped: 0,
      failed: 0,
      currentFile: '',
      message: '扫描本地资源，发现文件后逐项校验'
    })
    const local = await this.local.scan(options.signal, (path) => {
      if (scanning) scanned.add(scanning)
      scanning = path
      options.onProgress?.({ currentFile: path, completed: scanned.size })
    })
    if (scanning) scanned.add(scanning)
    options.onProgress?.({
      completed: scanned.size,
      total: scanned.size,
      currentFile: '',
      message: '核对远程索引'
    })
    const latest = initial ?? (await this.remote(options)),
      nextManifest: TeamManifest = { ...structuredClone(latest.manifest), schema: 2 }
    if (
      initial &&
      (Object.keys(local.objects).length !== Object.keys(view.local.objects).length ||
        Object.entries(local.objects).some(
          ([id, object]) => object.revision !== view.local.objects[id]?.revision
        ))
    )
      throw new Error('初始化预览后本地版本已变化，请刷新差异')
    const uploads = new Set<string>(),
      updates = new Map<string, TeamResource | null>(),
      copies = new Set<string>()
    const masks: Record<string, string[]> = {},
      uploadMasks: Record<string, string[]> = {},
      units: Units = {},
      uploadUnits: Units = {},
      expected: Record<string, string | null> = {},
      assets: Pending['assets'] = [],
      targets: Pending['targets'] = {}
    const assertReviewed = (id: string): void => {
      if ((view.remote.objects[id]?.hash ?? null) !== (latest.manifest.objects[id]?.hash ?? null))
        throw new Error('所选资源的远程版本已变化，请刷新并重新确认冲突选择')
      if ((view.local.objects[id]?.revision ?? null) !== (local.objects[id]?.revision ?? null))
        throw new Error('所选资源的本地版本已变化，请刷新差异')
    }
    const downloadObject = async (
      id: string,
      fields: string[],
      paths: Record<string, string> = {},
      resolution?: string
    ): Promise<void> => {
      const l = local.objects[id],
        r = latest.manifest.objects[id]
      masks[id] = fields
      expected[id] = l?.revision ?? null
      units[id] ??= {}
      if (!r) {
        updates.set(id, null)
        for (const f of this.fieldNames(l?.resource)) units[id][f] = null
        return
      }
      const next: TeamResource = structuredClone(l?.resource ?? { ...r, files: {} })
      if (!l && !fields.includes('$properties')) throw new Error('新对象需要一并选择属性配置')
      if (fields.includes('$properties')) {
        assertShareable(r.properties)
        assertShareable(r.name)
        next.properties = structuredClone(r.properties)
        next.name = r.name
        next.dependencies = [...r.dependencies]
      }
      for (const field of fields) {
        units[id][field] = unitHash(r, field)
        if (field === '$properties') continue
        const file = r.files[field]
        if (!file) {
          delete next.files[field]
          continue
        }
        const target =
          file.relativePath ?? paths[field] ?? this.local.legacyTarget(local, id, field, r)
        if (!target)
          throw new Error(`${r.name}：旧版 ${field} 未保存原文件名，请在详情中确认分类目标路径`)
        sharedPath(target)
        if (extname(target).toLowerCase() !== file.extension)
          throw new Error('目标文件扩展名与远程资源不一致')
        const current = await this.targetHash(target)
        if (!Object.hasOwn(view.targets, target) && current !== null && current !== file.sha256)
          throw new Error(`旧版资源的手动目标已存在不同内容：${target}，请选择未占用的分类文件名`)
        if (Object.hasOwn(view.targets, target) && view.targets[target] !== current)
          throw new Error('目标文件已在预览后变化，请刷新差异')
        if (
          current !== null &&
          current !== file.sha256 &&
          !['remote', 'copy'].includes(resolution ?? '')
        )
          throw new Error(`目标文件冲突：${target}，请选择采用远程或另存副本`)
        if (
          assets.some(
            (a) =>
              a.target.toLowerCase() === target.toLowerCase() &&
              (a.file.sha256 !== file.sha256 || a.target !== target)
          )
        )
          throw new Error('选中资源对同一路径要求不同内容或大小写，无法应用')
        targets[target] = current
        assets.push({ file, target })
        next.files[field] = pathDescriptor(this.deps.profile.id, target, file.sha256, file.size)
      }
      if (isDocumentResourceType(next.type)) {
        reconcileConfiguration(next, fields)
        updateConfigDocument(next, this.deps.profile.id)
        validateConfiguration(next, this.deps.profile.id)
      }
      next.hash = resourceHash(next)
      updates.set(id, next)
    }
    for (const [id, selection] of selected) {
      options.signal?.throwIfAborted()
      const row = view.result.rows.find((r) => r.id === id)
      if (
        !row ||
        (!isDocumentResourceType(row.type) &&
          !this.deps.profile.collections.some((c) => c.type === row.type))
      )
        throw new Error('无效的对象选择')
      assertReviewed(id)
      if (selection.resolution && !['local', 'remote', 'copy'].includes(selection.resolution))
        throw new Error('无效的冲突处理方式')
      const choice = selection.resolution ?? (request.direction === 'upload' ? 'local' : 'remote'),
        publish = choice === 'local' && request.direction === 'upload'
      const fields = [
        ...(selection.fields ??
          row
            .fields!.filter(
              (f) =>
                f.state !== 'excluded' &&
                (!publish || canPublishField(f)) &&
                f[publish ? 'upload' : 'download'] !== 'unchanged'
            )
            .map((f) => f.field))
      ]
      if (
        isDocumentResourceType(row.type) &&
        (fields.includes('document') || fields.includes('$properties'))
      )
        for (const f of ['document', '$properties']) if (!fields.includes(f)) fields.push(f)
      if (
        !Array.isArray(fields) ||
        !fields.length ||
        new Set(fields).size !== fields.length ||
        fields.some((f) => !row.fields!.some((v) => v.field === f && v.state !== 'excluded'))
      )
        throw new Error('请选择有效的属性或资源文件（视频不参与同步）')
      if (
        fields.some(
          (f) => row.fields!.find((v) => v.field === f)![request.direction] === 'conflict'
        ) &&
        !selection.resolution
      )
        throw new Error(`请先处理冲突：${row.name}`)
      if (publish) {
        const l = local.objects[id],
          r = latest.manifest.objects[id]
        if (fields.some((f) => !canPublishField(row.fields!.find((v) => v.field === f)!)))
          throw new Error('所选文件缺失、过大或属于外部路径，请跳过或先导入')
        if (!l) {
          delete nextManifest.objects[id]
          uploadUnits[id] = Object.fromEntries(this.fieldNames(undefined, r).map((f) => [f, null]))
        } else {
          if (!r && !fields.includes('$properties')) throw new Error('新对象需要一并选择属性配置')
          const next = structuredClone(r ?? { ...l.resource, files: {} })
          if (fields.includes('$properties')) {
            assertShareable(l.resource.properties)
            assertShareable(l.resource.name)
            next.properties = structuredClone(l.resource.properties)
            next.name = l.resource.name
            next.dependencies = l.resource.dependencies
          }
          uploadUnits[id] = {}
          for (const f of fields) {
            if (f !== '$properties') {
              if (l.resource.files[f]) next.files[f] = l.resource.files[f]
              else delete next.files[f]
            }
            uploadUnits[id][f] = unitHash(l.resource, f)
          }
          if (isDocumentResourceType(next.type)) {
            reconcileConfiguration(next, fields)
            updateConfigDocument(next, this.deps.profile.id)
            validateConfiguration(next, this.deps.profile.id)
            if (!fields.includes('document')) fields.push('document')
            uploadUnits[id].document = unitHash(next, 'document')
          }
          next.version = (r?.version ?? 0) + 1
          next.hash = resourceHash(next)
          nextManifest.objects[id] = next
        }
        uploadMasks[id] = fields
        uploads.add(id)
      } else if (choice === 'local')
        units[id] = Object.fromEntries(
          fields.map((f) => [f, unitHash(latest.manifest.objects[id], f)])
        )
      else {
        if (choice === 'copy' && local.objects[id]) copies.add(id)
        await downloadObject(id, fields, selection.paths, selection.resolution)
      }
    }
    const visited = new Set<string>()
    const dependencies = async (r: TeamResource): Promise<void> => {
      if (visited.has(r.id)) return
      visited.add(r.id)
      for (const id of r.dependencies) {
        const remote = latest.manifest.objects[id]
        if (!remote) throw new Error(`远程索引缺少必要依赖：${id}`)
        if (!updates.has(id)) {
          if (local.objects[id]) {
            if (
              this.fieldNames(local.objects[id].resource, remote)
                .filter((f) => !isVideo(remote.files[f]?.path ?? '', f))
                .some((f) => unitHash(local.objects[id].resource, f) !== unitHash(remote, f))
            )
              throw new Error(`依赖 ${remote.name} 有本地差异，请一并选择并处理冲突`)
            continue
          }
          assertReviewed(id)
          if (
            !isDocumentResourceType(remote.type) &&
            !this.deps.profile.collections.some((c) => c.type === remote.type)
          )
            throw new Error('依赖类型未配置')
          await downloadObject(
            id,
            this.fieldNames(undefined, remote).filter(
              (f) => !isVideo(remote.files[f]?.path ?? '', f)
            )
          )
        }
        if (!updates.get(id)) throw new Error('所选对象仍依赖将删除的资源')
        await dependencies(updates.get(id)!)
      }
    }
    for (const r of updates.values()) if (r) await dependencies(r)
    for (const r of Object.values(nextManifest.objects))
      for (const id of r.dependencies)
        if (!nextManifest.objects[id])
          throw new Error(`发布缺少 ${r.name} 的必要依赖，请一并选择依赖资源`)
    this.checkLocalDependencies(local, updates, copies)
    this.local.changes(local, updates, copies, masks)
    for (const a of assets)
      if (targets[a.target] !== null && targets[a.target] !== a.file.sha256)
        this.local.assertReferences(local, a.target, masks)
    const files = new Map<string, Buffer | null>(),
      checkedFiles = new Map<string, string>(),
      remoteHashes = new Map<string, string | null>(),
      skippedPaths = new Set<string>(),
      manifestPaths = new Map<string, ResourceFile>()
    const preparePaths = new Set<string>()
    for (const id of uploads) {
      const resource = nextManifest.objects[id]
      for (const field of uploadMasks[id]) {
        const file = resource?.files[field]
        if (file) preparePaths.add(file.path)
      }
      const removed = latest.manifest.objects[id]
      if (!resource && removed && isDocumentResourceType(removed.type))
        preparePaths.add(removed.files.document.path)
    }
    const prepared = new Set<string>()
    const reportPrepared = (path: string): void => {
      prepared.add(path)
      options.onProgress?.({ completed: prepared.size, skipped: skippedPaths.size })
    }
    if (uploads.size || initial)
      options.onProgress?.({
        stage: 'checking',
        total: preparePaths.size,
        completed: 0,
        skipped: 0,
        failed: 0,
        currentFile: '',
        message: '核对文件内容并准备上传队列'
      })
    for (const r of Object.values(nextManifest.objects))
      for (const file of Object.values(r.files)) {
        if (!file.relativePath) continue
        const old = manifestPaths.get(file.path.toLowerCase())
        if (old && (old.sha256 !== file.sha256 || old.path !== file.path))
          throw new Error(`共享路径冲突：${file.path}，请一并选择所有引用对象并保持内容一致`)
        manifestPaths.set(file.path.toLowerCase(), file)
      }
    for (const id of uploads) {
      options.signal?.throwIfAborted()
      const source = local.objects[id],
        resource = nextManifest.objects[id]
      if (!source || !resource) {
        const deleted = latest.manifest.objects[id]
        if (deleted && isDocumentResourceType(deleted.type)) {
          validateConfiguration(deleted, this.deps.profile.id)
          options.onProgress?.({ currentFile: deleted.files.document.path })
          const file = deleted.files.document,
            bytes = await this.deps.remote.read(
              file.path,
              latest.head.sha,
              MAX_INDEX_BYTES,
              options
            )
          if (bytes && digest(bytes) !== file.sha256)
            throw new Error('远程配置已在索引外修改，拒绝删除')
          if (bytes) files.set(file.path, null)
          reportPrepared(file.path)
        }
        continue
      }
      for (const field of uploadMasks[id]) {
        if (field === '$properties') continue
        const file = resource.files[field]
        if (!file) continue
        options.signal?.throwIfAborted()
        options.onProgress?.({ currentFile: file.path, message: '核对文件内容并准备上传队列' })
        if (checkedFiles.has(file.path)) {
          if (checkedFiles.get(file.path) !== file.sha256)
            throw new Error(`同一路径有不同上传内容：${file.path}`)
          continue
        }
        checkedFiles.set(file.path, file.sha256)
        const old = latest.manifest.objects[id]?.files[field]
        if (old?.path === file.path && old.sha256 === file.sha256) {
          skippedPaths.add(file.path)
          reportPrepared(file.path)
          continue
        }
        const data = await this.local.bytes(
            file,
            source.sources[field],
            isDocumentResourceType(resource.type) && field === 'document'
              ? configBytes(resource.properties.content)
              : source.buffers?.[field]
          ),
          collision = files.get(file.path)
        if (collision && digest(collision) !== file.sha256)
          throw new Error(`同一路径有不同上传内容：${file.path}`)
        if (!collision) {
          const existing = await this.deps.remote.read(
            file.path,
            latest.head.sha,
            MAX_FILE_BYTES + 1,
            options
          )
          remoteHashes.set(file.path, existing ? digest(existing) : null)
          if (existing && digest(existing) === file.sha256) {
            skippedPaths.add(file.path)
            reportPrepared(file.path)
            continue
          }
          if (existing && digest(existing) !== file.sha256) {
            const owners = Object.values(latest.manifest.objects).flatMap((r) =>
              Object.values(r.files).filter((f) => f.path === file.path)
            )
            if (!owners.length || owners.some((f) => f.sha256 !== digest(existing)))
              throw new Error(`远程路径 ${file.path} 存在未纳入索引或已独立修改的文件，拒绝覆盖`)
          }
          files.set(file.path, data)
        }
        reportPrepared(file.path)
      }
      const c = this.deps.profile.collections.find((c) => c.type === resource.type),
        field = c?.thumbnailField
      if (field && uploadMasks[id].includes(field)) {
        delete resource.thumbnail
        if (source.sources[field] && resource.files[field]?.size <= 20 * 1024 * 1024) {
          const bytes = this.deps.previewImage?.(await readFile(source.sources[field]))
          if (bytes && bytes.length <= 512 * 1024) {
            resource.thumbnail = {
              path: `${prefix(this.deps.profile.id)}/previews/${digest(bytes)}.png`,
              sha256: digest(bytes),
              size: bytes.length,
              extension: '.png'
            }
            files.set(resource.thumbnail.path, bytes)
          }
        }
      }
    }
    if (assets.length)
      options.onProgress?.({
        stage: 'downloading',
        total: assets.length,
        completed: 0,
        skipped: 0,
        failed: 0,
        currentFile: '',
        message: '下载并校验资源'
      })
    for (const [index, a] of assets.entries()) {
      options.signal?.throwIfAborted()
      options.onProgress?.({
        stage: 'downloading',
        currentFile: a.target,
        message: '下载并校验资源'
      })
      await this.download(a.file, latest.head.sha, options)
      options.onProgress?.({ completed: index + 1 })
    }
    this.local.assertUnchanged(local)
    let commit: string | undefined
    if (uploads.size || initial) {
      options.onProgress?.({
        stage: 'validating',
        total: 0,
        completed: 0,
        skipped: 0,
        currentFile: '',
        message: '生成共享配置与团队索引'
      })
      for (const [path, bytes] of await sharedStores(
        this.deps.profile,
        latest.manifest,
        nextManifest,
        uploads,
        local,
        this.deps.remote,
        latest.head,
        options
      )) {
        if (files.has(path) && digest(files.get(path)!) !== digest(bytes))
          throw new Error(`配置与对象选择冲突：${path}`)
        files.set(path, bytes)
      }
      validateManifest(nextManifest, this.deps.profile)
      const index = Buffer.from(JSON.stringify(nextManifest))
      if (index.length > MAX_INDEX_BYTES) throw new Error('团队索引过大，请拆分 Profile')
      files.set(latest.path, index)
      if (initial) {
        options.onProgress?.({
          stage: 'validating',
          total: files.size,
          completed: 0,
          skipped: 0,
          failed: 0,
          currentFile: '',
          message: '检查已有文件，确保初始化不会覆盖远程内容'
        })
        let validated = 0
        // Includes generated config stores and previews, not only asset uploads.
        for (const [path, bytes] of files) {
          options.signal?.throwIfAborted()
          options.onProgress?.({ currentFile: path })
          if (!bytes) throw new Error('初始化禁止删除远程文件')
          if (!remoteHashes.has(path)) {
            const existing = await this.deps.remote.read(
              path,
              latest.head.sha,
              MAX_FILE_BYTES + 1,
              options
            )
            remoteHashes.set(path, existing ? digest(existing) : null)
          }
          const hash = remoteHashes.get(path)
          if (hash !== null && hash !== digest(bytes))
            throw new Error(`初始化存在数据冲突，拒绝覆盖远程文件：${path}；请先备份并人工核对`)
          options.onProgress?.({ completed: ++validated })
        }
      }
      options.signal?.throwIfAborted()
      // A path may also be materialized by sharedStores; count it once.
      for (const path of files.keys()) skippedPaths.delete(path)
      const skipped = skippedPaths.size
      commit = await this.deps.remote.commit(
        latest.head,
        files,
        `BPbox: publish ${uploads.size} selected resources (${this.deps.profile.id})`,
        {
          ...options,
          onProgress: (update) =>
            options.onProgress?.({
              ...update,
              ...(update.total === undefined ? {} : { total: update.total + skipped }),
              ...(update.completed === undefined ? {} : { completed: update.completed + skipped }),
              ...(update.skipped === undefined ? {} : { skipped: update.skipped + skipped })
            })
        }
      )
      options.onProgress?.({ cancellable: false, message: '保存同步结果' })
      if (initial) {
        state.base = {}
        state.units = {}
      }
      mergeUnits(state, uploadUnits)
      state.cached = { head: { sha: commit, tree: '' }, manifest: nextManifest }
      atomicJson(this.statePath, state)
    }
    if (updates.size) {
      if (!commit) options.signal?.throwIfAborted()
      options.onProgress?.({ stage: 'applying', cancellable: false, message: '应用并保存同步结果' })
      state.pending = {
        format: 2,
        updates: Object.fromEntries(updates),
        expected,
        copies: [...copies],
        masks,
        assets,
        targets,
        units
      }
      atomicJson(this.statePath, state)
      if (this.deps.busy())
        return { pending: true, commit, message: '下载校验完成，等待比赛/展示结束后应用' }
      try {
        await this.applyNow(state)
      } catch (error) {
        return {
          pending: true,
          commit,
          message: `下载已保留，尚未应用：${(error as Error).message}`
        }
      }
    } else {
      if (!commit) options.signal?.throwIfAborted()
      mergeUnits(state, units)
      atomicJson(this.statePath, state)
    }
    this.view = undefined
    return {
      pending: false,
      commit,
      message: commit
        ? '已按原分类路径发布选中资源；未选中项与视频未上传'
        : '已应用选中资源及必要依赖'
    }
  }
  private checkLocalDependencies(
    local: LocalSnapshot,
    updates: Map<string, TeamResource | null>,
    copies: Set<string>
  ): void {
    const next = new Map(Object.values(local.objects).map((v) => [v.resource.id, v.resource]))
    for (const [id, r] of updates) {
      if (r) next.set(id, r)
      else next.delete(id)
    }
    for (const r of [
      ...next.values(),
      ...[...copies].flatMap((id) => (local.objects[id] ? [local.objects[id].resource] : []))
    ])
      for (const id of r.dependencies)
        if (!next.has(id)) throw new Error(`本地 ${r.name} 仍需要依赖 ${id}，无法应用删除`)
  }
  private async applyNow(state: State): Promise<void> {
    const pending = state.pending
    if (!pending) return
    if (pending.format !== 2)
      throw new Error('旧版待应用下载尚无分类目标，请取消后重新选择；旧基线和缓存保留')
    const busy = this.deps.busy()
    if (busy) throw new Error(busy)
    const local = await this.local.scan()
    for (const [id, expected] of Object.entries(pending.expected))
      if ((local.objects[id]?.revision ?? null) !== expected)
        throw new Error('等待期间本地资源已修改，请取消待应用下载并重新查看差异；没有覆盖本地修改')
    const updates = new Map(Object.entries(pending.updates)),
      files = new Map<string, string>(),
      copyPaths: Record<string, Record<string, string>> = {}
    validateManifest(
      {
        schema: 2,
        profileId: this.deps.profile.id,
        objects: Object.fromEntries(
          [...updates].filter((entry): entry is [string, TeamResource] => entry[1] !== null)
        )
      },
      this.deps.profile
    )
    this.checkLocalDependencies(local, updates, new Set(pending.copies))
    for (const a of pending.assets) {
      validateFile(a.file, this.deps.profile.id)
      const target = sharedPath(a.target),
        current = await this.targetHash(target)
      if (current !== pending.targets[target])
        throw new Error(`等待期间目标文件已修改：${target}，请取消后重新查看差异`)
      const source = this.cachePath(a.file)
      if (!existsSync(source) || (await sha256File(source)) !== a.file.sha256)
        throw new Error('暂存文件校验失败，请取消后重新下载')
      // Restoring an absent shared file does not overwrite its other references or configurations.
      if (current !== null && current !== a.file.sha256)
        this.local.assertReferences(local, target, pending.masks)
      // Document conflict copies are serialized by LocalProfile.changes, not copied as assets.
      if (target.startsWith('assets/') && current !== a.file.sha256)
        for (const id of pending.copies) {
          const object = local.objects[id]
          if (!object) continue
          for (const [field, f] of Object.entries(object.resource.files))
            if (f.relativePath?.toLowerCase() === target.toLowerCase()) {
              const copied = `${target.slice(0, -extname(target).length)}.local-${randomUUID().slice(0, 8)}${extname(target)}`
              copyPaths[id] ??= {}
              copyPaths[id][field] = copied
              files.set(inside(this.deps.root, copied), object.sources[field])
            }
        }
      const destination = inside(this.deps.root, target)
      if (target.startsWith('assets/') && (!existsSync(destination) || current !== a.file.sha256))
        files.set(destination, source)
    }
    const changes = this.local.changes(
      local,
      updates,
      new Set(pending.copies),
      pending.masks,
      copyPaths
    )
    this.local.assertUnchanged(local)
    if (this.deps.busy()) throw new Error('比赛或展示已开始，资源继续保留在待应用队列')
    const next = structuredClone(state)
    mergeUnits(next, pending.units)
    delete next.pending
    changes.set(this.statePath, JSON.stringify(next, null, 2) + '\n')
    transaction(this.deps.root, changes, files)
    this.deps.changed?.()
    this.view = undefined
  }
  importResource(token: string, id: string, field: string, target: string): Promise<void> {
    return this.exclusive(async () => {
      const view = this.requireView(token),
        local = await this.local.scan(),
        object = local.objects[id]
      if (this.deps.busy()) throw new Error(this.deps.busy()!)
      if (this.state().pending) throw new Error('请先处理待应用下载')
      if (
        !object ||
        view.local.objects[id]?.revision !== object.revision ||
        object.fields[field]?.state !== 'external'
      )
        throw new Error('外部资源状态已变化，请刷新')
      assetPath(target)
      const source =
        this.deps.resolveAsset?.(String(object.row[field])) ??
        resolve(this.deps.root, String(object.row[field]))
      if (isVideo(source, field) || extname(source).toLowerCase() !== extname(target).toLowerCase())
        throw new Error('只能导入相同扩展名的图片或音频')
      const info = await stat(source)
      if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error('资源不存在或超过 95 MiB')
      const destination = inside(this.deps.root, target)
      if ((await this.targetHash(target)) !== null)
        throw new Error('目标文件已存在，请选择新的分类文件名')
      const hash = await sha256File(source),
        resource = structuredClone(object.resource)
      resource.files[field] = pathDescriptor(this.deps.profile.id, target, hash, info.size)
      if (isDocumentResourceType(resource.type)) {
        reconcileConfiguration(resource, [field])
        updateConfigDocument(resource, this.deps.profile.id)
      }
      resource.hash = resourceHash(resource)
      const changes = this.local.changes(local, new Map([[id, resource]]), new Set(), {
        [id]: [field]
      })
      this.local.assertReferences(local, target, { [id]: [field] })
      this.local.assertUnchanged(local)
      const staged = this.cachePath(resource.files[field])
      mkdirSync(dirname(staged), { recursive: true })
      const data = await readFile(source)
      if (digest(data) !== hash) throw new Error('外部文件在导入期间变化，请重试')
      writeFileSync(staged, data)
      if (this.deps.busy()) throw new Error('比赛或展示正在使用资源，请稍后导入')
      this.local.assertUnchanged(local)
      transaction(this.deps.root, changes, new Map([[destination, staged]]))
      this.view = undefined
      this.deps.changed?.()
    })
  }
  applyPending(): Promise<SyncResult> {
    return this.exclusive(async () => {
      const s = this.state()
      if (!s.pending) return { pending: false, message: '没有待应用下载' }
      await this.applyNow(s)
      return { pending: false, message: '已应用暂存资源及必要依赖' }
    })
  }
  discardPending(): Promise<void> {
    return this.exclusive(async () => {
      const s = this.state()
      delete s.pending
      atomicJson(this.statePath, s)
      this.view = undefined
    })
  }
}
