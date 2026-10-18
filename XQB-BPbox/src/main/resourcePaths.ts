import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync
} from 'node:fs'
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Explicit resource fields: character/light-cone `path` is a business attribute. */
export const resourceDirectories: Record<string, string> = {
  left_head_image: 'assets/characters/left',
  right_head_image: 'assets/characters/right',
  avatar_small_image: 'assets/characters/small',
  full_body_image: 'assets/characters/big',
  chant_video: 'assets/videos/chant',
  pv: 'assets/videos/PV',
  upCharacterPvPath: 'assets/videos/PV',
  ban_voice: 'assets/audios/ban',
  pick_voice: 'assets/audios/pick',
  pick_sound: 'assets/audios/pick_sound',
  small_image: 'assets/lightcones/small',
  large_image: 'assets/lightcones/big',
  light_cone_small_image: 'assets/lightcones/small',
  light_cone_large_image: 'assets/lightcones/big',
  backgroundImage: 'assets/backgrounds/base',
  image: 'assets/backgrounds/base',
  frameImage: 'assets/hire',
  effectVideo: 'assets/effects/visual',
  pendingVideo: 'assets/effects/visual',
  selectedVideo: 'assets/effects/visual',
  selectedSound: 'assets/effects/sound',
  audioPath: 'assets/audios',
  iconPath: 'assets/icons',
  targetImage: 'assets/characters/small'
}
export const configReferenceDirectories: Record<string, string> = {
  triggerFlowFile: 'config/bp',
  bpFlowConfigFile: 'config/bp',
  bpResultFile: 'results/bp'
}
export const resourceUrlFields: Record<string, string> = Object.fromEntries([
  ...[
    'left_head_image',
    'right_head_image',
    'avatar_small_image',
    'full_body_image',
    'chant_video',
    'pv',
    'ban_voice',
    'pick_voice',
    'pick_sound',
    'small_image',
    'large_image'
  ].map((key) => [key, `${key}_url`]),
  ...[
    'backgroundImage',
    'image',
    'frameImage',
    'effectVideo',
    'pendingVideo',
    'selectedVideo',
    'selectedSound'
  ].map((key) => [key, `${key}Url`]),
  ['audioPath', 'audioUrl'],
  ['iconPath', 'iconUrl'],
  ['upCharacterPvPath', 'upCharacterPvUrl']
])

export function decodeResourcePath(value: string): string {
  let path = value
  if (path.startsWith('xqb-asset://local/'))
    path = decodeURIComponent(path.slice('xqb-asset://local/'.length))
  else if (path.startsWith('file:')) path = fileURLToPath(path)
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) throw new Error('不支持此资源 URL')
  return path.replace(/\\/g, '/')
}
export function isWithin(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path))
  return (
    !isAbsolute(rel) &&
    rel !== '..' &&
    !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  )
}
export function relativeResourcePath(root: string, value: string): string {
  const path = decodeResourcePath(value)
  const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path)
  if (!isWithin(root, absolute) || absolute === resolve(root))
    throw new Error('资源路径不在当前数据根目录内')
  const rel = relative(root, absolute).replace(/\\/g, '/')
  if (
    rel
      .split('/')
      .some(
        (part) =>
          /[<>:"|?*]/.test(part) ||
          /[. ]$/.test(part) ||
          [...part].some((char) => char.charCodeAt(0) < 32)
      )
  )
    throw new Error('资源路径包含无效文件名')
  return rel
}
function safeTarget(root: string, value: string): string {
  const path = resolve(root, relativeResourcePath(root, value))
  let cursor = path
  while (isWithin(root, cursor)) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink())
      throw new Error('资源路径包含符号链接或目录联接')
    if (cursor === resolve(root)) break
    cursor = dirname(cursor)
  }
  return path
}
function sameFile(left: string, right: string): boolean {
  if (realpathSync(left) === realpathSync(right)) return true
  if (
    !statSync(left).isFile() ||
    !statSync(right).isFile() ||
    statSync(left).size !== statSync(right).size
  )
    return false
  const a = openSync(left, 'r'),
    b = openSync(right, 'r')
  const x = Buffer.alloc(1024 * 1024),
    y = Buffer.alloc(x.length)
  try {
    while (true) {
      const size = readSync(a, x, 0, x.length, null)
      if (readSync(b, y, 0, y.length, null) !== size) return false
      if (!size) return true
      if (!x.subarray(0, size).equals(y.subarray(0, size))) return false
    }
  } finally {
    closeSync(a)
    closeSync(b)
  }
}
export interface ResourcePathIssue {
  field: string
  value: string
  reason: string
}
export interface ResourceCopy {
  source: string
  target: string
  size: number
  mtimeMs: number
}

/** Plans copies before touching configurations. Files never move or overwrite other files. */
export class ResourcePathPlan {
  readonly copies = new Map<string, ResourceCopy>()
  readonly issues: ResourcePathIssue[] = []
  constructor(
    readonly root: string,
    readonly legacyRoots: string[] = []
  ) {}

