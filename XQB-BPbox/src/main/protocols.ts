import { protocol } from 'electron'
import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'

import { assetProtocol, resolveStoredPath } from './assets'

const mimeTypes: Record<string, string> = {
  '.aac': 'audio/aac',
  '.apng': 'image/apng',
  '.avif': 'image/avif',
  '.flac': 'audio/flac',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.m4a': 'audio/mp4',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.png': 'image/png',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp'
}

interface RangeResult {
  start: number
  end: number
}

function parseRangeHeader(rangeHeader: string | null, size: number): RangeResult | null {
  if (!rangeHeader) {
    return null
  }

  const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/)
  if (!match) {
    return null
  }

  const [, startText, endText] = match
  if (!startText && !endText) {
    return null
  }

  if (!startText) {
    const suffixLength = Number(endText)
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return null
    }

    return {
      start: Math.max(0, size - suffixLength),
      end: size - 1
    }
  }

  const start = Number(startText)
  const end = endText ? Number(endText) : size - 1

  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    return null
  }

  return {
    start,
    end: Math.min(end, size - 1)
  }
}

export function registerAssetProtocolScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: assetProtocol,
      privileges: {
        bypassCSP: false,
        corsEnabled: true,
        secure: true,
        standard: true,
        stream: true,
        supportFetchAPI: true
      }
    }
  ])
}

export function registerAssetProtocol(): void {
  protocol.handle(assetProtocol, async (request) => {
    const url = new URL(request.url)
    const storedPath = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
    const resolvedPath = resolveStoredPath(storedPath)

    if (!resolvedPath) {
      return new Response('Asset path is empty.', { status: 404 })
    }

    try {
      const fileStat = await stat(resolvedPath)
      const contentType =
        mimeTypes[extname(resolvedPath).toLowerCase()] ?? 'application/octet-stream'
      const range = parseRangeHeader(request.headers.get('range'), fileStat.size)

      if (range) {
        const data = await readFile(resolvedPath)
        const chunk = data.subarray(range.start, range.end + 1)

        return new Response(chunk, {
          status: 206,
          headers: {
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store',
            'Content-Length': String(chunk.byteLength),
            'Content-Range': `bytes ${range.start}-${range.end}/${fileStat.size}`,
            'Content-Type': contentType
          }
        })
      }

      const data = await readFile(resolvedPath)

      return new Response(data, {
        headers: {
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
          'Content-Length': String(fileStat.size),
          'Content-Type': contentType
        }
      })
    } catch {
      return new Response('Asset not found.', { status: 404 })
    }
  })
}
