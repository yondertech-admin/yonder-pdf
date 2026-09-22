// Annotation commands. Geometry is PDF user space (points, origin bottom-left,
// unrotated page); every placement also accepts a text anchor (design §14.1 #4).
import { placeRelative, resolveAnchor, type Align } from '../anchors'
import { YonderError } from '../errors'
import { fitWidth, imageInfo, toDataUrl } from '../images'
import { s, type Schema } from '../schema'
import { NOTE_ICON_SIZE, boundsOf, type Annotation, type NewAnnotation, type Quad, type Rect } from '../types'
import { parseColor, parseOpacity, parsePage, parsePaths, parsePoint, parsePositive, parseQuads, parseRect } from '../validate'
import { requireDoc, type Command, type CommandContext, type Outcome, type Params } from './context'

const anchorParams: Record<string, Schema> = {
  text: s.str('Anchor: place relative to this text (see find)'),
  occurrence: s.int('Which occurrence of the anchor text (1-based)', { minimum: 1 }),
  align: s.str('Where relative to the anchor text', { enum: ['on', 'below', 'above', 'left', 'right'] }),
  offset: s.str('Extra offset "dx,dy" in points after alignment')
}
const pageParam = s.int('Page number (1-based)', { minimum: 1 })
const colorParam = (d: string): Schema => s.str(`Colour, hex (default ${d})`)
const opacityParam = s.num('Opacity 0–1 (default 1)', { minimum: 0, maximum: 1 })
const widthParam = s.num('Stroke width in points (default 2)', { exclusiveMinimum: 0 })

const round = (r: Rect): Rect => ({ x: +r.x.toFixed(2), y: +r.y.toFixed(2), width: +r.width.toFixed(2), height: +r.height.toFixed(2) })

interface Placement {
  page: number
  rect: Rect
  anchor?: { occurrence: number; total: number; snippet: string; quality: 'estimated' }
}

/** Resolve --page/--rect/--at or an anchor into a page + box for a box-shaped annotation. */
async function placeBox(ctx: CommandContext, p: Params, size: { width: number; height: number }, defaultAlign: Align): Promise<Placement> {
  const doc = requireDoc(ctx)
  if (p.text !== undefined && p.rect === undefined && p.at === undefined) {
    const pdf = await doc.pdfjs()
    const page = p.page === undefined ? undefined : parsePage(p.page as number, pdf.numPages)
    const a = await resolveAnchor(pdf, { text: String(p.text), page, occurrence: p.occurrence as number | undefined })
    const align = (p.align as Align | undefined) ?? defaultAlign
    const box = align === 'on' && p.width === undefined && p.height === undefined ? { width: a.bounds.width, height: a.bounds.height } : size
    const offset = p.offset === undefined ? undefined : parsePoint(String(p.offset))
    return { page: a.page, rect: placeRelative(a.bounds, align, box, offset), anchor: { occurrence: a.occurrence, total: a.total, snippet: a.snippet, quality: a.quality } }
  }
  if (p.page === undefined) throw new YonderError('YP_USAGE', 'Give --page with --rect/--at, or use --text to anchor to words on the page')
  const page = parsePage(p.page as number, await doc.pageCount())
  if (p.rect !== undefined) return { page, rect: parseRect(p.rect as string) }
  if (p.at !== undefined) {
    const at = parsePoint(String(p.at))
    return { page, rect: { x: at.x, y: at.y, width: size.width, height: size.height } }
  }
  throw new YonderError('YP_USAGE', 'Give --rect "x,y,w,h", --at "x,y" or --text "anchor words"')
}

async function add(ctx: CommandContext, a: NewAnnotation): Promise<Annotation> {
  const sess = await requireDoc(ctx).session()
  return sess.add({ ...a, id: ctx.newId(), createdAt: ctx.now() })
}

const created = (a: Annotation, extra: Record<string, unknown> = {}): Outcome => ({ result: { created: a.id, kind: a.kind, page: a.page + 1, bounds: round(boundsOf(a)), ...extra } })

