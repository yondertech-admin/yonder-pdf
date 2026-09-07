import { createRequire } from 'node:module'
const { PDFDocument, StandardFonts, rgb, degrees } = createRequire(new URL('../package.json', import.meta.url))('pdf-lib')
import { writeFileSync } from 'node:fs'
const doc = await PDFDocument.create()
const font = await doc.embedFont(StandardFonts.Helvetica)
const bold = await doc.embedFont(StandardFonts.HelveticaBold)
const form = doc.getForm()
for (let i = 1; i <= 4; i++) {
  const page = doc.addPage([612, 792])
  page.drawText(`Yonder PDF test document — page ${i}`, { x: 60, y: 720, size: 20, font: bold })
  const lorem = 'The quick brown fox jumps over the lazy dog. Sphinx of black quartz, judge my vow. Pack my box with five dozen liquor jugs. How vexingly quick daft zebras jump!'
  let y = 680
  for (let k = 0; k < 18; k++) { page.drawText(lorem.slice(0, 90 - (k % 5) * 7), { x: 60, y, size: 11, font }); y -= 18 }
  page.drawRectangle({ x: 60, y: 120, width: 200, height: 120, borderColor: rgb(0.2,0.4,0.9), borderWidth: 1 })
  page.drawText('Signature box', { x: 70, y: 225, size: 9, font, color: rgb(0.4,0.4,0.4) })
  if (i === 2) {
    page.drawText('Full name:', { x: 60, y: 400, size: 11, font })
    const tf = form.createTextField('name'); tf.addToPage(page, { x: 140, y: 392, width: 220, height: 22 })
    page.drawText('I agree:', { x: 60, y: 360, size: 11, font })
    const cb = form.createCheckBox('agree'); cb.addToPage(page, { x: 140, y: 356, width: 16, height: 16 })
  }
  if (i === 3) page.setRotation(degrees(90))
}
form.updateFieldAppearances(font)
writeFileSync(new URL('../test-fixtures/sample.pdf', import.meta.url), await doc.save())
console.log('wrote test.pdf')
