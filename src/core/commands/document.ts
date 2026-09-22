// Read-only document commands: info, text, find, annotations.
import { YonderError } from '../errors'
import { listFields } from '../forms'
import { s } from '../schema'
import { extractText, searchDocument } from '../text'
import { rectToQuad } from '../text'
import { boundsOf, translate, type Annotation } from '../types'
import { parsePage, parseRect } from '../validate'
import { requireDoc, sha256Hex, type Command, type Outcome } from './context'

const unionRect = (rects: Array<{ x: number; y: number; width: number; height: number }>): { x: number; y: number; width: number; height: number } => {
  const x0 = Math.min(...rects.map((r) => r.x)),
    y0 = Math.min(...rects.map((r) => r.y)),
    x1 = Math.max(...rects.map((r) => r.x + r.width)),
    y1 = Math.max(...rects.map((r) => r.y + r.height))
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

export const info: Command = {
  name: 'info',
  group: 'document',
  description: 'Pages (size, rotation), metadata, outline, capabilities (forms, XFA, JavaScript, signatures, encryption), annotation count and SHA-256.',
  scope: 'both',
  needsDoc: true,
  produces: 'none',
  params: s.obj({ outline: s.bool('Include the bookmark outline (default true)') }),
  examples: ['yonder-pdf info --in report.pdf --json'],
  async run(ctx, p): Promise<Outcome> {
    const doc = requireDoc(ctx)
    const pdf = await doc.pdfjs()
    const pages: Array<{ page: number; width: number; height: number; rotate: number }> = []
    let fileAnnotations = 0
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i)
      const vp = page.getViewport({ scale: 1 })
      pages.push({ page: i, width: +vp.width.toFixed(2), height: +vp.height.toFixed(2), rotate: page.rotate })
      const annots = (await page.getAnnotations()) as Array<{ subtype?: string }>
      fileAnnotations += annots.filter((a) => a.subtype !== 'Widget' && a.subtype !== 'Link' && a.subtype !== 'Popup').length
    }
    const meta = (await pdf.getMetadata().catch(() => null)) as { info?: Record<string, unknown> } | null
    const info = meta?.info ?? {}
    const pick = (k: string): string | undefined => (typeof info[k] === 'string' && (info[k] as string).trim() ? (info[k] as string) : undefined)
    const fields = await listFields(pdf).catch(() => [])
    let hasJs = false
    try {
      const js = await pdf.getJSActions()
      hasJs = Boolean(js && Object.keys(js).length)
    } catch {
      /* none */
    }
    let outline: unknown[] = []
    if (p.outline !== false) {
      const raw = (await pdf.getOutline().catch(() => null)) as Array<{ title: string; dest: unknown; items: unknown[] }> | null
      const convert = async (items: typeof raw, depth: number): Promise<unknown[]> => {
        if (!items || depth > 6) return []
        const out: unknown[] = []
        for (const it of items.slice(0, 500)) {
          let page: number | null = null
          try {
            const explicit = typeof it.dest === 'string' ? await pdf.getDestination(it.dest) : (it.dest as unknown[] | null)
            const ref = explicit?.[0]
            if (typeof ref === 'number') page = ref + 1
            else if (ref && typeof ref === 'object') page = (await pdf.getPageIndex(ref as { num: number; gen: number })) + 1
          } catch {
            /* unresolvable */
          }
          out.push({ title: it.title, page, items: await convert((it.items ?? []) as typeof raw, depth + 1) })
        }
        return out
      }
      outline = await convert(raw, 0)
    }
    return {
      result: {
        pageCount: pdf.numPages,
        pages,
        metadata: { title: pick('Title'), author: pick('Author'), subject: pick('Subject'), keywords: pick('Keywords'), creator: pick('Creator'), producer: pick('Producer'), created: pick('CreationDate'), modified: pick('ModDate') },
        outline,
        capabilities: {
          encrypted: doc.encrypted,
          readOnly: doc.encrypted,
          hasForms: fields.length > 0,
          hasXfa: Boolean((pdf as unknown as { isPureXfa?: boolean }).isPureXfa),
          hasJs,
          hasSignatures: fields.some((f) => f.type === 'signature')
        },
        fieldCount: fields.length,
        fileAnnotations,
        sessionAnnotations: doc.annotations.length,
        sha256: await sha256Hex(doc.bytes),
        bytes: doc.bytes.length
      }
    }
  }
}

