// Golden tests for the headless CLI and the MCP server (design §14.6). Runs
// the built bundle (npm run build:cli) against test-fixtures/sample.pdf and
// inspects outputs with pdf-lib / pdf.js instead of comparing bytes.
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument, PDFName } from 'pdf-lib'

const root = new URL('../../', import.meta.url)
const CLI = new URL('out/cli/index.mjs', root).pathname
const FIX = new URL('test-fixtures/sample.pdf', root).pathname
const T = realpathSync(mkdtempSync(join(tmpdir(), 'yonder-cli-')))
let failures = 0
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
  check(r.code === 0 && r.out.result.created === 'a0001' && r.out.wrote?.[0] === h, 'highlight by anchor writes the output (deterministic id)')
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
  check(dr.code === 0 && dr.out.dryRun === true && !dr.out.wrote, 'dry run writes nothing')
  const same = cli('annotate.date', '--in', FIX, '--out', FIX, '--page', '1')
  check(same.code === 4 && same.err?.error.code === 'YP_SAME_FILE', '--out equal to --in is refused (exit 4)')
  const exists = cli('annotate.date', '--in', FIX, '--out', h, '--page', '1')
  check(exists.code === 4 && exists.err?.error.code === 'YP_OUTPUT_EXISTS', 'existing output is refused without --overwrite')
  const bad = cli('annotate.rect', '--in', FIX, '--out', join(T, 'bad.pdf'), '--page', '1', '--rect', '10,10,-5,5')
  check(bad.code === 2 && bad.err?.error.code === 'YP_INVALID_INPUT', 'negative rect size is rejected before writing')
  const png = join(T, 'sig.png')
  writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVQIW2NkYGD4DwABBAEAX+XLxQAAAABJRU5ErkJggg==', 'base64'))
  const sg = cli('annotate.sign', '--in', FIX, '--out', join(T, 's.pdf'), '--file', png, '--page', '1', '--at', '80,130')
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
  check(sp.code === 0 && sp.out.wrote.length === 2 && (await load(sp.out.wrote[1])).getPageCount() === 1, 'split every 3 pages gives 3 + 1')
  const mg = cli('pages.merge', '--files', FIX, sp.out.wrote[1], '--out', join(T, 'm.pdf'))
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
  check(fail.code === 2 && fail.err?.error.details.failedIndex === 1 && !fail.out.wrote, 'a failing op aborts the batch and reports its index; nothing written')
  const l = cli('annotations.list', '--in', join(T, 'b.pdf'))
  check(l.code === 0 && l.out.result.file.length === 2 && l.out.result.file.every((a: any) => a.editable === false), 'annotations.list shows file annotations as read-only')
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
