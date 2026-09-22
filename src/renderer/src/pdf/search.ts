// Full-text search. Match rectangles are approximated per text item by
// proportional character width, which is accurate enough for highlighting.
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { Rect } from '@core/types'

export interface SearchMatch {
  page: number
  /** User-space rectangles covering the match. */
  rects: Rect[]
  snippet: string
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
  opts: { caseSensitive?: boolean; wholeWord?: boolean } = {},
  onProgress?: (matches: SearchMatch[], page: number) => void,
  signal?: { cancelled: boolean }
): Promise<SearchMatch[]> {
  const q = query.trim()
  const all: SearchMatch[] = []
  if (!q) return all
  const flags = opts.caseSensitive ? 'g' : 'gi'
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
  const re = new RegExp(opts.wholeWord ? `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])` : escaped, flags + 'u')

  for (let p = 0; p < pdf.numPages; p++) {
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
      pageMatches.push({ page: p, rects, snippet: (s0 > 0 ? '…' : '') + pt.text.slice(s0, s1).replace(/\s+/g, ' ') + (s1 < pt.text.length ? '…' : '') })
      if (pageMatches.length > 2000) break
    }
    all.push(...pageMatches)
    onProgress?.(all, p)
  }
  return all
}
