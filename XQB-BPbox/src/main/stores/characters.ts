import { existsSync, readFileSync, writeFileSync } from 'node:fs'

import type {
  Character,
  CharacterAssetField,
  CharacterFilters,
  CharacterPayload,
  CharacterResourceTableRow,
  CharacterRarity
} from '../../shared/types'
import { normalizePvEndTime, normalizePvStartTime } from '../../shared/pvPlayback'
import {
  ensureProjectDirectories,
  getConfigPath,
  normalizeStoredPath,
  prepareAssetValue,
  storedPathExists,
  storedPathToFileUrl
} from '../assets'

type StoredCharacter = Omit<
  Character,
  | 'left_head_image_url'
  | 'right_head_image_url'
  | 'chant_video_url'
  | 'pv_url'
  | 'avatar_small_image_url'
  | 'full_body_image_url'
  | 'ban_voice_url'
  | 'pick_voice_url'
  | 'pick_sound_url'
  | 'left_head_image_exists'
  | 'right_head_image_exists'
  | 'chant_video_exists'
  | 'pv_exists'
  | 'avatar_small_image_exists'
  | 'full_body_image_exists'
  | 'ban_voice_exists'
  | 'pick_voice_exists'
  | 'pick_sound_exists'
> &
  Record<string, unknown>

const characterAssetFields: CharacterAssetField[] = [
  'left_head_image',
  'right_head_image',
  'chant_video',
  'pv',
  'avatar_small_image',
  'full_body_image',
  'ban_voice',
  'pick_voice',
  'pick_sound'
]

function characterStorePath(): string {
  return getConfigPath('app', 'characters.json')
}

function nowIso(): string {
  return new Date().toISOString()
}

function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeRarity(value: unknown): CharacterRarity {
  return Number(value) === 4 ? 4 : 5
}

function normalizeCode(value: unknown): string {
  const code = stringOrEmpty(value).replace(/\s+/g, '')
  return /^\d+$/.test(code) ? code.padStart(5, '0') : code
}

function normalizeAssetPath(value: unknown): string | null {
  const text = stringOrEmpty(value)
  return text || null
}

function emptyCharacterStore(): StoredCharacter[] {
  return []
}

function ensureCharacterStoreFile(): void {
  ensureProjectDirectories()
  if (!existsSync(characterStorePath())) {
    writeFileSync(
      characterStorePath(),
      `${JSON.stringify(emptyCharacterStore(), null, 2)}\n`,
      'utf-8'
    )
  }
}

function normalizeStoredCharacter(value: unknown, index: number): StoredCharacter {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Partial<StoredCharacter> & Record<string, unknown>)
      : {}
  const timestamp = nowIso()
  const id = Math.max(1, Math.floor(Number(raw.id) || index + 1))

  return {
    ...raw,
    id,
    code: stringOrEmpty(raw.code),
    english_name: stringOrEmpty(raw.english_name),
    chinese_name: stringOrEmpty(raw.chinese_name),
    rarity: normalizeRarity(raw.rarity),
    element: stringOrEmpty(raw.element),
    path: stringOrEmpty(raw.path),
    left_head_image: normalizeAssetPath(raw.left_head_image),
    right_head_image: normalizeAssetPath(raw.right_head_image),
    chant_video: normalizeAssetPath(raw.chant_video),
    pv: normalizeAssetPath(raw.pv),
    pv_start_time: normalizePvStartTime(raw.pv_start_time),
    pv_end_time: normalizePvEndTime(raw.pv_end_time ?? raw.pvEndTime),
    avatar_small_image: normalizeAssetPath(raw.avatar_small_image),
    full_body_image: normalizeAssetPath(raw.full_body_image),
    ban_voice: normalizeAssetPath(raw.ban_voice),
    pick_voice: normalizeAssetPath(raw.pick_voice),
    pick_sound: normalizeAssetPath(raw.pick_sound),
    created_at: stringOrEmpty(raw.created_at) || timestamp,
    updated_at: stringOrEmpty(raw.updated_at) || timestamp
  }
}

function readCharacterStore(): StoredCharacter[] {
  ensureCharacterStoreFile()

  const parsed = JSON.parse(readFileSync(characterStorePath(), 'utf-8')) as unknown
  if (!Array.isArray(parsed)) {
    throw new Error('角色配置文件格式不正确，应为数组')
  }

  return parsed.map(normalizeStoredCharacter)
}