function markup(kind: 'highlight' | 'underline' | 'strikeout', defaultColor: string): Command {
  return {
    name: `annotate.${kind}`,
    group: 'annotate',
    description: `${kind[0].toUpperCase() + kind.slice(1)} text: either --text "words" (found on the page, use --occurrence when it appears more than once) or --page + --quads from find.`,
    scope: 'both',
    needsDoc: true,
    produces: 'document',
    params: s.obj({
      text: s.str('Text to mark up (whitespace-insensitive match)'),
      occurrence: anchorParams.occurrence,
      page: pageParam,
      case: s.bool('Case-sensitive anchor match'),
      quads: s.str('Explicit quads "ulx,uly,urx,ury,llx,lly,lrx,lry;…" (with --page)'),
      color: colorParam(defaultColor),
      opacity: opacityParam
    }),
    examples: [`yonder-pdf annotate.${kind} --in a.pdf --out b.pdf --text "Total due"`, `yonder-pdf annotate.${kind} --in a.pdf --out b.pdf --page 2 --quads "72,700,300,700,72,688,300,688"`],
    async run(ctx, p): Promise<Outcome> {
      const doc = requireDoc(ctx)
      let page: number
      let quads: Quad[]
      let anchor: Placement['anchor']
      let matched: string | undefined
      if (p.quads !== undefined) {
        if (p.page === undefined) throw new YonderError('YP_USAGE', '--quads needs --page')
        page = parsePage(p.page as number, await doc.pageCount())
        quads = parseQuads(p.quads as string)
      } else if (p.text !== undefined) {
        const pdf = await doc.pdfjs()
        const only = p.page === undefined ? undefined : parsePage(p.page as number, pdf.numPages)
        const a = await resolveAnchor(pdf, { text: String(p.text), page: only, occurrence: p.occurrence as number | undefined, caseSensitive: Boolean(p.case) })
        page = a.page
        quads = a.quads
        anchor = { occurrence: a.occurrence, total: a.total, snippet: a.snippet, quality: a.quality }
        matched = String(p.text)
      } else throw new YonderError('YP_USAGE', 'Give --text "words" or --page + --quads')
      const a = await add(ctx, { kind, page, quads, color: parseColor((p.color as string | undefined) ?? defaultColor), opacity: p.opacity === undefined ? 1 : parseOpacity(p.opacity as number), ...(matched ? { text: matched } : {}) })
      return created(a, anchor ? { anchor } : {})
    }
  }
}

export const textBox: Command = {
  name: 'annotate.text',
  group: 'annotate',
  description: 'Add a text box (FreeText). Place with --page + --rect/--at, or anchor with --text-anchor (default: below the anchor). Only WinAnsi characters render; others become "?" (reported in warnings).',
  scope: 'both',
  needsDoc: true,
  produces: 'document',
  params: s.obj(
    {
      content: s.str('The text to write', { minLength: 1 }),
      page: pageParam,
      rect: s.str('Box "x,y,width,height"'),
      at: s.str('Bottom-left corner "x,y" (box sized from --width and the font)'),
      width: s.num('Box width in points when using --at or an anchor (default 180)', { exclusiveMinimum: 0 }),
      fontSize: s.num('Font size in points (default 12)', { exclusiveMinimum: 0 }),
      color: colorParam('#1a1a1a'),
      text: anchorParams.text,
      occurrence: anchorParams.occurrence,
      align: anchorParams.align,
      offset: anchorParams.offset
    },
    ['content']
  ),
  examples: ['yonder-pdf annotate.text --in a.pdf --out b.pdf --page 1 --at 72,700 --content "Reviewed"', 'yonder-pdf annotate.text --in a.pdf --out b.pdf --text "Signature:" --align right --content "Ada Lovelace"'],
  async run(ctx, p): Promise<Outcome> {
    const fontSize = p.fontSize === undefined ? 12 : parsePositive(p.fontSize as number, 'fontSize', 400)
    const width = p.width === undefined ? 180 : parsePositive(p.width as number, 'width', 5000)
    const place = await placeBox(ctx, p, { width, height: fontSize * 1.2 + 6 }, 'below')
    const content = String(p.content)
    const a = await add(ctx, { kind: 'text', page: place.page, rect: place.rect, text: content, fontSize, color: parseColor((p.color as string | undefined) ?? '#1a1a1a'), rotate: await requireDoc(ctx).pageRotate(place.page) })
    const warnings = /[^\x00-\xff]/.test(content) ? ['Some characters are outside WinAnsi and will render as "?" (Unicode text boxes are planned).'] : []
    return created(a, { ...(place.anchor ? { anchor: place.anchor } : {}), ...(warnings.length ? { warnings } : {}) })
  }
}

