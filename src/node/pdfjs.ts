// pdf.js under Node (CLI, MCP, utility workers): the legacy build, no worker,
// packaged CMaps / standard fonts. The renderer has its own adapter
// (src/renderer/src/pdf/pdfjs.ts); both hand out the same proxy type.
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PDFDocumentProxy } from 'pdfjs-dist'

type PdfjsModule = typeof import('pdfjs-dist')

let mod: Promise<PdfjsModule> | null = null

/** Directory holding `cmaps/` and `standard_fonts/`. Packaged: next to the CLI bundle; dev: node_modules. */
export function assetDir(): string {
  const env = process.env.YONDER_PDFJS_ASSETS
  if (env) return env
  const here = dirname(fileURLToPath(import.meta.url))
  for (const candidate of [join(here, 'pdfjs'), join(here, '..', 'pdfjs'), join(here, '..', '..', 'src', 'renderer', 'public', 'pdfjs')]) {
    if (existsSync(join(candidate, 'cmaps'))) return candidate
  }
  const require = createRequire(import.meta.url)
  return resolve(dirname(require.resolve('pdfjs-dist/package.json')))
}

async function pdfjs(): Promise<PdfjsModule> {
  if (!mod) {
    const require = createRequire(import.meta.url)
    const path = require.resolve('pdfjs-dist/legacy/build/pdf.mjs')
    mod = import(/* @vite-ignore */ path) as Promise<PdfjsModule>
  }
  return mod
}

export interface NodeLoadResult {
  pdf: PDFDocumentProxy
  destroy: () => Promise<void>
  encrypted: boolean
}

export class NeedsPassword extends Error {
  constructor(public reason: 'need' | 'wrong') {
    super(reason === 'wrong' ? 'The password is incorrect' : 'This document is password protected')
  }
}

export async function loadPdfNode(bytes: Uint8Array, password?: string): Promise<NodeLoadResult> {
  const lib = await pdfjs()
  const base = assetDir()
  const task = lib.getDocument({
    data: bytes.slice(),
    password,
    cMapUrl: join(base, 'cmaps') + '/',
    cMapPacked: true,
    standardFontDataUrl: join(base, 'standard_fonts') + '/',
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    verbosity: 0
  })
  let encrypted = false
  let failure: NeedsPassword | null = null
  task.onPassword = (_update: (pw: string) => void, reason: number) => {
    encrypted = true
    failure = new NeedsPassword(reason === lib.PasswordResponses.INCORRECT_PASSWORD ? 'wrong' : 'need')
    void task.destroy()
  }
  let pdf: PDFDocumentProxy
  try {
    pdf = await task.promise
  } catch (err) {
    if (failure) throw failure
    throw err
  }
  return { pdf, destroy: () => task.destroy(), encrypted }
}