function writeCharacterStore(characters: StoredCharacter[]): void {
  ensureProjectDirectories()
  writeFileSync(characterStorePath(), `${JSON.stringify(characters, null, 2)}\n`, 'utf-8')
}

function mapCharacter(character: StoredCharacter): Character {
  return {
    ...character,
    left_head_image_url: storedPathToFileUrl(character.left_head_image),
    right_head_image_url: storedPathToFileUrl(character.right_head_image),
    chant_video_url: storedPathToFileUrl(character.chant_video),
    pv_url: storedPathToFileUrl(character.pv),
    avatar_small_image_url: storedPathToFileUrl(character.avatar_small_image),
    full_body_image_url: storedPathToFileUrl(character.full_body_image),
    ban_voice_url: storedPathToFileUrl(character.ban_voice),
    pick_voice_url: storedPathToFileUrl(character.pick_voice),
    pick_sound_url: storedPathToFileUrl(character.pick_sound),
    left_head_image_exists: storedPathExists(character.left_head_image),
    right_head_image_exists: storedPathExists(character.right_head_image),
    chant_video_exists: storedPathExists(character.chant_video),
    pv_exists: storedPathExists(character.pv),
    avatar_small_image_exists: storedPathExists(character.avatar_small_image),
    full_body_image_exists: storedPathExists(character.full_body_image),
    ban_voice_exists: storedPathExists(character.ban_voice),
    pick_voice_exists: storedPathExists(character.pick_voice),
    pick_sound_exists: storedPathExists(character.pick_sound)
  }
}

function validatePayload(payload: CharacterPayload): void {
  if (!payload.english_name.trim()) {
    throw new Error('英文名称不能为空')
  }

  if (!payload.chinese_name.trim()) {
    throw new Error('中文名称不能为空')
  }

  if (![4, 5].includes(payload.rarity)) {
    throw new Error('角色稀有度只能是 4 或 5')
  }
}

function ownerName(payload: CharacterPayload): string {
  return payload.english_name.trim() || payload.chinese_name.trim()
}

function prepareCharacterAssets(
  payload: CharacterPayload,
  existing?: StoredCharacter
): Record<CharacterAssetField, string | null> {
  const owner = ownerName(payload)
  return characterAssetFields.reduce(
    (assets, field) => {
      assets[field] = prepareAssetValue(
        payload[field],
        'characters',
        owner,
        field,
        existing?.[field] ?? null
      )
      return assets
    },
    {} as Record<CharacterAssetField, string | null>
  )
}

function nextCharacterId(characters: StoredCharacter[]): number {
  return Math.max(0, ...characters.map((character) => character.id)) + 1
}

function normalizedComparablePath(value: unknown): string {
  const text = stringOrEmpty(value)
  return text ? normalizeStoredPath(text).toLowerCase() : ''
}

function characterSharesResourceRowAsset(
  character: StoredCharacter,
  row: CharacterResourceTableRow
): boolean {
  return characterAssetFields.some((field) => {
    const rowValue = normalizedComparablePath(row[field])
    return Boolean(rowValue) && rowValue === normalizedComparablePath(character[field])
  })
}

function findCharacterIndexForResourceRow(
  characters: StoredCharacter[],
  row: CharacterResourceTableRow
): number {
  const code = normalizeCode(row.code)
  if (code) {
    const codeIndex = characters.findIndex((character) => normalizeCode(character.code) === code)
    if (codeIndex >= 0) {
      return codeIndex
    }
  }

  return characters.findIndex((character) => characterSharesResourceRowAsset(character, row))
}

function basicFieldsChanged(left: StoredCharacter, right: StoredCharacter): boolean {
  return (
    left.code !== right.code ||
    left.english_name !== right.english_name ||
    left.chinese_name !== right.chinese_name ||
    left.rarity !== right.rarity ||
    left.element !== right.element ||
    left.path !== right.path ||
    left.pv_start_time !== right.pv_start_time ||
    left.pv_end_time !== right.pv_end_time
  )
}

