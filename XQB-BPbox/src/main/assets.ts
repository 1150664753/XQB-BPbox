import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'

import type { ImportedAssetResult, LocalAssetFile, LocalAssetKind } from '../shared/types'

export type AssetCategory = 'characters' | 'light_cones' | 'display'
export const assetProtocol = 'xqb-asset'

const imageExtensions = new Set(['.apng', '.avif', '.gif', '.jpg', '.jpeg', '.png', '.webp'])
const audioExtensions = new Set(['.aac', '.flac', '.m4a', '.mp3', '.ogg', '.wav'])
const videoExtensions = new Set(['.mkv', '.mov', '.mp4', '.webm'])

function pathIsInside(rootPath: string, targetPath: string): boolean {
  const nextRelative = relative(rootPath, targetPath)
  return nextRelative === '' || (!nextRelative.startsWith('..') && !isAbsolute(nextRelative))
}

export function getProjectRootPath(): string {
  const overrideRoot = process.env.XQB_BP_ROOT?.trim()
  if (overrideRoot) {
    return resolve(overrideRoot)
  }

  if (app.isPackaged) {
    return dirname(app.getPath('exe'))
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

export function getLegacyUserDataPath(...parts: string[]): string {
  return join(app.getPath('userData'), ...parts)
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
  const resolvedPath = resolve(filePath)
  const rootPath = getProjectRootPath()

  if (pathIsInside(rootPath, resolvedPath)) {
    return normalizeStoredPath(relative(rootPath, resolvedPath))
  }

  return normalizeStoredPath(resolvedPath)
}

export function resolveStoredPath(storedPath: string | null | undefined): string | null {
  if (!storedPath) {
    return null
  }

  if (isAbsolute(storedPath)) {
    return storedPath
  }

  const projectPath = getProjectPath(...storedPath.split(/[\\/]/))
  if (existsSync(projectPath)) {
    return projectPath
  }

  const legacyPath = getLegacyUserDataPath(...storedPath.split(/[\\/]/))
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

  return `${assetProtocol}://local/${encodeURIComponent(normalizeStoredPath(storedPath))}`
}

export function isExternalFilePath(value: string | null | undefined): boolean {
  if (!value) {
    return false
  }

  return isAbsolute(value) && existsSync(value)
}

export function importAssetFile(
  sourcePath: string,
  category: AssetCategory,
  ownerName: string,
  assetKey: string
): ImportedAssetResult {
  void category
  void ownerName
  void assetKey

  if (!existsSync(sourcePath)) {
    throw new Error(`资源文件不存在：${sourcePath}`)
  }

  ensureProjectDirectories()

  const storedPath = toStoredPath(sourcePath)
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

  if (isExternalFilePath(value)) {
    return importAssetFile(value, category, ownerName, assetKey).storedPath
  }

  return normalizeStoredPath(value)
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
