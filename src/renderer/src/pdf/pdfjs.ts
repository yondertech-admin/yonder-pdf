// Single adapter around pdf.js so API churn stays in one file.
import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

const ASSET_BASE = new URL('./pdfjs/', document.baseURI).href

export { pdfjs }
export type { PDFDocumentProxy, PDFPageProxy }
export type PageViewport = pdfjs.PageViewport

export interface PageInfo {
  /** Size in user units after the page's own /Rotate (i.e. as displayed at rotation 0). */
  width: number
  height: number
  rotate: number
}

export interface LoadResult {
  pdf: PDFDocumentProxy
  /** Destroys the worker transport; call when the document is closed. */
  destroy: () => Promise<void>
  pages: PageInfo[]
  encrypted: boolean
  hasSignatureFields: boolean
  hasForms: boolean
}

export class PasswordCancelled extends Error {
  constructor() {
    super('Password entry cancelled')
  }
}

export async function loadPdf(
  bytes: Uint8Array,
  askPassword?: (reason: 'need' | 'wrong') => Promise<string | null>
): Promise<LoadResult> {
  const task = pdfjs.getDocument({
    data: bytes.slice(), // pdf.js transfers the buffer to its worker; keep ours (finding 10)
    cMapUrl: ASSET_BASE + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: ASSET_BASE + 'standard_fonts/',
    wasmUrl: ASSET_BASE + 'wasm/',
    iccUrl: ASSET_BASE + 'iccs/'
  })
  let encrypted = false
  task.onPassword = (update: (pw: string) => void, reason: number) => {
    encrypted = true
    const why = reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD ? 'wrong' : 'need'
    if (!askPassword) {
      void task.destroy()
      return
    }
    void askPassword(why).then((pw) => {
      if (pw === null) void task.destroy()
      else update(pw)
    })
  }
  let pdf: PDFDocumentProxy
  try {
    pdf = await task.promise
  } catch (err) {
    if (encrypted) throw new PasswordCancelled()
    throw err
  }
  const pages: PageInfo[] = []
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const vp = page.getViewport({ scale: 1 })
    pages.push({ width: vp.width, height: vp.height, rotate: page.rotate })
  }
  let hasSignatureFields = false
  let hasForms = false
  try {
    const fields = await pdf.getFieldObjects()
    if (fields) {
      hasForms = Object.keys(fields).length > 0
      for (const list of Object.values(fields)) {
        if ((list as Array<{ type?: string }>).some((f) => f.type === 'signature')) hasSignatureFields = true
      }
    }
  } catch {
    /* no AcroForm */
  }
  return { pdf, destroy: () => task.destroy(), pages, encrypted, hasSignatureFields, hasForms }
}

export function makeViewport(page: PDFPageProxy, scale: number, viewRotation: number): PageViewport {
  return page.getViewport({ scale, rotation: (page.rotate + viewRotation) % 360 })
}

/** Minimal PDFLinkService-compatible object for the annotation layer. */
export function makeLinkService(opts: {
  getPdf: () => PDFDocumentProxy | null
  goToPage: (index: number) => void
  openExternal: (url: string) => void
}): unknown {
  const service = {
    externalLinkEnabled: true,
    externalLinkTarget: 0,
    externalLinkRel: 'noopener noreferrer nofollow',
    isInPresentationMode: false,
    get pagesCount() {
      return opts.getPdf()?.numPages ?? 0
    },
    get page() {
      return 1
    },
    set page(_v: number) {},
    get rotation() {
      return 0
    },
    set rotation(_v: number) {},
    async goToDestination(dest: string | unknown[]): Promise<void> {
      const pdf = opts.getPdf()
      if (!pdf) return
      let explicit: unknown[] | null = null
      if (typeof dest === 'string') explicit = await pdf.getDestination(dest)
      else if (Array.isArray(dest)) explicit = dest
      if (!explicit || !explicit.length) return
      const ref = explicit[0]
      try {
        if (typeof ref === 'number') opts.goToPage(ref)
        else if (ref && typeof ref === 'object') opts.goToPage(await pdf.getPageIndex(ref as { num: number; gen: number }))
      } catch {
        /* unresolvable destination */
      }
    },
    goToPage(n: number | string): void {
      const idx = typeof n === 'number' ? n - 1 : parseInt(n, 10) - 1
      if (Number.isFinite(idx)) opts.goToPage(idx)
    },
    addLinkAttributes(link: HTMLAnchorElement, url: string, _newWindow?: boolean): void {
      link.href = '#'
      link.rel = 'noopener noreferrer nofollow'
      link.title = url
      link.onclick = (e: MouseEvent) => {
        e.preventDefault()
        opts.openExternal(url)
        return false
      }
    },
    getDestinationHash(dest: unknown): string {
      return '#' + (typeof dest === 'string' ? encodeURIComponent(dest) : '')
    },
    getAnchorUrl(hash: string): string {
      return '#' + hash
    },
    setHash(_hash: string): void {},
    executeNamedAction(action: string): void {
      // Only navigation actions are honoured; nothing else can run.
      const pdf = opts.getPdf()
      if (!pdf) return
      if (action === 'FirstPage') opts.goToPage(0)
      else if (action === 'LastPage') opts.goToPage(pdf.numPages - 1)
    },
    executeSetOCGState(_action: unknown): void {},
    cachePageRef(_n: number, _ref: unknown): void {},
    isPageVisible(_n: number): boolean {
      return true
    },
    isPageCached(_n: number): boolean {
      return true
    }
  }
  return service
}

export interface OutlineNode {
  title: string
  page: number | null // 0-based; resolved lazily
  dest: string | unknown[] | null
  items: OutlineNode[]
}

export async function getOutline(pdf: PDFDocumentProxy): Promise<OutlineNode[]> {
  const raw = (await pdf.getOutline()) as Array<{ title: string; dest: string | unknown[] | null; items: unknown[] }> | null
  if (!raw) return []
  const convert = (items: typeof raw): OutlineNode[] =>
    items.map((it) => ({
      title: it.title,
      page: null,
      dest: it.dest,
      items: convert((it.items ?? []) as typeof raw)
    }))
  return convert(raw)
}

export async function resolveDestination(pdf: PDFDocumentProxy, dest: string | unknown[] | null): Promise<number | null> {
  if (!dest) return null
  const explicit = typeof dest === 'string' ? await pdf.getDestination(dest) : dest
  if (!explicit || !explicit.length) return null
  const ref = explicit[0]
  try {
    if (typeof ref === 'number') return ref
    return await pdf.getPageIndex(ref as { num: number; gen: number })
  } catch {
    return null
  }
}
