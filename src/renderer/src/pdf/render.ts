// Rasterization for print and image export. Renders from a *materialized*
// copy (annotations + forms flattened) so output always equals what Save
// would produce (design §12 / finding 18).
import { pdfjs, type PDFDocumentProxy } from './pdfjs'
import { writeAnnotations } from './writer'
import type { Annotation } from './types'

export interface RasterPage {
  blob: Blob
  widthPt: number
  heightPt: number
  index: number
}

export interface Materialized {
  pdf: PDFDocumentProxy
  destroy: () => Promise<void>
}

export async function materialize(bytes: Uint8Array, annotations: Annotation[], author?: string): Promise<Materialized> {
  const flat = await writeAnnotations(bytes, annotations, { flattenAnnotations: true, flattenForms: true, author })
  const task = pdfjs.getDocument({ data: flat })
  return { pdf: await task.promise, destroy: () => task.destroy() }
}

export async function renderPage(
  pdf: PDFDocumentProxy,
  index: number,
  dpi: number,
  type: 'image/png' | 'image/jpeg' = 'image/png',
  quality = 0.92
): Promise<RasterPage> {
  const page = await pdf.getPage(index + 1)
  const base = page.getViewport({ scale: 1 })
  const scale = dpi / 72
  const vp = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(vp.width)
  canvas.height = Math.ceil(vp.height)
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) throw new Error('Canvas unavailable')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({
    canvas,
    viewport: vp,
    intent: 'print',
    annotationMode: pdfjs.AnnotationMode.ENABLE
  }).promise
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Encoding failed'))), type, quality)
  )
  canvas.width = canvas.height = 0
  page.cleanup()
  return { blob, widthPt: base.width, heightPt: base.height, index }
}

export function chooseDpi(pageCount: number): number {
  if (pageCount <= 20) return 200
  if (pageCount <= 100) return 150
  return 120
}
