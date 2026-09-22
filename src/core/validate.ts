// Input parsers for the command layer. Every value an agent can pass in text
// form is parsed and range-checked here, before it reaches pdf-lib.
import { YonderError } from './errors'
import type { Point, Quad, Rect } from './types'

const num = (raw: string | number, what: string): number => {
  const n = typeof raw === 'number' ? raw : Number(raw.trim())
  if (!Number.isFinite(n)) throw new YonderError('YP_INVALID_INPUT', `${what}: "${raw}" is not a number`)
  return n
}

/** "1-3, 5" or [1,5] (1-based) → sorted unique 0-based indices. */
export function parsePages(input: string | number | number[], pageCount: number): number[] {
  const list = Array.isArray(input) ? input : typeof input === 'number' ? [input] : null
  const out = new Set<number>()
  if (list) {
    for (const n of list) {
      if (!Number.isInteger(n) || n < 1 || n > pageCount) throw new YonderError('YP_PAGE_RANGE', `Page ${n} is out of range (1–${pageCount})`)
      out.add(n - 1)
    }
  } else {
    for (const part of String(input).split(/[,\s]+/).filter(Boolean)) {
      const m = part.match(/^(\d+)(?:-(\d+))?$/)
      if (!m) throw new YonderError('YP_PAGE_RANGE', `Invalid page range "${part}"`, 'Use forms like "3", "1-4" or "1,3,5-7" (1-based).')
      const a = parseInt(m[1], 10)
      const b = m[2] ? parseInt(m[2], 10) : a
      if (a < 1 || b < 1 || a > pageCount || b > pageCount) throw new YonderError('YP_PAGE_RANGE', `Page numbers must be between 1 and ${pageCount}`)
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) out.add(i - 1)
    }
  }
  if (!out.size) throw new YonderError('YP_PAGE_RANGE', 'No pages given')
  return [...out].sort((x, y) => x - y)
}

/** A single 1-based page → 0-based index. */
export function parsePage(input: string | number, pageCount: number): number {
  const n = num(input, 'page')
  if (!Number.isInteger(n) || n < 1 || n > pageCount) throw new YonderError('YP_PAGE_RANGE', `Page ${n} is out of range (1–${pageCount})`)
  return n - 1
}

/** "3,1,2" or [3,1,2] (1-based) → a complete 0-based permutation. */
export function parseOrder(input: string | number[], pageCount: number): number[] {
  const parts = Array.isArray(input) ? input : String(input).split(/[,\s]+/).filter(Boolean).map((p) => num(p, 'order'))
  if (parts.length !== pageCount) throw new YonderError('YP_INVALID_INPUT', `order must list all ${pageCount} pages exactly once (got ${parts.length})`)
  const seen = new Set<number>()
  for (const n of parts) {
    if (!Number.isInteger(n) || n < 1 || n > pageCount) throw new YonderError('YP_PAGE_RANGE', `Page ${n} is out of range (1–${pageCount})`)
    if (seen.has(n)) throw new YonderError('YP_INVALID_INPUT', `Page ${n} appears twice in order`)
    seen.add(n)
  }
  return parts.map((n) => n - 1)
}

export function parseColor(input: string): string {
  const v = input.trim().toLowerCase()
  const m6 = v.match(/^#?([0-9a-f]{6})$/)
  if (m6) return '#' + m6[1]
  const m3 = v.match(/^#?([0-9a-f])([0-9a-f])([0-9a-f])$/)
  if (m3) return '#' + m3[1] + m3[1] + m3[2] + m3[2] + m3[3] + m3[3]
  throw new YonderError('YP_INVALID_INPUT', `Colour "${input}" is not a hex colour like #ffd400`)
}

export function parseOpacity(input: string | number): number {
  const n = num(input, 'opacity')
  if (n < 0 || n > 1) throw new YonderError('YP_INVALID_INPUT', 'opacity must be between 0 and 1')
  return n
}

export function parsePositive(input: string | number, what: string, max = 1000): number {
  const n = num(input, what)
  if (n <= 0 || n > max) throw new YonderError('YP_INVALID_INPUT', `${what} must be between 0 and ${max}`)
  return n
}

export function parsePoint(input: string | number[] | { x: number; y: number }): Point {
  if (typeof input === 'object' && !Array.isArray(input)) return { x: num(input.x, 'x'), y: num(input.y, 'y') }
  const parts = Array.isArray(input) ? input : input.split(/[,\s]+/).filter(Boolean)
  if (parts.length !== 2) throw new YonderError('YP_INVALID_INPUT', `Point "${input}" must be "x,y" in PDF points`)
  return { x: num(parts[0], 'x'), y: num(parts[1], 'y') }
}

export function parseRect(input: string | number[] | Rect): Rect {
  if (typeof input === 'object' && !Array.isArray(input)) return checkRect({ x: num(input.x, 'x'), y: num(input.y, 'y'), width: num(input.width, 'width'), height: num(input.height, 'height') })
  const parts = Array.isArray(input) ? input : input.split(/[,\s]+/).filter(Boolean)
  if (parts.length !== 4) throw new YonderError('YP_INVALID_INPUT', `Rect "${input}" must be "x,y,width,height" in PDF points (origin bottom-left)`)
  return checkRect({ x: num(parts[0], 'x'), y: num(parts[1], 'y'), width: num(parts[2], 'width'), height: num(parts[3], 'height') })
}

function checkRect(r: Rect): Rect {
  if (r.width <= 0 || r.height <= 0) throw new YonderError('YP_INVALID_INPUT', 'Rect width and height must be positive')
  return r
}

/** Quads as "x1,y1,x2,y2,x3,y3,x4,y4;…" or number[][] (each 8 numbers: ul, ur, ll, lr). */
export function parseQuads(input: string | number[][]): Quad[] {
  const groups = Array.isArray(input) ? input : input.split(/\s*;\s*/).filter(Boolean).map((g) => g.split(/[,\s]+/).filter(Boolean).map((v) => num(v, 'quad')))
  if (!groups.length) throw new YonderError('YP_INVALID_INPUT', 'No quads given')
  return groups.map((g) => {
    if (g.length !== 8 || g.some((n) => !Number.isFinite(n))) throw new YonderError('YP_INVALID_INPUT', 'Each quad needs 8 numbers: ulx,uly,urx,ury,llx,lly,lrx,lry')
    return g as Quad
  })
}

/** Ink paths: "x,y x,y x,y; x,y x,y" (';' separates strokes) or Point[][]. */
export function parsePaths(input: string | Point[][]): Point[][] {
  if (Array.isArray(input)) return input.map((p) => p.map((pt) => parsePoint(pt)))
  const strokes = input
    .split(/\s*;\s*/)
    .filter(Boolean)
    .map((stroke) => stroke.trim().split(/\s+/).map((pt) => parsePoint(pt)))
  if (!strokes.length || strokes.some((st) => st.length < 1)) throw new YonderError('YP_INVALID_INPUT', 'Ink paths need at least one point per stroke: "x,y x,y; x,y x,y"')
  return strokes
}

export function parseRotation(input: string | number): 90 | -90 | 180 {
  const n = num(input, 'rotation')
  if (n === 90 || n === -90 || n === 180) return n
  if (n === 270) return -90
  throw new YonderError('YP_INVALID_INPUT', 'Rotation must be 90, -90 (or 270) or 180')
}
