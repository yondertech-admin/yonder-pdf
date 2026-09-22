// Raster image inputs for image / stamp / signature commands: PNG and JPEG
// only (what pdf-lib embeds). Dimensions come from the file headers so no
// decoder is needed in the headless path.
import { YonderError } from './errors'

export interface ImageInfo {
  mime: 'image/png' | 'image/jpeg'
  width: number
  height: number
}

/** Decoded-pixel ceiling (design §14.4): 64 megapixels. */
export const MAX_IMAGE_PIXELS = 64 * 1024 * 1024

export function imageInfo(bytes: Uint8Array): ImageInfo {
  const info = parseHeader(bytes)
  if (!(info.width > 0 && info.height > 0)) throw new YonderError('YP_INVALID_INPUT', 'Image has no size')
  if (info.width * info.height > MAX_IMAGE_PIXELS) throw new YonderError('YP_INVALID_INPUT', `Image is too large (${info.width}×${info.height}); the limit is 64 megapixels`)
  return info
}

function parseHeader(bytes: Uint8Array): ImageInfo {
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return { mime: 'image/png', width: dv.getUint32(16), height: dv.getUint32(20) }
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let i = 2
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) {
        i++
        continue
      }
      const marker = bytes[i + 1]
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2
        continue
      }
      const len = dv.getUint16(i + 2)
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return { mime: 'image/jpeg', height: dv.getUint16(i + 5), width: dv.getUint16(i + 7) }
      }
      i += 2 + len
    }
  }
  throw new YonderError('YP_INVALID_INPUT', 'Image must be a PNG or JPEG file')
}

export function toDataUrl(bytes: Uint8Array, mime: ImageInfo['mime']): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)))
  return `data:${mime};base64,${btoa(bin)}`
}

/** Fit an image of `w×h` pixels into a target width (points), keeping aspect ratio. */
export function fitWidth(info: ImageInfo, widthPt: number): { width: number; height: number } {
  return { width: widthPt, height: (widthPt * info.height) / info.width }
}
