import { nativeImage } from 'electron'
import type { RemoteAssetType } from '../../shared/remoteBp'

/** Player previews are independent of the original broadcast/display assets. */
export function prepareRemoteImage(
  data: Uint8Array,
  type: RemoteAssetType,
  mimeType: string
): { data: Uint8Array; mimeType: string } {
  const original = { data, mimeType }
  try {
    let image = nativeImage.createFromBuffer(Buffer.from(data))
    if (image.isEmpty()) return original
    const { width, height } = image.getSize()
    const maxWidth = type === 'portrait' ? 480 : 256
    const maxHeight = type === 'portrait' ? 720 : type === 'light-cone' ? 384 : 256
    const scale = Math.min(1, maxWidth / width, maxHeight / height)
    if (scale < 1) {
      image = image.resize({
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
        quality: 'good'
      })
    }
    // Keep transparent cutouts transparent. Opaque previews benefit from JPEG.
    const bitmap = image.toBitmap()
    let transparent = false
    for (let index = 3; index < bitmap.length; index += 4) {
      if (bitmap[index] !== 255) {
        transparent = true
        break
      }
    }
    const encoded = transparent ? image.toPNG() : image.toJPEG(78)
    return encoded.byteLength < data.byteLength
      ? { data: encoded, mimeType: transparent ? 'image/png' : 'image/jpeg' }
      : original
  } catch {
    return original
  }
}
