// Text anchors: "put this next to the words …" for agents that do not know
// coordinates (design §14.1 #4, §15 #11). Resolution goes through the shared
// search, so `find` and every placement command agree on geometry.
import { YonderError } from './errors'
import { rectToQuad, searchDocument, type SearchMatch } from './text'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { Point, Quad, Rect } from './types'

export type Align = 'on' | 'below' | 'above' | 'left' | 'right'

export interface AnchorSpec {
  text: string
  /** 0-based; undefined = whole document. */
  page?: number
  /** 1-based among the matches (in page/reading order). */
  occurrence?: number
  caseSensitive?: boolean
}

export interface ResolvedAnchor {
  page: number
  rects: Rect[]
  quads: Quad[]
  bounds: Rect
  quality: 'estimated'
  occurrence: number
  total: number
  snippet: string
}

const unionRect = (rects: Rect[]): Rect => {
  const x0 = Math.min(...rects.map((r) => r.x)),
    y0 = Math.min(...rects.map((r) => r.y)),
    x1 = Math.max(...rects.map((r) => r.x + r.width)),
    y1 = Math.max(...rects.map((r) => r.y + r.height))
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

const round = (r: Rect): Rect => ({ x: +r.x.toFixed(2), y: +r.y.toFixed(2), width: +r.width.toFixed(2), height: +r.height.toFixed(2) })
const describe = (m: SearchMatch, i: number): { occurrence: number; page: number; bounds: Rect; snippet: string } => ({ occurrence: i + 1, page: m.page + 1, bounds: round(unionRect(m.rects)), snippet: m.snippet })

export async function resolveAnchor(pdf: PDFDocumentProxy, spec: AnchorSpec): Promise<ResolvedAnchor> {
  const text = spec.text.trim()
  if (!text) throw new YonderError('YP_INVALID_INPUT', 'Anchor text is empty')
  const matches = (await searchDocument(pdf, text, { caseSensitive: spec.caseSensitive, pages: spec.page === undefined ? undefined : [spec.page] })).filter((m) => m.rects.length)
  if (!matches.length) throw new YonderError('YP_NO_MATCH', `"${text}" was not found${spec.page === undefined ? '' : ` on page ${spec.page + 1}`}`, 'Run `find` to see what text the page contains; matching is whitespace-insensitive.')
  let index = 0
  if (spec.occurrence !== undefined) {
    if (!Number.isInteger(spec.occurrence) || spec.occurrence < 1 || spec.occurrence > matches.length) throw new YonderError('YP_NO_MATCH', `Occurrence ${spec.occurrence} does not exist; "${text}" occurs ${matches.length} time(s)`, undefined, { matches: matches.map(describe) })
    index = spec.occurrence - 1
  } else if (matches.length > 1) {
    throw new YonderError('YP_AMBIGUOUS_ANCHOR', `"${text}" occurs ${matches.length} times`, 'Pass --occurrence N (1-based) or narrow with --page.', { matches: matches.map(describe) })
  }
  const m = matches[index]
  return { page: m.page, rects: m.rects, quads: m.rects.map(rectToQuad), bounds: unionRect(m.rects), quality: 'estimated', occurrence: index + 1, total: matches.length, snippet: m.snippet }
}

/** Place a box of `size` relative to the anchor bounds. `on` centres it over the text. */
export function placeRelative(bounds: Rect, align: Align, size: { width: number; height: number }, offset: Point = { x: 0, y: 0 }, gap = 4): Rect {
  let x = bounds.x
  let y = bounds.y
  switch (align) {
    case 'on':
      x = bounds.x + (bounds.width - size.width) / 2
      y = bounds.y + (bounds.height - size.height) / 2
      break
    case 'below':
      y = bounds.y - gap - size.height
      break
    case 'above':
      y = bounds.y + bounds.height + gap
      break
    case 'left':
      x = bounds.x - gap - size.width
      break
    case 'right':
      x = bounds.x + bounds.width + gap
      break
  }
  return { x: x + offset.x, y: y + offset.y, width: size.width, height: size.height }
}
