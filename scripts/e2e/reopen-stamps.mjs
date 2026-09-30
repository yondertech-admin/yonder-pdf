// The saved file must show its stamps in the app again (now as file annotations rendered by pdf.js).
export default async ({ cdp, sleep, S }) => {
  await sleep(800)
  const info = await cdp.eval(`(async () => { const st = window.__yonderStore.getState(); const d = st.docs[0]; const out = []; for (const i of [1, 3]) { const p = await d.pdf.getPage(i); const an = await p.getAnnotations(); out.push(an.filter(a => a.subtype === 'Stamp').map(a => (a.contentsObj?.str ?? '').split('\\n')[0] + (a.hasAppearance ? '' : ' (no AP)'))) } return JSON.stringify(out) })()`)
  console.log('stamps in reopened file:', info)
  const parsed = JSON.parse(info)
  if (parsed[0].length !== 3 || parsed[1].length !== 1 || parsed.flat().some((t) => t.includes('no AP'))) throw new Error('reopened file should contain 3 + 1 stamp annotations with appearances')
  await cdp.shot(`${S}/stamp-3-reopened.png`)
}
