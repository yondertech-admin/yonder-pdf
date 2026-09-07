import { useEffect, useRef, useState, type ReactNode } from 'react'
import { makeLinkService, makeViewport, pdfjs, type PageViewport, type PDFPageProxy } from '@/pdf/pdfjs'
import { useStore, type Doc } from '@/store/app'
import { Overlay } from './Overlay'
import { newId, type MarkupAnnotation, type Quad } from '@/pdf/types'

const MARKUP_TOOLS = new Set(['highlight', 'underline', 'strikeout'])
const ASSET_BASE = new URL('./pdfjs/', document.baseURI).href

/** Registry of live viewports so keyboard-driven markup can find the page under a text selection. */
export const viewports = new Map<string, PageViewport>()
const vpKey = (docId: string, index: number): string => `${docId}:${index}`

let linkService: unknown = null
function getLinkService(): unknown {
  if (!linkService) {
    linkService = makeLinkService({
      getPdf: () => {
        const s = useStore.getState()
        return s.docs.find((d) => d.id === s.activeId)?.pdf ?? null
      },
      goToPage: (i) => useStore.getState().goToPage(i),
      openExternal: (url) => void window.yonder.shell.openPdfLink(url)
    })
  }
  return linkService
}

export function PageView({ doc, index, width, height, visible }: { doc: Doc; index: number; width: number; height: number; visible: boolean }): ReactNode {
  const tool = useStore((s) => s.tool)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textRef = useRef<HTMLDivElement>(null)
  const formRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState<PageViewport | null>(null)
  const [page, setPage] = useState<PDFPageProxy | null>(null)

  // Fetch the page proxy.
  useEffect(() => {
    let alive = true
    setPage(null)
    void doc.pdf.getPage(index + 1).then((p) => alive && setPage(p))
    return () => {
      alive = false
    }
  }, [doc.pdf, index])

  // Render canvas + layers whenever geometry changes and the page is visible.
  useEffect(() => {
    if (!page || !visible) {
      setViewport(null)
      viewports.delete(vpKey(doc.id, index))
      // Release the canvas backing store and layer DOM while off-screen (finding 14).
      const c = canvasRef.current
      if (c) c.width = c.height = 0
      textRef.current?.replaceChildren()
      formRef.current?.replaceChildren()
      page?.cleanup()
      return
    }
    const canvas = canvasRef.current
    const textDiv = textRef.current
    const formDiv = formRef.current
    if (!canvas || !textDiv || !formDiv) return
    const vp = makeViewport(page, doc.zoom, doc.rotation)
    setViewport(vp)
    viewports.set(vpKey(doc.id, index), vp)

    const dpr = Math.min(3, window.devicePixelRatio || 1)
    const renderVp = makeViewport(page, doc.zoom * dpr, doc.rotation)
    canvas.width = Math.ceil(renderVp.width)
    canvas.height = Math.ceil(renderVp.height)
    const task = page.render({ canvas, viewport: renderVp, annotationMode: pdfjs.AnnotationMode.ENABLE_FORMS })
    task.promise.catch(() => undefined)

    textDiv.replaceChildren()
    const textLayer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: textDiv, viewport: vp })
    textLayer.render().catch(() => undefined)

    formDiv.replaceChildren()
    let cancelled = false
    void (async () => {
      try {
        const annotations = await page.getAnnotations({ intent: 'display' })
        if (cancelled) return
        const layer = new pdfjs.AnnotationLayer({
          div: formDiv,
          page,
          viewport: vp,
          accessibilityManager: null,
          annotationCanvasMap: null,
          annotationEditorUIManager: null,
          structTreeLayer: null,
          commentManager: null,
          linkService: getLinkService(),
          annotationStorage: doc.pdf.annotationStorage
        })
        await layer.render({
          annotations,
          div: formDiv,
          page,
          viewport: vp,
          linkService: getLinkService() as never,
          annotationStorage: doc.pdf.annotationStorage,
          renderForms: !doc.readOnly,
          imageResourcesPath: ASSET_BASE + 'images/',
          enableScripting: false,
          fieldObjects: doc.fieldObjects
        })
      } catch {
        /* pages without annotations or cancelled */
      }
    })()

    return () => {
      cancelled = true
      task.cancel()
      textLayer.cancel()
    }
  }, [page, visible, doc.zoom, doc.rotation, doc.id, doc.readOnly, doc.fieldObjects, index, doc.reloadToken])

  useEffect(() => () => void viewports.delete(vpKey(doc.id, index)), [doc.id, index])

  // Text-anchored markup: mouseup after a selection while a markup tool is active.
  const onMouseUp = (): void => {
    if (!MARKUP_TOOLS.has(tool)) return
    applySelectionMarkup(tool as MarkupAnnotation['kind'])
  }

  const mode =
    tool === 'select' ? 'tool-select' : tool === 'hand' ? 'tool-hand' : MARKUP_TOOLS.has(tool) ? 'tool-markup' : `tool-draw tool-${tool}`
  return (
    <div
      className={`page ${mode}`}
      data-page-index={index}
      data-doc-id={doc.id}
      style={{ width, height, ['--scale-factor' as string]: doc.zoom, ['--total-scale-factor' as string]: doc.zoom }}
      onMouseUp={onMouseUp}
    >
      <canvas ref={canvasRef} />
      <div ref={textRef} className="textLayer" />
      <div ref={formRef} className="annotationLayer" onInput={() => useStore.getState().markFormEdited(doc.id)} onChange={() => useStore.getState().markFormEdited(doc.id)} />
      {viewport && <Overlay doc={doc} index={index} viewport={viewport} />}
    </div>
  )
}

