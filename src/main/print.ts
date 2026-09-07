// Print jobs: the renderer streams rasterized pages one at a time (bounded
// memory); main writes them to a temp folder and prints a generated HTML page
// with exact physical page sizes through a hidden window.
import { app, BrowserWindow } from 'electron'
import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { PrintPage } from '@shared/api'

interface Job {
  dir: string
  pages: Array<{ file: string; widthPt: number; heightPt: number }>
  owner: number // webContents id
}

const jobs = new Map<string, Job>()
const MAX_PAGES = 5000
const MAX_PAGE_PNG = 40 * 1024 * 1024

export async function beginJob(ownerId: number): Promise<string> {
  const id = randomUUID()
  const dir = join(app.getPath('temp'), `yonder-print-${id}`)
  await fs.mkdir(dir, { recursive: true })
  jobs.set(id, { dir, pages: [], owner: ownerId })
  return id
}

function getJob(id: string, ownerId: number): Job {
  const job = jobs.get(id)
  if (!job || job.owner !== ownerId) throw new Error('Unknown print job')
  return job
}

export async function addPage(id: string, ownerId: number, page: PrintPage): Promise<void> {
  const job = getJob(id, ownerId)
  if (job.pages.length >= MAX_PAGES) throw new Error('Too many pages')
  if (!(page.png instanceof Uint8Array) || page.png.byteLength > MAX_PAGE_PNG) throw new Error('Invalid page image')
  if (!(page.widthPt > 0 && page.heightPt > 0 && page.widthPt < 20000 && page.heightPt < 20000)) {
    throw new Error('Invalid page size')
  }
  const file = join(job.dir, `p${job.pages.length}.png`)
  await fs.writeFile(file, page.png)
  job.pages.push({ file, widthPt: page.widthPt, heightPt: page.heightPt })
}

export async function cancelJob(id: string, ownerId: number): Promise<void> {
  const job = jobs.get(id)
  if (!job || job.owner !== ownerId) return
  jobs.delete(id)
  await fs.rm(job.dir, { recursive: true, force: true })
}

export async function endJob(id: string, ownerId: number, parent: BrowserWindow | null): Promise<void> {
  const job = getJob(id, ownerId)
  try {
    await runJob(job, parent)
  } finally {
    jobs.delete(id)
    await fs.rm(job.dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Remove every job owned by a renderer that went away. */
export async function cleanupOwner(ownerId: number): Promise<void> {
  for (const [id, job] of jobs) {
    if (job.owner !== ownerId) continue
    jobs.delete(id)
    await fs.rm(job.dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function runJob(job: Job, parent: BrowserWindow | null): Promise<void> {
  if (job.pages.length === 0) return

  // Named @page rules so mixed page sizes print at their real dimensions.
  const sizes = new Map<string, number>()
  let css = 'html,body{margin:0;padding:0}img{display:block}'
  let body = ''
  for (const p of job.pages) {
    const key = `${p.widthPt.toFixed(2)}x${p.heightPt.toFixed(2)}`
    if (!sizes.has(key)) {
      const n = sizes.size
      sizes.set(key, n)
      css += `@page s${n}{size:${p.widthPt}pt ${p.heightPt}pt;margin:0}.s${n}{page:s${n};width:${p.widthPt}pt;height:${p.heightPt}pt;break-after:page;overflow:hidden}`
    }
    const cls = `s${sizes.get(key)}`
    body += `<div class="${cls}"><img src="./${encodeURIComponent(basename(p.file))}" style="width:${p.widthPt}pt;height:${p.heightPt}pt"></div>`
  }
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Print</title><style>${css}</style></head><body>${body}</body></html>`
  const htmlPath = join(job.dir, 'print.html')
  await fs.writeFile(htmlPath, html, 'utf8')

  const win = new BrowserWindow({
    show: false,
    parent: parent ?? undefined,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  try {
    await win.loadFile(htmlPath)
    // Every image must decode; a failure would print blank pages.
    const decoded = (await win.webContents.executeJavaScript(
      'Promise.all([...document.images].map(i => i.decode().then(() => true, () => false))).then(r => r.every(Boolean))'
    )) as boolean
    if (!decoded) throw new Error('A page image could not be decoded')
    await new Promise<void>((resolve, reject) => {
      win.webContents.print({ silent: false, printBackground: true }, (ok, reason) => {
        if (!ok && reason && reason !== 'cancelled' && reason !== 'Print job canceled') reject(new Error(reason))
        else resolve()
      })
    })
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

export async function cleanupAll(): Promise<void> {
  for (const [id, job] of jobs) {
    jobs.delete(id)
    await fs.rm(job.dir, { recursive: true, force: true }).catch(() => undefined)
  }
}