export const text: Command = {
  name: 'text',
  group: 'document',
  description: 'Extract text. One page with --page, or a window of pages with --start/--limit. --layout adds a box (points, origin bottom-left) per text run.',
  scope: 'both',
  needsDoc: true,
  produces: 'none',
  params: s.obj({
    page: s.int('Page number (1-based)', { minimum: 1 }),
    start: s.int('First page of a window (1-based, default 1)', { minimum: 1 }),
    limit: s.int('Number of pages to return (default: all)', { minimum: 1 }),
    layout: s.bool('Include per-run boxes')
  }),
  examples: ['yonder-pdf text --in report.pdf --page 2', 'yonder-pdf text --in report.pdf --layout --json'],
  async run(ctx, p): Promise<Outcome> {
    const pdf = await requireDoc(ctx).pdfjs()
    const n = pdf.numPages
    let first = 0
    let last = n - 1
    if (p.page !== undefined) first = last = parsePage(p.page as number, n)
    else {
      if (p.start !== undefined) first = parsePage(p.start as number, n)
      if (p.limit !== undefined) last = Math.min(n - 1, first + (p.limit as number) - 1)
    }
    const pages: unknown[] = []
    for (let i = first; i <= last; i++) {
      const t = await extractText(pdf, i, Boolean(p.layout))
      pages.push({ page: i + 1, text: t.text, ...(t.lines ? { lines: t.lines.map((l) => ({ text: l.text, rect: round(l.rect) })) } : {}) })
    }
    return { result: { pageCount: n, pages, ...(last < n - 1 ? { nextStart: last + 2 } : {}) } }
  }
}

const round = (r: { x: number; y: number; width: number; height: number }): { x: number; y: number; width: number; height: number } => ({ x: +r.x.toFixed(2), y: +r.y.toFixed(2), width: +r.width.toFixed(2), height: +r.height.toFixed(2) })

export const find: Command = {
  name: 'find',
  group: 'document',
  description: 'Find literal text. Returns page, bounds, quads (usable with markup commands), a snippet and the occurrence number to pass as --occurrence. Matching ignores whitespace differences.',
  scope: 'both',
  needsDoc: true,
  produces: 'none',
  params: s.obj(
    {
      query: s.str('Text to find', { minLength: 1 }),
      page: s.int('Restrict to one page (1-based)', { minimum: 1 }),
      case: s.bool('Case-sensitive (default false)'),
      limit: s.int('Maximum matches to return (default 100)', { minimum: 1 }),
      cursor: s.int('Skip this many matches (for paging)', { minimum: 0 })
    },
    ['query']
  ),
  examples: ['yonder-pdf find "Total due" --in invoice.pdf --json'],
  async run(ctx, p): Promise<Outcome> {
    const pdf = await requireDoc(ctx).pdfjs()
    const page = p.page === undefined ? undefined : parsePage(p.page as number, pdf.numPages)
    const matches = await searchDocument(pdf, p.query as string, { caseSensitive: Boolean(p.case), pages: page === undefined ? undefined : [page] })
    const limit = (p.limit as number | undefined) ?? 100
    const cursor = (p.cursor as number | undefined) ?? 0
    const slice = matches.slice(cursor, cursor + limit)
    return {
      result: {
        query: p.query,
        total: matches.length,
        scope: page === undefined ? 'document' : `page ${page + 1}`,
        matches: slice.map((m, k) => ({ occurrence: cursor + k + 1, page: m.page + 1, bounds: round(unionRect(m.rects)), quads: m.rects.map(rectToQuad).map((q) => q.map((v) => +v.toFixed(2))), snippet: m.snippet, quality: m.quality })),
        ...(cursor + limit < matches.length ? { nextCursor: cursor + limit } : {})
      }
    }
  }
}

export const annotationsList: Command = {
  name: 'annotations.list',
  group: 'document',
  description: 'List annotations: those created in this session/batch (editable) and those already in the file (read-only until Phase 3).',
  scope: 'both',
  needsDoc: true,
  produces: 'none',
  params: s.obj({ page: s.int('Restrict to one page (1-based)', { minimum: 1 }) }),
  async run(ctx, p): Promise<Outcome> {
    const doc = requireDoc(ctx)
    const pdf = await doc.pdfjs()
    const only = p.page === undefined ? undefined : parsePage(p.page as number, pdf.numPages)
    const file: unknown[] = []
    for (let i = 0; i < pdf.numPages; i++) {
      if (only !== undefined && i !== only) continue
      const page = await pdf.getPage(i + 1)
      const annots = (await page.getAnnotations()) as Array<{ id: string; subtype: string; rect: number[]; contentsObj?: { str: string }; titleObj?: { str: string } }>
      for (const a of annots) {
        if (a.subtype === 'Widget' || a.subtype === 'Link' || a.subtype === 'Popup') continue
        const [x0, y0, x1, y1] = a.rect
        file.push({ id: a.id, provenance: 'file', editable: false, removable: false, kind: a.subtype.toLowerCase(), page: i + 1, rect: round({ x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) }), contents: a.contentsObj?.str || undefined, author: a.titleObj?.str || undefined })
      }
    }
    const session = doc.annotations
      .filter((a) => only === undefined || a.page === only)
      .map((a) => ({ id: a.id, provenance: 'session', editable: true, removable: true, kind: a.kind, page: a.page + 1, rect: round(boundsOf(a)), ...summary(a) }))
    return { result: { session, file } }
  }
}