/** Turn the current DOM text selection into a markup annotation on the page that contains it. */
export function applySelectionMarkup(kind: MarkupAnnotation['kind']): boolean {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false
  const range = sel.getRangeAt(0)
  const node = range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement
  const pageEl = node?.closest<HTMLElement>('.page')
  if (!pageEl) return false
  const index = parseInt(pageEl.dataset.pageIndex ?? '', 10)
  const docId = pageEl.dataset.docId ?? ''
  const vp = viewports.get(vpKey(docId, index))
  if (!vp) return false
  const pageRect = pageEl.getBoundingClientRect()
  const rects = Array.from(range.getClientRects()).filter((r) => r.width > 1 && r.height > 1)
  if (!rects.length) return false
  // Merge rects on the same line to avoid overlapping quads.
  const lines: DOMRect[] = []
  for (const r of rects.sort((a, b) => a.top - b.top || a.left - b.left)) {
    const last = lines[lines.length - 1]
    if (last && Math.abs(last.top - r.top) < r.height * 0.5 && r.left <= last.right + 4) {
      lines[lines.length - 1] = new DOMRect(Math.min(last.left, r.left), Math.min(last.top, r.top), Math.max(last.right, r.right) - Math.min(last.left, r.left), Math.max(last.bottom, r.bottom) - Math.min(last.top, r.top))
    } else lines.push(r)
  }
  const quads: Quad[] = lines.map((r) => {
    const x1 = r.left - pageRect.left
    const y1 = r.top - pageRect.top
    const x2 = r.right - pageRect.left
    const y2 = r.bottom - pageRect.top
    const [ax, ay] = vp.convertToPdfPoint(x1, y1)
    const [bx, by] = vp.convertToPdfPoint(x2, y1)
    const [cx, cy] = vp.convertToPdfPoint(x1, y2)
    const [dx, dy] = vp.convertToPdfPoint(x2, y2)
    // Normalise to PDF quad order (UL, UR, LL, LR) regardless of rotation.
    const pts = [
      [ax, ay],
      [bx, by],
      [cx, cy],
      [dx, dy]
    ]
    const minX = Math.min(...pts.map((p) => p[0])),
      maxX = Math.max(...pts.map((p) => p[0])),
      minY = Math.min(...pts.map((p) => p[1])),
      maxY = Math.max(...pts.map((p) => p[1]))
    return [minX, maxY, maxX, maxY, minX, minY, maxX, minY]
  })
  const s = useStore.getState()
  s.addAnnotation({
    id: newId(),
    page: index,
    createdAt: Date.now(),
    kind,
    quads,
    color: s.style.color,
    opacity: kind === 'highlight' ? Math.min(s.style.opacity, 1) : s.style.opacity,
    text: sel.toString().slice(0, 2000)
  })
  sel.removeAllRanges()
  return true
}
