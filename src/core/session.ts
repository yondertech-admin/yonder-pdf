// A Session is one document transaction: load once, apply any number of page
// operations and annotation edits, commit once (design §14 / §15 #13). The app
// keeps its byte-based undo history; the CLI `apply` batch and the local API
// use a Session so a batch never round-trips through bytes between steps.
import type { PDFDocument } from 'pdf-lib'
import { YonderError } from './errors'
import * as ops from './pageOps'
import { writeAnnotations, type WriteOptions } from './writer'
import { newId, type Annotation, type NewAnnotation } from './types'

export interface SessionInfo {
  pageCount: number
  pages: Array<{ width: number; height: number; rotate: number }>
}

export class Session {
  private constructor(
    public doc: PDFDocument,
    public annotations: Annotation[]
  ) {}

  static async open(bytes: Uint8Array, annotations: Annotation[] = []): Promise<Session> {
    const doc = await ops.load(bytes, { ignoreEncryption: true })
    // pdf-lib cannot re-encrypt; an encrypted document must never be rewritten as plaintext (§15 #8).
    if (doc.isEncrypted) throw new YonderError('YP_ENCRYPTED_READ_ONLY', 'This document is encrypted; it can be read but not edited in this version')
    return new Session(doc, annotations.map((a) => ({ ...a })))
  }

  get pageCount(): number {
    return this.doc.getPageCount()
  }

  info(): SessionInfo {
    const pages = this.doc.getPages().map((p) => {
      const { width, height } = p.getSize()
      return { width, height, rotate: p.getRotation().angle }
    })
    return { pageCount: pages.length, pages }
  }

  /** Throws unless every index is a page of the current document (0-based). */
  assertPages(indices: number[]): void {
    const n = this.pageCount
    for (const i of indices) if (!Number.isInteger(i) || i < 0 || i >= n) throw new Error(`Page ${i + 1} does not exist (document has ${n} page${n === 1 ? '' : 's'})`)
  }

  // ---- page operations (annotation indices are remapped in place) ----
  rotatePages(indices: number[], delta: 90 | -90 | 180): void {
    this.assertPages(indices)
    this.remap(ops.rotatePagesIn(this.doc, indices, delta))
  }
  deletePages(indices: number[]): void {
    this.assertPages(indices)
    this.remap(ops.deletePagesIn(this.doc, indices))
  }
  reorderPages(order: number[]): void {
    this.remap(ops.reorderPagesIn(this.doc, order))
  }
  insertBlankPage(at: number, size?: [number, number]): void {
    if (!Number.isInteger(at) || at < 0 || at > this.pageCount) throw new Error(`Insert position ${at} is out of range`)
    this.remap(ops.insertBlankPageIn(this.doc, at, size))
  }
  async insertFromPdf(source: Uint8Array, at: number): Promise<number> {
    if (!Number.isInteger(at) || at < 0 || at > this.pageCount) throw new Error(`Insert position ${at} is out of range`)
    const { map, inserted } = await ops.insertFromPdfIn(this.doc, source, at)
    this.remap(map)
    return inserted
  }
  private remap(map: ops.PageMap): void {
    this.annotations = ops.remapAnnotations(this.annotations, map)
  }

  // ---- annotations ----
  add(a: NewAnnotation & { id?: string; createdAt?: number }): Annotation {
    this.assertPages([a.page])
    const full = { ...a, id: a.id ?? newId(), createdAt: a.createdAt ?? Date.now() } as Annotation
    this.annotations.push(full)
    return full
  }
  update(id: string, patch: Partial<Annotation>): Annotation {
    const idx = this.annotations.findIndex((x) => x.id === id)
    if (idx < 0) throw new Error(`No annotation with id ${id}`)
    const next = { ...this.annotations[idx], ...patch } as Annotation
    this.annotations[idx] = next
    return next
  }
  remove(ids: string[]): number {
    const set = new Set(ids)
    const before = this.annotations.length
    this.annotations = this.annotations.filter((a) => !set.has(a.id))
    return before - this.annotations.length
  }

  /** Serialise the document, then write the annotation layer with the shared writer. */
  async commit(opts: WriteOptions = {}): Promise<Uint8Array> {
    const bytes = await ops.save(this.doc)
    if (!this.annotations.length && !opts.flattenForms) return bytes
    return writeAnnotations(bytes, this.annotations, opts)
  }
}
