import { writeFileSync } from 'node:fs'
export default async ({ cdp, sleep, S }) => {
  const st = (e) => cdp.store(e)
  const call = async (e) => { await cdp.eval(`window.__yonderStore.getState().${e}`); await sleep(400) }
  // search
  await cdp.eval(`window.__yonderStore.getState().setFind({ open: true, query: 'black quartz' })`); await sleep(100)
  await call('runSearch()'); await sleep(500)
  console.log('search matches', await st('st.find.matches.length'), 'current', await st('st.find.current'), 'first rects', JSON.stringify(await st('st.find.matches[0].rects.map(r => r.width.toFixed(1) + "x" + r.height.toFixed(1))')))
  await cdp.shot(`${S}/s8-find.png`)
  await cdp.eval(`window.__yonderStore.getState().setFind({ open: false, matches: [], current: -1 })`)
  // add an annotation on page 3 (index 2) to test remapping
  await cdp.eval(`window.__yonderStore.getState().addAnnotation({ id: 'a1', page: 2, createdAt: Date.now(), kind: 'rect', rect: { x: 50, y: 50, width: 100, height: 60 }, color: '#e5484d', fill: null, width: 2, opacity: 1 })`)
  // page ops
  await call('rotatePages([0], 90)'); console.log('rotate → pages', JSON.stringify(await st('d.pages.map(p => [p.width, p.height, p.rotate])')), 'history', await st('d.history.length'))
  await call('insertBlank(0)'); console.log('insertBlank → count', await st('d.pages.length'), 'annot page', await st('d.annotations[0].page'))
  await call('reorderPages([4, 0, 1, 2, 3])'); console.log('reorder → first page rotate', await st('d.pages[0].rotate'), 'annot page', await st('d.annotations[0].page'))
  await call('undo()'); await call('undo()'); console.log('undo x2 → count', await st('d.pages.length'), 'annot page', await st('d.annotations[0].page'), 'future', await st('d.future.length'))
  await call('redo()'); console.log('redo → count', await st('d.pages.length'))
  await call('rotateView(90)'); await sleep(800); await cdp.shot(`${S}/s8-rotated.png`)
  await call('rotateView(-90)')
  // theme light + welcome look: close doc without saving is a native dialog; instead switch theme and screenshot
  await call(`setTheme('light')`); await sleep(500); await cdp.shot(`${S}/s8-light.png`)
}
