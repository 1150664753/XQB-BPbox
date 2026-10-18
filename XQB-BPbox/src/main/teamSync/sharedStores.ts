import type { TeamManifest, TeamProfile } from '../../shared/teamSync'
import type { LocalSnapshot } from './localProfile'
import type { RemoteStore, RemoteHead, RemoteOperation } from './github'
import {
  assertShareable,
  digest,
  MAX_INDEX_BYTES,
  pathDescriptor,
  repositoryPath,
  isVideo
} from './model'
import { configBytes } from './configuration'

/** Materialize selected object updates as normal config JSON, preserving all other remote rows. */
export async function sharedStores(
  profile: TeamProfile,
  previous: TeamManifest,
  next: TeamManifest,
  selected: Set<string>,
  local: LocalSnapshot,
  remote: RemoteStore,
  head: RemoteHead,
  options?: RemoteOperation
): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>()
  const load = async (path: string, fallback: unknown): Promise<unknown> => {
    options?.signal?.throwIfAborted()
    options?.onProgress?.({
      currentFile: repositoryPath(profile.id, path),
      message: '核对共享配置'
    })
    const bytes = await remote.read(
      repositoryPath(profile.id, path),
      head.sha,
      MAX_INDEX_BYTES,
      options
    )
    if (!bytes) {
      if (previous.stores?.[path])
        throw new Error(`远程配置已被单独删除：${path}，请先恢复或重新审查索引`)
      return fallback
    }
    if (previous.stores?.[path] && previous.stores[path].sha256 !== digest(bytes))
      throw new Error(`远程配置已在索引外修改：${path}，拒绝覆盖`)
    const parsed = JSON.parse(bytes.toString())
    assertShareable(parsed)
    return parsed
  }
  const save = (path: string, value: unknown): void => {
    assertShareable(value)
    const bytes = configBytes(value)
    if (bytes.length > MAX_INDEX_BYTES) throw new Error(`共享配置过大：${path}`)
    files.set(repositoryPath(profile.id, path), bytes)
    next.stores ??= {}
    next.stores[path] = pathDescriptor(profile.id, path, digest(bytes), bytes.length)
  }
  for (const c of profile.collections) {
    const ids = [...selected].filter(
      (id) => (next.objects[id]?.type ?? previous.objects[id]?.type) === c.type
    )
    if (!ids.length) continue
    const rows = (await load(c.store, [])) as Record<string, unknown>[]
    if (!Array.isArray(rows)) throw new Error(`远程对象配置不是数组：${c.store}`)
    for (const id of ids) {
      const r = next.objects[id],
        matches = rows.flatMap((v, i) => (v.sync_id === id ? [i] : []))
      if (matches.length > 1) throw new Error('远程配置存在重复稳定 ID')
      const index = matches[0]
      if (!r) {
        if (index !== undefined) rows.splice(index, 1)
        continue
      }
      if (
        index === undefined &&
        r.properties.code &&
        rows.some((v) => v.code === r.properties.code)
      )
        throw new Error(`远程配置已有相同编号但缺少匹配的稳定 ID：${r.name}，请先人工确认历史记录`)
      const old = index === undefined ? undefined : rows[index]
      const row: Record<string, unknown> = {
        ...r.properties,
        sync_id: id,
        [c.idField]:
          old?.[c.idField] ?? Math.max(0, ...rows.map((v) => Number(v[c.idField]) || 0)) + 1,
        created_at:
          old?.created_at ?? local.objects[id]?.row.created_at ?? '1970-01-01T00:00:00.000Z'
      }
      if (c.dependenciesField) row[c.dependenciesField] = r.dependencies
      for (const field of Object.keys(c.assetFields)) {
        if (isVideo('', field)) {
          if (old?.[field]) row[field] = old[field]
          continue
        }
        const file = r.files[field]
        if (file && !file.relativePath) {
          // Do not invent a filename for a legacy blob that was not selected for migration.
          if (old?.[field]) row[field] = old[field]
        } else row[field] = file?.relativePath ?? null
      }
      if (index === undefined) rows.push(row)
      else rows[index] = row
    }
    save(c.store, rows)
    if (c.type === 'character' && c.store === 'config/app/characters.json') {
      const path = 'config/app/character-resource-table.json'
      const table = (await load(path, { version: 1, rows: [] })) as {
        version: number
        rows: Record<string, unknown>[]
      }
      const tableRows = Array.isArray(table) ? (table as Record<string, unknown>[]) : table.rows
      if (!Array.isArray(tableRows)) throw new Error('远程资源编号表格式无效')
      for (const id of ids) {
        const row = rows.find((r) => r.sync_id === id),
          old = previous.objects[id]
        const matches = tableRows.flatMap((r, i) =>
          r.sync_id === id ||
          ((row?.code ?? old?.properties.code) && r.code === (row?.code ?? old?.properties.code))
            ? [i]
            : []
        )
        if (matches.length > 1) throw new Error('远程资源编号表存在重复编号')
        const index = matches[0]
        if (!row) {
          if (index !== undefined) tableRows.splice(index, 1)
          continue
        }
        const mapped = {
          ...(index === undefined ? {} : tableRows[index]),
          ...row,
          row_id: index === undefined ? `resource-row-${id}` : tableRows[index].row_id
        }
        delete mapped[c.idField]
        if (index === undefined) tableRows.push(mapped)
        else tableRows[index] = mapped
      }
      save(path, Array.isArray(table) ? tableRows : { ...table, rows: tableRows })
    }
  }
  return files
}