function summary(a: Annotation): Record<string, unknown> {
  switch (a.kind) {
    case 'text':
      return { text: a.text, fontSize: a.fontSize, color: a.color }
    case 'note':
      return { text: a.text, color: a.color }
    case 'image':
      return { role: a.role }
    case 'highlight':
    case 'underline':
    case 'strikeout':
      return { color: a.color, opacity: a.opacity, text: a.text }
    case 'rect':
    case 'ellipse':
      return { color: a.color, fill: a.fill, width: a.width, opacity: a.opacity }
    default:
      return { color: a.color, width: a.width, opacity: a.opacity }
  }
}

const STYLE_KEYS: Record<string, string[]> = {
  highlight: ['color', 'opacity'],
  underline: ['color', 'opacity'],
  strikeout: ['color', 'opacity'],
  ink: ['color', 'width', 'opacity'],
  rect: ['color', 'fill', 'width', 'opacity'],
  ellipse: ['color', 'fill', 'width', 'opacity'],
  line: ['color', 'width', 'opacity'],
  arrow: ['color', 'width', 'opacity'],
  text: ['text', 'fontSize', 'color'],
  note: ['text', 'color'],
  image: []
}

export const annotationsUpdate: Command = {
  name: 'annotations.update',
  group: 'document',
  description: 'Change a session annotation: restyle (--color/--fill/--width/--opacity), edit text (--text/--font-size), move it (--move dx,dy) or set its box (--rect).',
  scope: 'both',
  needsDoc: true,
  produces: 'document',
  params: s.obj(
    {
      id: s.str('Annotation id from a previous result or annotations.list'),
      color: s.str('Stroke/text colour, hex'),
      fill: s.anyOf([s.str('Fill colour, hex'), s.str('"none"', { enum: ['none'] })], 'Fill colour or "none"'),
      width: s.num('Stroke width in points', { exclusiveMinimum: 0 }),
      opacity: s.num('0–1', { minimum: 0, maximum: 1 }),
      text: s.str('New text (text box / note)'),
      fontSize: s.num('Font size in points', { exclusiveMinimum: 0 }),
      move: s.str('Offset "dx,dy" in points'),
      rect: s.str('New box "x,y,width,height" (text, image, rect, ellipse)')
    },
    ['id']
  ),
  async run(ctx, p): Promise<Outcome> {
    const sess = await requireDoc(ctx).session()
    const a = sess.annotations.find((x) => x.id === p.id)
    if (!a) throw new YonderError('YP_NOT_FOUND', `No session annotation with id ${p.id}`, 'Only annotations created in this session or batch can be changed; annotations already in the file are read-only.')
    const allowed = STYLE_KEYS[a.kind]
    const patch: Record<string, unknown> = {}
    for (const key of ['color', 'fill', 'width', 'opacity', 'text', 'fontSize']) {
      if (p[key] === undefined) continue
      if (!allowed.includes(key)) throw new YonderError('YP_INVALID_INPUT', `${key} does not apply to a ${a.kind} annotation`)
      patch[key] = key === 'fill' ? (p.fill === 'none' ? null : p.fill) : p[key]
    }
    let next: Annotation = { ...a, ...patch } as Annotation
    if (p.move !== undefined) {
      const [dx, dy] = String(p.move).split(/[,\s]+/).map(Number)
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new YonderError('YP_INVALID_INPUT', 'move must be "dx,dy"')
      next = translate(next, dx, dy)
    }
    if (p.rect !== undefined) {
      if (!('rect' in next)) throw new YonderError('YP_INVALID_INPUT', `${a.kind} annotations have no rect; use --move`)
      next = { ...next, rect: parseRect(p.rect as string) } as Annotation
    }
    sess.update(a.id, next)
    return { result: { updated: a.id, kind: a.kind, bounds: round(boundsOf(next)) } }
  }
}

export const annotationsRemove: Command = {
  name: 'annotations.remove',
  group: 'document',
  description: 'Remove session annotations by id.',
  scope: 'both',
  needsDoc: true,
  produces: 'document',
  params: s.obj({ ids: s.arr(s.str('id'), 'Annotation ids', { minItems: 1 }) }, ['ids']),
  async run(ctx, p): Promise<Outcome> {
    const sess = await requireDoc(ctx).session()
    const ids = p.ids as string[]
    const missing = ids.filter((id) => !sess.annotations.some((a) => a.id === id))
    if (missing.length) throw new YonderError('YP_NOT_FOUND', `Not session annotations: ${missing.join(', ')}`, 'Annotations already in the file cannot be removed in this version.')
    return { result: { removed: sess.remove(ids) } }
  }
}

export const documentCommands: Command[] = [info, text, find, annotationsList, annotationsUpdate, annotationsRemove]
