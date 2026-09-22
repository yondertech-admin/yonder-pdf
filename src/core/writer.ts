// Low-level annotation writer (design §12 / finding 12). Produces real PDF
// annotation objects with appearance streams so any viewer renders them, or
// flattens them into page content on request. Signature images are always
// flattened.
import {
  PDFDocument,
  PDFFont,
  PDFHexString,
  PDFName,
  PDFPage,
  PDFRef,
  PDFString,
  StandardFonts,
  degrees,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
  type PDFImage,
  type PDFObject
} from 'pdf-lib'
import { NOTE_ICON_SIZE, arrowHeadPoints, boundsOf, hexToRgb, type Annotation, type ImageAnnotation, type Rect, type TextAnnotation, type NoteAnnotation } from './types'

export interface WriteOptions {
  /** Draw annotations into page content instead of creating annotation objects. */
  flattenAnnotations?: boolean
  /** Flatten AcroForm fields (keeps existing appearances). */
  flattenForms?: boolean
  author?: string
  /** Clock for /ModDate (deterministic builds); defaults to now. */
  now?: number
}

const f = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/\.?0+$/, ''))
const rgbOps = (hex: string, op: 'rg' | 'RG'): string => {
  const [r, g, b] = hexToRgb(hex)
  return `${f(r)} ${f(g)} ${f(b)} ${op}`
}

// Mirrors pdf-lib's (unexported) literal types accepted by PDFContext.obj().
type Literal = LiteralObject | LiteralArray | string | number | boolean | null | undefined | PDFObject
interface LiteralObject {
  [key: string]: Literal
}
type LiteralArray = Literal[]

interface Ctx {
  doc: PDFDocument
  author: string
  helv: PDFFont | null
  images: Map<string, PDFImage>
}

