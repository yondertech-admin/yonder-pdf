import { create } from 'zustand'
import type { OpenedFile, RecentEntry, Settings, UpdateStatus } from '@shared/api'
import { getOutline, loadPdf, PasswordCancelled, type OutlineNode, type PageInfo, type PDFDocumentProxy } from '@/pdf/pdfjs'
import { writeAnnotations } from '@/pdf/writer'
import * as ops from '@/pdf/pageOps'
import { searchDocument, type SearchMatch } from '@/pdf/search'
import { chooseDpi, materialize, renderPage, type Materialized } from '@/pdf/render'
import { cloneAnnotations, newId, type Annotation, type Tool, type ToolStyle } from '@/pdf/types'

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
  | { type: 'password'; reason: 'need' | 'wrong'; name: string; resolve: (pw: string | null) => void }
  | null

export interface PendingImage {
  dataUrl: string
  width: number
  height: number
  role: 'signature' | 'initials' | 'stamp' | 'image'
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

  /** Bytes with current AcroForm values folded in (pdf.js appearance generation). */
  const formBytes = async (d: Doc): Promise<Uint8Array> => {
    try {
      if (d.pdf.annotationStorage.size > 0) return await d.pdf.saveDocument()
    } catch (err) {
      console.warn('saveDocument failed, using base bytes', err)
    }
    return d.baseBytes
  }

  const reloadFromBytes = async (id: string, bytes: Uint8Array, annotations: Annotation[], extra: Partial<Doc> = {}): Promise<void> => {
    const d = get().docs.find((x) => x.id === id)
    if (!d) return
    const loaded = await loadPdf(bytes)
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
    const d = active()
    if (!d) return
    if (d.readOnly) return get().showToast('This document is read-only (password protected).', 'error')
    set({ busy: { label } })
    try {
      const bytes = await formBytes(d)
      const result = await fn(bytes, d)
      const annotations = ops.remapAnnotations(d.annotations, result.map)
      const hist = pushHistory({ ...d, baseBytes: bytes })
      await reloadFromBytes(d.id, result.bytes, annotations, { ...hist, dirty: true, ...after })
      syncTitle()
    } catch (err) {
      get().showToast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      set({ busy: null })
    }
  }

  const targets = (indices: number[] | null, d: Doc): number[] =>
    indices && indices.length ? indices : d.selectedPages.length ? d.selectedPages : [d.currentPage]

