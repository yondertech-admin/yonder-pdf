// Annotation commands. Every coordinate here is *view space* — the page as the
// user sees it (after /Rotate), origin bottom-left, points (design §14.1 #5,
// revised 2026-09-22 after a client's /Rotate 270 scans). Conversion to the
// stored user space happens once, through the page's ViewSpace.
import { placeRelative, resolveAnchor, type Align } from '../anchors'
import { YonderError } from '../errors'
import { assertEmbeddable, fitWidth, imageInfo, toDataUrl } from '../images'
import { s, type Schema } from '../schema'
import { roundRect } from '../space'
import { NOTE_ICON_SIZE, boundsOf, type Annotation, type NewAnnotation, type Rect } from '../types'
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

interface Placement {
  page: number
  /** Stored (user-space) box. */
  rect: Rect
  /** The same box as the user sees it. */
  view: Rect
  anchor?: { occurrence: number; total: number; snippet: string; quality: 'estimated' }
}

interface SizePolicy {
  /** View-space size. */
  size: { width: number; height: number }
  /** True when the caller gave an explicit size; false = a default that may yield to the anchor box. */
  explicit: boolean
}

/** Resolve --page/--rect/--at (view space) or a text anchor into a page + box. */
async function placeBox(ctx: CommandContext, p: Params, policy: SizePolicy, defaultAlign: Align): Promise<Placement> {
  const doc = requireDoc(ctx)
  if (p.text !== undefined && p.rect === undefined && p.at === undefined) {
    const pdf = await doc.pdfjs()
    const page = p.page === undefined ? undefined : parsePage(p.page as number, pdf.numPages)
    const a = await resolveAnchor(pdf, { text: String(p.text), page, occurrence: p.occurrence as number | undefined })
    const vs = await doc.viewSpace(a.page)
    const anchorView = vs.rectToView(a.bounds)
    const align = (p.align as Align | undefined) ?? defaultAlign
    const box = align === 'on' && !policy.explicit ? { width: anchorView.width, height: anchorView.height } : policy.size
    const offset = p.offset === undefined ? undefined : parsePoint(String(p.offset))
    const view = placeRelative(anchorView, align, box, offset)
    return { page: a.page, rect: vs.rectToUser(view), view, anchor: { occurrence: a.occurrence, total: a.total, snippet: a.snippet, quality: a.quality } }
  }
  if (p.page === undefined) throw new YonderError('YP_USAGE', 'Give --page with --rect/--at, or use --text to anchor to words on the page')
  const page = parsePage(p.page as number, await doc.pageCount())
  const vs = await doc.viewSpace(page)
  let view: Rect
  if (p.rect !== undefined) view = parseRect(p.rect as string)
  else if (p.at !== undefined) {
    const at = parsePoint(String(p.at))
    view = { x: at.x, y: at.y, width: policy.size.width, height: policy.size.height }
  } else throw new YonderError('YP_USAGE', 'Give --rect "x,y,w,h", --at "x,y" or --text "anchor words"')
  return { page, rect: vs.rectToUser(view), view }
}

async function add(ctx: CommandContext, a: NewAnnotation): Promise<Annotation> {
  const doc = requireDoc(ctx)
  const sess = await doc.session()
  const full = sess.add({ ...a, id: ctx.newId(), createdAt: ctx.now() })
  doc.touch()
  return full
}

/** Result for a created annotation; `bounds` is reported in view space. */
async function created(ctx: CommandContext, a: Annotation, extra: Record<string, unknown> = {}): Promise<Outcome> {
  const vs = await requireDoc(ctx).viewSpace(a.page)
  return { result: { created: a.id, kind: a.kind, page: a.page + 1, bounds: roundRect(vs.rectToView(boundsOf(a))), ...extra } }
}

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
      quads: s.anyOf([s.str('"ulx,uly,urx,ury,llx,lly,lrx,lry;…"'), s.arr(s.arr(s.num('coordinate'), 'one quad, 8 numbers'), 'quads')], 'Explicit quads in view space (with --page): a string or the `quads` array from find'),
      color: colorParam(defaultColor),
      opacity: opacityParam
    }),
    examples: [`yonder-pdf annotate.${kind} --in a.pdf --out b.pdf --text "Total due"`, `yonder-pdf annotate.${kind} --in a.pdf --out b.pdf --page 2 --quads "72,700,300,700,72,688,300,688"`],
    async run(ctx, p): Promise<Outcome> {
      const doc = requireDoc(ctx)
      let page: number
      let quads
      let anchor: Placement['anchor']
      let matched: string | undefined
      if (p.quads !== undefined) {
        if (p.page === undefined) throw new YonderError('YP_USAGE', '--quads needs --page')
        page = parsePage(p.page as number, await doc.pageCount())
        const vs = await doc.viewSpace(page)
        quads = parseQuads(p.quads as string | number[][]).map((q) => vs.quadToUser(q))
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
      return created(ctx, a, anchor ? { anchor } : {})
    }
  }
}

