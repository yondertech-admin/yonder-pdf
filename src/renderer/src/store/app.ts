import { create } from 'zustand'
import type { OpenedFile, RecentEntry, Settings, UpdateStatus } from '@shared/api'
import { getOutline, loadPdf, PasswordCancelled, type OutlineNode, type PageInfo, type PDFDocumentProxy } from '@/pdf/pdfjs'
import { writeAnnotations } from '@core/writer'
import * as ops from '@core/pageOps'
import { searchDocument, type SearchMatch } from '@/pdf/search'
import { chooseDpi, materialize, renderPage, type Materialized } from '@/pdf/render'
import { cloneAnnotations, hasUnsupportedText, newId, type Annotation, type Tool, type ToolStyle } from '@core/types'

export type ZoomMode = 'fit-width' | 'fit-page' | 'custom'
export type Rotation = 0 | 90 | 180 | 270

interface Snapshot {
  baseBytes: Uint8Array
  annotations: Annotation[]
}

export interface Doc {
  id: string
  handle: string | null
  name: string
  location: string
  baseBytes: Uint8Array
  pdf: PDFDocumentProxy
  destroy: () => Promise<void>
  pages: PageInfo[]
  annotations: Annotation[]
  history: Snapshot[]
  future: Snapshot[]
  dirty: boolean
  readOnly: boolean
  hasSignatureFields: boolean
  hasForms: boolean
  hasXfa: boolean
  hasJs: boolean
  fieldObjects: Map<string, object[]> | null
  /** Edit revision: bumped on every annotation/form/page change; save compares it. */
  rev: number
  outline: OutlineNode[] | null
  zoom: number
  zoomMode: ZoomMode
  rotation: Rotation
  currentPage: number
  scrollRequest: { page: number; token: number } | null
  selectedIds: string[]
  selectedPages: number[]
  reloadToken: number
}

export type Dialog =
  | { type: 'signature'; kind: 'signature' | 'initials' }
  | { type: 'goToPage' }
  | { type: 'shortcuts' }
  | { type: 'privacy' }
  | { type: 'about' }
  | { type: 'extract' }
  | { type: 'split' }
  | { type: 'note'; id: string }
  | { type: 'stamp' }
  | { type: 'password'; reason: 'need' | 'wrong'; name: string; resolve: (pw: string | null) => void }
  | null

export interface PendingImage {
  dataUrl: string
  width: number
  height: number
  role: 'signature' | 'initials' | 'stamp' | 'image'
}

/** A text stamp chosen in the Stamp dialog, waiting for a click on the page. Size in points. */
export interface PendingStamp {
  label: string
  sublabel?: string
  color: string
  preset?: string
  width: number
  height: number
}

interface FindState {
  open: boolean
  query: string
  caseSensitive: boolean
  matches: SearchMatch[]
  current: number
  searching: boolean
}

interface State {
  docs: Doc[]
  activeId: string | null
  tool: Tool
  style: ToolStyle
  pendingImage: PendingImage | null
  pendingStamp: PendingStamp | null
  sidebarOpen: boolean
  sidebarTab: Settings['sidebarTab']
  theme: Settings['theme']
  signerName: string
  find: FindState
  dialog: Dialog
  toast: { text: string; kind: 'info' | 'error' } | null
  busy: { label: string; percent?: number; cancel?: () => void } | null
  fullscreen: boolean
  updateStatus: UpdateStatus
  recent: RecentEntry[]
  settingsLoaded: boolean
}

interface Actions {
  init(): Promise<void>
  openFiles(files: OpenedFile[]): Promise<void>
  openDialog(): Promise<void>
  openRecent(id: string): Promise<void>
  closeDoc(id: string): Promise<boolean>
  closeAll(): Promise<boolean>
  setActive(id: string): void
  save(): Promise<boolean>
  saveAs(): Promise<boolean>
  buildOutput(doc: Doc, opts?: { flattenAnnotations?: boolean; flattenForms?: boolean }): Promise<Uint8Array>
  exportFlattened(): Promise<void>
  exportImages(): Promise<void>
  print(): Promise<void>
  merge(): Promise<void>

  setTool(tool: Tool): void
  setStyle(patch: Partial<ToolStyle>): void
  setPendingImage(img: PendingImage | null): void
  setPendingStamp(stamp: PendingStamp | null): void

  addAnnotation(a: Annotation): void
  updateAnnotation(id: string, patch: Partial<Annotation>, opts?: { history?: boolean }): void
  removeAnnotations(ids: string[]): void
  select(ids: string[]): void
  undo(): Promise<void>
  redo(): Promise<void>

