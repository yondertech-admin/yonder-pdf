// The command registry's runtime contract (design §14.1 #1, §15 #13).
// A front-end (CLI, MCP, the app's local API) creates a CommandContext, loads
// the input document into an InputDoc, runs one or more commands against it,
// then commits. Commands never touch the file system themselves.
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { YonderError } from '../errors'
import { hasSignatureFields } from '../forms'
import * as ops from '../pageOps'
import type { Schema } from '../schema'
import { Session } from '../session'
import { ViewSpace } from '../space'
import type { Annotation } from '../types'
import { writeAnnotations, type WriteOptions } from '../writer'

export interface LoadedPdfjs {
  pdf: PDFDocumentProxy
  destroy(): Promise<void>
  encrypted: boolean
}

export type PdfjsLoader = (bytes: Uint8Array, password?: string) => Promise<LoadedPdfjs>

export interface SavedSignatureRef {
  id: string
  kind: 'signature' | 'initials'
  dataUrl: string
  width: number
  height: number
  createdAt: number
}

/**
 * One input document across a command or a batch: pdf-lib Session for
 * structure + annotations, a pdf.js proxy for text/forms, both opened lazily
 * and kept consistent (structure changes are flushed to bytes before pdf.js
 * sees them; form fills and flattening replace the bytes and reopen the
 * session). `rev` counts logical mutations, not serialisations (REVIEW-05 #14).
 */
export class InputDoc {
  private _session: Session | null = null
  private _pdfjs: LoadedPdfjs | null = null
  private spaces = new Map<number, ViewSpace>()
  private structureDirty = false
  private pendingAnnotations: Annotation[] = []
  private _encrypted: boolean | null = null
  /** Logical edit revision: bumped on every annotation, structure or form change. */
  rev = 0
  /** Set by the loader when a password was needed (pdf.js), or by pdf-lib's /Encrypt check. */
  encrypted = false
  /** Warnings collected by commands (reported at the top level of the result). */
  warnings: string[] = []

  constructor(
    private readonly loader: PdfjsLoader,
    public bytes: Uint8Array,
    public readonly password?: string,
    private readonly writeDefaults: WriteOptions = {}
  ) {}

  get annotations(): Annotation[] {
    return this._session ? this._session.annotations : this.pendingAnnotations
  }

  /** Called by commands after any mutation. */
  touch(): void {
    this.rev++
  }

  async session(): Promise<Session> {
    if (!this._session) {
      this._session = await Session.open(this.bytes, this.pendingAnnotations)
      this.pendingAnnotations = []
      this._encrypted = false
    }
    return this._session
  }

  /** True when pdf-lib sees /Encrypt (cheap check, cached). */
  async isEncrypted(): Promise<boolean> {
    if (this._encrypted === null) {
      const doc = await ops.load(this.bytes, { ignoreEncryption: true })
      this._encrypted = doc.isEncrypted
      if (this._encrypted) this.encrypted = true
    }
    return this._encrypted
  }

  /** Throws unless the document may be rewritten (§15 #8). */
  async assertEditable(): Promise<void> {
    if (await this.isEncrypted()) throw new YonderError('YP_ENCRYPTED_READ_ONLY', 'This document is encrypted; it can be read but not edited in this version')
  }

  async hasSignatures(): Promise<boolean> {
    return hasSignatureFields(await this.pdfjs())
  }

  /** Call after a page operation so pdf.js consumers see the new structure. */
  markStructureChanged(): void {
    this.structureDirty = true
    this.touch()
  }

  async pdfjs(): Promise<PDFDocumentProxy> {
    if (this.structureDirty) await this.flushStructure()
    if (!this._pdfjs) {
      this._pdfjs = await this.loader(this.bytes, this.password)
      if (this._pdfjs.encrypted) this.encrypted = true
    }
    return this._pdfjs.pdf
  }

  /** Serialise structural changes (no annotations) so bytes reflect them. */
  async flushStructure(): Promise<void> {
    if (!this._session || !this.structureDirty) return
    this.bytes = await ops.save(this._session.doc)
    this.pendingAnnotations = this._session.annotations
    this._session = null
    this.structureDirty = false
    await this.dropPdfjs()
  }

  /** Replace the underlying bytes (after a pdf.js form save); pending annotations are kept. */
  async replaceBytes(bytes: Uint8Array): Promise<void> {
    if (this._session) {
      if (this.structureDirty) throw new YonderError('YP_INTERNAL', 'Structure changes were not flushed before a form fill')
      this.pendingAnnotations = this._session.annotations
      this._session = null
    }
    this.bytes = bytes
    this.touch()
    await this.dropPdfjs()
  }

