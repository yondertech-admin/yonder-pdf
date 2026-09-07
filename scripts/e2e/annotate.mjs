import { writeFileSync } from 'node:fs'
// Full annotation walk-through: markup, pen, shapes, text, note, typed signature, form fill, export, undo/redo.
export default async ({ cdp, sleep, S }) => {
  let z, pg
  const m = async () => { await sleep(250); z = await cdp.store('d.zoom'); pg = await cdp.page(0) }
  await m()
  const px = (x) => pg.left + x * z            // PDF user x -> screen
  const py = (y) => pg.top + (792 - y) * z     // PDF user y -> screen
  console.log('zoom', z, 'page', JSON.stringify(pg))
  const state = () => cdp.store(`({ n: d.annotations.length, kinds: d.annotations.map(a => a.kind), dirty: d.dirty, sel: d.selectedIds.length, tool: st.tool })`)

  // 1. Highlight: drag across text on line 1 (y≈680) with the highlight tool.
  await cdp.key('1'); await m()
  await cdp.drag(px(62), py(685), px(300), py(685))
  await sleep(300)
  console.log('after highlight', JSON.stringify(await state()))

  // 2. Pen stroke.
  await cdp.key('4'); await m()
  await cdp.drag(px(80), py(600), px(240), py(560), 20)
  await sleep(200)
  // 3. Rectangle + arrow.
  await cdp.key('5'); await m(); await cdp.drag(px(320), py(300), px(480), py(200))
  await cdp.key('8'); await m(); await cdp.drag(px(320), py(400), px(500), py(330))
  // 4. Text box: click, type, blur via Escape.
  await cdp.key('t'); await m(); await cdp.click(px(80), py(520)); await sleep(300)
  await cdp.type('Hello from Yonder PDF'); await cdp.key('Escape'); await sleep(300)
  console.log('after text', JSON.stringify(await state()), 'dialog', await cdp.store('st.dialog && st.dialog.type'))
  // 5. Sticky note: click → dialog → type → Done.
  await cdp.key('n'); await m(); console.log('tool', await cdp.store('st.tool'))
  await cdp.click(px(520), py(700)); await sleep(500)
  console.log('after note click', JSON.stringify(await state()), 'dialog', await cdp.store('st.dialog && st.dialog.type'), 'modal', await cdp.eval(`!!document.querySelector('.modal')`))
  await cdp.shot(`${S}/s3-note.png`)
  await cdp.eval(`(() => { const t = document.querySelector('.modal textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, 'A sticky note'); t.dispatchEvent(new Event('input', { bubbles: true })) })()`); await sleep(100)
  await cdp.eval(`[...document.querySelectorAll('.modal footer button')].find(b => b.textContent.trim() === 'Done')?.click()`)
  await sleep(300)
  console.log('after tools', JSON.stringify(await state()))

  // 6. Typed signature through the dialog.
  await cdp.eval(`window.__yonderStore.getState().setDialog({ type: 'signature', kind: 'signature' })`); await sleep(400)
  await cdp.eval(`[...document.querySelectorAll('.modal .seg button')].find(b => b.textContent.trim() === 'Type').click()`); await sleep(200)
  await cdp.eval(`(() => { const i = document.querySelector('.modal input[type=text]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'Aeed Puganti'); i.dispatchEvent(new Event('input', { bubbles: true })) })()`); await sleep(600)
  await cdp.eval(`[...document.querySelectorAll('.modal footer button')].find(b => b.textContent.includes('Place')).click()`); await sleep(400)
  console.log('tool now', await cdp.store('st.tool'), 'pending', await cdp.store('!!st.pendingImage'))
  await m(); await cdp.click(px(420), py(560)); await sleep(300)
  console.log('img elements', await cdp.eval(`JSON.stringify([...document.querySelectorAll('.img-annot')].map(e => { const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height), e.querySelector('img').naturalWidth] }))`))
  console.log('after signature', JSON.stringify(await state()))
  await cdp.shot(`${S}/s3-page1.png`)

  // 7. Form fill on page 2.
  await cdp.eval(`window.__yonderStore.getState().goToPage(1)`); await sleep(1200)
  const hasInput = await cdp.eval(`!!document.querySelector('.page[data-page-index="1"] .annotationLayer input[type=text]')`)
  console.log('form input rendered:', hasInput)
  if (hasInput) {
    await cdp.eval(`(() => { const i = document.querySelector('.page[data-page-index="1"] .annotationLayer input[type=text]'); i.focus(); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'Jane Doe'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); i.blur(); document.querySelector('.page[data-page-index="1"] .annotationLayer input[type=checkbox]').click() })()`); await sleep(200)
    console.log('storage size', await cdp.store('d.pdf.annotationStorage.size'), 'dirty', await cdp.store('d.dirty'))
  }
  await cdp.shot(`${S}/s3-page2.png`)

  // 8. Export bytes (what Save would write) to a file for independent verification.
  const b64 = await cdp.eval(`(async () => { const st = window.__yonderStore.getState(); const d = st.docs[0]; const out = await st.buildOutput(d); let s = ''; for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000)); return btoa(s) })()`)
  writeFileSync(`${S}/saved.pdf`, Buffer.from(b64, 'base64'))
  const flat = await cdp.eval(`(async () => { const st = window.__yonderStore.getState(); const d = st.docs[0]; const out = await st.buildOutput(d, { flattenAnnotations: true, flattenForms: true }); let s = ''; for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000)); return btoa(s) })()`)
  writeFileSync(`${S}/flat.pdf`, Buffer.from(flat, 'base64'))
  console.log('exported saved.pdf and flat.pdf')

  // 9. Undo twice, redo once.
  await cdp.eval(`window.__yonderStore.getState().undo()`); await sleep(100)
  await cdp.eval(`window.__yonderStore.getState().undo()`); await sleep(100)
  await cdp.eval(`window.__yonderStore.getState().redo()`); await sleep(100)
  console.log('after undo/redo', JSON.stringify(await state()))
}
