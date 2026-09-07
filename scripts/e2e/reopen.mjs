export default async ({ cdp, sleep, S }) => {
  await sleep(800)
  console.log('reopened:', JSON.stringify(await cdp.store('({ pages: d.pages.length, hasForms: d.hasForms, annots: d.annotations.length })')))
  await cdp.shot(`${S}/s7-reopened.png`)
  await cdp.eval(`window.__yonderStore.getState().goToPage(2)`); await sleep(1200)
  await cdp.shot(`${S}/s7-page3.png`)
  await cdp.eval(`window.__yonderStore.getState().goToPage(1)`); await sleep(1200)
  console.log('field value on reopen:', await cdp.eval(`(() => { const i = document.querySelector('.page[data-page-index="1"] .annotationLayer input[type=text]'); const c = document.querySelector('.page[data-page-index="1"] .annotationLayer input[type=checkbox]'); return i ? i.value + ' / checked=' + (c && c.checked) : 'no input' })()`))
}