export const note: Command = {
  name: 'annotate.note',
  group: 'annotate',
  description: 'Add a sticky note (popup comment) at --page + --at (icon top-left), or anchored to text (default: right of it).',
  scope: 'both',
  needsDoc: true,
  produces: 'document',
  params: s.obj(
    {
      content: s.str('Note text', { minLength: 1 }),
      page: pageParam,
      at: s.str('Icon top-left "x,y"'),
      color: colorParam('#ffd400'),
      text: anchorParams.text,
      occurrence: anchorParams.occurrence,
      align: anchorParams.align,
      offset: anchorParams.offset
    },
    ['content']
  ),
  examples: ['yonder-pdf annotate.note --in a.pdf --out b.pdf --text "Section 4" --content "Please clarify"'],
  async run(ctx, p): Promise<Outcome> {
    const size = { width: NOTE_ICON_SIZE, height: NOTE_ICON_SIZE }
    let place: Placement
    if (p.at !== undefined) {
      const doc = requireDoc(ctx)
      if (p.page === undefined) throw new YonderError('YP_USAGE', '--at needs --page')
      const page = parsePage(p.page as number, await doc.pageCount())
      const at = parsePoint(String(p.at))
      place = { page, rect: { x: at.x, y: at.y - size.height, width: size.width, height: size.height } }
    } else place = await placeBox(ctx, p, size, 'right')
    const r = place.rect
    const a = await add(ctx, { kind: 'note', page: place.page, at: { x: r.x, y: r.y + r.height }, text: String(p.content), color: parseColor((p.color as string | undefined) ?? '#ffd400'), rotate: await requireDoc(ctx).pageRotate(place.page) })
    return created(a, place.anchor ? { anchor: place.anchor } : {})
  }
}

function shape(kind: 'rect' | 'ellipse'): Command {
  return {
    name: `annotate.${kind}`,
    group: 'annotate',
    description: `Draw a ${kind === 'rect' ? 'rectangle' : 'ellipse'}: --page + --rect, or anchored to text (default: covering it, padded). A filled rectangle hides content visually but does not remove it — it is not redaction.`,
    scope: 'both',
    needsDoc: true,
    produces: 'document',
    params: s.obj({
      page: pageParam,
      rect: s.str('Box "x,y,width,height"'),
      color: colorParam('#e5484d'),
      fill: s.str('Fill colour, hex (default none)'),
      width: widthParam,
      opacity: opacityParam,
      padding: s.num('Padding around anchored text in points (default 2)', { minimum: 0 }),
      text: anchorParams.text,
      occurrence: anchorParams.occurrence,
      align: anchorParams.align,
      offset: anchorParams.offset
    }),
    examples: [`yonder-pdf annotate.${kind} --in a.pdf --out b.pdf --text "Total due" --color "#e5484d"`],
    async run(ctx, p): Promise<Outcome> {
      const pad = p.padding === undefined ? 2 : (p.padding as number)
      const place = await placeBox(ctx, p, { width: 100, height: 40 }, 'on')
      const r = place.anchor && (p.align === undefined || p.align === 'on') ? { x: place.rect.x - pad, y: place.rect.y - pad, width: place.rect.width + 2 * pad, height: place.rect.height + 2 * pad } : place.rect
      const a = await add(ctx, { kind, page: place.page, rect: r, color: parseColor((p.color as string | undefined) ?? '#e5484d'), fill: p.fill === undefined ? null : parseColor(p.fill as string), width: p.width === undefined ? 2 : parsePositive(p.width as number, 'width', 100), opacity: p.opacity === undefined ? 1 : parseOpacity(p.opacity as number) })
      return created(a, place.anchor ? { anchor: place.anchor } : {})
    }
  }
}

