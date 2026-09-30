// Annotation model. All coordinates are PDF user space (points, origin
// bottom-left of the unrotated page, exactly what pdf.js convertToPdfPoint
// returns and what pdf-lib expects).

export interface Point {
  x: number
  y: number
}

/** Axis-aligned rectangle in user space. */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Text quad (x1 y1 x2 y2 x3 y3 x4 y4 per PDF spec: upper-left, upper-right, lower-left, lower-right). */
export type Quad = [number, number, number, number, number, number, number, number]

interface Base {
  id: string
  page: number // 0-based
  createdAt: number
}

export interface MarkupAnnotation extends Base {
  kind: 'highlight' | 'underline' | 'strikeout'
  quads: Quad[]
  color: string
  opacity: number
  text?: string // selected text, stored as /Contents
}

export interface InkAnnotation extends Base {
  kind: 'ink'
  paths: Point[][]
  color: string
  width: number
  opacity: number
}

export interface ShapeAnnotation extends Base {
  kind: 'rect' | 'ellipse'
  rect: Rect
  color: string
  fill: string | null
  width: number
  opacity: number
}

export interface LineAnnotation extends Base {
  kind: 'line' | 'arrow'
  from: Point
  to: Point
  color: string
  width: number
  opacity: number
}

/** Orientation captured at placement: the page's /Rotate at that moment. The
 *  content is upright for that rotation and turns with the page afterwards. */
interface Oriented {
  rotate: number
}

export interface TextAnnotation extends Base, Oriented {
  kind: 'text'
  rect: Rect
  text: string
  fontSize: number
  color: string
}

export interface NoteAnnotation extends Base, Oriented {
  kind: 'note'
  at: Point // top-left corner of the icon
  text: string
  color: string
}

export interface ImageAnnotation extends Base, Oriented {
  kind: 'image'
  rect: Rect
  /** PNG data URL. */
  dataUrl: string
  role: 'signature' | 'initials' | 'stamp' | 'image'
}

/** A text stamp ("APPROVED"), written as a /Stamp annotation with its own appearance. */
export interface StampAnnotation extends Base, Oriented {
  kind: 'stamp'
  rect: Rect
  label: string
  /** Second line, e.g. "Ada Lovelace · Sep 30, 2026". */
  sublabel?: string
  color: string
  opacity: number
  /** Id of the standard stamp it came from (core/stamps.ts), if any. */
  preset?: string
}

export type Annotation =
  | MarkupAnnotation
  | InkAnnotation
  | ShapeAnnotation
  | LineAnnotation
  | TextAnnotation
  | NoteAnnotation
  | ImageAnnotation
  | StampAnnotation

export type AnnotationKind = Annotation['kind']

/** Omit that distributes over the Annotation union (a plain Omit collapses it to the common keys). */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
/** An annotation before it gets its id and timestamp. */
export type NewAnnotation = DistributiveOmit<Annotation, 'id' | 'createdAt'>

export type Tool =
  | 'select'
  | 'hand'
  | 'highlight'
  | 'underline'
  | 'strikeout'
  | 'ink'
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'text'
  | 'note'
  | 'image' // placing a signature / initials / image stamp
  | 'stamp' // placing a text stamp

export interface ToolStyle {
  color: string
  fill: string | null
  width: number
  opacity: number
  fontSize: number
}

export const NOTE_ICON_SIZE = 20

export function boundsOf(a: Annotation): Rect {
  switch (a.kind) {
    case 'highlight':
    case 'underline':
    case 'strikeout': {
      let x1 = Infinity,
        y1 = Infinity,
        x2 = -Infinity,
        y2 = -Infinity
      for (const q of a.quads) {
        for (let i = 0; i < 8; i += 2) {
          x1 = Math.min(x1, q[i])
          x2 = Math.max(x2, q[i])
          y1 = Math.min(y1, q[i + 1])
          y2 = Math.max(y2, q[i + 1])
        }
      }
      return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
    }
    case 'ink': {
      let x1 = Infinity,
        y1 = Infinity,
        x2 = -Infinity,
        y2 = -Infinity
      for (const path of a.paths) {
        for (const p of path) {
          x1 = Math.min(x1, p.x)
          x2 = Math.max(x2, p.x)
          y1 = Math.min(y1, p.y)
          y2 = Math.max(y2, p.y)
        }
      }
      const pad = a.width / 2
      return { x: x1 - pad, y: y1 - pad, width: x2 - x1 + a.width, height: y2 - y1 + a.width }
    }
    case 'rect':
    case 'ellipse':
    case 'text':
    case 'image':
    case 'stamp':
      return { ...a.rect }
    case 'line':
    case 'arrow': {
      const pts = [a.from, a.to]
      if (a.kind === 'arrow') pts.push(...arrowHeadPoints(a.from, a.to, a.width))
      const x1 = Math.min(...pts.map((p) => p.x))
      const y1 = Math.min(...pts.map((p) => p.y))
      const x2 = Math.max(...pts.map((p) => p.x))
      const y2 = Math.max(...pts.map((p) => p.y))
      const pad = Math.max(a.width, 4)
      return { x: x1 - pad, y: y1 - pad, width: x2 - x1 + pad * 2, height: y2 - y1 + pad * 2 }
    }
    case 'note':
      return { x: a.at.x, y: a.at.y - NOTE_ICON_SIZE, width: NOTE_ICON_SIZE, height: NOTE_ICON_SIZE }
  }
}

