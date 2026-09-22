// Text extraction and literal search over a pdf.js document proxy. Runs in the
// renderer (pdf.js browser build) and under Node (legacy build) unchanged.
// Match rectangles are approximated per text item by proportional character
// width; `quality` says so (design §15 #11).
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { Quad, Rect } from './types'

export interface SearchMatch {
  page: number
  /** User-space rectangles covering the match. */
  rects: Rect[]
  snippet: string
  /** 'estimated': axis-aligned boxes from proportional character widths. */
  quality: 'estimated'
  /** Set on the last match of a page whose matches were cut off at the per-page cap. */
  truncated?: boolean
}

interface TextItemLike {
  str: string
  transform: number[]
  width: number
  height: number
  hasEOL?: boolean
}

interface PageText {
  text: string
  /** For each character in `text`, the item index it came from (or -1 for separators). */
  itemOf: Int32Array
  offsetInItem: Int32Array
  items: TextItemLike[]
}

const cache = new WeakMap<PDFDocumentProxy, Map<number, PageText>>()

async function getPageText(pdf: PDFDocumentProxy, pageIndex: number): Promise<PageText> {
  let m = cache.get(pdf)
  if (!m) {
    m = new Map()
    cache.set(pdf, m)
  }
  const hit = m.get(pageIndex)
  if (hit) return hit
  const page = await pdf.getPage(pageIndex + 1)
  const content = await page.getTextContent()
  const items = (content.items as unknown[]).filter((it): it is TextItemLike => typeof (it as { str?: unknown }).str === 'string')
  let text = ''
  const itemOf: number[] = []
  const offset: number[] = []
  items.forEach((it, idx) => {
    for (let i = 0; i < it.str.length; i++) {
      itemOf.push(idx)
      offset.push(i)
    }
    text += it.str
    if (it.hasEOL || !it.str.endsWith(' ')) {
      text += ' '
      itemOf.push(-1)
      offset.push(0)
    }
  })
  const pt: PageText = { text, itemOf: Int32Array.from(itemOf), offsetInItem: Int32Array.from(offset), items }
  m.set(pageIndex, pt)
  return pt
}

function itemRect(it: TextItemLike, fromChar: number, toChar: number): Rect | null {
  const [a, b, , d, e, f] = it.transform
  const fontH = Math.hypot(a, b) || Math.abs(d) || 10
  const w = it.width || 0
  const n = Math.max(1, it.str.length)
  const x0 = e + (w * fromChar) / n
  const x1 = e + (w * toChar) / n
  if (!(x1 > x0)) return null
  // Vertical text or rotated items: fall back to the item's own box.
  const height = it.height || fontH
  return { x: x0, y: f - height * 0.2, width: x1 - x0, height: height * 1.1 }
}

export async function searchDocument(
  pdf: PDFDocumentProxy,
  query: string,
  opts: { caseSensitive?: boolean; wholeWord?: boolean; pages?: number[] } = {},
  onProgress?: (matches: SearchMatch[], page: number) => void,
  signal?: { cancelled: boolean }
): Promise<SearchMatch[]> {
  const q = query.trim()
  const all: SearchMatch[] = []
  if (!q) return all
  const flags = opts.caseSensitive ? 'g' : 'gi'
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
  const re = new RegExp(opts.wholeWord ? `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])` : escaped, flags + 'u')

  const pageList = opts.pages ?? Array.from({ length: pdf.numPages }, (_, i) => i)
  for (const p of pageList) {
    if (signal?.cancelled) break
    const pt = await getPageText(pdf, p)
    re.lastIndex = 0
    let m: RegExpExecArray | null
    const pageMatches: SearchMatch[] = []
    while ((m = re.exec(pt.text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++
        continue
      }
      const start = m.index
      const end = start + m[0].length
      const rects: Rect[] = []
      let cur = -1
      let from = 0
      let to = 0
      for (let i = start; i < end; i++) {
        const idx = pt.itemOf[i]
        if (idx === -1) continue
        if (idx !== cur) {
          if (cur >= 0) {
            const r = itemRect(pt.items[cur], from, to)
            if (r) rects.push(r)
          }
          cur = idx
          from = pt.offsetInItem[i]
        }
        to = pt.offsetInItem[i] + 1
      }
      if (cur >= 0) {
        const r = itemRect(pt.items[cur], from, to)
        if (r) rects.push(r)
      }
      const s0 = Math.max(0, start - 30)
      const s1 = Math.min(pt.text.length, end + 30)
      pageMatches.push({ page: p, rects, snippet: (s0 > 0 ? '…' : '') + pt.text.slice(s0, s1).replace(/\s+/g, ' ') + (s1 < pt.text.length ? '…' : ''), quality: 'estimated' })
      if (pageMatches.length >= 2000) {
        pageMatches[pageMatches.length - 1].truncated = true
        break
      }
    }
    all.push(...pageMatches)
    onProgress?.(all, p)
  }
  return all
}

export interface TextLine {
  text: string
  rect: Rect
}

/** Plain text of one page; with `layout`, one entry per text item with its box. */
export async function extractText(pdf: PDFDocumentProxy, pageIndex: number, layout = false): Promise<{ text: string; lines?: TextLine[] }> {
  const pt = await getPageText(pdf, pageIndex)
  const text = pt.text.replace(/[ \t]+\n/g, '\n').replace(/\s+$/g, '')
  if (!layout) return { text }
  const lines: TextLine[] = []
  for (const it of pt.items) {
    if (!it.str.trim()) continue
    const r = itemRect(it, 0, it.str.length)
    if (r) lines.push({ text: it.str, rect: r })
  }
  return { text, lines }
}

/** Axis-aligned rect → quad (ul, ur, ll, lr) as stored in markup annotations. */
export function rectToQuad(r: Rect): Quad {
  return [r.x, r.y + r.height, r.x + r.width, r.y + r.height, r.x, r.y, r.x + r.width, r.y]
}
