import { decodeResourcePath, relativeResourcePath } from '../resourcePaths'
import type { TeamResource } from '../../shared/teamSync'
import {
  assetPath,
  assertShareable,
  canonical,
  digest,
  isResultDocument,
  isSyncDocument,
  isVideo,
  pathDescriptor,
  sharedPath
} from './model'

export interface ConfigurationReference {
  field: string
  pointer: string[]
  value: string
  path?: string
  excluded: boolean
}
const privateKey = (key: string): boolean =>
  /token|password|secret|credential|authorization|api[_-]?key|access[_-]?key|private[_-]?key/i.test(
    key
  ) || ['currentProfileId', 'sourceRoots'].includes(key)
const derivedKey = (key: string): boolean =>
  /(?:_url|Url|_exists|Exists)$/.test(key) || key === 'resource_status'
const unsafeKey = (key: string): boolean => ['__proto__', 'constructor', 'prototype'].includes(key)
export function configIdentity(profile: string, path: string): string {
  return digest(
    canonical([profile, isResultDocument(path) ? 'result' : 'configuration', sharedPath(path)])
  )
}
export function configBytes(content: unknown): Buffer {
  return Buffer.from(JSON.stringify(content, null, 2) + '\n')
}
export function configuration(
  value: unknown,
  root: string
): { content: unknown; references: ConfigurationReference[] } {
  const references: ConfigurationReference[] = []
  const visit = (v: unknown, pointer: string[]): unknown => {
    if (typeof v === 'string') {
      let normalized: string
      try {
        normalized = /^(?:xqb-asset:|file:)/.test(v) ? decodeResourcePath(v) : v.replace(/\\/g, '/')
      } catch {
        return null
      }
      if (pointer.at(-1) === 'bpResultFile' && normalized) {
        try {
          const path = relativeResourcePath(
            root,
            normalized.includes('/') ? normalized : `results/bp/${normalized}`
          )
          return isResultDocument(path) ? sharedPath(path) : null
        } catch {
          return null
        }
      }
      if (/^(?:assets\/|[a-z]:\/|\/|file:)/i.test(normalized)) {
        let path = normalized
        try {
          path = relativeResourcePath(root, normalized)
        } catch {
          /* External references stay local. */
        }
        const excluded = isVideo(normalized, pointer.at(-1))
        let safe: string | undefined
        try {
          safe = assetPath(path)
        } catch {
          /* External/unsupported paths stay local. */
        }
        const ref = {
          field: `asset_${digest(canonical(pointer)).slice(0, 24)}`,
          pointer,
          value: v,
          path: safe,
          excluded
        }
        references.push(ref)
        if (safe) return safe
        // Portable references to videos may remain in configuration; bytes are never synchronized.
        if (
          excluded &&
          /^assets\/[a-zA-Z0-9_\-/ .\u0080-\uffff]+$/.test(path) &&
          !path.split('/').includes('..')
        )
          return path
        return null
      }
      return v
    }
    if (Array.isArray(v)) return v.map((item, i) => visit(item, [...pointer, String(i)]))
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v)
          .filter(([key]) => !privateKey(key) && !derivedKey(key) && !unsafeKey(key))
          .map(([key, child]) => [key, visit(child, [...pointer, key])])
      )
    return v
  }
  return { content: visit(value, []), references }
}
export function setPointer(object: unknown, pointer: string[], value: unknown): void {
  if (!pointer.length || pointer.some(unsafeKey)) throw new Error('配置资源引用位置无效')
  let current = object as Record<string, unknown>
  for (const key of pointer.slice(0, -1)) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, key))
      throw new Error('配置资源引用位置不存在')
    current = current[key] as Record<string, unknown>
  }
  if (!current || typeof current !== 'object') throw new Error('配置资源引用位置无效')
  current[pointer.at(-1)!] = value
}
export function validateConfiguration(resource: TeamResource, profile: string): void {
  const path = resource.properties.configPath
  if (
    typeof path !== 'string' ||
    !isSyncDocument(path) ||
    resource.type !== (isResultDocument(path) ? 'result' : 'configuration') ||
    configIdentity(profile, path) !== resource.id
  )
    throw new Error('共享配置身份或路径无效')
  assertShareable(resource.properties)
  const file = resource.files.document,
    bytes = configBytes(resource.properties.content)
  if (
    !file ||
    file.relativePath !== path ||
    file.sha256 !== digest(bytes) ||
    file.size !== bytes.length
  )
    throw new Error('共享配置内容与 SHA-256 不一致')
  const pointers = resource.properties.pointers
  if (!pointers || typeof pointers !== 'object' || Array.isArray(pointers))
    throw new Error('配置资源引用索引无效')
  for (const [field, pointer] of Object.entries(pointers)) {
    if (
      !Array.isArray(pointer) ||
      !pointer.length ||
      pointer.some((v) => typeof v !== 'string' || unsafeKey(v)) ||
      field !== `asset_${digest(canonical(pointer)).slice(0, 24)}`
    )
      throw new Error('配置引用位置无效')
    const file = resource.files[field]
    if (
      file &&
      (!file.relativePath?.startsWith('assets/') ||
        file.relativePath !== assetPath(file.relativePath))
    )
      throw new Error('配置媒体引用越界')
    if (file) {
      let value: unknown = resource.properties.content
      for (const key of pointer) {
        if (!value || typeof value !== 'object' || !Object.hasOwn(value, key))
          throw new Error('配置媒体引用位置不存在')
        value = value[key]
      }
      if (value !== file.relativePath) throw new Error('配置内容与媒体路径不一致')
    }
  }
  if (
    Object.keys(resource.files).some(
      (field) => field !== 'document' && !Object.hasOwn(pointers, field)
    )
  )
    throw new Error('配置媒体缺少引用位置')
}
/** Keep unselected indexed media references intact when selecting only the JSON document. */
export function reconcileConfiguration(resource: TeamResource, selected: string[]): void {
  const pointers = resource.properties.pointers as Record<string, string[]>
  for (const field of selected) {
    if (field === 'document' || field === '$properties') continue
    if (!pointers[field]) throw new Error('新增配置资源引用需要一并选择配置文件内容')
    setPointer(
      resource.properties.content,
      pointers[field],
      resource.files[field]?.relativePath ?? null
    )
  }
  for (const [field, file] of Object.entries(resource.files)) {
    if (field === 'document') continue
    if (!pointers[field]) {
      if (!selected.includes('$properties'))
        throw new Error('配置结构已变化，请一并选择配置文件内容')
      delete resource.files[field]
    } else setPointer(resource.properties.content, pointers[field], file.relativePath ?? null)
  }
}
/** Keep device-only settings on this machine when replacing the shareable configuration. */
export function restorePrivate(local: unknown, shared: unknown): unknown {
  if (Array.isArray(shared))
    return shared.map((item, index) => {
      const candidates = Array.isArray(local) ? local : []
      const key =
        item && typeof item === 'object'
          ? 'id' in item
            ? 'id'
            : 'sync_id' in item
              ? 'sync_id'
              : null
          : null
      const original = key ? candidates.find((v) => v && v[key] === item[key]) : candidates[index]
      return restorePrivate(original, item)
    })
  if (shared && typeof shared === 'object') {
    const result = Object.fromEntries(
      Object.entries(shared)
        .filter(([key]) => !unsafeKey(key))
        .map(([key, v]) => [
          key,
          restorePrivate(local && typeof local === 'object' ? local[key] : undefined, v)
        ])
    )
    if (local && typeof local === 'object')
      for (const [key, v] of Object.entries(local))
        if (privateKey(key) && !unsafeKey(key)) result[key] = v
    return result
  }
  return shared
}
export function updateConfigDocument(resource: TeamResource, profile: string): void {
  const bytes = configBytes(resource.properties.content)
  resource.files.document = pathDescriptor(
    profile,
    String(resource.properties.configPath),
    digest(bytes),
    bytes.length
  )
}
