// Confirms the live ad host page loads in the sandboxed frame and signals readiness.
export default async ({ cdp, sleep, S }) => {
  let ready = false
  for (let i = 0; i < 20 && !ready; i++) {
    await sleep(500)
    ready = await cdp.eval(`(() => { const f = document.querySelector('.adslot iframe'); return !!f && getComputedStyle(f).opacity !== '0' && !document.querySelector('.adslot .house') })()`)
  }
  console.log('ad frame ready:', ready, 'src:', await cdp.eval(`document.querySelector('.adslot iframe')?.getAttribute('src')`), 'sandbox:', await cdp.eval(`document.querySelector('.adslot iframe')?.getAttribute('sandbox')`))
  await cdp.shot(`${S}/ads.png`)
  if (!ready) throw new Error('ad frame never signalled ready')
}