  /**
   * Bake flattening into the bytes *now*, so later operations in a batch see
   * the flattened document (REVIEW-05 #9). Flattened session annotations are
   * consumed; form fields stop existing.
   */
  async materialize(opts: { flattenAnnotations?: boolean; flattenForms?: boolean }): Promise<void> {
    await this.flushStructure()
    const annotations = this.annotations
    const bytes = await writeAnnotations(this.bytes, opts.flattenAnnotations ? annotations : [], { ...this.writeDefaults, flattenAnnotations: Boolean(opts.flattenAnnotations), flattenForms: Boolean(opts.flattenForms) })
    const keep = opts.flattenAnnotations ? [] : annotations
    this._session = null
    this.pendingAnnotations = keep
    this.bytes = bytes
    this.touch()
    await this.dropPdfjs()
  }

  async pageCount(): Promise<number> {
    if (this._session) return this._session.pageCount
    return (await this.pdfjs()).numPages
  }

  /** View ↔ user space converter for a page (0-based), from the current pdf.js proxy. */
  async viewSpace(index: number): Promise<ViewSpace> {
    const pdf = await this.pdfjs()
    const hit = this.spaces.get(index)
    if (hit) return hit
    if (!Number.isInteger(index) || index < 0 || index >= pdf.numPages) throw new YonderError('YP_PAGE_RANGE', `Page ${index + 1} does not exist (document has ${pdf.numPages} page${pdf.numPages === 1 ? '' : 's'})`)
    const page = await pdf.getPage(index + 1)
    const vs = new ViewSpace(page.getViewport({ scale: 1 }))
    this.spaces.set(index, vs)
    return vs
  }

  /** The page's own /Rotate, needed for oriented annotations (text, note, image). */
  async pageRotate(index: number): Promise<number> {
    const sess = await this.session()
    sess.assertPages([index])
    return sess.doc.getPage(index).getRotation().angle
  }

  async commit(): Promise<Uint8Array> {
    const opts = this.writeDefaults
    if (this._session) return this._session.commit(opts)
    if (this.pendingAnnotations.length) return writeAnnotations(this.bytes, this.pendingAnnotations, opts)
    return this.bytes
  }

  private async dropPdfjs(): Promise<void> {
    const p = this._pdfjs
    this._pdfjs = null
    this.spaces.clear()
    if (p) await p.destroy().catch(() => undefined)
  }

  async destroy(): Promise<void> {
    await this.dropPdfjs()
    this._session = null
  }
}

export interface CommandContext {
  /** The input document for `needsDoc` commands. */
  doc?: InputDoc
  /** Read another file the command refers to (images, PDFs to insert/merge); bounded by `kind`. */
  readFile(path: string, kind: 'pdf' | 'image' | 'json'): Promise<Uint8Array>
  loadPdfjs: PdfjsLoader
  deterministic: boolean
  now(): number
  newId(): string
  /** Written as the annotation author (/T). */
  author?: string
  /** The app's saved signatures/initials, when reachable (read-only headlessly). */
  savedSignatures?(): Promise<SavedSignatureRef[]>
}

export interface Outcome {
  result: Record<string, unknown>
  /** For `produces: 'file' | 'files'`: new documents that are not the input. */
  outputs?: Array<{ name: string; bytes: Uint8Array }>
}

export type Params = Record<string, unknown>

export interface Command<P extends Params = Params> {
  /** Dotted name, e.g. "annotate.highlight". */
  name: string
  group: string
  description: string
  /** 'headless' runs without the app; 'app' needs the running instance; 'both' either. */
  scope: 'headless' | 'app' | 'both'
  needsDoc: boolean
  /** What the command changes: nothing, the input document (commit + write), one new file, or several. */
  produces: 'none' | 'document' | 'file' | 'files'
  params: Schema
  /** Example CLI invocations (also shown to agents). */
  examples?: string[]
  run(ctx: CommandContext, params: P): Promise<Outcome>
}

export function requireDoc(ctx: CommandContext): InputDoc {
  if (!ctx.doc) throw new YonderError('YP_USAGE', 'This command needs an input document (--in <file> or --doc <id>)')
  return ctx.doc
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))
  let hex = ''
  for (const b of digest) hex += b.toString(16).padStart(2, '0')
  return hex
}
