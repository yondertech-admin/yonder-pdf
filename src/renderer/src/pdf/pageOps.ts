// Page operations with pdf-lib. Rotate / delete / reorder / insert-blank keep
// the same PDFDocument and page refs (AcroForm + outlines preserved); merge /
// extract / insert-from-file copy pages (form fields of the *source* are not
// carried over — the UI says so). Each op also returns how to remap in-app
// annotation page indices.
import { PDFDocument, degrees } from 'pdf-lib'
import type { Annotation } from './types'

export type PageMap = (oldIndex: number) => number | null

export interface OpResult {
  bytes: Uint8Array
  map: PageMap
}

async function load(bytes: Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(bytes, { updateMetadata: false })
}

const save = (doc: PDFDocument): Promise<Uint8Array> => doc.save({ useObjectStreams: false, addDefaultPage: false })

export async function rotatePages(bytes: Uint8Array, indices: number[], delta: 90 | -90 | 180): Promise<OpResult> {
  const doc = await load(bytes)
  const pages = doc.getPages()
  for (const i of indices) {
    const p = pages[i]
    if (!p) continue
    const current = p.getRotation().angle
    p.setRotation(degrees((((current + delta) % 360) + 360) % 360))
  }
  return { bytes: await save(doc), map: (i) => i }
}

export async function deletePages(bytes: Uint8Array, indices: number[]): Promise<OpResult> {
  const doc = await load(bytes)
  const set = new Set(indices)
  if (set.size >= doc.getPageCount()) throw new Error('A document must keep at least one page')
  // Remove from the end so earlier indices stay valid.
  const sorted = [...set].sort((a, b) => b - a)
  for (const i of sorted) doc.removePage(i)
  const total = doc.getPageCount() + sorted.length
  const newIndex: Array<number | null> = []
  let n = 0
  for (let i = 0; i < total; i++) newIndex.push(set.has(i) ? null : n++)
  return { bytes: await save(doc), map: (i) => newIndex[i] ?? null }
}

/** `order` lists old indices in their new positions. */
export async function reorderPages(bytes: Uint8Array, order: number[]): Promise<OpResult> {
  const doc = await load(bytes)
  const pages = doc.getPages()
  if (order.length !== pages.length) throw new Error('Invalid page order')
  const refs = order.map((i) => pages[i])
  for (let i = pages.length - 1; i >= 0; i--) doc.removePage(i)
  for (const p of refs) doc.addPage(p)
  const inverse = new Map<number, number>()
  order.forEach((old, pos) => inverse.set(old, pos))
  return { bytes: await save(doc), map: (i) => inverse.get(i) ?? null }
}

export async function insertBlankPage(bytes: Uint8Array, at: number, size?: [number, number]): Promise<OpResult> {
  const doc = await load(bytes)
  const ref = doc.getPage(Math.min(Math.max(at - 1, 0), doc.getPageCount() - 1))
  const { width, height } = ref.getSize()
  doc.insertPage(at, size ?? [width, height])
  return { bytes: await save(doc), map: (i) => (i >= at ? i + 1 : i) }
}

export async function insertFromPdf(bytes: Uint8Array, source: Uint8Array, at: number): Promise<OpResult & { inserted: number }> {
  const doc = await load(bytes)
  const src = await load(source)
  const copied = await doc.copyPages(src, src.getPageIndices())
  copied.forEach((p, k) => doc.insertPage(at + k, p))
  const n = copied.length
  return { bytes: await save(doc), map: (i) => (i >= at ? i + n : i), inserted: n }
}

export async function extractPages(bytes: Uint8Array, indices: number[]): Promise<Uint8Array> {
  const src = await load(bytes)
  const out = await PDFDocument.create()
  const copied = await out.copyPages(src, indices)
  copied.forEach((p) => out.addPage(p))
  return save(out)
}

export async function mergePdfs(sources: Uint8Array[]): Promise<Uint8Array> {
  const out = await PDFDocument.create()
  for (const s of sources) {
    const doc = await load(s)
    const copied = await out.copyPages(doc, doc.getPageIndices())
    copied.forEach((p) => out.addPage(p))
  }
  return save(out)
}

/** Split into chunks of `every` pages (or explicit ranges). */
export async function splitPdf(bytes: Uint8Array, ranges: number[][]): Promise<Uint8Array[]> {
  const src = await load(bytes)
  const parts: Uint8Array[] = []
  for (const r of ranges) {
    const out = await PDFDocument.create()
    const copied = await out.copyPages(src, r)
    copied.forEach((p) => out.addPage(p))
    parts.push(await save(out))
  }
  return parts
}

export function remapAnnotations(list: Annotation[], map: PageMap): Annotation[] {
  const out: Annotation[] = []
  for (const a of list) {
    const p = map(a.page)
    if (p === null) continue
    out.push(p === a.page ? a : { ...a, page: p })
  }
  return out
}

/** Parse "1-3, 5, 8-10" into 0-based indices (validated against pageCount). */
export function parsePageRanges(input: string, pageCount: number): number[] {
  const out = new Set<number>()
  for (const part of input.split(/[,\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/)
    if (!m) throw new Error(`Invalid range "${part}"`)
    const a = parseInt(m[1], 10)
    const b = m[2] ? parseInt(m[2], 10) : a
    if (a < 1 || b < 1 || a > pageCount || b > pageCount) throw new Error(`Page numbers must be between 1 and ${pageCount}`)
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) out.add(i - 1)
  }
  return [...out].sort((x, y) => x - y)
}