  return {
    docs: [],
    activeId: null,
    tool: 'select',
    style: { ...DEFAULT_STYLE },
    pendingImage: null,
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
      const d = get().docs.find((x) => x.id === id)
      if (!d) return true
      if (d.dirty) {
        set({ activeId: id })
        const choice = await api().doc.confirmDiscard([d.name])
        if (choice === 'cancel') return false
        if (choice === 'save') {
          const ok = await get().save()
          if (!ok) return false
        }
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
      set({ busy: { label: 'Saving…' } })
      try {
        const bytes = await formBytes(d)
        const out = await writeAnnotations(bytes, d.annotations, { author: get().signerName || undefined })
        const r = await api().doc.save(d.handle, out)
        if (!r.ok) {
          get().showToast(`Save failed: ${r.error}`, 'error')
          return false
        }
        // Clean only after the disk commit; edits made meanwhile keep it dirty (finding 9).
        const now = get().docs.find((x) => x.id === d.id)
        const unchanged = now && now.annotations === d.annotations && now.baseBytes === d.baseBytes
        patchDoc(d.id, { baseBytes: bytes, dirty: !unchanged, name: r.name })
        syncTitle()
        get().showToast('Saved')
        return true
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
      set({ busy: { label: 'Saving…' } })
      try {
        const bytes = await formBytes(d)
        const out = await writeAnnotations(bytes, d.annotations, { author: get().signerName || undefined })
        const r = await api().doc.saveAs(d.handle, out, d.name)
        if (!r.ok) {
          if (!r.cancelled) get().showToast(`Save failed: ${r.error}`, 'error')
          return false
        }
        const now = get().docs.find((x) => x.id === d.id)
        const unchanged = now && now.annotations === d.annotations && now.baseBytes === d.baseBytes
        patchDoc(d.id, { baseBytes: bytes, dirty: !unchanged, handle: r.handle, name: r.name })
        syncTitle()
        void get().refreshRecent()
        get().showToast('Saved')
        return true
      } catch (err) {
        get().showToast(`Save failed: ${err instanceof Error ? err.message : String(err)}`, 'error')
        return false
      } finally {
        set({ busy: null })
      }
    },

    async exportFlattened() {
      const d = active()
      if (!d) return
      if (d.readOnly) return get().showToast('This document is read-only.', 'error')
      set({ busy: { label: 'Flattening…' } })
      try {
        const out = await get().buildOutput(d, { flattenAnnotations: true, flattenForms: true })
        const ok = await api().doc.exportFile(out, d.name.replace(/\.pdf$/i, '') + ' (flattened).pdf', 'pdf')
        if (ok) get().showToast('Flattened copy saved')
      } catch (err) {
        get().showToast(err instanceof Error ? err.message : String(err), 'error')
      } finally {
        set({ busy: null })
      }
    },

    async exportImages() {
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
      const style = color && tool !== s.tool && !['select', 'hand', 'image'].includes(tool) ? { ...s.style, color } : s.style
      set({ tool, style, pendingImage: tool === 'image' ? s.pendingImage : null })
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
      set({ pendingImage: img, tool: img ? 'image' : 'select' })
    },

    addAnnotation(a) {
      const d = active()
      if (!d || d.readOnly) return
      patchDoc(d.id, (cur) => ({ ...pushHistory(cur), annotations: [...cur.annotations, a], dirty: true, selectedIds: a.kind === 'ink' || a.kind === 'highlight' || a.kind === 'underline' || a.kind === 'strikeout' ? [] : [a.id] }))
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
        return { ...(opts.history === false ? {} : pushHistory(cur)), annotations, dirty: true }
      })
      syncTitle()
    },
    removeAnnotations(ids) {
      const d = active()
      if (!d || !ids.length) return
      const set_ = new Set(ids)
      patchDoc(d.id, (cur) => ({ ...pushHistory(cur), annotations: cur.annotations.filter((a) => !set_.has(a.id)), selectedIds: cur.selectedIds.filter((x) => !set_.has(x)), dirty: true }))
      syncTitle()
    },
    select(ids) {
      const d = active()
      if (!d) return
      patchDoc(d.id, { selectedIds: ids })
    },

    async undo() {
      const d = active()
      if (!d || !d.history.length) return
      const snap = d.history[d.history.length - 1]
      const future = [...d.future, { baseBytes: d.baseBytes, annotations: cloneAnnotations(d.annotations) }]
      const history = d.history.slice(0, -1)
      if (snap.baseBytes !== d.baseBytes) {
        set({ busy: { label: 'Undoing…' } })
        try {
          await reloadFromBytes(d.id, snap.baseBytes, snap.annotations, { history, future, dirty: true })
        } finally {
          set({ busy: null })
        }
      } else {
        patchDoc(d.id, { annotations: snap.annotations, history, future, dirty: true, selectedIds: [] })
      }
      syncTitle()
    },
    async redo() {
      const d = active()
      if (!d || !d.future.length) return
      const snap = d.future[d.future.length - 1]
      const history = [...d.history, { baseBytes: d.baseBytes, annotations: cloneAnnotations(d.annotations) }]
      const future = d.future.slice(0, -1)
      if (snap.baseBytes !== d.baseBytes) {
        set({ busy: { label: 'Redoing…' } })
        try {
          await reloadFromBytes(d.id, snap.baseBytes, snap.annotations, { history, future, dirty: true })
        } finally {
          set({ busy: null })
        }
      } else {
        patchDoc(d.id, { annotations: snap.annotations, history, future, dirty: true, selectedIds: [] })
      }
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
      if (!d || !find.query.trim()) {
        set((s) => ({ find: { ...s.find, matches: [], current: -1, searching: false } }))
        return
      }
      const signal = { cancelled: false }
      const myQuery = find.query
      set((s) => ({ find: { ...s.find, searching: true, matches: [], current: -1 } }))
      const matches = await searchDocument(d.pdf, myQuery, { caseSensitive: find.caseSensitive }, undefined, signal)
      if (get().find.query !== myQuery || get().activeId !== d.id) return
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
    setUpdateStatus(s) {
      set({ updateStatus: s })
    }
  }
})

export const useActiveDoc = (): Doc | null => useStore((s) => s.docs.find((d) => d.id === s.activeId) ?? null)
