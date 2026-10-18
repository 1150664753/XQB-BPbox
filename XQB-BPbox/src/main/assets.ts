import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import {
  decodeResourcePath,
  importDirectory,
  isWithin,
  relativeResourcePath,
  ResourcePathPlan,
  resourceUrlFields
} from './resourcePaths'
import {
  backupResourceConfig,
  pathBackupDirectory,
  writeResourceJsonAtomic
} from './resourceMigration'

import type { ImportedAssetResult, LocalAssetFile, LocalAssetKind } from '../shared/types'

export type AssetCategory = 'characters' | 'light_cones' | 'display'
export const assetProtocol = 'xqb-asset'

const imageExtensions = new Set(['.apng', '.avif', '.gif', '.jpg', '.jpeg', '.png', '.webp'])
const audioExtensions = new Set(['.aac', '.flac', '.m4a', '.mp3', '.ogg', '.wav'])
const videoExtensions = new Set(['.mkv', '.mov', '.mp4', '.webm'])

export function getProjectRootPath(): string {
  const overrideRoot = process.env.XQB_BP_ROOT?.trim()
  if (overrideRoot) {
    return resolve(overrideRoot)
  }

  if (app.isPackaged) {
    return app.getPath('userData')
  }

  return resolve(process.cwd())
}

export function getProjectPath(...parts: string[]): string {
  return join(getProjectRootPath(), ...parts)
}

export function getConfigPath(...parts: string[]): string {
  return getProjectPath('config', ...parts)
}

export function getAssetsPath(...parts: string[]): string {
  return getProjectPath('assets', ...parts)
}

export function getResultsPath(...parts: string[]): string {
  return getProjectPath('results', ...parts)
}

export function getLegacyResourceRoots(): string[] {
  return [app.isPackaged ? dirname(app.getPath('exe')) : app.getPath('userData')]
}

export function ensureProjectDirectories(): void {
  mkdirSync(getConfigPath('display'), { recursive: true })
  mkdirSync(getConfigPath('bp'), { recursive: true })
  mkdirSync(getConfigPath('audio'), { recursive: true })
  mkdirSync(getConfigPath('app'), { recursive: true })
  mkdirSync(getAssetsPath(), { recursive: true })
  mkdirSync(getAssetsPath('audios', 'pick_sound'), { recursive: true })
  mkdirSync(getResultsPath('bp'), { recursive: true })

  const settingsPath = getConfigPath('settings.json')
  if (!existsSync(settingsPath)) {
    writeFileSync(settingsPath, '{\n}\n', 'utf-8')
  }
}

export function ensureUserDataDirectories(): void {
  ensureProjectDirectories()
}