  setZoom(zoom: number, mode?: ZoomMode): void
  zoomIn(): void
  zoomOut(): void
  setRotation(r: Rotation): void
  rotateView(delta: 90 | -90): void
  setCurrentPage(page: number): void
  goToPage(page: number): void
  selectPages(pages: number[]): void

  rotatePages(indices: number[] | null, delta: 90 | -90): Promise<void>
  deletePages(indices: number[] | null): Promise<void>
  reorderPages(order: number[]): Promise<void>
  insertBlank(after: number | null): Promise<void>
  insertFromFile(after: number | null): Promise<void>
  extractPages(indices: number[]): Promise<void>
  splitDocument(every: number): Promise<void>

  setSidebar(open: boolean, tab?: Settings['sidebarTab']): void
  setTheme(theme: Settings['theme']): void
  setSignerName(name: string): void
  setDialog(d: Dialog): void
  showToast(text: string, kind?: 'info' | 'error'): void
  setFind(patch: Partial<FindState>): void
  runSearch(): Promise<void>
  findNext(delta: 1 | -1): void
  setFullscreen(v: boolean): void
  setUpdateStatus(s: UpdateStatus): void
  refreshRecent(): Promise<void>
  /** Called when pdf.js reports an AcroForm value change. */
  markFormEdited(id: string): void
}

export type Store = State & Actions

const MAX_HISTORY = 25
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 6, 8]

export const DEFAULT_STYLE: ToolStyle = { color: '#ffd400', fill: null, width: 2, opacity: 1, fontSize: 12 }
export const TOOL_DEFAULT_COLORS: Partial<Record<Tool, string>> = {
  highlight: '#ffd400',
  underline: '#e5484d',
  strikeout: '#e5484d',
  ink: '#e5484d',
  rect: '#e5484d',
  ellipse: '#e5484d',
  line: '#e5484d',
  arrow: '#e5484d',
  text: '#1a1a1a',
  note: '#ffd400'
}

const api = (): Window['yonder'] => window.yonder
let searchSignal = { cancelled: false }

