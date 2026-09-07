import { readFileSync } from 'node:fs'
import { PDFDocument } from 'pdf-lib'
import { deletePages, reorderPages, rotatePages } from '../../src/renderer/src/pdf/pageOps.ts'
const bytes = new Uint8Array(readFileSync(new URL('../../test-fixtures/sample.pdf', import.meta.url)))
const fields = async (b: Uint8Array) => { const d = await PDFDocument.load(b); let n = 0; try { n = d.getForm().getFields().length } catch {} return { pages: d.getPageCount(), fields: n, widgets: (Buffer.from(b).toString('latin1').match(/\/Subtype\s*\/Widget/g) ?? []).length } }
console.log('original', await fields(bytes))
const del = await deletePages(bytes, [1])
console.log('after deleting form page', await fields(del.bytes), 'map(2)→', del.map(2))
const re = await reorderPages(bytes, [3, 2, 1, 0])
const rd = await PDFDocument.load(re.bytes)
console.log('after reorder', await fields(re.bytes), 'first page rotate', rd.getPage(0).getRotation().angle, 'mediabox', rd.getPage(0).getMediaBox())
const rot = await rotatePages(re.bytes, [0], 90)
console.log('after rotate', (await PDFDocument.load(rot.bytes)).getPage(0).getRotation().angle)
const flat = await PDFDocument.load(del.bytes); flat.getForm().flatten({ updateFieldAppearances: false }); console.log('flatten after delete ok, bytes', (await flat.save()).length)
