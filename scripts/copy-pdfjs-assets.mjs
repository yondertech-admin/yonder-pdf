// Copies pdf.js runtime assets (CMaps, standard fonts, wasm, ICC) into the
// renderer public dir so they are served in dev and packaged in production.
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = resolve(root, 'node_modules/pdfjs-dist')
const dest = resolve(root, 'src/renderer/public/pdfjs')
rmSync(dest, { recursive: true, force: true })
mkdirSync(dest, { recursive: true })
for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  cpSync(resolve(src, dir), resolve(dest, dir), { recursive: true })
}
cpSync(resolve(src, 'web/images'), resolve(dest, 'images'), { recursive: true })
console.log('pdf.js assets copied to', dest)
