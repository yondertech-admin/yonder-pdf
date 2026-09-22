// Document handle registry. The renderer only ever sees opaque handles; the
// mapping to real paths lives here. All disk I/O goes through this module.
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, dirname, extname } from 'node:path'
import type { OpenedFile } from '@shared/api'

const handles = new Map<string, string>() // handle -> absolute path

export const MAX_PDF_BYTES = 1024 * 1024 * 1024 // 1 GiB hard cap

export function pathForHandle(handle: string): string | undefined {
  return handles.get(handle)
}

export function registerPath(path: string): string {
  for (const [h, p] of handles) if (p === path) return h
  const handle = randomUUID()
  handles.set(handle, path)
  return handle
}

export function releaseHandle(handle: string): void {
  handles.delete(handle)
}

export function isPdfPath(path: string): boolean {
  return extname(path).toLowerCase() === '.pdf'
}

export async function readPdf(path: string): Promise<OpenedFile> {
  const stat = await fs.stat(path)
  if (!stat.isFile()) throw new Error('Not a file')
  if (stat.size > MAX_PDF_BYTES) throw new Error('File is larger than 1 GB')
  const buf = await fs.readFile(path)
  // Cheap sanity check: PDF header must appear in the first 1 KiB.
  const head = buf.subarray(0, 1024).toString('latin1')
  if (!head.includes('%PDF-')) throw new Error('This file is not a PDF')
  return {
    handle: registerPath(path),
    name: basename(path),
    location: dirname(path),
    bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  }
}

export { writeAtomic } from '@node/fs'
