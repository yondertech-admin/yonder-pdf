// test-fixtures/rotated.pdf: the same portrait page with /Rotate 0, 90, 180
// and 270, each with a "Table" label near the top-left *as displayed*. Scans
// often carry such flags; every coordinate the CLI takes must be in view space.
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
const { PDFDocument, StandardFonts, degrees, rgb } = createRequire(new URL('../package.json', import.meta.url))('pdf-lib')

const doc = await PDFDocument.create()
const font = await doc.embedFont(StandardFonts.Helvetica)
for (const rot of [0, 90, 180, 270]) {
  const page = doc.addPage([612, 792])
  page.setRotation(degrees(rot))
  page.drawText(`Rotate ${rot}`, { x: 60, y: 720, size: 20, font })
  page.drawText('Table', { x: 60, y: 680, size: 14, font })
  page.drawRectangle({ x: 60, y: 400, width: 300, height: 200, borderColor: rgb(0.3, 0.3, 0.3), borderWidth: 1 })
}
writeFileSync(new URL('../test-fixtures/rotated.pdf', import.meta.url), await doc.save())
console.log('wrote test-fixtures/rotated.pdf')
