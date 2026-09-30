// Golden tests for the headless CLI and the MCP server (design §14.6). Runs
// the built bundle (npm run build:cli) against test-fixtures/sample.pdf and
// inspects outputs with pdf-lib / pdf.js instead of comparing bytes.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { PDFDocument, PDFName } from 'pdf-lib'

const root = new URL('../../', import.meta.url)
const CLI = new URL('out/cli/index.mjs', root).pathname
const FIX = new URL('test-fixtures/sample.pdf', root).pathname
const FORMS = new URL('test-fixtures/forms.pdf', root).pathname
const ROT = new URL('test-fixtures/rotated.pdf', root).pathname
const T = realpathSync(mkdtempSync(join(tmpdir(), 'yonder-cli-')))
let failures = 0
const wide = join(T, 'wide.png')
// 4×2 transparent PNG (2:1)
writeFileSync(wide, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAYAAAB/qH1jAAAAEUlEQVQIW2NkYGD4z8DAwAAABAABGqvLQwAAAABJRU5ErkJggg==', 'base64'))
const check = (cond: unknown, msg: string): void => {
  if (cond) console.log('  ok  ', msg)
  else {
    failures++
    console.log('  FAIL', msg)
  }
}
interface Run { code: number; out: Record<string, any>; err: Record<string, any> | null }
function cli(...args: string[]): Run {
  const r = spawnSync('node', [CLI, ...args, '--json'], { encoding: 'utf8', env: { ...process.env, YONDER_DETERMINISTIC: '1' } })
  let out: Record<string, any> = {}
  let err: Record<string, any> | null = null
  try { out = r.stdout.trim() ? JSON.parse(r.stdout) : {} } catch { out = { raw: r.stdout } }
  try { err = r.stderr.trim() ? JSON.parse(r.stderr) : null } catch { err = { raw: r.stderr } }
  return { code: r.status ?? -1, out, err }
}
const load = (p: string) => PDFDocument.load(readFileSync(p), { updateMetadata: false })
const subtypes = async (p: string, page: number): Promise<string[]> => {
  const d = await load(p)
  const annots = d.getPage(page).node.Annots()
  const out: string[] = []
  for (let i = 0; annots && i < annots.size(); i++) {
    const dict = d.context.lookup(annots.get(i)) as any
    const st = dict?.get?.(PDFName.of('Subtype'))
    if (st) out.push(st.toString())
  }
  return out
}

console.log('CLI: read commands')
{
  const r = cli('info', '--in', FIX)
  check(r.code === 0 && r.out.result.pageCount === 4, 'info reports 4 pages')
  check(r.out.result.pages[2].rotate === 90 && r.out.result.pages[2].width === 792, 'info reports the rotated page as landscape')
  check(r.out.result.capabilities.hasForms === true && r.out.result.fieldCount === 2, 'info sees the AcroForm')
  const f = cli('find', 'Signature box', '--in', FIX)
  check(f.code === 0 && f.out.result.total === 4 && f.out.result.matches[0].quads[0].length === 8, 'find returns one quad per page for "Signature box"')
  const amb = cli('annotate.highlight', '--in', FIX, '--out', join(T, 'x.pdf'), '--text', 'quick brown')
  check(amb.code === 2 && amb.err?.error.code === 'YP_AMBIGUOUS_ANCHOR' && amb.err.error.details.matches.length > 1, 'ambiguous anchor is refused with candidates')
  const t = cli('text', '--in', FIX, '--page', '2')
  check(t.code === 0 && /Full name:/.test(t.out.result.pages[0].text), 'text extracts page 2')
  const fields = cli('forms.fields', '--in', FIX)
  check(fields.code === 0 && fields.out.result.fields.map((x: any) => x.type).join() === 'text,checkbox' && fields.out.result.fields[1].exportValue === 'Yes', 'forms.fields lists text + checkbox with export value')
}

console.log('CLI: annotations')
{
  const h = join(T, 'h.pdf')
  const r = cli('annotate.highlight', '--in', FIX, '--out', h, '--text', 'Signature box', '--page', '1')
  check(r.code === 0 && r.out.result.created === 'a0001' && r.out.outputs?.[0]?.path === h && r.out.created[0] === 'a0001', 'highlight by anchor writes the output (deterministic id, top-level created)')
  check((await subtypes(h, 0)).includes('/Highlight'), 'output has a /Highlight annotation on page 1')
  const d = await load(h)
  const annots = d.getPage(0).node.Annots()!
  const dict = d.context.lookup(annots.get(0)) as any
  check(dict.get(PDFName.of('AP')) !== undefined && dict.get(PDFName.of('QuadPoints')) !== undefined, 'highlight carries /AP and /QuadPoints')
  const t = cli('annotate.text', '--in', h, '--out', join(T, 't.pdf'), '--page', '1', '--at', '72,300', '--content', 'Hello')
  check(t.code === 0 && (await subtypes(join(T, 't.pdf'), 0)).sort().join() === '/FreeText,/Highlight', 'text box added on top of a previous CLI output (re-apply does not duplicate)')
  const n = cli('annotate.note', '--in', FIX, '--out', join(T, 'n.pdf'), '--text', 'I agree:', '--content', 'check this')
  check(n.code === 0 && n.out.result.page === 2 && (await subtypes(join(T, 'n.pdf'), 1)).includes('/Text'), 'note anchored to text lands on page 2 as /Text')
  const dr = cli('annotate.date', '--in', FIX, '--out', join(T, 'dry.pdf'), '--page', '1', '--dry-run')
  check(dr.code === 0 && dr.out.dryRun === true && dr.out.outputs.length === 0 && !existsSync(join(T, 'dry.pdf')), 'dry run writes nothing (checked on disk)')
  const same = cli('annotate.date', '--in', FIX, '--out', FIX, '--page', '1')
  check(same.code === 4 && same.err?.error.code === 'YP_SAME_FILE', '--out equal to --in is refused (exit 4)')
  const exists = cli('annotate.date', '--in', FIX, '--out', h, '--page', '1')
  check(exists.code === 4 && exists.err?.error.code === 'YP_OUTPUT_EXISTS', 'existing output is refused without --overwrite')
  const bad = cli('annotate.rect', '--in', FIX, '--out', join(T, 'bad.pdf'), '--page', '1', '--rect', '10,10,-5,5')
  check(bad.code === 2 && bad.err?.error.code === 'YP_INVALID_INPUT', 'negative rect size is rejected before writing')
  const png = join(T, 'sig.png')
  writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVQIW2NkYGD4DwABBAEAX+XLxQAAAABJRU5ErkJggg==', 'base64'))
  const sg = cli('annotate.sign', '--in', FIX, '--out', join(T, 's.pdf'), '--image', png, '--page', '1', '--at', '80,130')
  check(sg.code === 0 && sg.out.result.image.width === 2 && sg.out.result.bounds.width === 160, 'sign places a PNG at the default signature width')
  const flat = await load(join(T, 's.pdf'))
  check(!(flat.getPage(0).node.Annots()?.size()), 'signature image is flattened into the page (no annotation object)')
}

console.log('CLI: pages and forms')
{
  const rot = cli('pages.rotate', '--in', FIX, '--out', join(T, 'rot.pdf'), '--pages', '1', '--by', '90')
  check(rot.code === 0 && (await load(join(T, 'rot.pdf'))).getPage(0).getRotation().angle === 90, 'rotate sets /Rotate 90 on page 1')
  const del = cli('pages.delete', '--in', FIX, '--out', join(T, 'del.pdf'), '--pages', '2')
  const dd = await load(join(T, 'del.pdf'))
  check(del.code === 0 && dd.getPageCount() === 3 && dd.getForm().getFields().length === 0, 'deleting the form page drops its fields')
  const re = cli('pages.reorder', '--in', FIX, '--out', join(T, 're.pdf'), '--order', '4,3,2,1')
  check(re.code === 0 && (await load(join(T, 're.pdf'))).getPage(1).getRotation().angle === 90, 'reorder moves the rotated page to position 2')
  const badOrder = cli('pages.reorder', '--in', FIX, '--out', join(T, 're2.pdf'), '--order', '1,2,3')
  check(badOrder.code === 2, 'incomplete order is rejected')
  const sp = cli('pages.split', '--in', FIX, '--out-dir', join(T, 'parts'), '--every', '3')
  check(sp.code === 0 && sp.out.outputs.length === 2 && (await load(sp.out.outputs[1].path)).getPageCount() === 1 && sp.out.warnings.includes('forms-dropped'), 'split every 3 pages gives 3 + 1 and warns about dropped forms')
  const mg = cli('pages.merge', '--files', FIX, sp.out.outputs[1].path, '--out', join(T, 'm.pdf'))
  check(mg.code === 0 && (await load(join(T, 'm.pdf'))).getPageCount() === 5, 'merge concatenates')
  const ins = cli('pages.insert-blank', '--in', FIX, '--out', join(T, 'ib.pdf'), '--after', '0')
  check(ins.code === 0 && (await load(join(T, 'ib.pdf'))).getPageCount() === 5, 'insert-blank at the beginning')
  const fill = cli('forms.fill', '--in', FIX, '--out', join(T, 'f.pdf'), '--set', 'name=Ada Lovelace', '--set', 'agree=true')
  const fd = await load(join(T, 'f.pdf'))
  check(fill.code === 0 && fd.getForm().getTextField('name').getText() === 'Ada Lovelace' && fd.getForm().getCheckBox('agree').isChecked(), 'fill sets text and checkbox through pdf.js')
  const unknown = cli('forms.fill', '--in', FIX, '--out', join(T, 'f2.pdf'), '--set', 'nope=1')
  check(unknown.code !== 0 && unknown.err?.error.code === 'YP_NOT_FOUND' && /Known fields: name, agree/.test(unknown.err.error.hint), 'unknown field name lists the known ones')
  const fl = cli('export.flatten', '--in', join(T, 'f.pdf'), '--out', join(T, 'flat.pdf'))
  const fld = await load(join(T, 'flat.pdf'))
  check(fl.code === 0 && fld.getForm().getFields().length === 0, 'flatten removes the fields')
}

console.log('CLI: batch apply')
{
  const ops = JSON.stringify([
    { command: 'annotate.highlight', params: { text: 'Signature box', page: 1 } },
    { command: 'annotations.update', params: { id: '$0.created', color: '#00ff00' } },
    { command: 'forms.fill', params: { set: ['name=Batch'] } },
    { command: 'pages.rotate', params: { pages: '1', by: 90 } },
    { command: 'annotate.note', params: { page: 1, at: '100,100', content: 'after rotate' } },
    { command: 'pages.delete', params: { pages: '4' } }
  ])
  const b = cli('apply', '--in', FIX, '--out', join(T, 'b.pdf'), '--ops', ops)
  check(b.code === 0 && b.out.result.ops.length === 6 && b.out.result.ops[1].updated === 'a0001', 'apply runs six ops with a $ref to the first result')
  const bd = await load(join(T, 'b.pdf'))
  check(bd.getPageCount() === 3 && bd.getPage(0).getRotation().angle === 90 && bd.getForm().getTextField('name').getText() === 'Batch', 'batch output has the rotation, the fill and the deletion')
  const st = await subtypes(join(T, 'b.pdf'), 0)
  check(st.includes('/Highlight') && st.includes('/Text'), 'batch output keeps annotations added before and after structural ops')
  const fail = cli('apply', '--in', FIX, '--out', join(T, 'b2.pdf'), '--ops', JSON.stringify([{ command: 'annotate.highlight', params: { text: 'Signature box', page: 1 } }, { command: 'pages.delete', params: { pages: '9' } }]))
  check(fail.code === 2 && fail.err?.error.details.failedIndex === 1 && !existsSync(join(T, 'b2.pdf')), 'a failing op aborts the batch and reports its index; nothing written')
  const l = cli('annotations.list', '--in', join(T, 'b.pdf'))
  check(l.code === 0 && l.out.result.file.length === 2 && l.out.result.file.every((a: any) => a.editable === false), 'annotations.list shows file annotations as read-only')
}

console.log('CLI: review-05 paths — forms fixture, guards, rotation, ordering, options')
{
  const fl = cli('forms.fields', '--in', FORMS)
  const byName = Object.fromEntries(fl.out.result.fields.map((f: any) => [f.name + (f.exportValue ? ':' + f.exportValue : ''), f]))
  check(fl.code === 0 && byName['employeeId'].readOnly === true && byName['toppings'].multiSelect === true && byName['shipping:air'].type === 'radio', 'fields reports read-only, multi-select and radio export values')
  const guard = cli('forms.fill', '--in', FORMS, '--out', join(T, 'g.pdf'), '--set', 'name=Ada')
  check(guard.code === 1 && guard.err?.error.code === 'YP_SIGNATURES_PRESENT' && !existsSync(join(T, 'g.pdf')), 'rewriting a document with a signature field is refused without acknowledgement')
  const ok = cli('forms.fill', '--in', FORMS, '--out', join(T, 'g.pdf'), '--acknowledge-signature-invalidation', '--set', 'name=Ada', '--set', 'shipping=air', '--set', 'toppings=cheese', '--set', 'toppings=peppers', '--set', 'size=L', '--set', 'subscribe=Yes')
  const gd = await load(join(T, 'g.pdf'))
  check(ok.code === 0 && gd.getForm().getRadioGroup('shipping').getSelected() === 'air' && gd.getForm().getDropdown('size').getSelected()[0] === 'L' && gd.getForm().getCheckBox('subscribe').isChecked(), 'radio, combo, checkbox (by export value) and text fill through pdf.js')
  check(gd.getForm().getOptionList('toppings').getSelected().sort().join() === 'cheese,peppers', 'multi-select list box takes several values')
  const ro = cli('forms.fill', '--in', FORMS, '--out', join(T, 'ro.pdf'), '--acknowledge-signature-invalidation', '--set', 'employeeId=X')
  check(ro.code === 1 && ro.err?.error.code === 'YP_UNSUPPORTED', 'read-only field is refused')
  const badOpt = cli('forms.fill', '--in', FORMS, '--out', join(T, 'bo.pdf'), '--acknowledge-signature-invalidation', '--set', 'size=XL')
  check(badOpt.code === 2 && /Options: S, M, L/.test(badOpt.err?.error.hint ?? ''), 'unknown combo option lists the options and writes nothing')
  const badCb = cli('forms.fill', '--in', FORMS, '--out', join(T, 'bc.pdf'), '--acknowledge-signature-invalidation', '--set', 'subscribe=maybe')
  check(badCb.code === 2 && badCb.err?.error.code === 'YP_INVALID_INPUT', 'checkbox typo is rejected instead of silently unchecking')
  writeFileSync(join(T, 'vals.json'), JSON.stringify({ name: 'From file', subscribe: true }))
  const vf = cli('forms.fill', '--in', FORMS, '--out', join(T, 'vf.pdf'), '--acknowledge-signature-invalidation', '--values-file', join(T, 'vals.json'))
  check(vf.code === 0 && (await load(join(T, 'vf.pdf'))).getForm().getTextField('name').getText() === 'From file', '--values-file fills from JSON')

  // Rotated page: coordinates are view space; the stored user-space box is swapped (REVIEW-05 #7, Adara scans).
  const rot = cli('annotate.text', '--in', FIX, '--out', join(T, 'rot-text.pdf'), '--page', '3', '--at', '100,100', '--content', 'Landscape')
  const rotDict = (await load(join(T, 'rot-text.pdf'))).getPage(2)
  const rotRect = (rotDict.node.Annots() && ((await load(join(T, 'rot-text.pdf'))).context.lookup(rotDict.node.Annots()!.get(0)) as any).get(PDFName.of('Rect')).asArray().map((n: any) => n.asNumber())) as number[]
  check(rot.code === 0 && rot.out.result.bounds.width === 180 && rot.out.result.bounds.height === 20.4 && +Math.abs(rotRect[2] - rotRect[0]).toFixed(1) === 20.4 && +Math.abs(rotRect[3] - rotRect[1]).toFixed(1) === 180, 'text box on a /Rotate 90 page: view bounds 180×20.4, stored /Rect 20.4×180')
  const rot2 = cli('annotate.text', '--in', FIX, '--out', join(T, 'rot-text2.pdf'), '--page', '1', '--at', '100,100', '--content', 'Portrait')
  check(rot2.code === 0 && rot2.out.result.bounds.width === 180 && rot2.out.result.bounds.height === 20.4, 'same box on an unrotated page keeps display size')

  // Flatten applies at its point in a batch (REVIEW-05 #9).
  const ordered = cli('apply', '--in', FIX, '--out', join(T, 'ord.pdf'), '--ops', JSON.stringify([
    { command: 'annotate.highlight', params: { text: 'Signature box', page: 1 } },
    { command: 'export.flatten', params: { forms: false } },
    { command: 'annotate.note', params: { page: 1, at: '100,100', content: 'after flatten' } },
    { command: 'forms.flatten', params: {} },
    { command: 'forms.fields', params: {} }
  ]))
  const od = await subtypes(join(T, 'ord.pdf'), 0)
  check(ordered.code === 0 && !od.includes('/Highlight') && od.includes('/Text') && ordered.out.result.ops[4].fields.length === 0, 'annotations before a flatten are baked in, later ones stay; forms.flatten hides fields from later ops')
  check((await load(join(T, 'ord.pdf'))).getForm().getFields().length === 0, 'flattened output has no fields')

  // Options and contracts.
  const dryStr = cli('annotate.date', '--in', FIX, '--out', join(T, 'dry2.pdf'), '--page', '1', '--dry-run=true')
  check(dryStr.code === 0 && dryStr.out.dryRun === true && !existsSync(join(T, 'dry2.pdf')), '--dry-run=true is a real dry run')
  const dryBad = cli('annotate.date', '--in', FIX, '--out', join(T, 'dry3.pdf'), '--page', '1', '--dry-run=maybe')
  check(dryBad.code === 2 && !existsSync(join(T, 'dry3.pdf')), 'a non-boolean global flag is a usage error')
  const au = cli('annotate.note', '--in', FIX, '--out', join(T, 'au.pdf'), '--page', '1', '--at', '100,100', '--content', 'x', '--author', 'Ada Lovelace')
  const aud = await load(join(T, 'au.pdf'))
  const noteDict = aud.context.lookup(aud.getPage(0).node.Annots()!.get(0)) as any
  check(au.code === 0 && noteDict.get(PDFName.of('T')).decodeText() === 'Ada Lovelace', '--author is written as the annotation /T')
  const surplus = cli('info', '--in', FIX, 'extra.pdf')
  check(surplus.code === 2 && /Unexpected argument/.test(surplus.err?.error.message ?? ''), 'a surplus positional argument is rejected')
  const badRef = cli('apply', '--in', FIX, '--out', join(T, 'br.pdf'), '--ops', JSON.stringify([{ command: 'annotate.note', params: { page: 1, at: '1,1', content: '$3.created' } }]))
  check(badRef.code === 2 && badRef.err?.error.details.failedIndex === 0, 'an invalid $ref is attributed to its op')
  const st = cli('status')
  check(st.code === 0 && st.out.app.running === false, 'status reports the app as not reachable')
  const ver = cli('--version')
  check(ver.code === 0 && typeof ver.out.version === 'string', '--version prints the version')
  const up = cli('apply', '--in', FIX, '--out', join(T, 'up.pdf'), '--ops', JSON.stringify([{ command: 'annotate.rect', params: { page: 1, rect: '10,10,50,50' } }, { command: 'annotations.update', params: { id: '$0.created', color: 'garbage' } }]))
  check(up.code === 2 && up.err?.error.details.failedIndex === 1 && !existsSync(join(T, 'up.pdf')), 'annotations.update validates colours like creation does')
  const quadsArr = cli('annotate.underline', '--in', FIX, '--out', join(T, 'qa.pdf'), '--page', '1', '--quads', JSON.stringify([[60, 700, 200, 700, 60, 688, 200, 688]]))
  check(quadsArr.code === 0 && (await subtypes(join(T, 'qa.pdf'), 0)).includes('/Underline'), 'quads accept the array form from find')
  const strokeW = cli('annotate.rect', '--in', FIX, '--out', join(T, 'sw.pdf'), '--text', 'Signature box', '--page', '1', '--width', '3')
  check(strokeW.code === 0 && strokeW.out.result.bounds.width < 70, 'stroke --width does not change anchored rect sizing')
}

console.log('CLI: review-06 paths')
{
  const ms = cli('forms.fill', '--in', FORMS, '--out', join(T, 'ms.pdf'), '--acknowledge-signature-invalidation', '--set', 'toppings=olives', '--set', 'toppings=peppers')
  const back = cli('forms.fields', '--in', join(T, 'ms.pdf'))
  const toppings = back.out.result.fields.find((f: any) => f.name === 'toppings')
  check(ms.code === 0 && Array.isArray(toppings.value) && toppings.value.sort().join() === 'olives,peppers', 'multi-select list box reads back every selected value')
  const ri = cli('annotate.image', '--in', FIX, '--out', join(T, 'ri.pdf'), '--page', '3', '--at', '100,100', '--image', wide)
  check(ri.code === 0 && ri.out.result.bounds.width === 200 && ri.out.result.bounds.height === 100, 'a 2:1 image on a /Rotate 90 page reports a 2:1 view box')
  const ra = cli('annotate.image', '--in', FIX, '--out', join(T, 'ra.pdf'), '--page', '3', '--text', 'Signature box', '--align', 'on', '--image', wide)
  check(ra.code === 0 && ra.out.result.bounds.width > ra.out.result.bounds.height, 'anchored "on" image keeps display aspect on a rotated page')
  const bad = join(T, 'bad.png')
  writeFileSync(bad, Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAYAAAB/qH1j', 'base64'), Buffer.from('garbage-garbage-garbage')]))
  const corrupt = cli('apply', '--in', FIX, '--out', join(T, 'corrupt.pdf'), '--ops', JSON.stringify([{ command: 'annotate.note', params: { page: 1, at: '1,1', content: 'x' } }, { command: 'annotate.image', params: { page: 1, at: '10,10', image: bad } }]))
  check(corrupt.code === 2 && corrupt.err?.error.details.failedIndex === 1 && !existsSync(join(T, 'corrupt.pdf')), 'a corrupt image fails in its own op, not at commit')
  const ex = cli('pages.extract', '--in', FIX, '--out', join(T, 'det.pdf'), '--pages', '1', '--deterministic')
  const exd = await load(join(T, 'det.pdf'))
  check(ex.code === 0 && exd.getModificationDate()?.getUTCFullYear() === 2026 && exd.getModificationDate()?.getUTCMonth() === 0, 'deterministic extract fixes the new document dates')
  const hf = cli('info', '--in', FIX, '--help=false')
  check(hf.code === 0 && hf.out.ok === true, '--help=false does not show help')
  const vb = cli('info', '--in', FIX, '--overwrite=sometimes')
  check(vb.code === 2 && vb.err?.error.code === 'YP_USAGE', 'an invalid meta boolean is a structured usage error')
  const outDir = join(T, 'rel-parts')
  const sp = cli('pages.split', '--in', FIX, '--out-dir', outDir, '--every', '2')
  check(sp.code === 0 && sp.out.outputs.every((o: any) => o.path.startsWith(realpathSync(T))), 'split reports canonical output paths')
}

console.log('CLI: view-space coordinates on /Rotate 0/90/180/270 pages (rotated.pdf)')
{
  // Independent check: convert the stored user-space /Rect back to view space with pdf.js itself.
  const pdfjs = await import(createRequire(import.meta.url).resolve('pdfjs-dist/legacy/build/pdf.mjs'))
  const viewRect = async (file: string, pageIndex: number): Promise<{ x: number; y: number; width: number; height: number; rotate: number }> => {
    const d = await load(file)
    const dict = d.context.lookup(d.getPage(pageIndex).node.Annots()!.get(0)) as any
    const [x0, y0, x1, y1] = dict.get(PDFName.of('Rect')).asArray().map((n: any) => n.asNumber())
    const task = pdfjs.getDocument({ data: new Uint8Array(readFileSync(file)), verbosity: 0, useSystemFonts: false })
    const doc = await task.promise
    const page = await doc.getPage(pageIndex + 1)
    const vp = page.getViewport({ scale: 1 })
    const [ax, ay] = vp.convertToViewportPoint(x0, y0)
    const [bx, by] = vp.convertToViewportPoint(x1, y1)
    await task.destroy()
    const top = Math.min(ay, by), bottom = Math.max(ay, by)
    return { x: +Math.min(ax, bx).toFixed(2), y: +(vp.height - bottom).toFixed(2), width: +Math.abs(bx - ax).toFixed(2), height: +Math.abs(bottom - top).toFixed(2), rotate: page.rotate }
  }
  for (const pageNo of [1, 2, 3, 4]) {
    const out = join(T, `rot${pageNo}.pdf`)
    // FreeText boxes are stored without stroke padding, so the /Rect can be compared exactly.
    const r = cli('annotate.text', '--in', ROT, '--out', out, '--page', String(pageNo), '--rect', '72,72,100,50', '--content', 'box')
    const back = await viewRect(out, pageNo - 1)
    check(r.code === 0 && back.x === 72 && back.y === 72 && back.width === 100 && back.height === 50, `text box at view (72,72,100,50) lands there on a /Rotate ${back.rotate} page`)
  }
  // Images are flattened into the content stream (no /Annots to read back); the placement path is the one verified above.
  const st = cli('annotate.stamp', '--in', ROT, '--out', join(T, 'stamp270.pdf'), '--page', '4', '--at', '400,40', '--width', '120', '--image', wide)
  const sb = st.out.result.bounds
  check(st.code === 0 && sb.x === 400 && sb.y === 40 && sb.width === 120 && sb.height === 60, 'a stamp at view (400,40) on a /Rotate 270 page reports a 120×60 view box there')
  const f = cli('find', 'Table', '--in', ROT)
  const b = f.out.result.matches.map((m: any) => m.bounds)
  // "Table" is drawn at user-space (60, 680) on every page; where it *appears* depends on /Rotate. Expect find to report that view position.
  const task = pdfjs.getDocument({ data: new Uint8Array(readFileSync(ROT)), verbosity: 0, useSystemFonts: false })
  const rdoc = await task.promise
  let allMatch = b.length === 4
  for (let i = 0; i < 4; i++) {
    const page = await rdoc.getPage(i + 1)
    const vp = page.getViewport({ scale: 1 })
    const [vx, vyTop] = vp.convertToViewportPoint(60, 680)
    const expected = { x: vx, y: vp.height - vyTop }
    // The run's start point maps to a different corner of its box on each rotation; it must lie inside the reported box.
    const near = expected.x >= b[i].x - 2 && expected.x <= b[i].x + b[i].width + 2 && expected.y >= b[i].y - 2 && expected.y <= b[i].y + b[i].height + 2
    if (!near) allMatch = false
  }
  await task.destroy()
  check(f.code === 0 && allMatch, 'find reports "Table" where it appears on each /Rotate 0/90/180/270 page')
  const hl = cli('annotate.highlight', '--in', ROT, '--out', join(T, 'hl270.pdf'), '--page', '4', '--text', 'Table')
  const hb = await viewRect(join(T, 'hl270.pdf'), 3)
  check(hl.code === 0 && Math.abs(hb.x - b[3].x) < 1 && Math.abs(hb.y - b[3].y) < 1, 'highlight by anchor on the /Rotate 270 page covers the found text')
  const arrow = cli('annotate.arrow', '--in', ROT, '--out', join(T, 'ar270.pdf'), '--page', '4', '--from', '100,100', '--to', '300,100')
  const ab = await viewRect(join(T, 'ar270.pdf'), 3)
  check(arrow.code === 0 && ab.width > ab.height, 'a horizontal arrow on the /Rotate 270 page stays horizontal as displayed')
}

console.log('CLI: stamps (design §17)')
{
  const annotDict = async (file: string, pageIndex: number, n = 0): Promise<any> => {
    const d = await load(file)
    return d.context.lookup(d.getPage(pageIndex).node.Annots()!.get(n)) as any
  }
  const list = cli('stamps.list')
  check(list.code === 0 && list.out.result.presets.length === 20 && list.out.result.presets.some((p: any) => p.id === 'approved'), 'stamps.list returns the 20 standard presets')
  const ap = cli('annotate.stamp', '--in', FIX, '--out', join(T, 'stamp1.pdf'), '--preset', 'approved', '--page', '1', '--at', '380,700')
  const d1 = await annotDict(join(T, 'stamp1.pdf'), 0)
  check(ap.code === 0 && ap.out.result.kind === 'stamp' && d1.get(PDFName.of('Subtype')).toString() === '/Stamp' && d1.get(PDFName.of('Name')).toString() === '/Approved' && d1.get(PDFName.of('AP')) !== undefined, 'preset stamp is a /Stamp annotation named /Approved with an appearance')
  check(ap.out.result.bounds.x === 380 && ap.out.result.bounds.y === 700 && ap.out.result.bounds.height === 34, 'preset stamp is placed at the requested view position with the default height')
  const apStream = (await load(join(T, 'stamp1.pdf'))).context.lookup(d1.get(PDFName.of('AP')).get(PDFName.of('N'))) as any
  const apText = Buffer.from(apStream.getContents()).toString('latin1')
  const apFonts = apStream.dict.lookup(PDFName.of('Resources')).lookup(PDFName.of('Font'))
  // The label is written as a hex string in Helvetica-Bold, inside a clip, with the preset's green as fill and stroke.
  check(/\/HelvB [0-9.]+ Tf/.test(apText) && apText.includes('<' + Buffer.from('APPROVED', 'latin1').toString('hex').toUpperCase() + '> Tj') && apFonts.get(PDFName.of('HelvB')) !== undefined, 'appearance stream draws the label in the bold font that its resources declare')
  check(/0\.102 0\.498 0\.216 rg/.test(apText) && /0\.102 0\.498 0\.216 RG/.test(apText) && / re W n /.test(apText), 'appearance uses the preset colour for fill and stroke and clips to its box')
  const bbox = apStream.dict.lookup(PDFName.of('BBox')).asArray().map((n: any) => n.asNumber())
  check(bbox[0] === 0 && bbox[1] === 0 && bbox[3] === 34, 'appearance BBox is the local stamp box')
  const dyn = cli('annotate.stamp', '--in', FIX, '--out', join(T, 'stamp2.pdf'), '--preset', 'received', '--author', 'Ada Lovelace', '--page', '1', '--at', '60,60')
  check(dyn.code === 0 && dyn.out.result.sublabel === 'Ada Lovelace · Jan 1, 2026' && dyn.out.result.bounds.height === 46, 'dynamic preset adds "name · date" and the taller box')
  const custom = cli('annotate.stamp', '--in', ROT, '--out', join(T, 'stamp3.pdf'), '--label', 'CHECKED', '--color', '#8250df', '--with-date', '--text', 'Table', '--page', '4', '--align', 'right')
  const d3 = await annotDict(join(T, 'stamp3.pdf'), 3)
  check(custom.code === 0 && d3.get(PDFName.of('Name')).toString() === '/Custom' && d3.get(PDFName.of('Contents')).decodeText() === 'CHECKED\nJan 1, 2026', 'custom stamp anchored to text on a /Rotate 270 page: /Custom with label and date in /Contents')
  const r3 = d3.get(PDFName.of('Rect')).asArray().map((n: any) => n.asNumber())
  check(Math.abs(r3[3] - r3[1]) > Math.abs(r3[2] - r3[0]) && custom.out.result.bounds.width > custom.out.result.bounds.height, 'on the rotated page the stored /Rect is tall while the view box is wide')
  const flat = cli('apply', '--in', FIX, '--out', join(T, 'stamp4.pdf'), '--ops', JSON.stringify([{ command: 'annotate.stamp', params: { preset: 'draft', page: 1, at: '100,400' } }, { command: 'annotations.update', params: { id: '$0.created', text: 'DRAFT 2', color: '#0969da' } }, { command: 'export.flatten', params: { forms: false } }]))
  const flatDoc = await load(join(T, 'stamp4.pdf'))
  const xobjects = flatDoc.getPage(0).node.Resources()?.lookup(PDFName.of('XObject')) as any
  const flatNames = xobjects ? xobjects.keys().map((k: any) => k.toString()) : []
  check(flat.code === 0 && !flatDoc.getPage(0).node.Annots()?.size() && flatNames.some((n: string) => n.startsWith('/YonderAnnot')), 'a stamp can be relabelled, recoloured and flattened: no annotation left, its appearance is a page XObject')
  const relabel = cli('apply', '--in', FIX, '--out', join(T, 'stamp4b.pdf'), '--ops', JSON.stringify([{ command: 'annotate.stamp', params: { preset: 'approved', page: 1, at: '100,400' } }, { command: 'annotations.update', params: { id: '$0.created', text: 'REJECTED' } }]))
  const d4b = await annotDict(join(T, 'stamp4b.pdf'), 0)
  check(relabel.code === 0 && d4b.get(PDFName.of('Name')).toString() === '/Custom' && d4b.get(PDFName.of('Contents')).decodeText() === 'REJECTED', 'relabelling a preset stamp drops its standard /Name')
  const emptyLabel = cli('apply', '--in', FIX, '--out', join(T, 'stamp4c.pdf'), '--ops', JSON.stringify([{ command: 'annotate.stamp', params: { preset: 'approved', page: 1, at: '100,400' } }, { command: 'annotations.update', params: { id: '$0.created', text: '   ' } }]))
  check(emptyLabel.code === 2 && emptyLabel.err?.error.details.failedIndex === 1, 'an empty stamp label is rejected on update')
  const tiny = cli('annotate.stamp', '--in', FIX, '--out', join(T, 'stamp4d.pdf'), '--preset', 'approved', '--page', '1', '--rect', '10,10,5,5')
  check(tiny.code === 2 && /at least 24×12/.test(tiny.err?.error.message ?? ''), 'a stamp box below the minimum size is rejected')
  const conflict = cli('annotate.stamp', '--in', FIX, '--out', join(T, 'stamp4e.pdf'), '--preset', 'approved', '--image', wide, '--page', '1', '--at', '10,10')
  check(conflict.code === 2 && /only one of/.test(conflict.err?.error.message ?? ''), 'conflicting stamp sources are rejected')
  const styled = cli('annotate.stamp', '--in', FIX, '--out', join(T, 'stamp4f.pdf'), '--image', wide, '--color', '#ff0000', '--page', '1', '--at', '10,10')
  check(styled.code === 2 && /only apply to text stamps/.test(styled.err?.error.message ?? ''), 'text options on an image stamp are rejected')
  const op = cli('annotate.stamp', '--in', FIX, '--out', join(T, 'stamp4g.pdf'), '--label', 'Tom & (Jerry) \\ Co', '--opacity', '0.5', '--page', '1', '--at', '60,300')
  const d4g = await annotDict(join(T, 'stamp4g.pdf'), 0)
  check(op.code === 0 && d4g.get(PDFName.of('CA')).asNumber() === 0.5 && d4g.get(PDFName.of('Contents')).decodeText() === 'Tom & (Jerry) \\ Co', 'opacity and a label with parentheses and a backslash survive')
  // Library entries come from a user-editable file: malformed ones are ignored, valid ones usable.
  const profile = join(T, 'profile')
  mkdirSync(profile)
  writeFileSync(join(profile, 'yonder-pdf.json'), JSON.stringify({ stamps: [
    { id: 'ok-text', type: 'text', label: 'QA PASSED', color: '#1a7f37', withName: false, withDate: true, createdAt: 1 },
    { id: 'bad-color', type: 'text', label: 'X', color: 'red', withName: false, withDate: false, createdAt: 1 },
    { id: 'bad-image', type: 'image', dataUrl: 'data:image/png;base64,garbage!!', width: 0, height: 10, createdAt: 1 },
    { id: 'zero-size', type: 'image', dataUrl: 'data:image/png;base64,AAAA', width: 0.1, height: 10, createdAt: 1 },
    { type: 'text', label: 'no id', color: '#000000' },
    'nonsense'
  ] }))
  const lib = spawnSync('node', [CLI, 'stamps.list', '--json'], { encoding: 'utf8', env: { ...process.env, YONDER_USER_DATA: profile } })
  const libSaved = JSON.parse(lib.stdout).result.saved
  check(lib.status === 0 && libSaved.length === 1 && libSaved[0].id === 'ok-text', 'malformed library entries are ignored')
  const fromLib = spawnSync('node', [CLI, 'annotate.stamp', '--in', FIX, '--out', join(T, 'stamp4h.pdf'), '--saved', 'ok-text', '--page', '1', '--at', '60,500', '--json'], { encoding: 'utf8', env: { ...process.env, YONDER_USER_DATA: profile, YONDER_DETERMINISTIC: '1' } })
  const fromLibOut = JSON.parse(fromLib.stdout)
  check(fromLib.status === 0 && fromLibOut.result.label === 'QA PASSED' && fromLibOut.result.sublabel === 'Jan 1, 2026', 'a saved text stamp is placed with its saved options')
  const bad = cli('annotate.stamp', '--in', FIX, '--out', join(T, 'stamp5.pdf'), '--preset', 'nope', '--page', '1', '--at', '10,10')
  check(bad.code === 2 && /Presets: approved/.test(bad.err?.error.hint ?? '') && !existsSync(join(T, 'stamp5.pdf')), 'an unknown preset lists the valid ones')
  const img = cli('annotate.stamp', '--in', FIX, '--out', join(T, 'stamp6.pdf'), '--image', wide, '--page', '1', '--at', '60,60', '--width', '120')
  check(img.code === 0 && img.out.result.kind === 'image' && img.out.result.bounds.width === 120 && img.out.result.bounds.height === 60, 'an image stamp keeps its aspect at the requested width')
  const none = cli('annotate.stamp', '--in', FIX, '--out', join(T, 'stamp7.pdf'), '--page', '1', '--at', '10,10')
  check(none.code === 2 && none.err?.error.code === 'YP_USAGE', 'a stamp needs a preset, a label, an image or a saved id')
}

console.log('MCP: stdio handshake, tools/list, tools/call')
await new Promise<void>((resolve) => {
  const child = spawn('node', [CLI, 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'] })
  let buf = ''
  const send = (m: unknown): void => void child.stdin.write(JSON.stringify(m) + '\n')
  const timer = setTimeout(() => { check(false, 'MCP server answered in time'); child.kill(); resolve() }, 15000)
  child.stdout.on('data', (c) => {
    buf += c
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!line.trim()) continue
      const m = JSON.parse(line)
      if (m.id === 1) {
        check(m.result?.serverInfo?.name === 'yonder-pdf', 'initialize returns serverInfo')
        send({ jsonrpc: '2.0', method: 'notifications/initialized' })
        send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
      } else if (m.id === 2) {
        const tools = m.result.tools as Array<{ name: string; inputSchema: any }>
        check(tools.length >= 30 && tools.some((t) => t.name === 'yonder_annotate_highlight'), `tools/list exposes ${tools.length} tools`)
        const hl = tools.find((t) => t.name === 'yonder_annotate_highlight')!
        check(hl.inputSchema.required.includes('in') && hl.inputSchema.properties.out && hl.inputSchema.properties.text, 'highlight tool schema carries in/out plus command params')
        send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'yonder_find', arguments: { in: FIX, query: 'Full name', page: 2 } } })
      } else if (m.id === 3) {
        check(m.result.structuredContent?.result?.total === 1 && m.result.isError !== true, 'tools/call find returns structured content')
        send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'yonder_pages_delete', arguments: { in: FIX, pages: '9', out: join(T, 'mcp.pdf') } } })
      } else if (m.id === 4) {
        check(m.result.isError === true && /YP_PAGE_RANGE/.test(m.result.content[0].text), 'tools/call reports command errors with isError')
        send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'yonder_annotate_date', arguments: { in: FIX, page: 1, out: join(T, 'mcp2.pdf'), dryRun: 'false' } } })
      } else if (m.id === 5) {
        check(m.result.isError === true && /YP_INVALID_INPUT/.test(m.result.content[0].text) && !existsSync(join(T, 'mcp2.pdf')), 'MCP rejects a string-valued boolean IO argument before doing anything')
        clearTimeout(timer)
        child.kill()
        resolve()
      }
    }
  })
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } })
})

rmSync(T, { recursive: true, force: true })
if (failures) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall CLI checks passed')
