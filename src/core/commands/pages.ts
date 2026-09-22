// Page operations. Structural changes go through the Session so a batch loads
// and saves once; extract/split/merge produce new files.
import { YonderError } from '../errors'
import * as ops from '../pageOps'
import { s } from '../schema'
import { parseOrder, parsePages, parsePositive, parseRotation } from '../validate'
import { requireDoc, type Command, type Outcome } from './context'

const pagesParam = s.anyOf([s.str('Ranges like "1-3,7" (1-based)'), s.arr(s.int('page', { minimum: 1 }), 'Page numbers (1-based)')], 'Pages (1-based): "1-3,7" or [1,2,3]')

export const rotate: Command = {
  name: 'pages.rotate',
  group: 'pages',
  description: 'Rotate pages by 90, -90 or 180 degrees (sets /Rotate; annotations keep their user-space coordinates).',
  scope: 'both',
  needsDoc: true,
  produces: 'document',
  params: s.obj({ pages: pagesParam, by: s.int('90, -90 (or 270) or 180') }, ['pages', 'by']),
  examples: ['yonder-pdf pages.rotate --in a.pdf --out b.pdf --pages 2-3 --by 90'],
  async run(ctx, p): Promise<Outcome> {
    const doc = requireDoc(ctx)
    const sess = await doc.session()
    const idx = parsePages(p.pages as string, sess.pageCount)
    sess.rotatePages(idx, parseRotation(p.by as number))
    doc.markStructureChanged()
    return { result: { rotated: idx.map((i) => i + 1), by: p.by } }
  }
}

export const del: Command = {
  name: 'pages.delete',
  group: 'pages',
  description: 'Delete pages. Form fields whose only widgets were on deleted pages are removed with them.',
  scope: 'both',
  needsDoc: true,
  produces: 'document',
  params: s.obj({ pages: pagesParam }, ['pages']),
  examples: ['yonder-pdf pages.delete --in a.pdf --out b.pdf --pages 4'],
  async run(ctx, p): Promise<Outcome> {
    const doc = requireDoc(ctx)
    const sess = await doc.session()
    const idx = parsePages(p.pages as string, sess.pageCount)
    sess.deletePages(idx)
    doc.markStructureChanged()
    return { result: { deleted: idx.map((i) => i + 1), pageCount: sess.pageCount } }
  }
}

export const reorder: Command = {
  name: 'pages.reorder',
  group: 'pages',
  description: 'Reorder pages: --order lists every current page number once, in its new position (e.g. "3,1,2").',
  scope: 'both',
  needsDoc: true,
  produces: 'document',
  params: s.obj({ order: s.anyOf([s.str('"3,1,2"'), s.arr(s.int('page', { minimum: 1 }), 'numbers')], 'Complete permutation of 1-based page numbers') }, ['order']),
  examples: ['yonder-pdf pages.reorder --in a.pdf --out b.pdf --order 3,1,2,4'],
  async run(ctx, p): Promise<Outcome> {
    const doc = requireDoc(ctx)
    const sess = await doc.session()
    const order = parseOrder(p.order as string, sess.pageCount)
    sess.reorderPages(order)
    doc.markStructureChanged()
    return { result: { order: order.map((i) => i + 1) } }
  }
}

export const insertBlank: Command = {
  name: 'pages.insert-blank',
  group: 'pages',
  description: 'Insert a blank page after page N (--after 0 = at the beginning). Size defaults to the neighbouring page.',
  scope: 'both',
  needsDoc: true,
  produces: 'document',
  params: s.obj({ after: s.int('Insert after this page (0 = beginning)', { minimum: 0 }), width: s.num('Width in points', { exclusiveMinimum: 0 }), height: s.num('Height in points', { exclusiveMinimum: 0 }) }, ['after']),
  examples: ['yonder-pdf pages.insert-blank --in a.pdf --out b.pdf --after 2'],
  async run(ctx, p): Promise<Outcome> {
    const doc = requireDoc(ctx)
    const sess = await doc.session()
    const at = p.after as number
    if (at > sess.pageCount) throw new YonderError('YP_PAGE_RANGE', `--after ${at} is beyond the last page (${sess.pageCount})`)
    const size = p.width !== undefined || p.height !== undefined ? ([parsePositive((p.width as number | undefined) ?? 612, 'width', 14400), parsePositive((p.height as number | undefined) ?? 792, 'height', 14400)] as [number, number]) : undefined
    sess.insertBlankPage(at, size)
    doc.markStructureChanged()
    return { result: { insertedAt: at + 1, pageCount: sess.pageCount } }
  }
}

