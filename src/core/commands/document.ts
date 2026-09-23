// Read-only document commands: info, text, find, annotations.
import { YonderError } from '../errors'
import { listFields } from '../forms'
import { s } from '../schema'
import { extractText, searchDocument } from '../text'
import { rectToQuad } from '../text'
import { roundRect } from '../space'
import { boundsOf, translate, type Annotation } from '../types'
import { parseColor, parseOpacity, parsePage, parsePoint, parsePositive, parseRect } from '../validate'
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
    const pages: unknown[] = []
    let fileAnnotations = 0
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i)
      const vp = page.getViewport({ scale: 1 })
      const [vx0, vy0, vx1, vy1] = page.view
      const userUnit = (page as unknown as { userUnit?: number }).userUnit ?? 1
      // width/height: as displayed (after /Rotate). cropBox: the unrotated user-space box that
      // every coordinate in this API refers to (§14.1 #5); origin is not always 0,0.
      pages.push({ page: i, width: +vp.width.toFixed(2), height: +vp.height.toFixed(2), rotate: page.rotate, cropBox: round({ x: vx0, y: vy0, width: vx1 - vx0, height: vy1 - vy0 }), ...(userUnit !== 1 ? { userUnit } : {}) })
      const annots = (await page.getAnnotations()) as Array<{ subtype?: string }>
      fileAnnotations += annots.filter((a) => a.subtype !== 'Widget' && a.subtype !== 'Link' && a.subtype !== 'Popup').length
    }
    const meta = (await pdf.getMetadata().catch(() => null)) as { info?: Record<string, unknown> } | null
    const info = meta?.info ?? {}
    const pick = (k: string): string | undefined => (typeof info[k] === 'string' && (info[k] as string).trim() ? (info[k] as string) : undefined)
    const fields = await listFields(pdf).catch(() => [])
    let hasJs = false
    try {
      const js = (await pdf.getJSActions()) as unknown
      hasJs = js instanceof Map ? js.size > 0 : Boolean(js && Object.keys(js as object).length)
      if (!hasJs) {
        const raw = (await pdf.getFieldObjects()) as unknown
        const lists: unknown[][] = raw instanceof Map ? [...raw.values()] : raw && typeof raw === 'object' ? Object.values(raw as Record<string, unknown[]>) : []
        for (const list of lists) if (list.some((f) => { const a = (f as { actions?: unknown }).actions; return a instanceof Map ? a.size > 0 : Boolean(a && Object.keys(a as object).length) })) hasJs = true
      }
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
        coordinates: 'view: page as displayed (after /Rotate), origin bottom-left, points',
        pageCount: pdf.numPages,
        pages,
        metadata: { title: pick('Title'), author: pick('Author'), subject: pick('Subject'), keywords: pick('Keywords'), creator: pick('Creator'), producer: pick('Producer'), created: pick('CreationDate'), modified: pick('ModDate') },
        outline,
        capabilities: {
          encrypted: await doc.isEncrypted(),
          readOnly: await doc.isEncrypted(),
          hasForms: fields.length > 0,
          hasXfa: Boolean((pdf as unknown as { isPureXfa?: boolean }).isPureXfa),
          hasJs,
          hasSignatures: await doc.hasSignatures()
        },
        rev: doc.rev,
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
  description: 'Extract text. One page with --page, or a window of pages with --start/--limit (default 20 pages; the result says where to continue). --layout adds a box (points, origin bottom-left) per text run.',
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
      last = Math.min(n - 1, first + ((p.limit as number | undefined) ?? 20) - 1)
    }
    const pages: unknown[] = []
    const doc = requireDoc(ctx)
    for (let i = first; i <= last; i++) {
      const t = await extractText(pdf, i, Boolean(p.layout))
      const vs = t.lines ? await doc.viewSpace(i) : null
      pages.push({ page: i + 1, text: t.text, ...(t.lines && vs ? { lines: t.lines.map((l) => ({ text: l.text, rect: roundRect(vs.rectToView(l.rect)) })) } : {}) })
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
    const truncated = matches.some((m) => m.truncated)
    const limit = (p.limit as number | undefined) ?? 100
    const cursor = (p.cursor as number | undefined) ?? 0
    const slice = matches.slice(cursor, cursor + limit)
    const doc = requireDoc(ctx)
    const out: unknown[] = []
    for (const [k, m] of slice.entries()) {
      const vs = await doc.viewSpace(m.page)
      out.push({ occurrence: cursor + k + 1, page: m.page + 1, bounds: roundRect(vs.rectToView(unionRect(m.rects))), quads: m.rects.map(rectToQuad).map((q) => vs.quadToView(q).map((v) => +v.toFixed(2))), snippet: m.snippet, quality: m.quality })
    }
    return {
      result: {
        query: p.query,
        total: matches.length,
        scope: page === undefined ? 'document' : `page ${page + 1}`,
        matches: out,
        ...(cursor + limit < matches.length ? { nextCursor: cursor + limit } : {}),
        ...(truncated ? { truncated: true, warnings: ['More than 2000 matches on a page were not counted; narrow the query.'] } : {})
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
  params: s.obj({ page: s.int('Restrict to one page (1-based)', { minimum: 1 }), limit: s.int('Maximum file annotations to return (default 500)', { minimum: 1 }), cursor: s.int('Skip this many file annotations', { minimum: 0 }) }),
  async run(ctx, p): Promise<Outcome> {
    const doc = requireDoc(ctx)
    const pdf = await doc.pdfjs()
    const only = p.page === undefined ? undefined : parsePage(p.page as number, pdf.numPages)
    const limit = (p.limit as number | undefined) ?? 500
    const cursor = (p.cursor as number | undefined) ?? 0
    const file: unknown[] = []
    for (let i = 0; i < pdf.numPages; i++) {
      if (only !== undefined && i !== only) continue
      const page = await pdf.getPage(i + 1)
      const annots = (await page.getAnnotations()) as Array<{ id: string; subtype: string; rect: number[]; contentsObj?: { str: string }; titleObj?: { str: string } }>
      const vs = await doc.viewSpace(i)
      for (const a of annots) {
        if (a.subtype === 'Widget' || a.subtype === 'Link' || a.subtype === 'Popup') continue
        const [x0, y0, x1, y1] = a.rect
        file.push({ id: a.id, provenance: 'file', editable: false, removable: false, kind: a.subtype.toLowerCase(), page: i + 1, rect: roundRect(vs.rectToView({ x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) })), contents: a.contentsObj?.str || undefined, author: a.titleObj?.str || undefined })
      }
    }
    const session: unknown[] = []
    for (const a of doc.annotations) {
      if (only !== undefined && a.page !== only) continue
      const vs = await doc.viewSpace(a.page)
      session.push({ id: a.id, provenance: 'session', editable: true, removable: true, kind: a.kind, page: a.page + 1, rect: roundRect(vs.rectToView(boundsOf(a))), ...summary(a) })
    }
    const slice = file.slice(cursor, cursor + limit)
    return { result: { rev: doc.rev, session, file: slice, fileTotal: file.length, ...(cursor + limit < file.length ? { nextCursor: cursor + limit } : {}) } }
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
      move: s.str('Offset "dx,dy" in points (view space)'),
      rect: s.str('New box "x,y,width,height" in view space (text, image, rect, ellipse)')
    },
    ['id']
  ),
  async run(ctx, p): Promise<Outcome> {
    const sess = await requireDoc(ctx).session()
    const a = sess.annotations.find((x) => x.id === p.id)
    if (!a) throw new YonderError('YP_NOT_FOUND', `No session annotation with id ${p.id}`, 'Only annotations created in this session or batch can be changed; annotations already in the file are read-only.')
    const allowed = STYLE_KEYS[a.kind]
    const patch: Record<string, unknown> = {}
    const warnings: string[] = []
    for (const key of ['color', 'fill', 'width', 'opacity', 'text', 'fontSize']) {
      if (p[key] === undefined) continue
      if (!allowed.includes(key)) throw new YonderError('YP_INVALID_INPUT', `${key} does not apply to a ${a.kind} annotation`)
      // Same parsers and limits as creation (REVIEW-05 #12).
      switch (key) {
        case 'color':
          patch.color = parseColor(String(p.color))
          break
        case 'fill':
          patch.fill = p.fill === 'none' ? null : parseColor(String(p.fill))
          break
        case 'width':
          patch.width = parsePositive(p.width as number, 'width', 100)
          break
        case 'opacity':
          patch.opacity = parseOpacity(p.opacity as number)
          break
        case 'fontSize':
          patch.fontSize = parsePositive(p.fontSize as number, 'fontSize', 400)
          break
        case 'text':
          patch.text = String(p.text)
          if (a.kind === 'text' && /[^\x00-\xff]/.test(String(p.text))) warnings.push('Some characters are outside WinAnsi and will render as "?".')
          break
      }
    }
    let next: Annotation = { ...a, ...patch } as Annotation
    const vs = await requireDoc(ctx).viewSpace(a.page)
    if (p.move !== undefined) {
      const d = vs.deltaToUser(parsePoint(String(p.move)))
      next = translate(next, d.x, d.y)
    }
    if (p.rect !== undefined) {
      if (!('rect' in next)) throw new YonderError('YP_INVALID_INPUT', `${a.kind} annotations have no rect; use --move`)
      next = { ...next, rect: vs.rectToUser(parseRect(p.rect as string)) } as Annotation
    }
    sess.update(a.id, next)
    requireDoc(ctx).touch()
    return { result: { updated: a.id, kind: a.kind, bounds: roundRect(vs.rectToView(boundsOf(next))), ...(warnings.length ? { warnings } : {}) } }
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
    const removed = sess.remove(ids)
    requireDoc(ctx).touch()
    return { result: { removed } }
  }
}

export const documentCommands: Command[] = [info, text, find, annotationsList, annotationsUpdate, annotationsRemove]