function lineLike(kind: 'line' | 'arrow'): Command {
  return {
    name: `annotate.${kind}`,
    group: 'annotate',
    description: `Draw ${kind === 'line' ? 'a line' : 'an arrow (head at --to)'} from --from to --to on --page.`,
    scope: 'both',
    needsDoc: true,
    produces: 'document',
    params: s.obj({ page: pageParam, from: s.str('Start "x,y"'), to: s.str('End "x,y"'), color: colorParam('#e5484d'), width: widthParam, opacity: opacityParam }, ['page', 'from', 'to']),
    examples: [`yonder-pdf annotate.${kind} --in a.pdf --out b.pdf --page 1 --from 72,500 --to 300,520`],
    async run(ctx, p): Promise<Outcome> {
      const page = parsePage(p.page as number, await requireDoc(ctx).pageCount())
      const a = await add(ctx, { kind, page, from: parsePoint(String(p.from)), to: parsePoint(String(p.to)), color: parseColor((p.color as string | undefined) ?? '#e5484d'), width: p.width === undefined ? 2 : parsePositive(p.width as number, 'width', 100), opacity: p.opacity === undefined ? 1 : parseOpacity(p.opacity as number) })
      return created(a)
    }
  }
}

export const ink: Command = {
  name: 'annotate.ink',
  group: 'annotate',
  description: 'Freehand strokes on --page: --path "x,y x,y x,y; x,y x,y" (";" separates strokes).',
  scope: 'both',
  needsDoc: true,
  produces: 'document',
  params: s.obj({ page: pageParam, path: s.str('Stroke points'), color: colorParam('#e5484d'), width: widthParam, opacity: opacityParam }, ['page', 'path']),
  async run(ctx, p): Promise<Outcome> {
    const page = parsePage(p.page as number, await requireDoc(ctx).pageCount())
    const a = await add(ctx, { kind: 'ink', page, paths: parsePaths(String(p.path)), color: parseColor((p.color as string | undefined) ?? '#e5484d'), width: p.width === undefined ? 2 : parsePositive(p.width as number, 'width', 100), opacity: p.opacity === undefined ? 1 : parseOpacity(p.opacity as number) })
    return created(a)
  }
}

function imageLike(name: string, role: 'image' | 'stamp' | 'signature' | 'initials', description: string): Command {
  const defaultWidth = role === 'initials' ? 60 : role === 'signature' ? 160 : 200
  return {
    name: `annotate.${name}`,
    group: 'annotate',
    description,
    scope: 'both',
    needsDoc: true,
    produces: 'document',
    params: s.obj(
      {
        file: s.str('PNG or JPEG file'),
        page: pageParam,
        rect: s.str('Box "x,y,width,height" (image is stretched to it)'),
        at: s.str('Bottom-left corner "x,y" (sized by --width, aspect kept)'),
        width: s.num(`Width in points when using --at or an anchor (default ${defaultWidth})`, { exclusiveMinimum: 0 }),
        text: anchorParams.text,
        occurrence: anchorParams.occurrence,
        align: anchorParams.align,
        offset: anchorParams.offset
      },
      ['file']
    ),
    examples: [`yonder-pdf annotate.${name} --in a.pdf --out b.pdf --file ${role}.png --text "Signature:" --align right`],
    async run(ctx, p): Promise<Outcome> {
      const bytes = await ctx.readFile(String(p.file))
      const info = imageInfo(bytes)
      const width = p.width === undefined ? defaultWidth : parsePositive(p.width as number, 'width', 5000)
      const place = await placeBox(ctx, p, fitWidth(info, width), role === 'signature' || role === 'initials' ? 'right' : 'below')
      const rect = p.rect !== undefined ? place.rect : p.align === 'on' && p.width === undefined ? fitAnchored(place.rect, info) : place.rect
      const a = await add(ctx, { kind: 'image', page: place.page, rect, dataUrl: toDataUrl(bytes, info.mime), role, rotate: await requireDoc(ctx).pageRotate(place.page) })
      return created(a, { image: { width: info.width, height: info.height, mime: info.mime }, ...(place.anchor ? { anchor: place.anchor } : {}) })
    }
  }
}

