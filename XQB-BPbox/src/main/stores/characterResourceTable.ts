import {
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'

import type {
  Character,
  CharacterResourceStatus,
  CharacterResourceTableAssetField,
  CharacterResourceTableLoadResult,
  CharacterResourceTableRow,
  CharacterResourceTableSource,
  CharacterRarity,
  LocalAssetFile
} from '../../shared/types'
import {
  DEFAULT_PV_END_TIME,
  normalizePvEndTime,
  normalizePvStartTime
} from '../../shared/pvPlayback'
import {
  ensureProjectDirectories,
  getConfigPath,
  normalizeStoredPath,
  scanLocalAssets,
  storedPathExists
} from '../assets'
import { listCharacters } from './characters'

type MutableCharacterResourceTableRow = CharacterResourceTableRow & {
  [key in CharacterResourceTableAssetField]?: string | null
}

const tableAssetFields: CharacterResourceTableAssetField[] = [
  'left_head_image',
  'right_head_image',
  'chant_video',
  'pv',
  'avatar_small_image',
  'full_body_image',
  'ban_voice',
  'pick_voice',
  'pick_sound',
  'light_cone_small_image',
  'light_cone_large_image'
]

function resourceTablePath(): string {
  return getConfigPath('app', 'character-resource-table.json')
}

function characterStorePath(): string {
  return getConfigPath('app', 'characters.json')
}

function nowIso(): string {
  return new Date().toISOString()
}

function timestampForFileName(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function createRowId(): string {
  return `resource-row-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeCode(value: unknown): string {
  const code = stringOrEmpty(value).replace(/\s+/g, '')
  return /^\d+$/.test(code) ? code.padStart(5, '0') : code
}

function normalizeNullableAsset(value: unknown): string | null {
  const text = stringOrEmpty(value)
  return text ? normalizeStoredPath(text) : null
}

function normalizeRarity(value: unknown): CharacterRarity | null {
  if (Number(value) === 4) {
    return 4
  }

  if (Number(value) === 5) {
    return 5
  }

  return null
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = stringOrEmpty(value)
    if (text) {
      return text
    }
  }

  return ''
}

function firstAsset(...values: unknown[]): string | null {
  for (const value of values) {
    const text = normalizeNullableAsset(value)
    if (text) {
      return text
    }
  }

  return null
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function validResourceStatus(value: unknown): CharacterResourceStatus | undefined {
  return value === 'found' || value === 'missing' || value === 'notConfigured' ? value : undefined
}

function normalizeStatusMap(
  value: unknown
): Partial<Record<CharacterResourceTableAssetField, CharacterResourceStatus>> {
  if (!isObjectRecord(value)) {
    return {}
  }

  const aliases: Record<string, CharacterResourceTableAssetField> = {
    left_head_image: 'left_head_image',
    characterLeftImage: 'left_head_image',
    right_head_image: 'right_head_image',
    characterRightImage: 'right_head_image',
    chant_video: 'chant_video',
    callNameVideo: 'chant_video',
    pv: 'pv',
    avatar_small_image: 'avatar_small_image',
    characterSmallImage: 'avatar_small_image',
    full_body_image: 'full_body_image',
    characterBigImage: 'full_body_image',
    ban_voice: 'ban_voice',
    banAudio: 'ban_voice',
    pick_voice: 'pick_voice',
    pickAudio: 'pick_voice',
    pick_sound: 'pick_sound',
    light_cone_small_image: 'light_cone_small_image',
    lightconeSmallImage: 'light_cone_small_image',
    light_cone_large_image: 'light_cone_large_image',
    lightconeBigImage: 'light_cone_large_image'
  }
  const next: Partial<Record<CharacterResourceTableAssetField, CharacterResourceStatus>> = {}

  Object.entries(value).forEach(([key, rawStatus]) => {
    const field = aliases[key]
    const status = validResourceStatus(rawStatus)
    if (field && status) {
      next[field] = status
    }
  })

  return next
}

function computeResourceStatus(
  row: MutableCharacterResourceTableRow
): Partial<Record<CharacterResourceTableAssetField, CharacterResourceStatus>> {
  return tableAssetFields.reduce(
    (status, field) => {
      const value = row[field]
      status[field] = value ? (storedPathExists(value) ? 'found' : 'missing') : 'notConfigured'
      return status
    },
    {} as Partial<Record<CharacterResourceTableAssetField, CharacterResourceStatus>>
  )
}

function emptyTableRow(patch: Partial<CharacterResourceTableRow> = {}): CharacterResourceTableRow {
  const timestamp = nowIso()
  const row: MutableCharacterResourceTableRow = {
    row_id: createRowId(),
    code: '',
    english_name: '',
    chinese_name: '',
    rarity: null,
    element: '',
    path: '',
    left_head_image: null,
    right_head_image: null,
    chant_video: null,
    pv: null,
    pv_start_time: 0,
    pv_end_time: DEFAULT_PV_END_TIME,
    avatar_small_image: null,
    full_body_image: null,
    ban_voice: null,
    pick_voice: null,
    pick_sound: null,
    light_cone_small_image: null,
    light_cone_large_image: null,
    resource_status: {},
    status: '',
    created_at: timestamp,
    updated_at: timestamp,
    ...patch
  }

  row.resource_status = computeResourceStatus(row)
  return row
}

function normalizeResourceTableRow(value: unknown, index: number): CharacterResourceTableRow {
  const raw = isObjectRecord(value) ? value : {}
  const timestamp = nowIso()
  const row: MutableCharacterResourceTableRow = {
    row_id: firstString(raw.row_id, raw.rowId) || `resource-row-${index + 1}`,
    code: normalizeCode(firstString(raw.code, raw.id)),
    english_name: firstString(raw.english_name, raw.englishName),
    chinese_name: firstString(raw.chinese_name, raw.chineseName),
    rarity: normalizeRarity(raw.rarity),
    element: firstString(raw.element),
    path: firstString(raw.path),
    left_head_image: firstAsset(raw.left_head_image, raw.characterLeftImage),
    right_head_image: firstAsset(raw.right_head_image, raw.characterRightImage),
    chant_video: firstAsset(raw.chant_video, raw.callNameVideo),
    pv: firstAsset(raw.pv),
    pv_start_time: normalizePvStartTime(raw.pv_start_time ?? raw.pvStartTime),
    pv_end_time: normalizePvEndTime(raw.pv_end_time ?? raw.pvEndTime),
    avatar_small_image: firstAsset(raw.avatar_small_image, raw.characterSmallImage),
    full_body_image: firstAsset(raw.full_body_image, raw.characterBigImage),
    ban_voice: firstAsset(raw.ban_voice, raw.banAudio),
    pick_voice: firstAsset(raw.pick_voice, raw.pickAudio),
    pick_sound: firstAsset(raw.pick_sound),
    light_cone_small_image: firstAsset(raw.light_cone_small_image, raw.lightconeSmallImage),
    light_cone_large_image: firstAsset(raw.light_cone_large_image, raw.lightconeBigImage),
    resource_status: normalizeStatusMap(raw.resource_status ?? raw.resourceStatus),
    status: firstString(raw.status),
    created_at: firstString(raw.created_at, raw.createdAt) || timestamp,
    updated_at: firstString(raw.updated_at, raw.updatedAt) || timestamp
  }

  row.resource_status = {
    ...row.resource_status,
    ...computeResourceStatus(row)
  }

  return row
}

function rowHasContent(row: CharacterResourceTableRow): boolean {
  const mutable = row as MutableCharacterResourceTableRow
  return Boolean(
    row.code ||
    row.english_name ||
    row.chinese_name ||
    row.element ||
    row.path ||
    row.rarity ||
    tableAssetFields.some((field) => Boolean(mutable[field]))
  )
}

function fillStringIfEmpty(
  target: CharacterResourceTableRow,
  key: 'code' | 'english_name' | 'chinese_name' | 'element' | 'path' | 'status',
  value: string
): boolean {
  if (!target[key] && value) {
    target[key] = value
    return true
  }

  return false
}

function fillAssetIfEmpty(
  target: MutableCharacterResourceTableRow,
  key: CharacterResourceTableAssetField,
  value: string | null | undefined
): boolean {
  if (!target[key] && value) {
    target[key] = normalizeStoredPath(value)
    return true
  }

  return false
}

function fillRowIfEmpty(
  target: CharacterResourceTableRow,
  source: CharacterResourceTableRow
): boolean {
  let changed = false
  const mutableTarget = target as MutableCharacterResourceTableRow
  const mutableSource = source as MutableCharacterResourceTableRow

  changed = fillStringIfEmpty(target, 'code', source.code) || changed
  changed = fillStringIfEmpty(target, 'english_name', source.english_name) || changed
  changed = fillStringIfEmpty(target, 'chinese_name', source.chinese_name) || changed
  changed = fillStringIfEmpty(target, 'element', source.element) || changed
  changed = fillStringIfEmpty(target, 'path', source.path) || changed

  if (!target.rarity && source.rarity) {
    target.rarity = source.rarity
    changed = true
  }

  if (!target.pv_start_time && source.pv_start_time) {
    target.pv_start_time = source.pv_start_time
    changed = true
  }

  tableAssetFields.forEach((field) => {
    changed = fillAssetIfEmpty(mutableTarget, field, mutableSource[field]) || changed
  })

  if (changed) {
    target.updated_at = nowIso()
    target.resource_status = computeResourceStatus(mutableTarget)
  }

  return changed
}

function characterValuesForCode(character: Character): Array<string | null | undefined> {
  return [
    character.code,
    character.left_head_image,
    character.right_head_image,
    character.chant_video,
    character.pv,
    character.avatar_small_image,
    character.full_body_image,
    character.ban_voice,
    character.pick_voice,
    character.pick_sound
  ]
}

function extractCode(value: string | null | undefined): string {
  const match = value?.match(/(^|[^\d])(\d{4,5})(?!\d)/)
  return match?.[2] ? normalizeCode(match[2]) : ''
}

function codeFromCharacter(character: Character): string {
  const explicitCode = normalizeCode(character.code)
  if (explicitCode) {
    return explicitCode
  }

  for (const value of characterValuesForCode(character)) {
    const parsedCode = extractCode(value)
    if (parsedCode) {
      return parsedCode
    }
  }

  return ''
}

function rowFromCharacter(character: Character): CharacterResourceTableRow {
  const code = codeFromCharacter(character)
  return emptyTableRow({
    code,
    english_name: character.english_name,
    chinese_name: character.chinese_name,
    rarity: character.rarity,
    element: character.element,
    path: character.path,
    left_head_image: character.left_head_image,
    right_head_image: character.right_head_image,
    chant_video: character.chant_video,
    pv: character.pv,
    pv_start_time: character.pv_start_time,
    pv_end_time: character.pv_end_time,
    avatar_small_image: character.avatar_small_image,
    full_body_image: character.full_body_image,
    ban_voice: character.ban_voice,
    pick_voice: character.pick_voice,
    pick_sound: character.pick_sound,
    status: code ? '已从角色配置初始化' : '旧角色缺少编号，请手动补全'
  })
}

function rowsFromCharacters(): CharacterResourceTableRow[] {
  return listCharacters().map(rowFromCharacter)
}

function safeRowsFromCharacters(warnings: string[]): CharacterResourceTableRow[] {
  try {
    return rowsFromCharacters()
  } catch (error) {
    const backupPath = backupFile(characterStorePath(), 'broken')
    warnings.push(
      `角色配置无法用于初始化批量管理表，已备份为 ${backupPath ?? '备份失败'}：${
        error instanceof Error ? error.message : String(error)
      }`
    )
    return []
  }
}

function fieldForAsset(asset: LocalAssetFile): CharacterResourceTableAssetField | null {
  const path = normalizeStoredPath(asset.path).toLowerCase()

  if (path.includes('/audios/ban/')) {
    return 'ban_voice'
  }

  if (path.includes('/audios/pick_sound/')) {
    return 'pick_sound'
  }

  if (path.includes('/audios/pick/')) {
    return 'pick_voice'
  }

  if (path.includes('/characters/big/')) {
    return 'full_body_image'
  }

  if (path.includes('/characters/small/')) {
    return 'avatar_small_image'
  }

  if (path.includes('/characters/right/')) {
    return 'right_head_image'
  }

  if (path.includes('/characters/left/')) {
    return 'left_head_image'
  }

  if (path.includes('/videos/pv/') || path.includes('/videos/pv_')) {
    return 'pv'
  }

  if (path.includes('/videos/chant/') || path.includes('/videos/chant_')) {
    return 'chant_video'
  }

  if (path.includes('/lightcones/small/')) {
    return 'light_cone_small_image'
  }

  return null
}

function rowsFromAssets(): CharacterResourceTableRow[] {
  const rowsByCode = new Map<string, CharacterResourceTableRow>()

  scanLocalAssets().forEach((asset) => {
    const code = extractCode(asset.path)
    const field = fieldForAsset(asset)
    if (!code || !field) {
      return
    }

    const row = rowsByCode.get(code) ?? emptyTableRow({ code, status: '已从 assets 扫描初始化' })
    ;(row as MutableCharacterResourceTableRow)[field] = asset.path
    row.resource_status = computeResourceStatus(row as MutableCharacterResourceTableRow)
    rowsByCode.set(code, row)
  })

  return [...rowsByCode.values()].sort((left, right) => left.code.localeCompare(right.code))
}

function normalizeAndMergeRows(rows: CharacterResourceTableRow[]): CharacterResourceTableRow[] {
  const merged: CharacterResourceTableRow[] = []
  const rowByCode = new Map<string, CharacterResourceTableRow>()

  rows.forEach((row) => {
    const normalized = normalizeResourceTableRow(row, merged.length)

    if (!rowHasContent(normalized)) {
      return
    }

    if (normalized.code) {
      const existing = rowByCode.get(normalized.code)
      if (existing) {
        fillRowIfEmpty(existing, normalized)
        return
      }

      rowByCode.set(normalized.code, normalized)
    }

    merged.push(normalized)
  })

  return merged
}

function mergeRows(
  baseRows: CharacterResourceTableRow[],
  incomingRows: CharacterResourceTableRow[]
): { rows: CharacterResourceTableRow[]; changed: boolean } {
  const rows = normalizeAndMergeRows(baseRows)
  const rowsByCode = new Map(rows.filter((row) => row.code).map((row) => [row.code, row]))
  let changed = rows.length !== baseRows.length

  incomingRows.forEach((incomingRow) => {
    const normalized = normalizeResourceTableRow(incomingRow, rows.length)
    if (!rowHasContent(normalized)) {
      return
    }

    const existing = normalized.code ? rowsByCode.get(normalized.code) : undefined
    if (existing) {
      changed = fillRowIfEmpty(existing, normalized) || changed
      return
    }

    rows.push(normalized)
    if (normalized.code) {
      rowsByCode.set(normalized.code, normalized)
    }
    changed = true
  })

  rows.forEach((row) => {
    row.resource_status = computeResourceStatus(row as MutableCharacterResourceTableRow)
  })

  return { rows, changed }
}

function backupFile(filePath: string, label: string): string | null {
  if (!existsSync(filePath)) {
    return null
  }

  const backupPath = filePath.replace(/\.json$/i, `.${label}-${timestampForFileName()}.json`)
  copyFileSync(filePath, backupPath)
  return backupPath
}

function writeTableRows(rows: CharacterResourceTableRow[]): void {
  ensureProjectDirectories()

  const normalizedRows = normalizeAndMergeRows(rows)
  const payload = {
    version: 1,
    updated_at: nowIso(),
    rows: normalizedRows
  }
  const targetPath = resourceTablePath()
  const tempPath = `${targetPath}.tmp-${Date.now()}`

  writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8')

  try {
    renameSync(tempPath, targetPath)
  } catch (error) {
    if (existsSync(targetPath)) {
      unlinkSync(targetPath)
      renameSync(tempPath, targetPath)
      return
    }

    throw error
  }
}

function parseTableFile(warnings: string[]): CharacterResourceTableRow[] | null {
  const targetPath = resourceTablePath()
  if (!existsSync(targetPath)) {
    return null
  }

  try {
    const parsed = JSON.parse(readFileSync(targetPath, 'utf-8')) as unknown
    const rawRows = Array.isArray(parsed)
      ? parsed
      : isObjectRecord(parsed) && Array.isArray(parsed.rows)
        ? parsed.rows
        : null

    if (!rawRows) {
      throw new Error('批量管理表格式不正确，应为数组或包含 rows 数组的对象')
    }

    return normalizeAndMergeRows(rawRows.map(normalizeResourceTableRow))
  } catch (error) {
    const backupPath = backupFile(targetPath, 'broken')
    warnings.push(
      `批量管理表损坏，已备份为 ${backupPath ?? '备份失败'}：${
        error instanceof Error ? error.message : String(error)
      }`
    )
    return null
  }
}

function loadRowsFromBestSource(includeAssetScan: boolean): {
  rows: CharacterResourceTableRow[]
  source: CharacterResourceTableSource
  warnings: string[]
} {
  ensureProjectDirectories()

  const warnings: string[] = []
  const tableRows = parseTableFile(warnings)

  if (tableRows) {
    const merged = includeAssetScan
      ? mergeRows(tableRows, rowsFromAssets())
      : { rows: tableRows, changed: false }

    if ((includeAssetScan && merged.changed) || warnings.length > 0) {
      writeTableRows(merged.rows)
    }

    return {
      rows: merged.rows,
      source: 'table',
      warnings
    }
  }

  const characterRows = safeRowsFromCharacters(warnings)
  if (characterRows.length > 0) {
    const backupPath = backupFile(characterStorePath(), 'backup-before-resource-table')
    if (backupPath) {
      warnings.push(`已备份旧角色配置：${backupPath}`)
    }
    const merged = includeAssetScan
      ? mergeRows(characterRows, rowsFromAssets())
      : { rows: characterRows }
    writeTableRows(merged.rows)
    return {
      rows: normalizeAndMergeRows(merged.rows),
      source: 'characters',
      warnings
    }
  }

  const assetRows = rowsFromAssets()
  writeTableRows(assetRows)

  return {
    rows: assetRows,
    source: assetRows.length > 0 ? 'assets' : 'empty',
    warnings
  }
}

function tableResult(
  rows: CharacterResourceTableRow[],
  source: CharacterResourceTableSource,
  warnings: string[]
): CharacterResourceTableLoadResult {
  return {
    rows,
    source,
    path: resourceTablePath(),
    warnings
  }
}

export function loadCharacterResourceTable(): CharacterResourceTableLoadResult {
  const { rows, source, warnings } = loadRowsFromBestSource(false)
  return tableResult(rows, source, warnings)
}

export function scanCharacterResourceTable(): CharacterResourceTableLoadResult {
  const { rows, source, warnings } = loadRowsFromBestSource(true)
  return tableResult(rows, source, warnings)
}

export function saveCharacterResourceTable(
  rows: CharacterResourceTableRow[]
): CharacterResourceTableLoadResult {
  const normalizedRows = normalizeAndMergeRows(rows).map((row) => {
    row.updated_at = nowIso()
    row.resource_status = computeResourceStatus(row as MutableCharacterResourceTableRow)
    return row
  })

  writeTableRows(normalizedRows)
  return tableResult(normalizedRows, 'table', [])
}