/** Arrow head vertices for a line ending at `to` (shared by writer and overlay). */
export function arrowHeadPoints(from: Point, to: Point, width: number): Point[] {
  const len = Math.max(10, width * 4)
  const ang = Math.atan2(to.y - from.y, to.x - from.x)
  const spread = Math.PI / 7
  return [
    { x: to.x - len * Math.cos(ang - spread), y: to.y - len * Math.sin(ang - spread) },
    { x: to.x - len * Math.cos(ang + spread), y: to.y - len * Math.sin(ang + spread) }
  ]
}

/** True when every character can be written with the built-in WinAnsi fonts (Helvetica). */
export function isWinAnsi(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    if (!(ch === '\n' || ch === '\t' || (c >= 32 && c <= 126) || (c >= 160 && c <= 255) || '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'.includes(ch))) return false
  }
  return true
}

/** Replace characters the built-in fonts cannot write with '?' (what the PDF writer does). */
export function sanitizeForWinAnsi(text: string): string {
  let out = ''
  for (const ch of text) out += isWinAnsi(ch) ? ch : '?'
  return out
}

/** Characters outside WinAnsi are written as '?' in FreeText appearances (Helvetica). */
export function hasUnsupportedText(list: Annotation[]): boolean {
  for (const a of list) {
    if (a.kind !== 'text' && a.kind !== 'stamp') continue
    for (const ch of a.kind === 'text' ? a.text : a.label + (a.sublabel ?? '')) {
      const c = ch.codePointAt(0) ?? 0
      if (!(ch === '\n' || ch === '\t' || (c >= 32 && c <= 126) || (c >= 160 && c <= 255) || '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'.includes(ch))) return true
    }
  }
  return false
}

export function translate<T extends Annotation>(a: T, dx: number, dy: number): T {
  switch (a.kind) {
    case 'highlight':
    case 'underline':
    case 'strikeout':
      return {
        ...a,
        quads: a.quads.map((q) => q.map((v, i) => (i % 2 === 0 ? v + dx : v + dy)) as Quad)
      }
    case 'ink':
      return { ...a, paths: a.paths.map((p) => p.map((pt) => ({ x: pt.x + dx, y: pt.y + dy }))) }
    case 'rect':
    case 'ellipse':
    case 'text':
    case 'image':
    case 'stamp':
      return { ...a, rect: { ...a.rect, x: a.rect.x + dx, y: a.rect.y + dy } }
    case 'line':
    case 'arrow':
      return { ...a, from: { x: a.from.x + dx, y: a.from.y + dy }, to: { x: a.to.x + dx, y: a.to.y + dy } }
    case 'note':
      return { ...a, at: { x: a.at.x + dx, y: a.at.y + dy } }
  }
}

export function canResize(a: Annotation): boolean {
  return a.kind === 'rect' || a.kind === 'ellipse' || a.kind === 'text' || a.kind === 'image' || a.kind === 'stamp'
}

export function normalizeRect(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y)
  }
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

export function newId(): string {
  return crypto.randomUUID()
}

export function cloneAnnotations(list: Annotation[]): Annotation[] {
  return structuredClone(list)
}

export const KIND_LABEL: Record<AnnotationKind, string> = {
  highlight: 'Highlight',
  underline: 'Underline',
  strikeout: 'Strikethrough',
  ink: 'Pen',
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  line: 'Line',
  arrow: 'Arrow',
  text: 'Text',
  note: 'Note',
  image: 'Image',
  stamp: 'Stamp'
}