/** When placed "on" an anchor without a width, keep the image's aspect inside the anchor box. */
function fitAnchored(box: Rect, info: { width: number; height: number }): Rect {
  const ratio = info.height / info.width
  let w = box.width
  let h = w * ratio
  if (h > box.height) {
    h = box.height
    w = h / ratio
  }
  return { x: box.x + (box.width - w) / 2, y: box.y + (box.height - h) / 2, width: w, height: h }
}

export const date: Command = {
  name: 'annotate.date',
  group: 'annotate',
  description: "Stamp today's date as a small text box in the page's top-right corner (like the toolbar Date button), or at --at / an anchor.",
  scope: 'both',
  needsDoc: true,
  produces: 'document',
  params: s.obj({
    page: pageParam,
    format: s.str('Date text override (default: e.g. "Sep 22, 2026")'),
    at: s.str('Bottom-left corner "x,y" instead of the corner'),
    text: anchorParams.text,
    occurrence: anchorParams.occurrence,
    align: anchorParams.align,
    offset: anchorParams.offset
  }),
  examples: ['yonder-pdf annotate.date --in a.pdf --out b.pdf --page 1', 'yonder-pdf annotate.date --in a.pdf --out b.pdf --text "Date:" --align right'],
  async run(ctx, p): Promise<Outcome> {
    const doc = requireDoc(ctx)
    const d = new Date(ctx.now())
    const label = p.format !== undefined ? String(p.format) : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: ctx.deterministic ? 'UTC' : undefined })
    const w = 110,
      h = 18,
      m = 36
    let place: Placement
    if (p.at !== undefined || p.text !== undefined) place = await placeBox(ctx, p, { width: w, height: h }, 'right')
    else {
      if (p.page === undefined) throw new YonderError('YP_USAGE', 'Give --page (or --text to anchor)')
      const pdf = await doc.pdfjs()
      const idx = parsePage(p.page as number, pdf.numPages)
      const page = await pdf.getPage(idx + 1)
      const vp = page.getViewport({ scale: 1 })
      const [x1, y1] = vp.convertToPdfPoint(vp.width - m - w, m)
      const [x2, y2] = vp.convertToPdfPoint(vp.width - m, m + h)
      place = { page: idx, rect: { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) } }
    }
    const a = await add(ctx, { kind: 'text', page: place.page, rect: place.rect, text: label, fontSize: 11, color: '#1a1a1a', rotate: await doc.pageRotate(place.page) })
    return created(a, { text: label, ...(place.anchor ? { anchor: place.anchor } : {}) })
  }
}

export const annotateCommands: Command[] = [
  markup('highlight', '#ffd400'),
  markup('underline', '#e5484d'),
  markup('strikeout', '#e5484d'),
  textBox,
  note,
  shape('rect'),
  shape('ellipse'),
  lineLike('line'),
  lineLike('arrow'),
  ink,
  imageLike('image', 'image', 'Place a PNG/JPEG image.'),
  imageLike('stamp', 'stamp', 'Place an image as a stamp.'),
  imageLike('sign', 'signature', 'Place a signature image (visual signing; flattened into the page on save). Typed signatures need the app.'),
  imageLike('initial', 'initials', 'Place an initials image (visual signing; flattened on save).'),
  date
]