export const useStore = create<Store>()((set, get) => {
  const active = (): Doc | null => {
    const s = get()
    return s.docs.find((d) => d.id === s.activeId) ?? null
  }
  const patchDoc = (id: string, patch: Partial<Doc> | ((d: Doc) => Partial<Doc>)): void => {
    set((s) => ({ docs: s.docs.map((d) => (d.id === id ? { ...d, ...(typeof patch === 'function' ? patch(d) : patch) } : d)) }))
  }
  const syncTitle = (): void => {
    const d = active()
    api().window.setTitle(d ? d.name : '', d?.dirty ?? false)
  }
  const pushHistory = (d: Doc): Partial<Doc> => ({
    history: [...d.history.slice(-(MAX_HISTORY - 1)), { baseBytes: d.baseBytes, annotations: cloneAnnotations(d.annotations) }],
    future: []
  })

  /** Per-document mutex: save, page ops, undo/redo and exports never interleave (finding 7). */
  const locks = new Map<string, Promise<unknown>>()
  const withLock = async <T,>(id: string, fn: () => Promise<T>): Promise<T> => {
    const prev = locks.get(id) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    const tail = run.catch(() => undefined)
    locks.set(id, tail)
    try {
      return await run
    } finally {
      if (locks.get(id) === tail) locks.delete(id)
    }
  }

  /** Bytes with current AcroForm values folded in (pdf.js appearance generation). Throws rather than silently dropping form edits (finding 6). */
  const formBytes = async (d: Doc): Promise<Uint8Array> => {
    if (d.pdf.annotationStorage.size === 0) return d.baseBytes
    try {
      return await d.pdf.saveDocument()
    } catch (err) {
      throw new Error(`Form values could not be written: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const bump = (d: Doc): Partial<Doc> => ({ rev: d.rev + 1, dirty: true })

  /** Copy live AcroForm values from one pdf.js proxy to another (annotation ids are stable across reloads of the same file). */
  const carryFormValues = (from: PDFDocumentProxy, to: PDFDocumentProxy): void => {
    try {
      const all = (from.annotationStorage as unknown as { getAll(): Record<string, unknown> | null }).getAll()
      if (!all) return
      for (const [key, value] of Object.entries(all)) to.annotationStorage.setValue(key, value as object)
    } catch {
      /* best effort */
    }
  }

  const reloadFromBytes = async (id: string, bytes: Uint8Array, annotations: Annotation[], extra: Partial<Doc> = {}): Promise<void> => {
    const d = get().docs.find((x) => x.id === id)
    if (!d) return
    const loaded = await loadPdf(bytes)
    carryFormValues(d.pdf, loaded.pdf)
    const oldDestroy = d.destroy
    const outline = await getOutline(loaded.pdf).catch(() => [])
    patchDoc(id, {
      baseBytes: bytes,
      pdf: loaded.pdf,
      destroy: loaded.destroy,
      pages: loaded.pages,
      annotations,
      hasForms: loaded.hasForms,
      hasSignatureFields: loaded.hasSignatureFields,
      hasXfa: loaded.hasXfa,
      hasJs: loaded.hasJs,
      fieldObjects: loaded.fieldObjects,
      outline,
      currentPage: Math.min(d.currentPage, loaded.pages.length - 1),
      selectedPages: [],
      selectedIds: [],
      reloadToken: d.reloadToken + 1,
      ...extra
    })
    void oldDestroy()
  }

  const runPageOp = async (
    label: string,
    fn: (bytes: Uint8Array, d: Doc) => Promise<ops.OpResult>,
    after?: Partial<Doc>
  ): Promise<void> => {
    const d0 = active()
    if (!d0) return
    if (d0.readOnly) return get().showToast('This document is read-only (password protected).', 'error')
    if (get().busy) return
    flushEditors()
    set({ busy: { label } })
    try {
      await withLock(d0.id, async () => {
        const d = get().docs.find((x) => x.id === d0.id)
        if (!d) return
        const bytes = await formBytes(d)
        const result = await fn(bytes, d)
        const annotations = ops.remapAnnotations(d.annotations, result.map)
        const hist = pushHistory({ ...d, baseBytes: bytes })
        await reloadFromBytes(d.id, result.bytes, annotations, { ...hist, ...bump(d), ...after })
      })
      syncTitle()
    } catch (err) {
      get().showToast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      set({ busy: null })
    }
  }

  /** Commit any open inline text editor so its draft is in document state before saving/printing (finding 9). */
  const flushEditors = (): void => {
    const el = document.activeElement as HTMLElement | null
    if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')) el.blur()
  }

  /** After a successful save, history snapshots that pointed at the old bytes now point at the new ones so undo does not reload pre-form-fill bytes (finding 8). */
  const rebaseHistory = (d: Doc, oldBytes: Uint8Array, newBytes: Uint8Array): Partial<Doc> => ({
    history: d.history.map((h) => (h.baseBytes === oldBytes ? { ...h, baseBytes: newBytes } : h)),
    future: d.future.map((h) => (h.baseBytes === oldBytes ? { ...h, baseBytes: newBytes } : h))
  })

  const targets = (indices: number[] | null, d: Doc): number[] =>
    indices && indices.length ? indices : d.selectedPages.length ? d.selectedPages : [d.currentPage]

  return {
    docs: [],
    activeId: null,
    tool: 'select',
    style: { ...DEFAULT_STYLE },
    pendingImage: null,
    pendingStamp: null,
    sidebarOpen: true,
    sidebarTab: 'thumbnails',
    theme: 'system',
    signerName: '',
    find: { open: false, query: '', caseSensitive: false, matches: [], current: -1, searching: false },
    dialog: null,
    toast: null,
    busy: null,
    fullscreen: false,
    updateStatus: { state: 'idle' },
    recent: [],
    settingsLoaded: false,

    async init() {
      const s = await api().settings.get()
      set({ sidebarOpen: s.sidebarOpen, sidebarTab: s.sidebarTab, theme: s.theme, signerName: s.signerName, settingsLoaded: true })
      await get().refreshRecent()
      set({ fullscreen: await api().window.isFullScreen() })
    },

    async refreshRecent() {
      set({ recent: await api().doc.recent() })
    },

    async openFiles(files) {
      for (const f of files) {
        const existing = get().docs.find((d) => d.handle && d.handle === f.handle)
        if (existing) {
          set({ activeId: existing.id })
          continue
        }
        try {
          const loaded = await loadPdf(f.bytes, (reason) =>
            new Promise<string | null>((resolve) => {
              set({ dialog: { type: 'password', reason, name: f.name, resolve: (pw) => { set({ dialog: null }); resolve(pw) } } })
            })
          )
          const outline = await getOutline(loaded.pdf).catch(() => [])
          const doc: Doc = {
            id: newId(),
            handle: f.handle,
            name: f.name,
            location: f.location,
            baseBytes: f.bytes,
            pdf: loaded.pdf,
            destroy: loaded.destroy,
            pages: loaded.pages,
            annotations: [],
            history: [],
            future: [],
            dirty: false,
            readOnly: loaded.encrypted,
            hasSignatureFields: loaded.hasSignatureFields,
            hasForms: loaded.hasForms,
            hasXfa: loaded.hasXfa,
            hasJs: loaded.hasJs,
            fieldObjects: loaded.fieldObjects,
            rev: 0,
            outline,
            zoom: 1,
            zoomMode: 'fit-width',
            rotation: 0,
            currentPage: 0,
            scrollRequest: null,
            selectedIds: [],
            selectedPages: [],
            reloadToken: 0
          }
          set((s) => ({ docs: [...s.docs, doc], activeId: doc.id }))
        } catch (err) {
          if (err instanceof PasswordCancelled) continue
          await api().doc.showError(`Could not open ${f.name}`, err instanceof Error ? err.message : String(err))
        }
      }
      syncTitle()
      void get().refreshRecent()
    },

    async openDialog() {
      const files = await api().doc.openDialog(true)
      await get().openFiles(files)
    },

    async openRecent(id) {
      const f = await api().doc.openRecent(id)
      if (f) await get().openFiles([f])
      else void get().refreshRecent()
    },

    async closeDoc(id) {
      flushEditors()
      let d = get().docs.find((x) => x.id === id)
      if (!d) return true
      // Wait for any running save/page operation on this document first.
      await withLock(id, async () => undefined)
      d = get().docs.find((x) => x.id === id)
      if (!d) return true
      for (let attempt = 0; d.dirty && attempt < 3; attempt++) {
        set({ activeId: id })
        const choice = await api().doc.confirmDiscard([d.name])
        if (choice === 'cancel') return false
        if (choice === 'discard') break
        const ok = await get().save()
        if (!ok) return false
        d = get().docs.find((x) => x.id === id)
        if (!d) return true
      }
      set((s) => {
        const docs = s.docs.filter((x) => x.id !== id)
        const idx = s.docs.findIndex((x) => x.id === id)
        const next = s.activeId === id ? (docs[Math.min(idx, docs.length - 1)]?.id ?? null) : s.activeId
        return { docs, activeId: next }
      })
      void d.destroy()
      syncTitle()
      return true
    },

    async closeAll() {
      for (const d of [...get().docs]) {
        const ok = await get().closeDoc(d.id)
        if (!ok) return false
      }
      return true
    },

    setActive(id) {
      set({ activeId: id, find: { ...get().find, matches: [], current: -1 } })
      syncTitle()
    },

    async buildOutput(doc, opts = {}) {
      const bytes = await formBytes(doc)
      return writeAnnotations(bytes, doc.annotations, { ...opts, author: get().signerName || undefined })
    },

    async save() {
      const d = active()
      if (!d) return false
      if (d.readOnly) {
        get().showToast('Password-protected documents open read-only in this version.', 'error')
        return false
      }
      if (!d.handle) return get().saveAs()
      if (d.hasSignatureFields) {
        const ok = await api().doc.confirm({
          title: 'Document contains signature fields',
          message: 'Saving will rewrite the file and invalidate any existing digital signatures.',
          detail: 'Choose "Save As" to keep the original untouched.',
          ok: 'Save anyway',
          danger: true
        })
        if (!ok) return false
      }
      if (get().busy) return false
      flushEditors()
      set({ busy: { label: 'Saving…' } })
      try {
        return await withLock(d.id, async () => {
          const cur = get().docs.find((x) => x.id === d.id)
          if (!cur || !cur.handle) return false
          const rev = cur.rev
          const bytes = await formBytes(cur)
          const out = await writeAnnotations(bytes, cur.annotations, { author: get().signerName || undefined })
          const r = await api().doc.save(cur.handle, out)
          if (!r.ok) {
            get().showToast(`Save failed: ${r.error}`, 'error')
            return false
          }
          // Clean only after the disk commit; edits made meanwhile keep it dirty (finding 9).
          const now = get().docs.find((x) => x.id === d.id)
          if (!now) return true
          patchDoc(d.id, { baseBytes: bytes, dirty: now.rev !== rev, name: r.name, ...rebaseHistory(now, now.baseBytes, bytes) })
          syncTitle()
          get().showToast(hasUnsupportedText(cur.annotations) ? 'Saved. Some characters in text boxes are not supported by the built-in font and were written as "?".' : 'Saved')
          return true
        })
      } catch (err) {
        get().showToast(`Save failed: ${err instanceof Error ? err.message : String(err)}`, 'error')
        return false
      } finally {
        set({ busy: null })
      }
    },

    async saveAs() {
      const d = active()
      if (!d) return false
      if (d.readOnly) {
        get().showToast('Password-protected documents open read-only in this version.', 'error')
        return false
      }
      if (get().busy) return false
      flushEditors()
      set({ busy: { label: 'Saving…' } })
      try {
        return await withLock(d.id, async () => {
          const cur = get().docs.find((x) => x.id === d.id)
          if (!cur) return false
          const rev = cur.rev
          const bytes = await formBytes(cur)
          const out = await writeAnnotations(bytes, cur.annotations, { author: get().signerName || undefined })
          const r = await api().doc.saveAs(cur.handle, out, cur.name)
          if (!r.ok) {
            if (!r.cancelled) get().showToast(`Save failed: ${r.error}`, 'error')
            return false
          }
          const now = get().docs.find((x) => x.id === d.id)
          if (!now) return true
          patchDoc(d.id, { baseBytes: bytes, dirty: now.rev !== rev, handle: r.handle, name: r.name, ...rebaseHistory(now, now.baseBytes, bytes) })
          syncTitle()
          void get().refreshRecent()
          get().showToast(hasUnsupportedText(cur.annotations) ? 'Saved. Some characters in text boxes are not supported by the built-in font and were written as "?".' : 'Saved')
          return true
        })
      } catch (err) {
        get().showToast(`Save failed: ${err instanceof Error ? err.message : String(err)}`, 'error')
        return false
      } finally {
        set({ busy: null })
      }
    },

    async exportFlattened() {
      if (get().busy) return
      flushEditors()
      const d = active()
      if (!d) return
      if (d.readOnly) return get().showToast('This document is read-only.', 'error')
      set({ busy: { label: 'Flattening…' } })
      try {
        const out = await get().buildOutput(d, { flattenAnnotations: true, flattenForms: true })
        const ok = await api().doc.exportFile(out, d.name.replace(/\.pdf$/i, '') + ' (flattened).pdf', 'pdf')
        if (ok) get().showToast('Flattened copy saved. Annotations that were already in the file stay as annotations.')
      } catch (err) {
        get().showToast(err instanceof Error ? err.message : String(err), 'error')
      } finally {
        set({ busy: null })
      }
    },

    async exportImages() {
      if (get().busy) return
      flushEditors()
      const d = active()
      if (!d) return
      let cancelled = false
      set({ busy: { label: 'Rendering pages…', percent: 0, cancel: () => (cancelled = true) } })
      let mat: Materialized | null = null
      try {
        mat = d.readOnly ? null : await materialize(await formBytes(d), d.annotations, get().signerName || undefined)
        const pdf = mat ? mat.pdf : d.pdf
        const files: Array<{ name: string; bytes: Uint8Array }> = []
        const base = d.name.replace(/\.pdf$/i, '')
        const pad = String(pdf.numPages).length
        for (let i = 0; i < pdf.numPages; i++) {
          if (cancelled) break
          const r = await renderPage(pdf, i, 150, 'image/png')
          files.push({ name: `${base}-${String(i + 1).padStart(pad, '0')}.png`, bytes: new Uint8Array(await r.blob.arrayBuffer()) })
          set({ busy: { label: `Rendering page ${i + 1} of ${pdf.numPages}…`, percent: Math.round(((i + 1) / pdf.numPages) * 100), cancel: () => (cancelled = true) } })
        }
        if (!cancelled && files.length) {
          const n = await api().doc.exportMany(files)
          if (n) get().showToast(`Exported ${n} image${n === 1 ? '' : 's'}`)
        }
      } catch (err) {
        get().showToast(err instanceof Error ? err.message : String(err), 'error')
      } finally {
        if (mat) void mat.destroy()
        set({ busy: null })
      }
    },

    async print() {
      if (get().busy) return
      flushEditors()
      const d = active()
      if (!d) return
      let cancelled = false
      set({ busy: { label: 'Preparing to print…', percent: 0, cancel: () => (cancelled = true) } })
      let mat: Materialized | null = null
      let job: string | null = null
      try {
        mat = d.readOnly ? null : await materialize(await formBytes(d), d.annotations, get().signerName || undefined)
        const pdf = mat ? mat.pdf : d.pdf
        job = await api().print.begin()
        const dpi = chooseDpi(pdf.numPages)
        for (let i = 0; i < pdf.numPages; i++) {
          if (cancelled) break
          const r = await renderPage(pdf, i, dpi, 'image/png')
          await api().print.addPage(job, { png: new Uint8Array(await r.blob.arrayBuffer()), widthPt: r.widthPt, heightPt: r.heightPt })
          set({ busy: { label: `Preparing page ${i + 1} of ${pdf.numPages}…`, percent: Math.round(((i + 1) / pdf.numPages) * 100), cancel: () => (cancelled = true) } })
        }
        if (cancelled) {
          await api().print.cancel(job)
        } else {
          set({ busy: { label: 'Opening print dialog…' } })
          await api().print.end(job)
        }
        job = null
      } catch (err) {
        if (job) await api().print.cancel(job).catch(() => undefined)
        get().showToast(`Print failed: ${err instanceof Error ? err.message : String(err)}`, 'error')
      } finally {
        if (mat) void mat.destroy()
        set({ busy: null })
      }
    },

    async merge() {
      const files = await api().doc.importDialog('pdf', true)
      if (files.length < 1) return
      set({ busy: { label: 'Merging…' } })
      try {
        const sources = files.map((f) => f.bytes)
        const d = active()
        if (d && !d.readOnly) sources.unshift(await get().buildOutput(d))
        const bytes = await ops.mergePdfs(sources)
        await get().openFiles([{ handle: '', name: 'Merged.pdf', location: '', bytes }])
        const nd = active()
        if (nd) patchDoc(nd.id, { handle: null, dirty: true })
        syncTitle()
        get().showToast('Merged document created. Note: form fields from merged files are not carried over.')
      } catch (err) {
        get().showToast(err instanceof Error ? err.message : String(err), 'error')
      } finally {
        set({ busy: null })
      }
    },

    setTool(tool) {
      const s = get()
      const color = TOOL_DEFAULT_COLORS[tool]
      const style = color && tool !== s.tool && !['select', 'hand', 'image', 'stamp'].includes(tool) ? { ...s.style, color } : s.style
      set({ tool, style, pendingImage: tool === 'image' ? s.pendingImage : null, pendingStamp: tool === 'stamp' ? s.pendingStamp : null })
      const d = active()
      if (d && tool !== 'select' && d.selectedIds.length) patchDoc(d.id, { selectedIds: [] })
    },
    setStyle(patch) {
      set((s) => ({ style: { ...s.style, ...patch } }))
      const d = active()
      // Live-apply to selection.
      if (d && d.selectedIds.length) {
        for (const id of d.selectedIds) {
          const a = d.annotations.find((x) => x.id === id)
          if (!a) continue
          const p: Record<string, unknown> = {}
          if (patch.color !== undefined && 'color' in a) p.color = patch.color
          if (patch.fill !== undefined && 'fill' in a) p.fill = patch.fill
          if (patch.width !== undefined && 'width' in a && (a.kind === 'ink' || a.kind === 'rect' || a.kind === 'ellipse' || a.kind === 'line' || a.kind === 'arrow')) p.width = patch.width
          if (patch.opacity !== undefined && 'opacity' in a) p.opacity = patch.opacity
          if (patch.fontSize !== undefined && a.kind === 'text') p.fontSize = patch.fontSize
          if (Object.keys(p).length) get().updateAnnotation(id, p as Partial<Annotation>)
        }
      }
    },
    setPendingImage(img) {
      set({ pendingImage: img, pendingStamp: null, tool: img ? 'image' : 'select' })
    },
    setPendingStamp(stamp) {
      set({ pendingStamp: stamp, pendingImage: null, tool: stamp ? 'stamp' : 'select' })
    },

    addAnnotation(a) {
      const d = active()
      if (!d || d.readOnly) return
      patchDoc(d.id, (cur) => ({ ...pushHistory(cur), ...bump(cur), annotations: [...cur.annotations, a], selectedIds: a.kind === 'ink' || a.kind === 'highlight' || a.kind === 'underline' || a.kind === 'strikeout' ? [] : [a.id] }))
      syncTitle()
    },
    updateAnnotation(id, patch, opts = {}) {
      const d = active()
      if (!d) return
      patchDoc(d.id, (cur) => {
        const idx = cur.annotations.findIndex((x) => x.id === id)
        if (idx < 0) return {}
        const annotations = cur.annotations.slice()
        annotations[idx] = { ...annotations[idx], ...patch } as Annotation
        return { ...(opts.history === false ? {} : pushHistory(cur)), ...bump(cur), annotations }
      })
      syncTitle()
    },
    removeAnnotations(ids) {
      const d = active()
      if (!d || !ids.length) return
      const set_ = new Set(ids)
      patchDoc(d.id, (cur) => ({ ...pushHistory(cur), ...bump(cur), annotations: cur.annotations.filter((a) => !set_.has(a.id)), selectedIds: cur.selectedIds.filter((x) => !set_.has(x)) }))
      syncTitle()
    },
    select(ids) {
      const d = active()
      if (!d) return
      patchDoc(d.id, { selectedIds: ids })
    },

    async undo() {
      const d0 = active()
      if (!d0 || !d0.history.length || get().busy) return
      await withLock(d0.id, async () => {
        const d = get().docs.find((x) => x.id === d0.id)
        if (!d || !d.history.length) return
        const snap = d.history[d.history.length - 1]
        const future = [...d.future, { baseBytes: d.baseBytes, annotations: cloneAnnotations(d.annotations) }]
        const history = d.history.slice(0, -1)
        if (snap.baseBytes !== d.baseBytes) {
          set({ busy: { label: 'Undoing…' } })
          try {
            await reloadFromBytes(d.id, snap.baseBytes, snap.annotations, { history, future, ...bump(d) })
          } finally {
            set({ busy: null })
          }
        } else {
          patchDoc(d.id, { annotations: snap.annotations, history, future, ...bump(d), selectedIds: [] })
        }
      })
      syncTitle()
    },
    async redo() {
      const d0 = active()
      if (!d0 || !d0.future.length || get().busy) return
      await withLock(d0.id, async () => {
        const d = get().docs.find((x) => x.id === d0.id)
        if (!d || !d.future.length) return
        const snap = d.future[d.future.length - 1]
        const history = [...d.history, { baseBytes: d.baseBytes, annotations: cloneAnnotations(d.annotations) }]
        const future = d.future.slice(0, -1)
        if (snap.baseBytes !== d.baseBytes) {
          set({ busy: { label: 'Redoing…' } })
          try {
            await reloadFromBytes(d.id, snap.baseBytes, snap.annotations, { history, future, ...bump(d) })
          } finally {
            set({ busy: null })
          }
        } else {
          patchDoc(d.id, { annotations: snap.annotations, history, future, ...bump(d), selectedIds: [] })
        }
      })
      syncTitle()
    },

    setZoom(zoom, mode = 'custom') {
      const d = active()
      if (!d) return
      patchDoc(d.id, { zoom: Math.min(8, Math.max(0.1, zoom)), zoomMode: mode })
    },
    zoomIn() {
      const d = active()
      if (!d) return
      const next = ZOOM_STEPS.find((z) => z > d.zoom + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]
      get().setZoom(next)
    },
    zoomOut() {
      const d = active()
      if (!d) return
      const next = [...ZOOM_STEPS].reverse().find((z) => z < d.zoom - 0.001) ?? ZOOM_STEPS[0]
      get().setZoom(next)
    },
    setRotation(r) {
      const d = active()
      if (d) patchDoc(d.id, { rotation: r })
    },
    rotateView(delta) {
      const d = active()
      if (d) patchDoc(d.id, { rotation: ((((d.rotation + delta) % 360) + 360) % 360) as Rotation })
    },
    setCurrentPage(page) {
      const d = active()
      if (d && d.currentPage !== page) patchDoc(d.id, { currentPage: page })
    },
    goToPage(page) {
      const d = active()
      if (!d) return
      const p = Math.min(Math.max(page, 0), d.pages.length - 1)
      patchDoc(d.id, { currentPage: p, scrollRequest: { page: p, token: Date.now() } })
    },
    selectPages(pages) {
      const d = active()
      if (d) patchDoc(d.id, { selectedPages: pages })
    },

    rotatePages(indices, delta) {
      return runPageOp('Rotating…', (bytes, d) => ops.rotatePages(bytes, targets(indices, d), delta))
    },
    async deletePages(indices) {
      const d = active()
      if (!d) return
      const list = targets(indices, d)
      const ok = await api().doc.confirm({
        title: 'Delete pages',
        message: list.length === 1 ? `Delete page ${list[0] + 1}?` : `Delete ${list.length} pages?`,
        ok: 'Delete',
        danger: true
      })
      if (!ok) return
      await runPageOp('Deleting…', (bytes) => ops.deletePages(bytes, list))
    },
    reorderPages(order) {
      return runPageOp('Reordering…', (bytes) => ops.reorderPages(bytes, order))
    },
    insertBlank(after) {
      const d = active()
      if (!d) return Promise.resolve()
      const at = (after ?? d.currentPage) + 1
      return runPageOp('Inserting page…', (bytes) => ops.insertBlankPage(bytes, at), { currentPage: at, scrollRequest: { page: at, token: Date.now() } })
    },
    async insertFromFile(after) {
      const d = active()
      if (!d) return
      const files = await api().doc.importDialog('pdf', false)
      if (!files.length) return
      const at = (after ?? d.currentPage) + 1
      await runPageOp('Inserting pages…', (bytes) => ops.insertFromPdf(bytes, files[0].bytes, at), { currentPage: at, scrollRequest: { page: at, token: Date.now() } })
      get().showToast('Pages inserted. Form fields from the inserted file are not carried over.')
    },
    async extractPages(indices) {
      const d = active()
      if (!d || !indices.length) return
      set({ busy: { label: 'Extracting…' } })
      try {
        const src = d.readOnly ? d.baseBytes : await get().buildOutput(d)
        const out = await ops.extractPages(src, indices)
        const ok = await api().doc.exportFile(out, d.name.replace(/\.pdf$/i, '') + ' (pages).pdf', 'pdf')
        if (ok) get().showToast('Pages extracted')
      } catch (err) {
        get().showToast(err instanceof Error ? err.message : String(err), 'error')
      } finally {
        set({ busy: null })
      }
    },
    async splitDocument(every) {
      const d = active()
      if (!d || every < 1) return
      set({ busy: { label: 'Splitting…' } })
      try {
        const src = d.readOnly ? d.baseBytes : await get().buildOutput(d)
        const ranges: number[][] = []
        for (let i = 0; i < d.pages.length; i += every) ranges.push(Array.from({ length: Math.min(every, d.pages.length - i) }, (_, k) => i + k))
        const parts = await ops.splitPdf(src, ranges)
        const base = d.name.replace(/\.pdf$/i, '')
        const pad = String(parts.length).length
        const n = await api().doc.exportMany(parts.map((bytes, i) => ({ name: `${base}-part${String(i + 1).padStart(pad, '0')}.pdf`, bytes })))
        if (n) get().showToast(`Split into ${n} files`)
      } catch (err) {
        get().showToast(err instanceof Error ? err.message : String(err), 'error')
      } finally {
        set({ busy: null })
      }
    },

    setSidebar(open, tab) {
      set((s) => ({ sidebarOpen: open, sidebarTab: tab ?? s.sidebarTab }))
      void api().settings.set('sidebarOpen', open)
      if (tab) void api().settings.set('sidebarTab', tab)
    },
    setTheme(theme) {
      set({ theme })
      void api().settings.set('theme', theme)
    },
    setSignerName(name) {
      set({ signerName: name })
      void api().settings.set('signerName', name)
    },
    setDialog(d) {
      set({ dialog: d })
    },
    showToast(text, kind = 'info') {
      set({ toast: { text, kind } })
      const mine = get().toast
      setTimeout(() => {
        if (get().toast === mine) set({ toast: null })
      }, kind === 'error' ? 6000 : 3000)
    },
    setFind(patch) {
      set((s) => ({ find: { ...s.find, ...patch } }))
    },
    async runSearch() {
      const d = active()
      const { find } = get()
      searchSignal.cancelled = true
      if (!d || !find.query.trim() || !find.open) {
        set((s) => ({ find: { ...s.find, matches: [], current: -1, searching: false } }))
        return
      }
      const signal = { cancelled: false }
      searchSignal = signal
      const myQuery = find.query
      const myCase = find.caseSensitive
      const myPdf = d.pdf
      set((s) => ({ find: { ...s.find, searching: true, matches: [], current: -1 } }))
      const matches = await searchDocument(d.pdf, myQuery, { caseSensitive: myCase }, undefined, signal)
      const now = get()
      const cur = now.docs.find((x) => x.id === now.activeId)
      if (signal.cancelled || !now.find.open || now.find.query !== myQuery || now.find.caseSensitive !== myCase || cur?.pdf !== myPdf) return
      const first = matches.findIndex((m) => m.page >= d.currentPage)
      const current = matches.length ? (first >= 0 ? first : 0) : -1
      set((s) => ({ find: { ...s.find, matches, current, searching: false } }))
      if (current >= 0) get().goToPage(matches[current].page)
    },
    findNext(delta) {
      const { find } = get()
      if (!find.matches.length) return
      const current = (find.current + delta + find.matches.length) % find.matches.length
      set((s) => ({ find: { ...s.find, current } }))
      get().goToPage(find.matches[current].page)
    },
    setFullscreen(v) {
      set({ fullscreen: v })
    },
    markFormEdited(id) {
      patchDoc(id, (cur) => bump(cur))
      syncTitle()
    },
    setUpdateStatus(s) {
      set({ updateStatus: s })
    }
  }
})

export const useActiveDoc = (): Doc | null => useStore((s) => s.docs.find((d) => d.id === s.activeId) ?? null)
