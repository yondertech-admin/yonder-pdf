// The command registry's runtime contract (design §14.1 #1, §15 #13).
// A front-end (CLI, MCP, the app's local API) creates a CommandContext, loads
// the input document into an InputDoc, runs one or more commands against it,
// then commits. Commands never touch the file system themselves.
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { YonderError } from '../errors'
import * as ops from '../pageOps'
import type { Schema } from '../schema'
import { Session } from '../session'
import type { Annotation } from '../types'
import { writeAnnotations, type WriteOptions } from '../writer'

export interface LoadedPdfjs {
  pdf: PDFDocumentProxy
  destroy(): Promise<void>
  encrypted: boolean
}

export type PdfjsLoader = (bytes: Uint8Array, password?: string) => Promise<LoadedPdfjs>

/**
 * One input document across a command or a batch: pdf-lib Session for
 * structure + annotations, a pdf.js proxy for text/forms, both opened lazily
 * and kept consistent (structure changes are flushed to bytes before pdf.js
 * sees them; form fills replace the bytes and reopen the session).
 */
export class InputDoc {
  private _session: Session | null = null
  private _pdfjs: LoadedPdfjs | null = null
  private structureDirty = false
  private pendingAnnotations: Annotation[] = []
  /** Set by flatten commands, consumed at commit. */
  commitOptions: WriteOptions = {}
  /** Rewrites of bytes performed so far (form fills); reported as `revAfter`. */
  rev = 0
  encrypted = false

  constructor(
    private readonly loader: PdfjsLoader,
    public bytes: Uint8Array,
    public readonly password?: string
  ) {}

  get annotations(): Annotation[] {
    return this._session ? this._session.annotations : this.pendingAnnotations
  }

  async session(): Promise<Session> {
    if (!this._session) {
      try {
        this._session = await Session.open(this.bytes, this.pendingAnnotations)
      } catch (err) {
        if (err instanceof Error && /encrypted/i.test(err.message)) throw new YonderError('YP_ENCRYPTED_READ_ONLY', 'This document is encrypted; it can be read but not edited in this version')
        throw err
      }
      this.pendingAnnotations = []
    }
    return this._session
  }

  /** Call after a page operation so pdf.js consumers see the new structure. */
  markStructureChanged(): void {
    this.structureDirty = true
  }

  async pdfjs(): Promise<PDFDocumentProxy> {
    if (this.structureDirty) await this.flushStructure()
    if (!this._pdfjs) {
      this._pdfjs = await this.loader(this.bytes, this.password)
      this.encrypted = this._pdfjs.encrypted
    }
    return this._pdfjs.pdf
  }

  /** Serialise structural changes (no annotations) so bytes reflect them. */
  private async flushStructure(): Promise<void> {
    if (!this._session || !this.structureDirty) return
    this.bytes = await ops.save(this._session.doc)
    this.pendingAnnotations = this._session.annotations
    this._session = null
    this.structureDirty = false
    this.rev++
    await this.dropPdfjs()
  }

  /** Replace the underlying bytes (after a pdf.js form save); annotations are kept. */
  async replaceBytes(bytes: Uint8Array): Promise<void> {
    if (this._session) {
      if (this.structureDirty) throw new YonderError('YP_INTERNAL', 'Structure changes were not flushed before a form fill')
      this.pendingAnnotations = this._session.annotations
      this._session = null
    }
    this.bytes = bytes
    this.rev++
    await this.dropPdfjs()
  }

  async pageCount(): Promise<number> {
    if (this._session) return this._session.pageCount
    return (await this.pdfjs()).numPages
  }

  /** The page's own /Rotate, needed for oriented annotations (text, note, image). */
  async pageRotate(index: number): Promise<number> {
    const sess = await this.session()
    sess.assertPages([index])
    return sess.doc.getPage(index).getRotation().angle
  }

  async commit(): Promise<Uint8Array> {
    const opts = this.commitOptions
    if (this._session) return this._session.commit(opts)
    if (this.pendingAnnotations.length || opts.flattenForms || opts.flattenAnnotations) return writeAnnotations(this.bytes, this.pendingAnnotations, opts)
    return this.bytes
  }

  private async dropPdfjs(): Promise<void> {
    const p = this._pdfjs
    this._pdfjs = null
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
  /** Read another file the command refers to (images, PDFs to insert/merge). */
  readFile(path: string): Promise<Uint8Array>
  loadPdfjs: PdfjsLoader
  deterministic: boolean
  now(): number
  newId(): string
  /** Written as the annotation author (/T). */
  author?: string
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
