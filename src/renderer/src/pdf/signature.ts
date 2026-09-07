// Signature image utilities: trimming, background removal, typed rendering.

export interface SignatureImage {
  dataUrl: string
  width: number
  height: number
}

export const SIGNATURE_FONTS: Array<{ id: string; label: string; family: string }> = [
  { id: 'dancing', label: 'Dancing Script', family: '"Dancing Script", cursive' },
  { id: 'vibes', label: 'Great Vibes', family: '"Great Vibes", cursive' },
  { id: 'apple', label: 'Homemade Apple', family: '"Homemade Apple", cursive' },
  { id: 'caveat', label: 'Caveat', family: '"Caveat", cursive' }
]

/** Trim transparent margins and optionally knock out near-white background. */
export function finalizeSignature(source: HTMLCanvasElement | HTMLImageElement | ImageBitmap, opts: { removeWhite?: boolean; padding?: number } = {}): SignatureImage | null {
  const w = source.width
  const h = source.height
  if (!w || !h) return null
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(source, 0, 0)
  const img = ctx.getImageData(0, 0, w, h)
  const d = img.data
  if (opts.removeWhite) {
    for (let i = 0; i < d.length; i += 4) {
      const lum = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000
      if (lum > 245) d[i + 3] = 0
      else if (lum > 200) d[i + 3] = Math.min(d[i + 3], Math.round(((245 - lum) / 45) * 255))
    }
  }
  let minX = w,
    minY = h,
    maxX = -1,
    maxY = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 8) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return null
  ctx.putImageData(img, 0, 0)
  const pad = opts.padding ?? 6
  const cw = maxX - minX + 1 + pad * 2
  const ch = maxY - minY + 1 + pad * 2
  const out = document.createElement('canvas')
  out.width = cw
  out.height = ch
  const octx = out.getContext('2d')
  if (!octx) return null
  octx.drawImage(canvas, minX - pad, minY - pad, cw, ch, 0, 0, cw, ch)
  return { dataUrl: out.toDataURL('image/png'), width: cw, height: ch }
}

export async function renderTypedSignature(text: string, fontFamily: string, color: string): Promise<SignatureImage | null> {
  const t = text.trim()
  if (!t) return null
  const size = 96
  try {
    await document.fonts.load(`${size}px ${fontFamily}`, t)
  } catch {
    /* fall back to whatever the browser resolves */
  }
  const probe = document.createElement('canvas').getContext('2d')
  if (!probe) return null
  probe.font = `${size}px ${fontFamily}`
  const metrics = probe.measureText(t)
  const w = Math.ceil(metrics.width + size)
  const h = Math.ceil(size * 1.8)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.font = `${size}px ${fontFamily}`
  ctx.fillStyle = color
  ctx.textBaseline = 'middle'
  ctx.fillText(t, size / 2, h / 2)
  return finalizeSignature(canvas)
}

export async function loadImageFile(bytes: Uint8Array, mime: string): Promise<ImageBitmap> {
  const blob = new Blob([bytes as BlobPart], { type: mime })
  return createImageBitmap(blob)
}

/** Default placed width for a signature in PDF points, keeping aspect ratio. */
export function defaultPlacement(img: { width: number; height: number }, role: 'signature' | 'initials' | 'stamp' | 'image'): { width: number; height: number } {
  const target = role === 'initials' ? 60 : role === 'signature' ? 160 : 200
  const ratio = img.height / img.width
  return { width: target, height: target * ratio }
}

export function todayString(): string {
  const d = new Date()
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}
