import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  unlinkSync,
  lstatSync,
  copyFileSync,
  readdirSync
} from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setImmediate as yieldIO } from 'node:timers/promises'
import type { TeamProfile, TeamResource, ResourceFile, ResourceField } from '../../shared/teamSync'
import { isDocumentResourceType } from '../../shared/teamSync'
import {
  canonical,
  digest,
  pathDescriptor,
  MAX_FILE_BYTES,
  resourceHash,
  safeKey,
  assetPath,
  isVideo,
  assertShareable
} from './model'
import { sha256File } from '../fileHash'
import { decodeResourcePath, relativeResourcePath } from '../resourcePaths'
import {
  configuration,
  configIdentity,
  configBytes,
  restorePrivate,
  setPointer,
  updateConfigDocument,
  validateConfiguration
} from './configuration'
import { isResultDocument, isSyncDocument } from './model'

export const defaultProfile: TeamProfile = {
  id: 'default',
  name: '当前 Profile',
  collections: [
    {
      type: 'character',
      label: '角色',
      store: 'config/app/characters.json',
      idField: 'id',
      nameFields: ['chinese_name', 'english_name'],
      thumbnailField: 'avatar_small_image',
      assetFields: {
        left_head_image: '左头像',
        right_head_image: '右头像',
        avatar_small_image: '头像',
        full_body_image: '立绘',
        chant_video: '唱名视频',
        pv: 'PV',
        ban_voice: 'BAN 语音',
        pick_voice: 'PICK 语音',
        pick_sound: '音效'
      }
    },
    {
      type: 'lightCone',
      label: '光锥',
      store: 'config/app/light-cones.json',
      idField: 'id',
      nameFields: ['name'],
      thumbnailField: 'small_image',
      assetFields: { small_image: '小图', large_image: '大图' }
    }
  ]
}
export interface LocalResource {
  resource: TeamResource
  sources: Record<string, string>
  problems: string[]
  row: Record<string, unknown>
  fields: Record<string, ResourceField>
  revision: string
  buffers?: Record<string, Buffer>
  configPath?: string
  pointers?: Record<string, string[]>
}
export interface LocalSnapshot {
  objects: Record<string, LocalResource>
  stores: Record<string, { rows: Record<string, unknown>[]; content: string | null }>
  stamps: Map<string, string>
  auxiliary: Map<string, string>
}
export function jsonRead<T>(path: string, fallback: T): T {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : fallback
}
export function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n')
  renameSync(temp, path)
}
/** Reject traversal and symlink/junction destinations, including existing parent directories. */
export function inside(root: string, path: string): string {
  const target = resolve(root, path)
  const rel = relative(resolve(root), target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Profile 路径越界')
  let cursor = target
  while (cursor !== resolve(root)) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink())
      throw new Error('同步目录不能使用符号链接或目录联接')
    cursor = dirname(cursor)
  }
  return target
}
export function profilesAt(root: string): TeamProfile[] {
  const registry = jsonRead<{
    currentProfileId?: string
    profiles?: { id: string; displayName: string }[]
  }>(join(root, 'config/app/profiles.json'), {})
  const fallback = structuredClone(defaultProfile)
  fallback.localProfileId = 'star-rail'
  fallback.name = `${registry.profiles?.find((p) => p.id === 'star-rail')?.displayName ?? '星穹铁道'}（远程 default）`
  if (
    !existsSync(join(root, 'config/team-profiles.json')) &&
    registry.currentProfileId &&
    registry.currentProfileId !== 'star-rail'
  )
    throw new Error('当前 Profile 不是星穹铁道，请先配置 config/team-profiles.json 的独立同步映射')
  const profiles = jsonRead<TeamProfile[]>(join(root, 'config/team-profiles.json'), [fallback])
  if (!Array.isArray(profiles) || !profiles.length) throw new Error('Profile 映射必须是非空数组')
  const ids = new Set<string>(),
    stores = new Set<string>()
  for (const p of profiles) {
    if (
      !p ||
      !safeKey.test(p.id) ||
      ids.has(p.id) ||
      typeof p.name !== 'string' ||
      !Array.isArray(p.collections) ||
      !p.collections.length
    )
      throw new Error('无效的 Profile 映射')
    ids.add(p.id)
    const types = new Set<string>()
    for (const c of p.collections) {
      if (
        !safeKey.test(c.type) ||
        types.has(c.type) ||
        !safeKey.test(c.idField) ||
        typeof c.label !== 'string' ||
        !Array.isArray(c.nameFields) ||
        !c.nameFields.length ||
        c.nameFields.some((f) => !safeKey.test(f)) ||
        !c.assetFields ||
        typeof c.assetFields !== 'object' ||
        Array.isArray(c.assetFields) ||
        Object.keys(c.assetFields).some((f) => !safeKey.test(f)) ||
        (c.thumbnailField && !Object.hasOwn(c.assetFields, c.thumbnailField)) ||
        (c.dependenciesField && !safeKey.test(c.dependenciesField)) ||
        typeof c.store !== 'string' ||
        !/^config\/(?!team-)[a-zA-Z0-9_./-]+\.json$/.test(c.store)
      )
        throw new Error('无效的 Profile 对象类型映射')
      const store = inside(root, c.store).toLowerCase()
      if (stores.has(store)) throw new Error('不同对象集合不能写入同一个配置文件')
      stores.add(store)
      types.add(c.type)
    }
  }
  return profiles
}
function stamp(s: { size: number; mtimeMs: number; ctimeMs: number }): string {
  return `${s.size}:${s.mtimeMs}:${s.ctimeMs}`
}
export class LocalProfile {
  private hashes = new Map<string, { stamp: string; hash: string }>()
  constructor(
    readonly root: string,
    readonly profile: TeamProfile,
    private resolveAsset: (path: string) => string = (p) => resolve(root, p)
  ) {}
  private identity(type: string, row: Record<string, unknown>, idField: string): string {
    if (typeof row.sync_id === 'string' && safeKey.test(row.sync_id)) return row.sync_id
    // Existing copies of the same dataset acquire the same identity without rewriting unselected rows.
    return digest(canonical([this.profile.id, type, row[idField], row.created_at ?? 'legacy']))
  }
  async scan(signal?: AbortSignal, onFile?: (path: string) => void): Promise<LocalSnapshot> {
    const snapshot: LocalSnapshot = {
      objects: {},
      stores: {},
      stamps: new Map(),
      auxiliary: new Map()
    }
    for (const collection of this.profile.collections) {
      signal?.throwIfAborted()
      onFile?.(collection.store)
      const path = inside(this.root, collection.store)
      const content = existsSync(path) ? readFileSync(path, 'utf8') : null
      const rows: Record<string, unknown>[] = content ? JSON.parse(content) : []
      if (!Array.isArray(rows)) throw new Error(`${collection.label}配置不是 JSON 数组`)
      snapshot.stores[collection.type] = { content, rows }
      for (const row of rows) {
        if (signal) await yieldIO(undefined, { signal })
        if (!row || typeof row !== 'object' || row[collection.idField] === undefined)
          throw new Error('对象缺少本地 ID')
        const id = this.identity(collection.type, row, collection.idField)
        if (snapshot.objects[id]) throw new Error(`对象稳定 ID 重复：${id}`)
        const properties = Object.fromEntries(
          Object.entries(row).filter(
            ([key]) =>
              ![
                collection.idField,
                'sync_id',
                'created_at',
                'updated_at',
                collection.dependenciesField
              ].includes(key) &&
              !Object.hasOwn(collection.assetFields, key) &&
              !key.endsWith('_url') &&
              !key.endsWith('_exists')
          )
        )
        const resource: TeamResource = {
          id,
          type: collection.type,
          name: collection.nameFields.map((f) => String(row[f] ?? '')).find(Boolean) ?? id,
          version: 1,
          hash: '',
          properties,
          files: {},
          dependencies: []
        }
        if (collection.dependenciesField && row[collection.dependenciesField] != null) {
          const deps = row[collection.dependenciesField]
          if (!Array.isArray(deps) || deps.some((d) => typeof d !== 'string' || !safeKey.test(d)))
            throw new Error('对象依赖必须是稳定 ID 数组')
          resource.dependencies = [...new Set(deps)]
        }
        const local: LocalResource = {
          resource,
          sources: {},
          problems: [],
          row,
          fields: {},
          revision: ''
        }
        try {
          assertShareable(properties)
          assertShareable(resource.name)
        } catch (error) {
          local.fields.$properties = {
            field: '$properties',
            label: '属性配置',
            state: 'invalid',
            message: String((error as Error).message),
            upload: 'unchanged',
            download: 'unchanged'
          }
          resource.properties = {}
        }
        for (const field of Object.keys(collection.assetFields)) {
          signal?.throwIfAborted()
          const value = row[field]
          const info: ResourceField = {
            field,
            label: collection.assetFields[field],
            state: 'empty',
            upload: 'unchanged',
            download: 'unchanged'
          }
          local.fields[field] = info
          if (isVideo(String(value ?? ''), field)) {
            info.state = 'excluded'
            info.message = '视频不参与同步（所有大小均排除）'
            continue
          }
          if (!value) continue
          try {
            if (typeof value !== 'string') throw new Error('资源路径必须是字符串')
            const normalized = decodeResourcePath(value)
            let relativePath = normalized
            if (isAbsolute(normalized)) {
              relativePath = relative(this.root, normalized).replace(/\\/g, '/')
              if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
                info.state = 'external'
                info.message = '外部绝对路径：请导入到分类资源目录后再发布'
                continue
              }
            }
            if (relativePath.startsWith('assets/team-sync/')) {
              info.state = 'external'
              info.message = '旧版哈希文件缺少原始文件名，请导入到确认的分类路径'
              continue
            }
            assetPath(relativePath)
            inside(this.root, relativePath)
            info.localPath = relativePath
            const source = this.resolveAsset(relativePath)
            onFile?.(relativePath)
            // Legacy fallback is allowed only for the same classified relative path.
            const sourceRoot = resolve(source, ...relativePath.split('/').map(() => '..'))
            if (resolve(sourceRoot, relativePath) !== resolve(source))
              throw new Error('回退资源路径不一致')
            inside(sourceRoot, relativePath)
            const before = await stat(source)
            if (!before.isFile()) throw new Error('不是文件')
            if (before.size > MAX_FILE_BYTES) {
              info.state = 'tooLarge'
              info.message = '超过 95 MiB，不能同步，请先处理该文件'
              continue
            }
            const extension = extname(source).toLowerCase()
            if (!/^\.[a-z0-9]{1,10}$/.test(extension)) throw new Error('文件扩展名无效')
            const cached = this.hashes.get(source)
            const hash =
              cached?.stamp === stamp(before) ? cached.hash : await sha256File(source, signal)
            if (stamp(await stat(source)) !== stamp(before))
              throw new Error('扫描时文件发生变化，请刷新')
            this.hashes.set(source, { stamp: stamp(before), hash })
            snapshot.stamps.set(source, stamp(before))
            resource.files[field] = pathDescriptor(this.profile.id, relativePath, hash, before.size)
            local.sources[field] = source
            info.state = 'ready'
          } catch (error) {
            signal?.throwIfAborted()
            info.state = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid'
            info.message =
              info.state === 'missing'
                ? '文件缺失，可跳过此项同步其他资源'
                : '路径或资源不可读取，请检查分类路径'
          }
        }
        local.problems = Object.values(local.fields)
          .filter((f) => f.message && f.state !== 'excluded')
          .map((f) => `${f.label}：${f.message}`)
        resource.hash = resourceHash(resource)
        local.revision = digest(canonical({ row, hash: resource.hash, fields: local.fields }))
        snapshot.objects[id] = local
      }
    }
    const collect = (dir: string): void => {
      signal?.throwIfAborted()
      if (!existsSync(dir)) return
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const path = inside(this.root, join(dir, e.name))
        if (e.isDirectory()) collect(path)
        else if (e.name.endsWith('.json')) snapshot.auxiliary.set(path, readFileSync(path, 'utf8'))
      }
    }
    collect(join(this.root, 'config'))
    collect(join(this.root, 'results'))
    for (const [path, text] of snapshot.auxiliary) {
      if (signal) await yieldIO(undefined, { signal })
      const configPath = relative(this.root, path).replace(/\\/g, '/')
      onFile?.(configPath)
      if (!isSyncDocument(configPath)) continue
      const documentLabel = isResultDocument(configPath) ? '结果文件' : '配置文件'
      const id = configIdentity(this.profile.id, configPath)
      const resource: TeamResource = {
        id,
        type: isResultDocument(configPath) ? 'result' : 'configuration',
        name: configPath,
        version: 1,
        hash: '',
        properties: { configPath },
        files: {},
        dependencies: []
      }
      const entry: LocalResource = {
        resource,
        sources: {},
        problems: [],
        fields: {},
        row: {},
        revision: '',
        configPath,
        pointers: {},
        buffers: {}
      }
      try {
        const raw = JSON.parse(text),
          cleaned = configuration(raw, this.root)
        resource.properties.content = cleaned.content
        resource.properties.pointers = Object.fromEntries(
          cleaned.references.filter((r) => !r.excluded).map((r) => [r.field, r.pointer])
        )
        entry.row.content = raw
        for (const ref of cleaned.references) {
          signal?.throwIfAborted()
          entry.row[ref.field] = ref.value
          entry.pointers![ref.field] = ref.pointer
          const field: ResourceField = {
            field: ref.field,
            label: ref.pointer.join('.'),
            state: ref.excluded ? 'excluded' : ref.path ? 'ready' : 'external',
            upload: 'unchanged',
            download: 'unchanged',
            localPath: ref.path
          }
          entry.fields[ref.field] = field
          if (ref.excluded) {
            field.message = '视频文件不参与同步'
            continue
          }
          if (!ref.path) {
            field.message = '外部或不支持的路径已从共享配置移除，请先安全导入所需资源'
            continue
          }
          try {
            inside(this.root, ref.path)
            const source = this.resolveAsset(ref.path),
              before = await stat(source)
            if (!before.isFile() || before.size > MAX_FILE_BYTES) {
              field.state = 'tooLarge'
              field.message = '不是普通文件或超过 95 MiB'
              continue
            }
            const sourceRoot = resolve(source, ...ref.path.split('/').map(() => '..'))
            if (resolve(sourceRoot, ref.path) !== resolve(source)) throw new Error('回退路径不一致')
            inside(sourceRoot, ref.path)
            const hash = await sha256File(source, signal)
            if (stamp(await stat(source)) !== stamp(before)) throw new Error('文件已变化')
            snapshot.stamps.set(source, stamp(before))
            resource.files[ref.field] = pathDescriptor(this.profile.id, ref.path, hash, before.size)
            entry.sources[ref.field] = source
          } catch {
            signal?.throwIfAborted()
            field.state = 'missing'
            field.message = '文件缺失，可跳过同步其他资源'
          }
        }
        updateConfigDocument(resource, this.profile.id)
        entry.buffers!.document = configBytes(cleaned.content)
        entry.fields.document = {
          field: 'document',
          label: `${documentLabel}内容（不含凭据与运行时 URL）`,
          state: 'ready',
          localPath: configPath,
          upload: 'unchanged',
          download: 'unchanged'
        }
        if (configPath.startsWith('config/audio/') && raw.bpResultFile)
          entry.problems.push('关联 BP 结果可在“结果文件”类型中单独选择同步')
      } catch {
        signal?.throwIfAborted()
        entry.fields.$properties = {
          field: '$properties',
          label: `${documentLabel}属性`,
          state: 'invalid',
          message: `${documentLabel} JSON 无法解析`,
          upload: 'unchanged',
          download: 'unchanged'
        }
        entry.fields.document = {
          field: 'document',
          label: `${documentLabel}内容`,
          state: 'invalid',
          message: `请先修复此${documentLabel}`,
          upload: 'unchanged',
          download: 'unchanged'
        }
      }
      entry.problems.push(
        ...Object.values(entry.fields)
          .filter((f) => f.message && f.state !== 'excluded')
          .map((f) => `${f.label}：${f.message}`)
      )
      resource.hash = resourceHash(resource)
      entry.revision = digest(canonical({ text, hash: resource.hash }))
      snapshot.objects[id] = entry
    }
    this.assertUnchanged(snapshot)
    return snapshot
  }
  assertUnchanged(snapshot: LocalSnapshot): void {
    for (const [path, content] of snapshot.auxiliary)
      if (!existsSync(path) || readFileSync(path, 'utf8') !== content)
        throw new Error('本地配置已变化，请刷新差异')
    for (const c of this.profile.collections) {
      const path = inside(this.root, c.store)
      if (
        (existsSync(path) ? readFileSync(path, 'utf8') : null) !== snapshot.stores[c.type].content
      )
        throw new Error('本地配置已变化，请刷新差异')
    }
    for (const [path, expected] of snapshot.stamps) {
      if (!existsSync(path) || stamp(lstatSync(path)) !== expected)
        throw new Error('本地文件已变化，请刷新差异')
    }
  }
  async bytes(file: ResourceFile, source: string, prepared?: Buffer): Promise<Buffer> {
    const bytes = prepared ?? (await readFile(source))
    if (bytes.length !== file.size || digest(bytes) !== file.sha256)
      throw new Error('本地文件已变化，请刷新后发布')
    return bytes
  }
  /** Commit the selected rows only; immutable downloaded blobs never overwrite shared local files. */
  changes(
    snapshot: LocalSnapshot,
    updates: Map<string, TeamResource | null>,
    copies: Set<string>,
    masks: Record<string, string[]> = {},
    copyPaths: Record<string, Record<string, string>> = {}
  ): Map<string, string | null> {
    const changes = new Map<string, string | null>()
    for (const c of this.profile.collections) {
      const rows = snapshot.stores[c.type].rows.map((r) => ({ ...r }))
      let dirty = false
      for (const [id, resource] of updates) {
        const existing = snapshot.objects[id]
        if (resource && existing && resource.type !== existing.resource.type)
          throw new Error('同一个稳定 ID 不能更换对象类型，请另存为新对象')
        if ((resource?.type ?? existing?.resource.type) !== c.type) continue
        const index = rows.findIndex((r) => this.identity(c.type, r, c.idField) === id)
        if (copies.has(id) && index >= 0) {
          const copy = {
            ...rows[index],
            sync_id: randomUUID(),
            [c.idField]: Math.max(0, ...rows.map((r) => Number(r[c.idField]) || 0)) + 1
          }
          Object.assign(copy, copyPaths[id] ?? {})
          if ('code' in copy) copy.code = ''
          const nameField = c.nameFields.find((f) => typeof copy[f] === 'string')
          if (nameField) copy[nameField] = `${copy[nameField]}（本地副本）`
          rows.push(copy)
          dirty = true
        }
        if (!resource) {
          if (index >= 0) {
            rows.splice(index, 1)
            dirty = true
          }
          continue
        }
        if (resource.dependencies.length && !c.dependenciesField)
          throw new Error(`请为 ${c.label} 配置 dependenciesField 后再下载带依赖的对象`)
        const forbidden = new Set([
          c.idField,
          'sync_id',
          'created_at',
          'updated_at',
          c.dependenciesField,
          ...Object.keys(c.assetFields)
        ])
        if (
          Object.keys(resource.properties).some(
            (k) =>
              forbidden.has(k) ||
              ['__proto__', 'constructor', 'prototype'].includes(k) ||
              k.endsWith('_url') ||
              k.endsWith('_exists')
          ) ||
          Object.keys(resource.files).some((k) => !Object.hasOwn(c.assetFields, k))
        )
          throw new Error(`远程对象字段与本地映射不兼容：${resource.name}`)
        const selected = masks[id] ?? ['$properties', ...Object.keys(c.assetFields)]
        // File-only recovery leaves the existing row and resource table byte-for-byte intact.
        if (
          existing &&
          !copies.has(id) &&
          selected.every(
            (field) =>
              existing.fields[field]?.state === 'missing' &&
              this.relativeAsset(existing.row[field]) === resource.files[field]?.relativePath
          )
        )
          continue
        dirty = true
        const preserved = index >= 0 ? { ...rows[index] } : {}
        if (selected.includes('$properties'))
          for (const key of Object.keys(preserved)) {
            if (
              ![
                c.idField,
                'sync_id',
                'created_at',
                'updated_at',
                ...Object.keys(c.assetFields)
              ].includes(key)
            )
              delete preserved[key]
          }
        const row: Record<string, unknown> = {
          ...preserved,
          ...(selected.includes('$properties') ? resource.properties : {}),
          sync_id: id,
          [c.idField]:
            index >= 0
              ? rows[index][c.idField]
              : Math.max(0, ...rows.map((r) => Number(r[c.idField]) || 0)) + 1,
          created_at: index >= 0 ? rows[index].created_at : new Date().toISOString(),
          updated_at: new Date().toISOString()
        }
        for (const field of Object.keys(c.assetFields)) {
          if (
            !selected.includes(field) ||
            isVideo(String(resource.files[field]?.path ?? ''), field)
          )
            continue
          const file = resource.files[field]
          if (file && !file.relativePath) throw new Error('旧版资源需要确认分类目标路径')
          row[field] = file ? assetPath(file.relativePath!) : null
        }
        if (c.dependenciesField && selected.includes('$properties'))
          row[c.dependenciesField] = resource.dependencies
        if (index >= 0) rows[index] = row
        else rows.push(row)
      }
      if (dirty) changes.set(inside(this.root, c.store), JSON.stringify(rows, null, 2) + '\n')
    }
    this.updateResourceTable(snapshot, updates, masks, changes)
    for (const [id, resource] of updates) {
      const existing = snapshot.objects[id]
      if (!isDocumentResourceType(resource?.type ?? existing?.resource.type)) continue
      if (!resource) {
        if (existing?.configPath) changes.set(inside(this.root, existing.configPath), null)
        continue
      }
      validateConfiguration(resource, this.profile.id)
      const path = inside(this.root, String(resource.properties.configPath)),
        selected = masks[id] ?? ['$properties', ...Object.keys(resource.files)]
      const content = structuredClone(
        selected.includes('document') || selected.includes('$properties')
          ? resource.properties.content
          : existing?.resource.properties.content
      )
      if (content === undefined) throw new Error('新配置需要一并选择配置文件内容')
      const pointers = resource.properties.pointers as Record<string, string[]>
      for (const field of selected)
        if (pointers[field])
          setPointer(content, pointers[field], resource.files[field]?.relativePath ?? null)
      const raw = snapshot.auxiliary.has(path)
        ? JSON.parse(snapshot.auxiliary.get(path)!)
        : undefined
      if (copies.has(id) && raw !== undefined) {
        const copy = structuredClone(raw)
        for (const [field, savedPath] of Object.entries(copyPaths[id] ?? {})) {
          const pointer = existing?.pointers?.[field]
          if (pointer) setPointer(copy, pointer, savedPath)
        }
        changes.set(
          `${path.slice(0, -5)}.local-${randomUUID().slice(0, 8)}.json`,
          JSON.stringify(copy, null, 2) + '\n'
        )
      }
      const restored = restorePrivate(raw, content)
      if (
        existing &&
        !copies.has(id) &&
        selected.every((field) => existing.fields[field]?.state === 'missing') &&
        canonical(raw) === canonical(restored)
      )
        continue
      changes.set(path, configBytes(restored).toString())
    }
    return changes
  }

  relativeAsset(value: unknown): string | null {
    if (typeof value !== 'string') return null
    try {
      return assetPath(relativeResourcePath(this.root, value))
    } catch {
      return null
    }
  }
  legacyTarget(
    snapshot: LocalSnapshot,
    id: string,
    field: string,
    resource: TeamResource
  ): string | undefined {
    const own = this.relativeAsset(snapshot.objects[id]?.row[field])
    if (own) return own
    if (resource.type !== 'character') return undefined
    const table = snapshot.auxiliary.get(
      join(this.root, 'config/app/character-resource-table.json')
    )
    if (!table) return undefined
    const parsed = JSON.parse(table)
    const rows = Array.isArray(parsed) ? parsed : parsed.rows
    const matches = Array.isArray(rows)
      ? rows.filter(
          (r) =>
            r.sync_id === id || (resource.properties.code && r.code === resource.properties.code)
        )
      : []
    return matches.length === 1 ? (this.relativeAsset(matches[0][field]) ?? undefined) : undefined
  }
  private tableMatches(
    rows: Record<string, unknown>[],
    id: string,
    resource: TeamResource | null,
    local?: LocalResource
  ): number[] {
    const code = local?.row.code ?? resource?.properties.code
    return rows.flatMap((r, i) => (r.sync_id === id || (code && r.code === code) ? [i] : []))
  }
  private updateResourceTable(
    snapshot: LocalSnapshot,
    updates: Map<string, TeamResource | null>,
    masks: Record<string, string[]>,
    changes: Map<string, string | null>
  ): void {
    const path = join(this.root, 'config/app/character-resource-table.json')
    const content = snapshot.auxiliary.get(path) ?? '{"version":1,"rows":[]}'
    const parsed = JSON.parse(content),
      rows: Record<string, unknown>[] = Array.isArray(parsed) ? parsed : parsed.rows
    if (!Array.isArray(rows)) throw new Error('资源编号表格式无效，请先修复后同步')
    let dirty = false
    for (const [id, resource] of updates) {
      if ((resource?.type ?? snapshot.objects[id]?.resource.type) !== 'character') continue
      const c = this.profile.collections.find((c) => c.type === 'character')!
      if (c.store !== 'config/app/characters.json') continue
      const matched = this.tableMatches(rows, id, resource, snapshot.objects[id])
      if (matched.length > 1) throw new Error('资源编号表有重复编号，请先消除歧义后同步')
      const index = matched[0]
      if (!resource) {
        if (index !== undefined) {
          rows.splice(index, 1)
          dirty = true
        }
        continue
      }
      const newRows = JSON.parse(changes.get(inside(this.root, c.store)) ?? '[]')
      const updated = newRows.find((r) => r.sync_id === id)
      if (!updated) continue
      const target = index === undefined ? { row_id: `resource-row-${randomUUID()}` } : rows[index]
      const fields = masks[id] ?? ['$properties', ...Object.keys(c.assetFields)]
      target.sync_id = id
      if (fields.includes('$properties'))
        for (const f of [
          'code',
          'english_name',
          'chinese_name',
          'rarity',
          'element',
          'path',
          'pv_start_time',
          'pv_end_time'
        ])
          if (Object.hasOwn(updated, f)) target[f] = updated[f]
      for (const f of fields)
        if (Object.hasOwn(c.assetFields, f) && !isVideo('', f)) {
          target[f] = updated[f]
          target.resource_status = {
            ...((target.resource_status as object) ?? {}),
            [f]: updated[f] ? 'found' : 'notConfigured'
          }
        }
      target.updated_at = new Date().toISOString()
      target.status = '已同步；资源状态将在读取时重新检查'
      if (index === undefined) rows.push(target)
      dirty = true
    }
    if (dirty)
      changes.set(
        path,
        JSON.stringify(
          Array.isArray(parsed) ? rows : { ...parsed, rows, updated_at: new Date().toISOString() },
          null,
          2
        ) + '\n'
      )
  }
  /** Do not overwrite a shared path through an unselected object, field, display or audio configuration. */
  assertReferences(snapshot: LocalSnapshot, target: string, masks: Record<string, string[]>): void {
    const allowed = new Set<string>()
    for (const [id, fields] of Object.entries(masks)) {
      const object = snapshot.objects[id]
      if (!object) continue
      if (object.configPath) {
        for (const field of fields)
          if (object.pointers?.[field])
            allowed.add(
              `${inside(this.root, object.configPath)}|${object.pointers[field].join('.')}`
            )
        continue
      }
      const c = this.profile.collections.find((c) => c.type === object.resource.type)!
      const index = snapshot.stores[c.type].rows.indexOf(object.row)
      for (const field of fields) allowed.add(`${inside(this.root, c.store)}|${index}.${field}`)
      if (c.type === 'character' && c.store === 'config/app/characters.json') {
        const tablePath = join(this.root, 'config/app/character-resource-table.json'),
          text = snapshot.auxiliary.get(tablePath)
        if (text) {
          const table = JSON.parse(text),
            rows = Array.isArray(table) ? table : table.rows
          if (Array.isArray(rows))
            for (const i of this.tableMatches(rows, id, object.resource, object))
              for (const field of fields)
                allowed.add(`${tablePath}|${Array.isArray(table) ? '' : 'rows.'}${i}.${field}`)
        }
      }
    }
    for (const [path, content] of snapshot.auxiliary) {
      const walk = (value: unknown, key: string): void => {
        if (
          typeof value === 'string' &&
          this.relativeAsset(value)?.toLowerCase() === target.toLowerCase() &&
          !allowed.has(`${path}|${key}`)
        )
          throw new Error(
            `共享文件 ${target} 被未选中的对象或配置引用，请一并选择相关资源或使用新文件名`
          )
        if (value && typeof value === 'object')
          for (const [k, v] of Object.entries(value)) walk(v, key ? `${key}.${k}` : k)
      }
      walk(JSON.parse(content), '')
    }
  }
}