export const textBox: Command = {
  name: 'annotate.text',
  group: 'annotate',
  description: 'Add a text box (FreeText). Place with --page + --rect/--at, or anchor it with --text "words" (default: below the anchor). Only WinAnsi characters render; others become "?" (reported in warnings).',
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
    const place = await placeBox(ctx, p, { size: { width, height: fontSize * 1.2 + 6 }, explicit: true }, 'below')
    const content = String(p.content)
    const a = await add(ctx, { kind: 'text', page: place.page, rect: place.rect, text: content, fontSize, color: parseColor((p.color as string | undefined) ?? '#1a1a1a'), rotate: await requireDoc(ctx).pageRotate(place.page) })
    const warnings = /[^\x00-\xff]/.test(content) ? ['Some characters are outside WinAnsi and will render as "?" (Unicode text boxes are planned).'] : []
    return created(ctx, a, { ...(place.anchor ? { anchor: place.anchor } : {}), ...(warnings.length ? { warnings } : {}) })
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
      const view = { x: at.x, y: at.y - size.height, width: size.width, height: size.height }
      place = { page, rect: (await doc.viewSpace(page)).rectToUser(view), view }
    } else place = await placeBox(ctx, p, { size, explicit: true }, 'right')
    const r = place.rect
    const a = await add(ctx, { kind: 'note', page: place.page, at: { x: r.x, y: r.y + r.height }, text: String(p.content), color: parseColor((p.color as string | undefined) ?? '#ffd400'), rotate: await requireDoc(ctx).pageRotate(place.page) })
    return created(ctx, a, place.anchor ? { anchor: place.anchor } : {})
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
      const place = await placeBox(ctx, p, { size: { width: 100, height: 40 }, explicit: false }, 'on')
      let rect = place.rect
      if (place.anchor && (p.align === undefined || p.align === 'on')) {
        const v = place.view
        rect = (await requireDoc(ctx).viewSpace(place.page)).rectToUser({ x: v.x - pad, y: v.y - pad, width: v.width + 2 * pad, height: v.height + 2 * pad })
      }
      const a = await add(ctx, { kind, page: place.page, rect, color: parseColor((p.color as string | undefined) ?? '#e5484d'), fill: p.fill === undefined ? null : parseColor(p.fill as string), width: p.width === undefined ? 2 : parsePositive(p.width as number, 'width', 100), opacity: p.opacity === undefined ? 1 : parseOpacity(p.opacity as number) })
      return created(ctx, a, place.anchor ? { anchor: place.anchor } : {})
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
      const doc = requireDoc(ctx)
      const page = parsePage(p.page as number, await doc.pageCount())
      const vs = await doc.viewSpace(page)
      const a = await add(ctx, { kind, page, from: vs.toUser(parsePoint(String(p.from))), to: vs.toUser(parsePoint(String(p.to))), color: parseColor((p.color as string | undefined) ?? '#e5484d'), width: p.width === undefined ? 2 : parsePositive(p.width as number, 'width', 100), opacity: p.opacity === undefined ? 1 : parseOpacity(p.opacity as number) })
      return created(ctx, a)
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
    const doc = requireDoc(ctx)
    const page = parsePage(p.page as number, await doc.pageCount())
    const vs = await doc.viewSpace(page)
    const a = await add(ctx, { kind: 'ink', page, paths: vs.pathsToUser(parsePaths(String(p.path))), color: parseColor((p.color as string | undefined) ?? '#e5484d'), width: p.width === undefined ? 2 : parsePositive(p.width as number, 'width', 100), opacity: p.opacity === undefined ? 1 : parseOpacity(p.opacity as number) })
    return created(ctx, a)
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
        image: s.str('PNG or JPEG file'),
        saved: s.str('Use a signature/initials saved in the app instead of --image (see signatures.list)'),
        page: pageParam,
        rect: s.str('Box "x,y,width,height" (image is stretched to it)'),
        at: s.str('Bottom-left corner "x,y" (sized by --width, aspect kept)'),
        width: s.num(`Width in points when using --at or an anchor (default ${defaultWidth})`, { exclusiveMinimum: 0 }),
        text: anchorParams.text,
        occurrence: anchorParams.occurrence,
        align: anchorParams.align,
        offset: anchorParams.offset
      },
      []
    ),
    examples: [`yonder-pdf annotate.${name} --in a.pdf --out b.pdf --image ${role}.png --text "Signature:" --align right`],
    async run(ctx, p): Promise<Outcome> {
      let dataUrl: string
      let info: { width: number; height: number; mime: 'image/png' | 'image/jpeg' }
      if (p.saved !== undefined) {
        if (!ctx.savedSignatures) throw new YonderError('YP_UNSUPPORTED', 'Saved signatures are not reachable here')
        const hit = (await ctx.savedSignatures()).find((x) => x.id === p.saved)
        if (!hit) throw new YonderError('YP_NOT_FOUND', `No saved signature with id ${p.saved}`, 'Run signatures.list to see the ids.')
        dataUrl = hit.dataUrl
        info = { width: hit.width, height: hit.height, mime: hit.dataUrl.startsWith('data:image/jpeg') ? 'image/jpeg' : 'image/png' }
      } else if (p.image !== undefined) {
        const bytes = await ctx.readFile(String(p.image), 'image')
        info = imageInfo(bytes)
        await assertEmbeddable(bytes, info)
        dataUrl = toDataUrl(bytes, info.mime)
      } else throw new YonderError('YP_USAGE', 'Give --image <png|jpg> or --saved <id>')
      const explicitWidth = p.width !== undefined
      const width = explicitWidth ? parsePositive(p.width as number, 'width', 5000) : defaultWidth
      const place = await placeBox(ctx, p, { size: fitWidth(info, width), explicit: explicitWidth }, role === 'signature' || role === 'initials' ? 'right' : 'below')
      let rect = place.rect
      if (p.rect === undefined && p.align === 'on' && !explicitWidth && place.anchor) {
        // Keep the image's aspect inside the anchor box (all in view space).
        rect = (await requireDoc(ctx).viewSpace(place.page)).rectToUser(fitInside(place.view, info))
      }
      const a = await add(ctx, { kind: 'image', page: place.page, rect, dataUrl, role, rotate: await requireDoc(ctx).pageRotate(place.page) })
      return created(ctx, a, { image: { width: info.width, height: info.height, mime: info.mime }, ...(place.anchor ? { anchor: place.anchor } : {}) })
    }
  }
}