export function listCharacters(filters: CharacterFilters = {}): Character[] {
  const search = filters.search?.trim().toLowerCase()
  const element = filters.element?.trim()
  const path = filters.path?.trim()

  return readCharacterStore()
    .filter((character) => {
      if (
        search &&
        !character.code.toLowerCase().includes(search) &&
        !character.english_name.toLowerCase().includes(search) &&
        !character.chinese_name.toLowerCase().includes(search)
      ) {
        return false
      }

      if (element && character.element !== element) {
        return false
      }

      if (path && character.path !== path) {
        return false
      }

      return !filters.rarity || character.rarity === filters.rarity
    })
    .sort(
      (left, right) =>
        right.rarity - left.rarity ||
        left.chinese_name.localeCompare(right.chinese_name, 'zh-Hans-CN') ||
        left.english_name.localeCompare(right.english_name)
    )
    .map(mapCharacter)
}

export function getCharacter(id: number): Character | null {
  const character = readCharacterStore().find((item) => item.id === id)
  return character ? mapCharacter(character) : null
}

export function createCharacter(payload: CharacterPayload): Character {
  validatePayload(payload)

  const characters = readCharacterStore()
  const timestamp = nowIso()
  const assets = prepareCharacterAssets(payload)
  const character: StoredCharacter = {
    id: nextCharacterId(characters),
    code: stringOrEmpty(payload.code),
    english_name: payload.english_name.trim(),
    chinese_name: payload.chinese_name.trim(),
    rarity: payload.rarity,
    element: payload.element.trim(),
    path: payload.path.trim(),
    ...assets,
    pv_start_time: normalizePvStartTime(payload.pv_start_time),
    pv_end_time: normalizePvEndTime(payload.pv_end_time),
    created_at: timestamp,
    updated_at: timestamp
  }

  writeCharacterStore([...characters, character])
  return mapCharacter(character)
}

export function updateCharacter(id: number, payload: CharacterPayload): Character {
  validatePayload(payload)

  const characters = readCharacterStore()
  const index = characters.findIndex((character) => character.id === id)
  if (index < 0) {
    throw new Error('角色不存在')
  }

  const existing = characters[index]
  const assets = prepareCharacterAssets(payload, existing)
  const updated: StoredCharacter = {
    ...existing,
    code: stringOrEmpty(payload.code),
    english_name: payload.english_name.trim(),
    chinese_name: payload.chinese_name.trim(),
    rarity: payload.rarity as CharacterRarity,
    element: payload.element.trim(),
    path: payload.path.trim(),
    ...assets,
    pv_start_time: normalizePvStartTime(payload.pv_start_time),
    pv_end_time: normalizePvEndTime(payload.pv_end_time),
    updated_at: nowIso()
  }
  const nextCharacters = [...characters]
  nextCharacters[index] = updated

  writeCharacterStore(nextCharacters)
  return mapCharacter(updated)
}

export function syncCharacterBasicsFromResourceRows(rows: CharacterResourceTableRow[]): number {
  const characters = readCharacterStore()
  const nextCharacters = [...characters]
  const matchedCharacterIds = new Set<number>()
  let updatedCount = 0

  rows.forEach((row) => {
    const index = findCharacterIndexForResourceRow(nextCharacters, row)
    if (index < 0) {
      return
    }

    const existing = nextCharacters[index]
    if (matchedCharacterIds.has(existing.id)) {
      return
    }

    const updated: StoredCharacter = {
      ...existing,
      code: normalizeCode(row.code),
      english_name: stringOrEmpty(row.english_name) || existing.english_name,
      chinese_name: stringOrEmpty(row.chinese_name) || existing.chinese_name,
      rarity: row.rarity === 4 || row.rarity === 5 ? row.rarity : existing.rarity,
      element: stringOrEmpty(row.element),
      path: stringOrEmpty(row.path),
      pv_start_time: normalizePvStartTime(row.pv_start_time),
      pv_end_time: normalizePvEndTime(row.pv_end_time)
    }

    if (!basicFieldsChanged(existing, updated)) {
      matchedCharacterIds.add(existing.id)
      return
    }

    updated.updated_at = nowIso()
    nextCharacters[index] = updated
    matchedCharacterIds.add(existing.id)
    updatedCount += 1
  })

  if (updatedCount > 0) {
    writeCharacterStore(nextCharacters)
  }

  return updatedCount
}

export function deleteCharacter(id: number): boolean {
  const characters = readCharacterStore()
  const nextCharacters = characters.filter((character) => character.id !== id)
  if (nextCharacters.length === characters.length) {
    return false
  }

  writeCharacterStore(nextCharacters)
  return true
}
