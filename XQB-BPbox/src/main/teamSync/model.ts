import { createHash } from 'node:crypto'
import type { TeamManifest, TeamProfile, TeamResource, ResourceFile } from '../../shared/teamSync'

export const MAX_FILE_BYTES = 95 * 1024 * 1024
export const MAX_INDEX_BYTES = 8 * 1024 * 1024
export const safeKey = /^(?!(?:constructor|prototype)$)[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/
const mediaExtension = /\.(png|jpe?g|webp|gif|avif|apng|bmp|ico|aac|flac|m4a|mp3|ogg|wav)$/i
export function isVideo(path: string, field = ''): boolean {
  return (
    /\.(mp4|webm|mov|mkv|avi|m4v|wmv|flv|mpeg|mpg)$/i.test(path) ||
    /(^|\/)videos(\/|$)/i.test(path) ||
    ['chant_video', 'pv'].includes(field)
  )
}
/** Portable filenames only; rejects Windows aliases, ADS, traversal and credential formats. */
export function assetPath(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length > 500 ||
    !value.startsWith('assets/') ||
    !mediaExtension.test(value) ||
    isVideo(value) ||
    value.startsWith('assets/team-sync/') ||
    value
      .split('/')
      .some(
        (s) =>
          !s ||
          s === '.' ||
          s === '..' ||
          /[\\\\<>:"|?*%]/.test(s) ||
          Array.from(s).some((c) => c.charCodeAt(0) < 32) ||
          /[. ]$/.test(s) ||
          s.startsWith('.') ||
          /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(s)
      )
  )
    throw new Error(
      '资源路径必须是 assets/ 内的图片或音频分类相对路径，不能包含视频、缓存或越界片段'
    )
  return value
}
export function isConfigDocument(path: string): boolean {
  return /^(?:config\/(?:bp|display|audio)\/.+\.json|config\/settings\.json|config\/app\/profiles\.json)$/.test(
    path
  )
}
export function isResultDocument(path: string): boolean {
  return /^results\/.+\.json$/.test(path)
}
export function isSyncDocument(path: string): boolean {
  return isConfigDocument(path) || isResultDocument(path)
}
export function sharedPath(value: string): string {
  if (value.startsWith('assets/')) return assetPath(value)
  if (
    (!isSyncDocument(value) && !/^config\/(?:app\/)?[a-zA-Z0-9_-]+\.json$/.test(value)) ||
    (!isResultDocument(value) &&
      /(?:profile-migrations|team-|credential|token|password|secret)/i.test(value)) ||
    value
      .split('/')
      .some(
        (s) =>
          !s ||
          s.startsWith('.') ||
          /[\\\\<>:"|?*%]/.test(s) ||
          Array.from(s).some((c) => c.charCodeAt(0) < 32) ||
          /[. ]$/.test(s) ||
          /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(s)
      )
  )
    throw new Error('文档路径不在可共享的 config 或 results 目录内')
  return value
}
export function repositoryPath(profileId: string, relativePath: string): string {
  const path = sharedPath(relativePath)
  return profileId === 'default' ? path : `${prefix(profileId)}/${path}`
}
export function pathDescriptor(
  profileId: string,
  relativePath: string,
  sha256: string,
  size: number
): ResourceFile {
  const path = sharedPath(relativePath)
  return {
    path: repositoryPath(profileId, path),
    relativePath: path,
    sha256,
    size,
    extension: path.slice(path.lastIndexOf('.')).toLowerCase()
  }
}
export function assertShareable(value: unknown): void {
  if (typeof value === 'string' && /^(?:[a-z]:[\\/]|[\\/]|file:|xqb-asset:)/i.test(value))
    throw new Error('属性包含个人绝对路径或运行时 URL，请先移除或取消勾选属性')
  if (value && typeof value === 'object')
    for (const [key, child] of Object.entries(value)) {
      if (
        /^(?:__proto__|constructor|prototype)$/i.test(key) ||
        /token|password|secret|credential|authorization|api[_-]?key|access[_-]?key|private[_-]?key/i.test(
          key
        )
      )
        throw new Error('属性包含凭据或不允许的字段，请取消勾选属性')
      assertShareable(child)
    }
}
export function unitHash(resource: TeamResource | undefined, field: string): string | null {
  if (!resource) return null
  if (field === '$properties')
    return digest(
      canonical({
        name: resource.name,
        properties: resource.properties,
        dependencies: resource.dependencies
      })
    )
  const f = resource.files[field]
  return f
    ? digest(
        canonical({
          sha256: f.sha256,
          extension: f.extension,
          ...(f.relativePath ? { relativePath: f.relativePath } : {})
        })
      )
    : null
}
const hashPattern = /^[a-f0-9]{64}$/
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`
  return JSON.stringify(value)
}
export function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}
export function resourceHash(resource: TeamResource): string {
  // Preview encoders and local filenames do not change object identity/content.
  return digest(
    canonical({
      id: resource.id,
      type: resource.type,
      name: resource.name,
      properties: resource.properties,
      files: Object.fromEntries(
        Object.entries(resource.files).map(([key, f]) => [
          key,
          {
            sha256: f.sha256,
            extension: f.extension,
            ...(f.relativePath ? { relativePath: f.relativePath } : {})
          }
        ])
      ),
      dependencies: [...resource.dependencies].sort()
    })
  )
}
export function prefix(profileId: string): string {
  return `bpbox/profiles/${profileId}`
}
export function indexPath(profileId: string): string {
  return `.bpbox/profiles/${profileId}/manifest.json`
}
/** Existing repositories keep their original index location until explicitly migrated. */
export function legacyIndexPath(profileId: string): string {
  return `${prefix(profileId)}/manifest.json`
}
export function fileDescriptor(
  profileId: string,
  sha256: string,
  size: number,
  extension: string
): ResourceFile {
  return { path: `${prefix(profileId)}/blobs/${sha256}${extension}`, sha256, size, extension }
}
export function validateFile(file: ResourceFile, profileId: string): void {
  if (
    !file ||
    !hashPattern.test(file.sha256) ||
    !Number.isSafeInteger(file.size) ||
    file.size < 0 ||
    file.size > MAX_FILE_BYTES ||
    !/^\.[a-z0-9]{1,10}$/.test(file.extension) ||
    (file.relativePath
      ? file.path !== repositoryPath(profileId, file.relativePath) ||
        !file.relativePath.toLowerCase().endsWith(file.extension)
      : file.path !== fileDescriptor(profileId, file.sha256, file.size, file.extension).path &&
        file.path !== `${prefix(profileId)}/previews/${file.sha256}.png`)
  ) {
    throw new Error('远程文件索引无效（路径、大小或 SHA-256）')
  }
}
export function validateManifest(value: unknown, profile: TeamProfile): TeamManifest {
  const m = value as TeamManifest
  if (
    !m ||
    ![1, 2].includes(m.schema) ||
    m.profileId !== profile.id ||
    !m.objects ||
    Array.isArray(m.objects) ||
    typeof m.objects !== 'object' ||
    Object.keys(m.objects).length > 20000
  )
    throw new Error('不兼容的团队 Manifest')
  for (const [id, r] of Object.entries(m.objects)) {
    if (
      !safeKey.test(id) ||
      !r ||
      r.id !== id ||
      !safeKey.test(r.type) ||
      typeof r.name !== 'string' ||
      r.name.length > 500 ||
      !Number.isSafeInteger(r.version) ||
      r.version < 1 ||
      !r.properties ||
      Array.isArray(r.properties) ||
      typeof r.properties !== 'object' ||
      !r.files ||
      Array.isArray(r.files) ||
      typeof r.files !== 'object' ||
      !Array.isArray(r.dependencies) ||
      r.dependencies.length > 1000 ||
      r.dependencies.some((d) => typeof d !== 'string' || !safeKey.test(d)) ||
      !hashPattern.test(r.hash)
    )
      throw new Error(`无效的对象索引：${id}`)
    for (const [key, file] of Object.entries(r.files)) {
      if (!safeKey.test(key)) throw new Error('无效的资源字段')
      validateFile(file, profile.id)
    }
    if (r.thumbnail) {
      validateFile(r.thumbnail, profile.id)
      if (r.thumbnail.size > 512 * 1024) throw new Error('缩略图过大')
    }
    if (resourceHash(r) !== r.hash) throw new Error(`对象摘要校验失败：${r.name}`)
  }
  for (const [path, file] of Object.entries(m.stores ?? {})) {
    if (
      file.relativePath !== path ||
      !(
        path === 'config/app/character-resource-table.json' ||
        profile.collections.some((c) => c.store === path)
      )
    )
      throw new Error('配置索引路径无效')
    validateFile(file, profile.id)
  }
  return m
}
