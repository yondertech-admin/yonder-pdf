// test-fixtures/forms.pdf: every AcroForm field type the CLI must handle, a
// read-only field, a multi-select list box, and a bare /Sig field (signature
// guard). Regenerate with `npm run fixture:forms`.
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
const { PDFDocument, PDFName, PDFDict, PDFArray, PDFString, StandardFonts } = createRequire(new URL('../package.json', import.meta.url))('pdf-lib')

const doc = await PDFDocument.create()
const font = await doc.embedFont(StandardFonts.Helvetica)
const form = doc.getForm()
const page = doc.addPage([612, 792])
page.drawText('Yonder PDF forms fixture', { x: 60, y: 740, size: 18, font })

page.drawText('Name:', { x: 60, y: 690, size: 11, font })
form.createTextField('name').addToPage(page, { x: 140, y: 682, width: 220, height: 22 })

page.drawText('Employee id (read only):', { x: 60, y: 650, size: 11, font })
const ro = form.createTextField('employeeId')
ro.setText('E-1234')
ro.enableReadOnly()
ro.addToPage(page, { x: 220, y: 642, width: 140, height: 22 })

page.drawText('Shipping:', { x: 60, y: 610, size: 11, font })
const radio = form.createRadioGroup('shipping')
radio.addOptionToPage('ground', page, { x: 140, y: 604, width: 16, height: 16 })
radio.addOptionToPage('air', page, { x: 220, y: 604, width: 16, height: 16 })
page.drawText('ground', { x: 160, y: 608, size: 10, font })
page.drawText('air', { x: 240, y: 608, size: 10, font })

page.drawText('Toppings:', { x: 60, y: 560, size: 11, font })
const list = form.createOptionList('toppings')
list.addOptions(['cheese', 'olives', 'peppers'])
list.enableMultiselect()
list.addToPage(page, { x: 140, y: 500, width: 160, height: 60 })

page.drawText('Size:', { x: 60, y: 460, size: 11, font })
const combo = form.createDropdown('size')
combo.addOptions(['S', 'M', 'L'])
combo.select('M')
combo.addToPage(page, { x: 140, y: 452, width: 100, height: 22 })

page.drawText('Subscribe:', { x: 60, y: 420, size: 11, font })
form.createCheckBox('subscribe').addToPage(page, { x: 140, y: 414, width: 16, height: 16 })

// Signature field: pdf-lib has no helper, so build the /Sig widget by hand.
const sigWidget = doc.context.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Sig', T: PDFString.of('signer'), Rect: [140, 340, 340, 380], F: 4, P: page.ref })
const sigRef = doc.context.register(sigWidget)
page.node.set(PDFName.of('Annots'), doc.context.obj([...(page.node.Annots()?.asArray() ?? []), sigRef]))
const acro = doc.catalog.lookup(PDFName.of('AcroForm'), PDFDict)
const fieldsArr = acro.lookup(PDFName.of('Fields'), PDFArray)
fieldsArr.push(sigRef)
page.drawText('Signature:', { x: 60, y: 355, size: 11, font })
page.drawRectangle({ x: 140, y: 340, width: 200, height: 40, borderColor: { type: 'RGB', red: 0.6, green: 0.6, blue: 0.6 }, borderWidth: 0.5 })

form.updateFieldAppearances(font)
writeFileSync(new URL('../test-fixtures/forms.pdf', import.meta.url), await doc.save())
console.log('wrote test-fixtures/forms.pdf')
