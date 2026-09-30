import { writeFileSync } from 'node:fs'
// Stamps (design §17): standard preset, dynamic preset with name + date, custom text stamp saved to the
// library and reused, recolour, resize, undo/redo, rotated page, and the saved file.
export default async ({ cdp, sleep, S }) => {
  await sleep(300)
  const fail = (msg) => { throw new Error(msg) }
  const stamps = () => cdp.store(`d.annotations.filter(a => a.kind === 'stamp').map(a => ({ label: a.label, sublabel: a.sublabel ?? null, color: a.color, preset: a.preset ?? null, page: a.page, w: Math.round(a.rect.width), h: Math.round(a.rect.height), rotate: a.rotate }))`)
  const waitFor = async (expr, what) => { for (let i = 0; i < 30; i++) { if (await cdp.eval(expr)) return; await sleep(100) } fail('timed out waiting for ' + what) }
  const openDialog = async () => { await cdp.eval(`[...document.querySelectorAll('.toolbar .tbtn')].find(b => b.textContent.trim() === 'Stamp').click()`); await waitFor(`!!document.querySelector('.modal .stamp-grid')`, 'the stamp dialog') }
  const pg = await cdp.page(0)

  // 1. Standard stamp from the toolbar dialog.
  await openDialog()
  console.log('presets shown', await cdp.eval(`document.querySelectorAll('.stamp-tile[data-preset]').length`))
  await cdp.eval(`document.querySelector('.stamp-tile[data-preset="approved"]').click()`); await sleep(200)
  if ((await cdp.store('st.tool')) !== 'stamp') fail('picking a preset should arm the stamp tool')
  await cdp.mouse('mouseMoved', pg.left + pg.width * 0.7, pg.top + 140); await sleep(150)
  console.log('ghost visible', await cdp.eval(`!!document.querySelector('.ghost-stamp svg')`))
  await cdp.click(pg.left + pg.width * 0.7, pg.top + 140); await sleep(300)
  let list = await stamps()
  console.log('after preset', JSON.stringify(list), 'tool', await cdp.store('st.tool'), 'selected', await cdp.store('d.selectedIds.length'))
  if (list.length !== 1 || list[0].label !== 'APPROVED' || list[0].preset !== 'approved') fail('APPROVED stamp was not placed')
  console.log('rendered', await cdp.eval(`(() => { const e = document.querySelector('.stamp-annot'); const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height), e.querySelector('text').textContent].join(' ') })()`))
  await cdp.shot(`${S}/stamp-1-approved.png`)

  // 2. Dynamic preset: second line with the signer name and today's date.
  await cdp.eval(`window.__yonderStore.getState().setSignerName('Ada Lovelace')`)
  await openDialog()
  await cdp.eval(`document.querySelector('.stamp-tile[data-preset="received"]').click()`); await sleep(200)
  await cdp.click(pg.left + pg.width * 0.7, pg.top + 230); await sleep(300)
  list = await stamps()
  if (list.length !== 2 || !/^Ada Lovelace · /.test(list[1].sublabel ?? '')) fail('RECEIVED should carry "name · date": ' + JSON.stringify(list[1]))
  console.log('dynamic', JSON.stringify(list[1]))

  // 3. Custom text stamp, saved to the library.
  await openDialog()
  await cdp.eval(`[...document.querySelectorAll('.modal .seg button')].find(b => b.textContent.trim() === 'Custom').click()`); await sleep(200)
  await cdp.eval(`(() => { const i = document.querySelector('.stamp-custom input[type=text]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'CHECKED BY QA'); i.dispatchEvent(new Event('input', { bubbles: true })) })()`); await sleep(150)
  await cdp.eval(`document.querySelectorAll('.stamp-colors .color')[2].click()`); await sleep(100)
  console.log('preview', await cdp.eval(`document.querySelector('.stamp-preview text')?.textContent`))
  await cdp.eval(`[...document.querySelectorAll('.modal footer button')].find(b => b.textContent.trim() === 'Place').click()`); await sleep(400)
  await cdp.click(pg.left + pg.width * 0.3, pg.top + 330); await sleep(300)
  list = await stamps()
  if (list.length !== 3 || list[2].label !== 'CHECKED BY QA' || list[2].color !== '#0969da') fail('custom stamp was not placed: ' + JSON.stringify(list))
  const saved = await cdp.eval(`window.yonder.stamps.list().then(l => l.map(s => s.type === 'text' ? s.label : 'image'))`)
  console.log('library', JSON.stringify(saved))
  if (!saved.includes('CHECKED BY QA')) fail('custom stamp was not saved to the library')

  // 4. Reuse it from the library on the rotated page (index 2, /Rotate 90).
  await cdp.eval(`window.__yonderStore.getState().goToPage(2)`); await sleep(1200)
  const p3 = await cdp.page(2)
  await openDialog()
  await cdp.eval(`[...document.querySelectorAll('.modal .seg button')].find(b => b.textContent.trim() === 'Custom').click()`); await sleep(300)
  await waitFor(`!!document.querySelector('.stamp-tile.saved')`, 'the saved stamp tile')
  await cdp.eval(`document.querySelector('.stamp-tile.saved').click()`); await sleep(200)
  await cdp.click(p3.left + p3.width * 0.5, p3.top + 160); await sleep(300)
  list = await stamps()
  const onRotated = list.find((x) => x.page === 2)
  console.log('rotated page', JSON.stringify(onRotated))
  if (!onRotated || onRotated.rotate !== 90 || !(onRotated.h > onRotated.w)) fail('stamp on the /Rotate 90 page should be stored with swapped width/height')
  await cdp.shot(`${S}/stamp-2-rotated.png`)

  // 5. Recolour via the properties bar, move and resize with the mouse, then undo / redo all of it.
  const rotStamp = () => cdp.store(`(() => { const a = d.annotations.find(a => a.page === 2 && a.kind === 'stamp'); return { color: a.color, x: Math.round(a.rect.x), y: Math.round(a.rect.y), w: Math.round(a.rect.width), h: Math.round(a.rect.height) } })()`)
  const placedAt = await rotStamp()
  await cdp.eval(`[...document.querySelectorAll('.props .color')].find(b => b.title === '#e5484d')?.click()`); await sleep(200)
  if ((await rotStamp()).color !== '#e5484d') fail('recolouring through the properties bar did not change the stamp colour')
  const box = await cdp.center('.page[data-page-index="2"] .stamp-annot')
  await cdp.drag(box.x, box.y, box.x + 50, box.y + 30, 8); await sleep(300)
  const moved = await rotStamp()
  if (moved.x === placedAt.x && moved.y === placedAt.y) fail('dragging the stamp did not move it')
  if (moved.w !== placedAt.w || moved.h !== placedAt.h) fail('moving must not change the stamp size')
  // Handles are rendered in the order nw, ne, sw, se, …; take the bottom-right one.
  const handle = await cdp.eval(`(() => { const h = document.querySelectorAll('.page[data-page-index="2"] .overlay .handle')[3]; if (!h) return null; const r = h.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
  if (!handle) fail('the selected stamp shows no resize handles')
  await cdp.drag(handle.x, handle.y, handle.x + 40, handle.y + 24, 8); await sleep(300)
  const resized = await rotStamp()
  console.log('placed', JSON.stringify(placedAt), 'moved', JSON.stringify(moved), 'resized', JSON.stringify(resized))
  if (resized.w === moved.w && resized.h === moved.h) fail('dragging the corner handle did not resize the stamp')
  console.log('resized text still inside', await cdp.eval(`(() => { const e = document.querySelector('.page[data-page-index="2"] .stamp-annot'); const r = e.getBoundingClientRect(); const t = e.querySelector('text').getBoundingClientRect(); return t.left >= r.left - 1 && t.right <= r.right + 1 && t.top >= r.top - 1 && t.bottom <= r.bottom + 1 })()`))
  for (let i = 0; i < 4; i++) { await cdp.eval(`window.__yonderStore.getState().undo()`); await sleep(150) }
  const afterUndo = (await stamps()).length
  for (let i = 0; i < 4; i++) { await cdp.eval(`window.__yonderStore.getState().redo()`); await sleep(150) }
  const redone = await rotStamp()
  console.log('undo →', afterUndo, 'redo →', (await stamps()).length, JSON.stringify(redone))
  if (afterUndo !== 3 || (await stamps()).length !== 4 || redone.color !== '#e5484d' || redone.w !== resized.w) fail('undo/redo should remove and restore the stamp with its colour and size')

  // 5b. Shift-click keeps the stamp armed; Escape disarms it. (Undone afterwards so the saved file keeps four stamps.)
  await openDialog()
  await cdp.eval(`document.querySelector('.stamp-tile[data-preset="draft"]').click()`); await sleep(200)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p3.left + p3.width * 0.2, y: p3.top + 300 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p3.left + p3.width * 0.2, y: p3.top + 300, button: 'left', clickCount: 1, modifiers: 8 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p3.left + p3.width * 0.2, y: p3.top + 300, button: 'left', clickCount: 1, modifiers: 8 }); await sleep(250)
  const armed = await cdp.store('st.tool')
  await cdp.key('Escape'); await sleep(200)
  console.log('after shift-click tool', armed, '→ after Esc', await cdp.store('st.tool'), 'stamps', (await stamps()).length)
  if (armed !== 'stamp' || (await cdp.store('st.tool')) !== 'select' || (await stamps()).length !== 5) fail('shift-click should place a stamp and keep the tool armed until Esc')
  await cdp.eval(`window.__yonderStore.getState().undo()`); await sleep(200)

  // 6. Remove the library entry again and save the document for the reopen scenario.
  await cdp.eval(`window.yonder.stamps.list().then(l => Promise.all(l.map(s => window.yonder.stamps.remove(s.id))))`)
  const b64 = await cdp.eval(`(async () => { const st = window.__yonderStore.getState(); const d = st.docs[0]; const out = await st.buildOutput(d); let s = ''; for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000)); return btoa(s) })()`)
  writeFileSync(`${S}/stamped.pdf`, Buffer.from(b64, 'base64'))
  console.log('exported stamped.pdf')
}
