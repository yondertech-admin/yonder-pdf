// Shared IPC contract between main, preload and renderer.
// The renderer never sees or sends file-system paths for privileged operations;
// main hands out opaque document handles instead (design §12 / finding 21).

export type Platform = 'darwin' | 'win32' | 'linux'

export interface OpenedFile {
  /** Opaque handle owned by main; maps to a path only inside main. */
  handle: string
  /** Display name (basename). */
  name: string
  /** Display-only folder text for the UI; never sent back to main. */
  location: string
  bytes: Uint8Array
}

export interface ImportedFile {
  name: string
  bytes: Uint8Array
}

export interface RecentEntry {
  id: string
  name: string
  location: string
  openedAt: number
}

export type SaveResult = { ok: true; handle: string; name: string } | { ok: false; error: string; cancelled?: boolean }

export interface ExportFile {
  name: string
  bytes: Uint8Array
}

export interface SavedSignature {
  id: string
  kind: 'signature' | 'initials'
  /** PNG data URL, transparent background. */
  dataUrl: string
  width: number
  height: number
  createdAt: number
}

export interface Settings {
  theme: 'system' | 'light' | 'dark'
  sidebarOpen: boolean
  sidebarTab: 'thumbnails' | 'outline' | 'annotations'
  defaultZoom: 'fit-width' | 'fit-page' | 'actual'
  signerName: string
  adsConsentShown: boolean
}

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; version: string; releaseUrl: string; canInstall: boolean }
  | { state: 'downloading'; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'none' }
  | { state: 'error'; message: string }

export type MenuCommand =
  | 'file:open'
  | 'file:save'
  | 'file:saveAs'
  | 'file:close'
  | 'file:print'
  | 'file:merge'
  | 'file:exportImages'
  | 'file:flatten'
  | 'edit:undo'
  | 'edit:redo'
  | 'edit:find'
  | 'edit:selectAll'
  | 'edit:deleteSelection'
  | 'view:zoomIn'
  | 'view:zoomOut'
  | 'view:fitWidth'
  | 'view:fitPage'
  | 'view:actualSize'
  | 'view:rotateCw'
  | 'view:rotateCcw'
  | 'view:toggleSidebar'
  | 'view:thumbnails'
  | 'view:outline'
  | 'view:annotations'
  | 'view:nextPage'
  | 'view:prevPage'
  | 'view:firstPage'
  | 'view:lastPage'
  | 'view:goToPage'
  | 'view:theme:system'
  | 'view:theme:light'
  | 'view:theme:dark'
  | 'tool:select'
  | 'tool:hand'
  | 'tool:highlight'
  | 'tool:underline'
  | 'tool:strikeout'
  | 'tool:ink'
  | 'tool:rect'
  | 'tool:ellipse'
  | 'tool:line'
  | 'tool:arrow'
  | 'tool:text'
  | 'tool:note'
  | 'sign:signature'
  | 'sign:initials'
  | 'sign:date'
  | 'page:rotateCw'
  | 'page:rotateCcw'
  | 'page:delete'
  | 'page:insertBlank'
  | 'page:insertFromFile'
  | 'page:extract'
  | 'page:split'
  | 'help:shortcuts'
  | 'help:privacy'
  | 'help:about'
  | 'help:checkUpdates'

export interface PrintPage {
  png: Uint8Array
  widthPt: number
  heightPt: number
}

export interface YonderAPI {
  platform: Platform
  version: string
  isPackaged: boolean
  doc: {
    openDialog(multiple?: boolean): Promise<OpenedFile[]>
    openRecent(id: string): Promise<OpenedFile | null>
    /** Resolve a File dropped onto the window into a handle + bytes (path stays in preload/main). */
    openDropped(file: File): Promise<OpenedFile | null>
    save(handle: string, bytes: Uint8Array): Promise<SaveResult>
    saveAs(handle: string | null, bytes: Uint8Array, suggestedName: string): Promise<SaveResult>
    /** Save arbitrary bytes through a save dialog (export, extract, split single). */
    exportFile(bytes: Uint8Array, suggestedName: string, filter: 'pdf' | 'png' | 'jpeg'): Promise<boolean>
    /** Choose a folder and write several files into it. */
    exportMany(files: ExportFile[]): Promise<number>
    /** Pick files to import (merge, insert, image). Bytes only, no handles. */
    importDialog(filter: 'pdf' | 'image', multiple?: boolean): Promise<ImportedFile[]>
    recent(): Promise<RecentEntry[]>
    clearRecent(): Promise<void>
    confirmDiscard(names: string[]): Promise<'save' | 'discard' | 'cancel'>
    confirm(opts: { title: string; message: string; detail?: string; ok: string; danger?: boolean }): Promise<boolean>
    showError(title: string, message: string): Promise<void>
  }
  print: {
    begin(): Promise<string>
    addPage(job: string, page: PrintPage): Promise<void>
    end(job: string): Promise<void>
    cancel(job: string): Promise<void>
  }
  settings: {
    get(): Promise<Settings>
    set<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void>
  }
  signatures: {
    list(): Promise<SavedSignature[]>
    add(sig: Omit<SavedSignature, 'id' | 'createdAt'>): Promise<SavedSignature>
    remove(id: string): Promise<void>
  }
  shell: {
    /** Allow-listed https URLs only (app UI links). */
    openExternal(url: string): Promise<boolean>
    /** Any https URL, after a confirmation dialog (links inside PDFs). */
    openPdfLink(url: string): Promise<boolean>
  }
  update: {
    check(): Promise<void>
    install(): Promise<void>
  }
  window: {
    /** Renderer has mounted its listeners; main may now deliver queued files. */
    ready(): void
    setTitle(title: string, edited: boolean): void
    closeConfirmed(): void
    isFullScreen(): Promise<boolean>
  }
  on(channel: 'menu', cb: (command: MenuCommand) => void): () => void
  on(channel: 'open-files', cb: (files: OpenedFile[]) => void): () => void
  on(channel: 'close-request', cb: () => void): () => void
  on(channel: 'update-status', cb: (status: UpdateStatus) => void): () => void
  on(channel: 'fullscreen', cb: (isFull: boolean) => void): () => void
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  sidebarOpen: true,
  sidebarTab: 'thumbnails',
  defaultZoom: 'fit-width',
  signerName: '',
  adsConsentShown: false
}

/** Only these https hosts may be opened in the system browser from the app. */
export const EXTERNAL_URL_ALLOWLIST = [
  'yondertech.net',
  'www.yondertech.net',
  'github.com',
  'www.github.com',
  'fonts.google.com'
]

/** Ad host page lives on the main site under /yonderpdf/ad (no separate DNS needed). */
export const AD_HOST = 'https://yondertech.net'
