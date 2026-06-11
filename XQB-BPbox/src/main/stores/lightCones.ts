import { existsSync, readFileSync, writeFileSync } from 'node:fs'

import type {
  LightCone,
  LightConeFilters,
  LightConePayload,
  LightConeRarity
} from '../../shared/types'
import {
  ensureProjectDirectories,
  getConfigPath,
  prepareAssetValue,
  storedPathExists,
  storedPathToFileUrl
} from '../assets'

type StoredLightCone = Omit<
  LightCone,
  'small_image_url' | 'large_image_url' | 'small_image_exists' | 'large_image_exists'
>

function lightConeStorePath(): string {
  return getConfigPath('app', 'light-cones.json')
}

function nowIso(): string {
  return new Date().toISOString()
}

function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeRarity(value: unknown): LightConeRarity {
  const rarity = Number(value)
  return rarity === 3 || rarity === 4 ? rarity : 5
}

function normalizeAssetPath(value: unknown): string | null {
  const text = stringOrEmpty(value)
  return text || null
}

function ensureLightConeStoreFile(): void {
  ensureProjectDirectories()
  if (!existsSync(lightConeStorePath())) {
    writeFileSync(lightConeStorePath(), '[]\n', 'utf-8')
  }
}

function normalizeStoredLightCone(value: unknown, index: number): StoredLightCone {
  const raw = value && typeof value === 'object' ? (value as Partial<StoredLightCone>) : {}
  const timestamp = nowIso()
  const id = Math.max(1, Math.floor(Number(raw.id) || index + 1))

  return {
    id,
    name: stringOrEmpty(raw.name),
    path: stringOrEmpty(raw.path),
    rarity: normalizeRarity(raw.rarity),
    small_image: normalizeAssetPath(raw.small_image),
    large_image: normalizeAssetPath(raw.large_image),
    created_at: stringOrEmpty(raw.created_at) || timestamp,
    updated_at: stringOrEmpty(raw.updated_at) || timestamp
  }
}

function readLightConeStore(): StoredLightCone[] {
  ensureLightConeStoreFile()

  const parsed = JSON.parse(readFileSync(lightConeStorePath(), 'utf-8')) as unknown
  if (!Array.isArray(parsed)) {
    throw new Error('光锥配置文件格式不正确，应为数组')
  }

  return parsed.map(normalizeStoredLightCone)
}

function writeLightConeStore(lightCones: StoredLightCone[]): void {
  ensureProjectDirectories()
  writeFileSync(lightConeStorePath(), `${JSON.stringify(lightCones, null, 2)}\n`, 'utf-8')
}

function mapLightCone(lightCone: StoredLightCone): LightCone {
  return {
    ...lightCone,
    small_image_url: storedPathToFileUrl(lightCone.small_image),
    large_image_url: storedPathToFileUrl(lightCone.large_image),
    small_image_exists: storedPathExists(lightCone.small_image),
    large_image_exists: storedPathExists(lightCone.large_image)
  }
}

function validatePayload(payload: LightConePayload): void {
  if (!payload.name.trim()) {
    throw new Error('光锥名称不能为空')
  }

  if (![3, 4, 5].includes(payload.rarity)) {
    throw new Error('光锥稀有度只能是 3、4 或 5')
  }
}

function nextLightConeId(lightCones: StoredLightCone[]): number {
  return Math.max(0, ...lightCones.map((lightCone) => lightCone.id)) + 1
}

export function listLightCones(filters: LightConeFilters = {}): LightCone[] {
  const search = filters.search?.trim().toLowerCase()
  const path = filters.path?.trim()

  return readLightConeStore()
    .filter((lightCone) => {
      if (search && !lightCone.name.toLowerCase().includes(search)) {
        return false
      }

      if (path && lightCone.path !== path) {
        return false
      }

      return !filters.rarity || lightCone.rarity === filters.rarity
    })
    .sort(
      (left, right) =>
        right.rarity - left.rarity || left.name.localeCompare(right.name, 'zh-Hans-CN')
    )
    .map(mapLightCone)
}

export function getLightCone(id: number): LightCone | null {
  const lightCone = readLightConeStore().find((item) => item.id === id)
  return lightCone ? mapLightCone(lightCone) : null
}

export function createLightCone(payload: LightConePayload): LightCone {
  validatePayload(payload)

  const lightCones = readLightConeStore()
  const timestamp = nowIso()
  const lightCone: StoredLightCone = {
    id: nextLightConeId(lightCones),
    name: payload.name.trim(),
    path: payload.path.trim(),
    rarity: payload.rarity,
    small_image: prepareAssetValue(payload.small_image, 'light_cones', payload.name, 'small_image'),
    large_image: prepareAssetValue(payload.large_image, 'light_cones', payload.name, 'large_image'),
    created_at: timestamp,
    updated_at: timestamp
  }

  writeLightConeStore([...lightCones, lightCone])
  return mapLightCone(lightCone)
}

export function updateLightCone(id: number, payload: LightConePayload): LightCone {
  validatePayload(payload)

  const lightCones = readLightConeStore()
  const index = lightCones.findIndex((lightCone) => lightCone.id === id)
  if (index < 0) {
    throw new Error('光锥不存在')
  }

  const existing = lightCones[index]
  const updated: StoredLightCone = {
    ...existing,
    name: payload.name.trim(),
    path: payload.path.trim(),
    rarity: payload.rarity as LightConeRarity,
    small_image: prepareAssetValue(
      payload.small_image,
      'light_cones',
      payload.name,
      'small_image',
      existing.small_image
    ),
    large_image: prepareAssetValue(
      payload.large_image,
      'light_cones',
      payload.name,
      'large_image',
      existing.large_image
    ),
    updated_at: nowIso()
  }
  const nextLightCones = [...lightCones]
  nextLightCones[index] = updated

  writeLightConeStore(nextLightCones)
  return mapLightCone(updated)
}

export function deleteLightCone(id: number): boolean {
  const lightCones = readLightConeStore()
  const nextLightCones = lightCones.filter((lightCone) => lightCone.id !== id)
  if (nextLightCones.length === lightCones.length) {
    return false
  }

  writeLightConeStore(nextLightCones)
  return true
}