export function sanitizeFileSegment(value: string): string {
  const withoutUnsafeChars = Array.from(value.trim())
    .map((char) => {
      const code = char.charCodeAt(0)
      return code < 32 || /[<>:"/\\|?*]/.test(char) ? '-' : char
    })
    .join('')

  const clean = withoutUnsafeChars.replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')

  return clean || 'untitled'
}

export function normalizeStoredPath(value: string): string {
  return value.replace(/\\/g, '/')
}

export function toStoredPath(filePath: string): string {
  return relativeResourcePath(getProjectRootPath(), filePath)
}

export function resolveStoredPath(storedPath: string | null | undefined): string | null {
  if (!storedPath) {
    return null
  }

  let decoded: string
  try {
    decoded = decodeResourcePath(storedPath)
  } catch {
    return null
  }
  if (isAbsolute(decoded)) return decoded // Unresolved legacy references remain usable until imported.
  const projectPath = resolve(getProjectRootPath(), decoded)
  if (!isWithin(getProjectRootPath(), projectPath)) return null
  if (existsSync(projectPath)) {
    return projectPath
  }

  const legacyPath = join(getLegacyResourceRoots()[0], decoded)
  return existsSync(legacyPath) ? legacyPath : projectPath
}

export function storedPathExists(storedPath: string | null | undefined): boolean {
  const resolvedPath = resolveStoredPath(storedPath)
  return resolvedPath ? existsSync(resolvedPath) : false
}

export function storedPathToFileUrl(storedPath: string | null | undefined): string | null {
  if (!storedPath) {
    return null
  }

  try {
    const decoded = decodeResourcePath(storedPath)
    const path =
      isAbsolute(decoded) && isWithin(getProjectRootPath(), decoded)
        ? toStoredPath(decoded)
        : decoded
    return `${assetProtocol}://local/${encodeURIComponent(path)}`
  } catch {
    return null
  }
}

export function isExternalFilePath(value: string | null | undefined): boolean {
  if (!value) {
    return false
  }

  try {
    return isAbsolute(decodeResourcePath(value)) && storedPathExists(value)
  } catch {
    return false
  }
}

export function importAssetFile(
  sourcePath: string,
  category: AssetCategory,
  ownerName: string,
  assetKey: string
): ImportedAssetResult {
  void ownerName
  const plan = new ResourcePathPlan(getProjectRootPath(), getLegacyResourceRoots())
  const storedPath = plan.convert(sourcePath, importDirectory(category, assetKey, sourcePath))
  plan.applyCopies()
  return {
    storedPath,
    url: storedPathToFileUrl(storedPath),
    exists: true
  }
}

export function prepareAssetValue(
  value: string | null | undefined,
  category: AssetCategory,
  ownerName: string,
  assetKey: string,
  fallback: string | null = null
): string | null {
  if (value === undefined) {
    return fallback
  }

  if (value === null || value.trim() === '') {
    return null
  }

  try {
    return importAssetFile(value, category, ownerName, assetKey).storedPath
  } catch (error) {
    // Never rewrite an existing missing reference, nor silently persist a newly selected absolute path.
    if (value === fallback || !/^(?:[a-z]:|[\\/]|file:|xqb-asset:)/i.test(value)) {
      console.warn('[ResourcePath]', (error as Error).message, value)
      return value
    }
    throw error
  }
}

/** All saves use the data root; loading never copies or rewrites a resource. */
export function writeResourceDocument<T>(filePath: string, value: T): T {
  const root = getProjectRootPath()
  relativeResourcePath(root, filePath)
  const previous = existsSync(filePath) ? JSON.parse(readFileSync(filePath, 'utf8')) : undefined
  const plan = new ResourcePathPlan(root, getLegacyResourceRoots())
  const portable = plan.document(value, previous, true)
  if (previous && JSON.stringify(previous) !== JSON.stringify(portable))
    backupResourceConfig(root, filePath, pathBackupDirectory(root))
  plan.applyCopies()
  writeResourceJsonAtomic(filePath, portable)
  for (const issue of plan.issues) console.warn('[ResourcePath]', filePath, issue)
  return portable
}

export function hydrateResourceDocument<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => hydrateResourceDocument(item)) as T
  if (!value || typeof value !== 'object') return value
  const row = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      ['resource_status', 'resourceStatus'].includes(key) ? child : hydrateResourceDocument(child)
    ])
  )
  for (const [field, url] of Object.entries(resourceUrlFields)) {
    if (!(field in row)) continue
    row[url] = storedPathToFileUrl(row[field])
    if (field === 'audioPath') row.audioExists = storedPathExists(row[field])
    else if (url.endsWith('_url')) row[`${field}_exists`] = storedPathExists(row[field])
  }
  if (typeof row.targetImage === 'string') row.targetImage = storedPathToFileUrl(row.targetImage)
  return row as T
}

/** Named file selectors still accept legacy bare names; persisted references use root-relative paths. */
export function resolveConfigReference(value: string, directory: string): string {
  const path = decodeResourcePath(value)
  if (isAbsolute(path)) return path
  const relativePath = path.includes('/') ? path : `${directory}/${path}`
  return resolve(getProjectRootPath(), relativeResourcePath(getProjectRootPath(), relativePath))
}

function classifyAssetKind(filePath: string): LocalAssetKind {
  const extension = extname(filePath).toLowerCase()

  if (imageExtensions.has(extension)) {
    return 'image'
  }

  if (audioExtensions.has(extension)) {
    return 'audio'
  }

  if (videoExtensions.has(extension)) {
    return 'video'
  }

  return 'other'
}

function scanAssetDirectory(dirPath: string, kind?: LocalAssetKind): LocalAssetFile[] {
  if (!existsSync(dirPath)) {
    return []
  }

  return readdirSync(dirPath, { withFileTypes: true }).flatMap((entry) => {
    const filePath = join(dirPath, entry.name)

    if (entry.isDirectory()) {
      return scanAssetDirectory(filePath, kind)
    }

    if (!entry.isFile()) {
      return []
    }

    const assetKind = classifyAssetKind(filePath)
    if (kind && assetKind !== kind) {
      return []
    }

    const stat = statSync(filePath)
    const storedPath = toStoredPath(filePath)
    return [
      {
        name: entry.name,
        path: storedPath,
        url: storedPathToFileUrl(storedPath),
        kind: assetKind,
        size: stat.size,
        updatedAt: stat.mtime.toISOString()
      }
    ]
  })
}

export function scanLocalAssets(kind?: LocalAssetKind): LocalAssetFile[] {
  ensureProjectDirectories()
  return scanAssetDirectory(getAssetsPath(), kind).sort((left, right) =>
    left.path.localeCompare(right.path)
  )
}