export async function writeAnnotations(bytes: Uint8Array, annotations: Annotation[], opts: WriteOptions = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false })
  const ctx: Ctx = { doc, author: opts.author || 'Yonder PDF', helv: null, images: new Map() }
  const pages = doc.getPages()

  for (const a of annotations) {
    const page = pages[a.page]
    if (!page) continue
    if (a.kind === 'image') {
      await drawImage(ctx, page, a)
      continue
    }
    const ap = await buildAppearance(ctx, page, a)
    if (!ap) continue
    if (opts.flattenAnnotations) {
      const name = page.node.newXObject('YonderAnnot', ap.ref)
      page.pushOperators(pushGraphicsState(), drawObject(name), popGraphicsState())
    } else {
      addAnnotation(ctx, page, a, ap)
    }
  }

  if (opts.flattenForms && doc.catalog.has(PDFName.of('AcroForm'))) {
    try {
      doc.getForm().flatten({ updateFieldAppearances: false })
    } catch (err) {
      throw new Error(`Form fields could not be flattened: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  doc.setModificationDate(new Date(opts.now ?? Date.now()))
  return doc.save({ useObjectStreams: false, addDefaultPage: false })
}

interface Appearance {
  ref: PDFRef
  rect: [number, number, number, number]
}

/** Orientation the content was placed for; falls back to the page's current /Rotate for legacy data. */
function placementRotation(a: { rotate?: number }, page: PDFPage): number {
  const r = typeof a.rotate === 'number' ? a.rotate : page.getRotation().angle
  return ((r % 360) + 360) % 360
}

async function buildAppearance(ctx: Ctx, page: PDFPage, a: Annotation): Promise<Appearance | null> {
  const { doc } = ctx
  switch (a.kind) {
    case 'highlight':
    case 'underline':
    case 'strikeout': {
      const b = boundsOf(a)
      const gs = doc.context.register(
        doc.context.obj({ Type: 'ExtGState', CA: a.opacity, ca: a.opacity, BM: a.kind === 'highlight' ? 'Multiply' : 'Normal' })
      )
      let s = `/GS gs ${rgbOps(a.color, 'rg')} ${rgbOps(a.color, 'RG')} `
      for (const q of a.quads) {
        const x1 = Math.min(q[0], q[4]),
          x2 = Math.max(q[2], q[6]),
          yTop = Math.max(q[1], q[3]),
          yBot = Math.min(q[5], q[7])
        const h = yTop - yBot
        if (a.kind === 'highlight') s += `${f(x1)} ${f(yBot)} ${f(x2 - x1)} ${f(h)} re f `
        else {
          const t = Math.max(1, h * 0.07)
          const y = a.kind === 'underline' ? yBot + t : yBot + h / 2
          s += `${f(t)} w ${f(x1)} ${f(y)} m ${f(x2)} ${f(y)} l S `
        }
      }
      return form(ctx, s, rectOf(b), { ExtGState: { GS: gs } })
    }
    case 'ink': {
      const b = boundsOf(a)
      const gs = opacityState(ctx, a.opacity)
      let s = `/GS gs ${rgbOps(a.color, 'RG')} ${f(a.width)} w 1 J 1 j `
      for (const path of a.paths) {
        if (!path.length) continue
        if (path.length === 1) {
          s += `${f(path[0].x)} ${f(path[0].y)} m ${f(path[0].x)} ${f(path[0].y)} l S `
          continue
        }
        s += `${f(path[0].x)} ${f(path[0].y)} m `
        for (let i = 1; i < path.length; i++) s += `${f(path[i].x)} ${f(path[i].y)} l `
        s += 'S '
      }
      return form(ctx, s, rectOf(b), { ExtGState: { GS: gs } })
    }
    case 'rect':
    case 'ellipse': {
      const pad = a.width / 2
      const r: Rect = { x: a.rect.x - pad, y: a.rect.y - pad, width: a.rect.width + a.width, height: a.rect.height + a.width }
      const gs = opacityState(ctx, a.opacity)
      let s = `/GS gs ${rgbOps(a.color, 'RG')} ${f(a.width)} w `
      if (a.fill) s += `${rgbOps(a.fill, 'rg')} `
      const paint = a.fill ? (a.width > 0 ? 'B' : 'f') : 'S'
      if (a.kind === 'rect') {
        s += `${f(a.rect.x)} ${f(a.rect.y)} ${f(a.rect.width)} ${f(a.rect.height)} re ${paint} `
      } else {
        s += ellipsePath(a.rect) + ` ${paint} `
      }
      return form(ctx, s, rectOf(r), { ExtGState: { GS: gs } })
    }
    case 'line':
    case 'arrow': {
      const b = boundsOf(a)
      const gs = opacityState(ctx, a.opacity)
      let s = `/GS gs ${rgbOps(a.color, 'RG')} ${rgbOps(a.color, 'rg')} ${f(a.width)} w 1 J 1 j `
      s += `${f(a.from.x)} ${f(a.from.y)} m ${f(a.to.x)} ${f(a.to.y)} l S `
      if (a.kind === 'arrow') s += arrowHead(a.from, a.to, a.width)
      return form(ctx, s, rectOf(b), { ExtGState: { GS: gs } })
    }
    case 'text':
      return textAppearance(ctx, a, placementRotation(a, page))
    case 'note':
      return noteAppearance(ctx, a, placementRotation(a, page))
    default:
      return null
  }
}

function opacityState(ctx: Ctx, opacity: number): PDFRef {
  return ctx.doc.context.register(ctx.doc.context.obj({ Type: 'ExtGState', CA: opacity, ca: opacity }))
}

function rectOf(r: Rect): [number, number, number, number] {
  return [r.x, r.y, r.x + r.width, r.y + r.height]
}

function form(
  ctx: Ctx,
  content: string,
  rect: [number, number, number, number],
  resources: LiteralObject,
  matrix?: number[],
  bbox?: [number, number, number, number]
): Appearance {
  const dict: LiteralObject = {
    Type: 'XObject',
    Subtype: 'Form',
    FormType: 1,
    BBox: bbox ?? rect,
    Resources: ctx.doc.context.obj(resources)
  }
  if (matrix) dict.Matrix = matrix
  const stream = ctx.doc.context.stream(content, dict)
  return { ref: ctx.doc.context.register(stream), rect }
}

function ellipsePath(r: Rect): string {
  const k = 0.5523
  const cx = r.x + r.width / 2,
    cy = r.y + r.height / 2,
    rx = r.width / 2,
    ry = r.height / 2
  return (
    `${f(cx + rx)} ${f(cy)} m ` +
    `${f(cx + rx)} ${f(cy + ry * k)} ${f(cx + rx * k)} ${f(cy + ry)} ${f(cx)} ${f(cy + ry)} c ` +
    `${f(cx - rx * k)} ${f(cy + ry)} ${f(cx - rx)} ${f(cy + ry * k)} ${f(cx - rx)} ${f(cy)} c ` +
    `${f(cx - rx)} ${f(cy - ry * k)} ${f(cx - rx * k)} ${f(cy - ry)} ${f(cx)} ${f(cy - ry)} c ` +
    `${f(cx + rx * k)} ${f(cy - ry)} ${f(cx + rx)} ${f(cy - ry * k)} ${f(cx + rx)} ${f(cy)} c h`
  )
}

function arrowHead(from: { x: number; y: number }, to: { x: number; y: number }, width: number): string {
  const [p1, p2] = arrowHeadPoints(from, to, width)
  return `${f(to.x)} ${f(to.y)} m ${f(p1.x)} ${f(p1.y)} l ${f(p2.x)} ${f(p2.y)} l h B `
}

/** Rotation matrix + translation that maps a local [0 0 W H] box onto `rect` for a page rotated by `rot`. */
function rotatedMatrix(rect: Rect, rot: number): { matrix: number[]; w: number; h: number } {
  const swap = rot === 90 || rot === 270
  const w = swap ? rect.height : rect.width
  const h = swap ? rect.width : rect.height
  const rad = (rot * Math.PI) / 180
  const cos = Math.round(Math.cos(rad)),
    sin = Math.round(Math.sin(rad))
  // Corners of the local box after rotation about the origin.
  const xs = [0, w * cos, -h * sin, w * cos - h * sin]
  const ys = [0, w * sin, h * cos, w * sin + h * cos]
  const tx = rect.x - Math.min(...xs)
  const ty = rect.y - Math.min(...ys)
  return { matrix: [cos, sin, -sin, cos, tx, ty], w, h }
}

function sanitizeForWinAnsi(s: string): string {
  let out = ''
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 63
    if (ch === '\n' || ch === '\t' || (code >= 32 && code <= 126) || (code >= 160 && code <= 255) || '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'.includes(ch)) out += ch
    else out += '?'
  }
  return out
}

export function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = []
  for (const para of text.replace(/\t/g, '    ').split('\n')) {
    const words = para.split(' ')
    let line = ''
    for (const word of words) {
      const trial = line ? line + ' ' + word : word
      if (font.widthOfTextAtSize(trial, size) <= maxWidth || !line) {
        if (font.widthOfTextAtSize(trial, size) > maxWidth && !line) {
          // Break an over-long word character by character.
          let chunk = ''
          for (const ch of word) {
            if (font.widthOfTextAtSize(chunk + ch, size) > maxWidth && chunk) {
              lines.push(chunk)
              chunk = ch
            } else chunk += ch
          }
          line = chunk
        } else line = trial
      } else {
        lines.push(line)
        line = word
      }
    }
    lines.push(line)
  }
  return lines
}

async function getHelv(ctx: Ctx): Promise<PDFFont> {
  if (!ctx.helv) ctx.helv = await ctx.doc.embedFont(StandardFonts.Helvetica)
  return ctx.helv
}

async function textAppearance(ctx: Ctx, a: TextAnnotation, rot: number): Promise<Appearance> {
  const font = await getHelv(ctx)
  const { matrix, w, h } = rotatedMatrix(a.rect, rot)
  const text = sanitizeForWinAnsi(a.text)
  const pad = 2
  const lines = wrapText(text, font, a.fontSize, Math.max(1, w - pad * 2))
  const lineH = a.fontSize * 1.2
  let s = `/Tx BMC q ${f(pad)} ${f(pad)} ${f(Math.max(0, w - pad * 2))} ${f(Math.max(0, h - pad * 2))} re W n BT /Helv ${f(a.fontSize)} Tf ${rgbOps(a.color, 'rg')} `
  let y = h - pad - a.fontSize * 0.95
  for (const line of lines) {
    s += `1 0 0 1 ${f(pad)} ${f(y)} Tm ${font.encodeText(line).toString()} Tj `
    y -= lineH
  }
  s += 'ET Q EMC'
  return form(ctx, s, rectOf(a.rect), { Font: { Helv: font.ref } }, matrix, [0, 0, w, h])
}

function noteAppearance(ctx: Ctx, a: NoteAnnotation, rot: number): Appearance {
  const size = NOTE_ICON_SIZE
  const rect: Rect = { x: a.at.x, y: a.at.y - size, width: size, height: size }
  const { matrix, w, h } = rotatedMatrix(rect, rot)
  const s =
    `${rgbOps(a.color, 'rg')} 1 1 1 RG 0.8 w ` +
    `1 1 ${f(w - 2)} ${f(h - 2)} re B ` +
    `1 1 1 RG 1.2 w 5 ${f(h - 6)} m ${f(w - 5)} ${f(h - 6)} l S 5 ${f(h / 2)} m ${f(w - 5)} ${f(h / 2)} l S 5 6 m ${f(w / 2)} 6 l S`
  return form(ctx, s, rectOf(rect), {}, matrix, [0, 0, w, h])
}

function addAnnotation(ctx: Ctx, page: PDFPage, a: Annotation, ap: Appearance): void {
  const { doc } = ctx
  const now = PDFString.fromDate(new Date(a.createdAt || Date.now()))
  const base: LiteralObject = {
    Type: 'Annot',
    Rect: ap.rect,
    F: 4,
    NM: PDFString.of(a.id),
    M: now,
    T: PDFHexString.fromText(ctx.author),
    P: page.ref,
    AP: { N: ap.ref }
  }
  const color = (hex: string): number[] => [...hexToRgb(hex)]
  switch (a.kind) {
    case 'highlight':
    case 'underline':
    case 'strikeout':
      Object.assign(base, {
        Subtype: a.kind === 'highlight' ? 'Highlight' : a.kind === 'underline' ? 'Underline' : 'StrikeOut',
        QuadPoints: a.quads.flat(),
        C: color(a.color),
        CA: a.opacity,
        Contents: PDFHexString.fromText(a.text ?? '')
      })
      break
    case 'ink':
      Object.assign(base, {
        Subtype: 'Ink',
        InkList: a.paths.map((p) => p.flatMap((pt) => [pt.x, pt.y])),
        C: color(a.color),
        CA: a.opacity,
        BS: { W: a.width, S: 'S' }
      })
      break
    case 'rect':
    case 'ellipse':
      Object.assign(base, {
        Subtype: a.kind === 'rect' ? 'Square' : 'Circle',
        C: color(a.color),
        CA: a.opacity,
        BS: { W: a.width, S: 'S' },
        ...(a.fill ? { IC: color(a.fill) } : {})
      })
      break
    case 'line':
    case 'arrow':
      Object.assign(base, {
        Subtype: 'Line',
        L: [a.from.x, a.from.y, a.to.x, a.to.y],
        LE: [PDFName.of('None'), PDFName.of(a.kind === 'arrow' ? 'ClosedArrow' : 'None')],
        C: color(a.color),
        IC: color(a.color),
        CA: a.opacity,
        BS: { W: a.width, S: 'S' }
      })
      break
    case 'text': {
      const [r, g, b] = hexToRgb(a.color)
      Object.assign(base, {
        Subtype: 'FreeText',
        DA: PDFString.of(`/Helv ${f(a.fontSize)} Tf ${f(r)} ${f(g)} ${f(b)} rg`),
        Contents: PDFHexString.fromText(a.text),
        C: [],
        Q: 0
      })
      break
    }
    case 'note': {
      const annot = doc.context.obj({
        ...base,
        Subtype: 'Text',
        Name: 'Comment',
        Contents: PDFHexString.fromText(a.text),
        C: color(a.color),
        Open: false,
        F: 28 // Print | NoZoom | NoRotate
      })
      const annotRef = doc.context.register(annot)
      const popup = doc.context.obj({
        Type: 'Annot',
        Subtype: 'Popup',
        Rect: [ap.rect[2] + 4, ap.rect[1] - 120, ap.rect[2] + 184, ap.rect[3]],
        Parent: annotRef,
        Open: false,
        F: 0
      })
      const popupRef = doc.context.register(popup)
      annot.set(PDFName.of('Popup'), popupRef)
      page.node.addAnnot(annotRef)
      page.node.addAnnot(popupRef)
      return
    }
    default:
      return
  }
  const ref = doc.context.register(doc.context.obj(base))
  page.node.addAnnot(ref)
}

async function drawImage(ctx: Ctx, page: PDFPage, a: ImageAnnotation): Promise<void> {
  let img = ctx.images.get(a.dataUrl)
  if (!img) {
    const bytes = dataUrlToBytes(a.dataUrl)
    img = a.dataUrl.startsWith('data:image/jpeg') ? await ctx.doc.embedJpg(bytes) : await ctx.doc.embedPng(bytes)
    ctx.images.set(a.dataUrl, img)
  }
  const rot = placementRotation(a, page)
  const R = a.rect
  // Keep the image upright for the orientation it was placed in.
  switch (rot) {
    case 90:
      page.drawImage(img, { x: R.x + R.width, y: R.y, width: R.height, height: R.width, rotate: degrees(90) })
      break
    case 180:
      page.drawImage(img, { x: R.x + R.width, y: R.y + R.height, width: R.width, height: R.height, rotate: degrees(180) })
      break
    case 270:
      page.drawImage(img, { x: R.x, y: R.y + R.height, width: R.height, height: R.width, rotate: degrees(270) })
      break
    default:
      page.drawImage(img, { x: R.x, y: R.y, width: R.width, height: R.height })
  }
}

export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',')
  const b64 = dataUrl.slice(comma + 1)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