interface Journal {
  entries: { path: string; before: string | null; after: string | null }[]
  committed: boolean
  files?: { path: string; before: string | null; after: string }[]
}
/** Durable write-ahead journal. On restart an interrupted application rolls back before Profile loading. */
export function recoverTransaction(root: string): void {
  const path = inside(root, '.team-sync/transaction.json')
  const journal = jsonRead<Journal | null>(path, null)
  if (!journal) return
  for (const e of journal.files ?? []) {
    const target = inside(root, e.path),
      saved = journal.committed ? e.after : e.before
    if (!saved) {
      if (existsSync(target)) unlinkSync(target)
    } else {
      mkdirSync(dirname(target), { recursive: true })
      const temp = inside(root, `${target}.team-sync.tmp`)
      copyFileSync(inside(root, saved), temp)
      renameSync(temp, target)
    }
  }
  for (const e of journal.entries) {
    const target = inside(root, e.path)
    const content = journal.committed ? e.after : e.before
    if (content === null) {
      if (existsSync(target)) unlinkSync(target)
    } else {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content)
    }
  }
  unlinkSync(path)
}
export function transaction(
  root: string,
  changes: Map<string, string | null>,
  files = new Map<string, string>()
): void {
  const path = inside(root, '.team-sync/transaction.json')
  if (existsSync(path)) throw new Error('存在尚未恢复的同步事务，请重启 BPbox')
  const journal: Journal = {
    committed: false,
    entries: [...changes].map(([p, after]) => ({
      path: relative(root, inside(root, p)),
      before: existsSync(p) ? readFileSync(p, 'utf8') : null,
      after
    }))
  }
  if (files.size) {
    const stage = `.team-sync/transactions/${randomUUID()}`
    mkdirSync(inside(root, stage), { recursive: true })
    journal.files = [...files].map(([targetPath, source], i) => {
      const target = inside(root, targetPath),
        after = `${stage}/${i}.after`,
        before = existsSync(target) ? `${stage}/${i}.before` : null
      copyFileSync(source, inside(root, after))
      if (before) copyFileSync(target, inside(root, before))
      return { path: relative(root, target), before, after }
    })
  }
  atomicJson(path, journal)
  try {
    for (const e of journal.files ?? []) {
      const target = inside(root, e.path)
      mkdirSync(dirname(target), { recursive: true })
      const temp = inside(root, `${target}.team-sync.tmp`)
      copyFileSync(inside(root, e.after), temp)
      renameSync(temp, target)
    }
    for (const [target, content] of changes) {
      if (content === null) {
        if (existsSync(target)) unlinkSync(target)
        continue
      }
      mkdirSync(dirname(target), { recursive: true })
      const temp = inside(root, `${target}.team-sync.tmp`)
      writeFileSync(temp, content)
      renameSync(temp, target)
    }
    atomicJson(path, { ...journal, committed: true })
    unlinkSync(path)
  } catch (error) {
    recoverTransaction(root)
    throw error
  }
}