export const insert: Command = {
  name: 'pages.insert',
  group: 'pages',
  description: 'Insert all pages of another PDF after page N (--after 0 = beginning). Form fields and bookmarks of the inserted file are not carried over.',
  scope: 'both',
  needsDoc: true,
  produces: 'document',
  params: s.obj({ file: s.str('PDF to insert'), after: s.int('Insert after this page (0 = beginning)', { minimum: 0 }) }, ['file', 'after']),
  examples: ['yonder-pdf pages.insert --in a.pdf --out b.pdf --file appendix.pdf --after 5'],
  async run(ctx, p): Promise<Outcome> {
    const doc = requireDoc(ctx)
    const sess = await doc.session()
    const at = p.after as number
    if (at > sess.pageCount) throw new YonderError('YP_PAGE_RANGE', `--after ${at} is beyond the last page (${sess.pageCount})`)
    const inserted = await sess.insertFromPdf(await ctx.readFile(String(p.file)), at)
    doc.markStructureChanged()
    return { result: { insertedAt: at + 1, inserted, pageCount: sess.pageCount, warnings: ['forms-dropped', 'outline-dropped'] } }
  }
}

export const extract: Command = {
  name: 'pages.extract',
  group: 'pages',
  description: 'Copy pages into a new PDF (--out). Session annotations on those pages are included; form fields and bookmarks are not.',
  scope: 'both',
  needsDoc: true,
  produces: 'file',
  params: s.obj({ pages: pagesParam }, ['pages']),
  examples: ['yonder-pdf pages.extract --in a.pdf --out pages-2-3.pdf --pages 2-3'],
  async run(ctx, p): Promise<Outcome> {
    const doc = requireDoc(ctx)
    const idx = parsePages(p.pages as string, await doc.pageCount())
    const bytes = await ops.extractPages(await doc.commit(), idx)
    return { result: { pages: idx.map((i) => i + 1), warnings: ['forms-dropped', 'outline-dropped'] }, outputs: [{ name: 'extract.pdf', bytes }] }
  }
}

export const split: Command = {
  name: 'pages.split',
  group: 'pages',
  description: 'Split into several PDFs in --out-dir: --every N pages, or explicit --ranges "1-2;3-5". Files are named <input>-<n>.pdf.',
  scope: 'both',
  needsDoc: true,
  produces: 'files',
  params: s.obj({ every: s.int('Pages per part', { minimum: 1 }), ranges: s.str('Parts as ranges separated by ";" e.g. "1-2;3-5"') }),
  examples: ['yonder-pdf pages.split --in a.pdf --out-dir parts --every 1'],
  async run(ctx, p): Promise<Outcome> {
    const doc = requireDoc(ctx)
    const n = await doc.pageCount()
    let ranges: number[][]
    if (p.ranges !== undefined) ranges = String(p.ranges).split(/\s*;\s*/).filter(Boolean).map((r) => parsePages(r, n))
    else if (p.every !== undefined) {
      const every = p.every as number
      ranges = []
      for (let i = 0; i < n; i += every) ranges.push(Array.from({ length: Math.min(every, n - i) }, (_, k) => i + k))
    } else throw new YonderError('YP_USAGE', 'Give --every N or --ranges "1-2;3-5"')
    const parts = await ops.splitPdf(await doc.commit(), ranges)
    const pad = String(parts.length).length
    return { result: { parts: ranges.map((r, i) => ({ index: i + 1, pages: r.map((x) => x + 1) })) }, outputs: parts.map((bytes, i) => ({ name: `${String(i + 1).padStart(pad, '0')}.pdf`, bytes })) }
  }
}

export const merge: Command = {
  name: 'pages.merge',
  group: 'pages',
  description: 'Concatenate PDFs (--files, in order) into --out. Form fields and bookmarks are not carried over.',
  scope: 'headless',
  needsDoc: false,
  produces: 'file',
  params: s.obj({ files: s.arr(s.str('PDF path'), 'Input files in order', { minItems: 1 }) }, ['files']),
  examples: ['yonder-pdf pages.merge --files a.pdf b.pdf --out merged.pdf'],
  async run(ctx, p): Promise<Outcome> {
    const files = p.files as string[]
    const sources: Uint8Array[] = []
    for (const f of files) sources.push(await ctx.readFile(f))
    const bytes = await ops.mergePdfs(sources)
    return { result: { merged: files.length, warnings: ['forms-dropped', 'outline-dropped'] }, outputs: [{ name: 'merged.pdf', bytes }] }
  }
}

export const pagesCommands: Command[] = [rotate, del, reorder, insertBlank, insert, extract, split, merge]
