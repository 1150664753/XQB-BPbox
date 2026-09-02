import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'

import type {
  AssetManifest,
  AssetManifestEntry,
  RemoteAssetBinary,
  RemoteAssetType
} from '../../shared/remoteBp'
import type { Character, LightCone } from '../../shared/types'

export interface RemoteAssetProviderDependencies {
  listCharacters: () => readonly Character[]
  listLightCones: () => readonly LightCone[]
  resolveStoredPath: (storedPath: string | null | undefined) => string | null
  now?: () => Date
}

interface AllowedAsset {
  descriptor: AssetManifestEntry
  filePath: string
  sourceSize: number
  sourceMtimeMs: number
}

interface Candidate {
  assetId: string
  type: RemoteAssetType
  storedPath: string | null
  characterId?: string
  lightConeId?: string
  ownerId: string
}

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.apng': 'image/apng',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp'
}
const MAX_REMOTE_ASSET_BYTES = 64 * 1024 * 1024

function candidatesFor(character: Character): Candidate[] {
  return [
    {
      assetId: assetId(character.id, 'avatar'),
      type: 'avatar',
      storedPath: character.avatar_small_image,
      characterId: String(character.id),
      ownerId: String(character.id)
    },
    {
      assetId: assetId(character.id, 'portrait'),
      type: 'portrait',
      storedPath: character.full_body_image,
      characterId: String(character.id),
      ownerId: String(character.id)
    }
  ]
}

function assetId(characterId: number, type: Candidate['type']): string {
  return `character:${characterId}:${type}`
}

function lightConeAssetId(lightConeId: number): string {
  return `light-cone:${lightConeId}:image`
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

export class RemoteAssetProvider {
  private allowedAssets = new Map<string, AllowedAsset>()
  private manifestRevision = 0
  private lastFingerprint = ''
  private lastGeneratedAt = ''
  private refreshPromise: Promise<void> | null = null

  constructor(private readonly dependencies: RemoteAssetProviderDependencies) {}

  async getManifest(): Promise<AssetManifest> {
    await this.refreshAllowlist()
    return {
      revision: this.manifestRevision,
      generatedAt: this.lastGeneratedAt,
      assets: [...this.allowedAssets.values()]
        .map(({ descriptor }) => ({ ...descriptor }))
        .sort((left, right) => left.assetId.localeCompare(right.assetId))
    }
  }

  async getDescriptor(requestedAssetId: string): Promise<AssetManifestEntry> {
    await this.ensureAllowlist()
    const allowed = this.allowedAssets.get(requestedAssetId)
    if (!allowed) throw new Error('远程资源不存在或不在允许列表中')
    return { ...allowed.descriptor }
  }

  async getAssetManifest(requestedAssetId: string): Promise<AssetManifestEntry> {
    return this.getDescriptor(requestedAssetId)
  }

  async getAsset(requestedAssetId: string): Promise<RemoteAssetBinary> {
    await this.ensureAllowlist()
    let allowed = this.allowedAssets.get(requestedAssetId)
    if (!allowed) throw new Error('远程资源不存在或不在允许列表中')

    const currentStat = await stat(allowed.filePath).catch(() => null)
    if (
      !currentStat?.isFile() ||
      currentStat.size !== allowed.sourceSize ||
      currentStat.mtimeMs !== allowed.sourceMtimeMs
    ) {
      this.allowedAssets.delete(requestedAssetId)
      await this.refreshAllowlist()
      allowed = this.allowedAssets.get(requestedAssetId)
      if (!allowed) throw new Error('远程资源在读取前已失效')
    }

    const data = await readFile(allowed.filePath)
    const actualHash = createHash('sha256').update(data).digest('hex')
    if (actualHash !== allowed.descriptor.hash || data.byteLength !== allowed.descriptor.size) {
      this.allowedAssets.delete(requestedAssetId)
      await this.refreshAllowlist()
      const refreshed = this.allowedAssets.get(requestedAssetId)
      if (
        !refreshed ||
        refreshed.descriptor.hash === allowed.descriptor.hash ||
        refreshed.descriptor.size !== data.byteLength
      ) {
        throw new Error('远程资源在读取期间发生变化，请重试')
      }
      return this.getAsset(requestedAssetId)
    }

    return {
      descriptor: { ...allowed.descriptor },
      data: new Uint8Array(data)
    }
  }

  private async ensureAllowlist(): Promise<void> {
    if (this.refreshPromise) await this.refreshPromise
    if (!this.lastGeneratedAt) await this.refreshAllowlist()
  }

  private async refreshAllowlist(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise
    const refresh = this.buildAllowlist()
    this.refreshPromise = refresh
    try {
      await refresh
    } finally {
      if (this.refreshPromise === refresh) this.refreshPromise = null
    }
  }

  private async buildAllowlist(): Promise<void> {
    const previousAllowed = new Map(this.allowedAssets)
    const nextAllowed = new Map<string, AllowedAsset>()
    const candidates: Candidate[] = []
    for (const character of this.dependencies.listCharacters()) {
      candidates.push(...candidatesFor(character))
    }
    for (const lightCone of this.dependencies.listLightCones()) {
      candidates.push({
        assetId: lightConeAssetId(lightCone.id),
        type: 'light-cone',
        storedPath: lightCone.small_image,
        lightConeId: String(lightCone.id),
        ownerId: String(lightCone.id)
      })
    }

    for (const candidate of candidates) {
      const filePath = this.dependencies.resolveStoredPath(candidate.storedPath)
      if (!filePath) continue
      const fileStat = await stat(filePath).catch(() => null)
      const mimeType = MIME_TYPES[extname(filePath).toLowerCase()]
      if (
        !fileStat?.isFile() ||
        !mimeType ||
        fileStat.size < 1 ||
        fileStat.size > MAX_REMOTE_ASSET_BYTES
      )
        continue

      const previous = previousAllowed.get(candidate.assetId)
      if (
        previous &&
        previous.filePath === filePath &&
        previous.sourceSize === fileStat.size &&
        previous.sourceMtimeMs === fileStat.mtimeMs
      ) {
        nextAllowed.set(candidate.assetId, previous)
        continue
      }

      const descriptor: AssetManifestEntry = {
        assetId: candidate.assetId,
        type: candidate.type,
        hash: await sha256File(filePath),
        size: fileStat.size,
        mimeType,
        ...(candidate.characterId ? { characterId: candidate.characterId } : {}),
        ...(candidate.lightConeId ? { lightConeId: candidate.lightConeId } : {}),
        ownerId: candidate.ownerId
      }
      nextAllowed.set(descriptor.assetId, {
        descriptor,
        filePath,
        sourceSize: fileStat.size,
        sourceMtimeMs: fileStat.mtimeMs
      })
    }

    const fingerprint = JSON.stringify(
      [...nextAllowed.values()]
        .map(({ descriptor }) => descriptor)
        .sort((left, right) => left.assetId.localeCompare(right.assetId))
    )
    if (fingerprint !== this.lastFingerprint) {
      this.manifestRevision += 1
      this.lastFingerprint = fingerprint
      this.lastGeneratedAt = (this.dependencies.now?.() ?? new Date()).toISOString()
    }
    this.allowedAssets = nextAllowed
  }
}