  convert(value: string, directory: string, configReference = false): string {
    const decoded = decodeResourcePath(value)
    const path =
      configReference && !isAbsolute(decoded) && !decoded.includes('/')
        ? `${directory}/${decoded}`
        : decoded
    let source: string, stored: string
    if (!isAbsolute(path) || isWithin(this.root, path)) {
      stored = relativeResourcePath(this.root, path)
      source = safeTarget(this.root, stored)
      if (existsSync(source)) {
        if (!statSync(source).isFile()) throw new Error('资源路径不是文件')
        return stored
      }
      let fallback = this.legacyRoots
        .map((root) => safeTarget(root, stored))
        .find((candidate) => existsSync(candidate))
      // Very old releases stored flows in userData/flows. Accept only a matching,
      // readable flow document; never replace a configuration already in the data root.
      if (!fallback && configReference && directory === 'config/bp') {
        fallback = this.legacyRoots
          .map((root) => safeTarget(root, `flows/${basename(stored)}`))
          .find((candidate) => {
            if (!existsSync(candidate) || !statSync(candidate).isFile()) return false
            try {
              const flow = JSON.parse(readFileSync(candidate, 'utf8'))
              return (
                typeof flow.name === 'string' && flow.name.length > 0 && Array.isArray(flow.steps)
              )
            } catch {
              return false
            }
          })
      }
      if (!fallback) throw new Error('文件不存在（当前根目录及旧回退目录均缺失）')
      source = fallback
    } else {
      source = resolve(path)
      if (!existsSync(source) || !statSync(source).isFile())
        throw new Error('外部资源文件不存在或不是文件')
      const legacy = this.legacyRoots.find((root) => isWithin(root, source))
      stored = legacy ? relativeResourcePath(legacy, source) : `${directory}/${basename(source)}`
      if (legacy) safeTarget(legacy, stored)
    }
    if (!statSync(source).isFile() || lstatSync(source).isSymbolicLink())
      throw new Error('不能安全复制此资源')
    const target = safeTarget(this.root, stored)
    if (existsSync(target)) {
      if (!sameFile(source, target))
        throw new Error('目标存在同名不同内容文件；保留原引用，不覆盖或改名')
      return stored
    }
    const key = target.toLowerCase()
    const pending = this.copies.get(key)
    if (pending && !sameFile(source, pending.source))
      throw new Error('多个不同资源使用相同目标文件名；保留原引用')
    const stat = statSync(source)
    this.copies.set(key, { source, target, size: stat.size, mtimeMs: stat.mtimeMs })
    return stored
  }

  document<T>(value: T, previous?: unknown, strict = false, prefix = ''): T {
    const visit = (input: unknown, before: unknown, pointer: string): unknown => {
      if (Array.isArray(input))
        return input.map((v, i) =>
          visit(v, Array.isArray(before) ? before[i] : undefined, `${pointer}/${i}`)
        )
      if (!input || typeof input !== 'object') return input
      const original = input as Record<string, unknown>
      const row = { ...original }
      // Recover older URL-only entries, then remove runtime-derived values from disk.
      for (const [field, url] of Object.entries(resourceUrlFields)) {
        if (
          !row[field] &&
          typeof row[url] === 'string' &&
          /^(xqb-asset:|file:)/.test(row[url] as string)
        )
          row[field] = row[url]
        delete row[url]
        delete row[field.endsWith('Path') ? field.replace(/Path$/, 'Exists') : `${field}_exists`]
      }
      for (const [key, child] of Object.entries(row)) {
        if (key === 'resource_status' || key === 'resourceStatus') continue
        const directory = Object.hasOwn(resourceDirectories, key)
          ? resourceDirectories[key]
          : Object.hasOwn(configReferenceDirectories, key)
            ? configReferenceDirectories[key]
            : undefined
        const prior = before && typeof before === 'object' ? before[key] : undefined
        if (directory && typeof child === 'string' && child) {
          try {
            row[key] = this.convert(child, directory, Boolean(configReferenceDirectories[key]))
          } catch (error) {
            const issue = {
              field: `${pointer}/${key}`,
              value: child,
              reason: (error as Error).message
            }
            this.issues.push(issue)
            // Existing unresolved references remain editable; new absolute/URL values must import successfully.
            if (strict && child !== prior && /^(?:[a-z]:|[\\/]|file:|xqb-asset:)/i.test(child)) {
              if (
                typeof prior === 'string' &&
                decodeResourcePath(child) === decodeResourcePath(prior)
              )
                row[key] = prior
              else throw new Error(`${issue.reason}：${child}`)
            }
          }
        } else row[key] = visit(child, prior, `${pointer}/${key}`)
      }
      return row
    }
    return visit(value, previous, prefix) as T
  }

  applyCopies(): void {
    for (const copy of this.copies.values()) {
      const target = safeTarget(this.root, copy.target)
      const current = statSync(copy.source)
      if (current.size !== copy.size || current.mtimeMs !== copy.mtimeMs)
        throw new Error(`复制前源文件已变化：${copy.source}`)
      if (existsSync(target)) {
        if (!sameFile(copy.source, target)) throw new Error(`目标文件已变化，未覆盖：${target}`)
        continue
      }
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(copy.source, target, constants.COPYFILE_EXCL)
    }
  }
}

export function importDirectory(category: string, key: string, source: string): string {
  if (Object.hasOwn(resourceDirectories, key)) return resourceDirectories[key]
  if (key.startsWith('voice-timeline-audio')) return 'assets/audios'
  if (key.includes('background')) return 'assets/backgrounds/base'
  if (key.includes('frame')) return 'assets/hire'
  if (category === 'light_cones')
    return key.includes('large') ? 'assets/lightcones/big' : 'assets/lightcones/small'
  const extension = extname(source).toLowerCase()
  if (/\.(mp3|wav|ogg|m4a|aac|flac)$/.test(extension)) return 'assets/effects/sound'
  if (/\.(mp4|webm|mov|mkv)$/.test(extension)) return 'assets/effects/visual'
  return 'assets/backgrounds/base'
}