function fitInside(box: Rect, info: { width: number; height: number }): Rect {
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
    if (p.at !== undefined || p.text !== undefined) place = await placeBox(ctx, p, { size: { width: w, height: h }, explicit: true }, 'right')
    else {
      if (p.page === undefined) throw new YonderError('YP_USAGE', 'Give --page (or --text to anchor)')
      const page = parsePage(p.page as number, await doc.pageCount())
      const vs = await doc.viewSpace(page)
      // Top-right corner of the page as displayed (the toolbar's Date button does the same).
      const view = { x: vs.width - m - w, y: vs.height - m - h, width: w, height: h }
      place = { page, rect: vs.rectToUser(view), view }
    }
    const a = await add(ctx, { kind: 'text', page: place.page, rect: place.rect, text: label, fontSize: 11, color: '#1a1a1a', rotate: await doc.pageRotate(place.page) })
    return created(ctx, a, { text: label, ...(place.anchor ? { anchor: place.anchor } : {}) })
  }
}

export const signaturesList: Command = {
  name: 'signatures.list',
  group: 'annotate',
  description: 'List the signatures and initials saved in the Yonder PDF app (use with annotate.sign --saved <id>).',
  scope: 'both',
  needsDoc: false,
  produces: 'none',
  params: s.obj({}),
  async run(ctx): Promise<Outcome> {
    if (!ctx.savedSignatures) throw new YonderError('YP_UNSUPPORTED', 'Saved signatures are not reachable here')
    const list = await ctx.savedSignatures()
    return { result: { signatures: list.map((x) => ({ id: x.id, kind: x.kind, width: x.width, height: x.height, createdAt: new Date(x.createdAt).toISOString() })) } }
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
  imageLike('sign', 'signature', 'Place a signature image (--image file or --saved id; visual signing, flattened into the page on save). Typed signatures need the app.'),
  imageLike('initial', 'initials', 'Place an initials image (--image file or --saved id; visual signing, flattened on save).'),
  date,
  signaturesList
]
