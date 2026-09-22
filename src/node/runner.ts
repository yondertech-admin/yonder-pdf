// Headless execution of registry commands against files (design §14.4/14.5):
// resolves --in/--out, refuses ambiguous writes, loads the document once,
// runs the command, commits and writes atomically, and reports a uniform
// result. Used by the CLI and the MCP server; the app's local API will run the
// same code in a utility process.
import { promises as fs } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { get, type Command, type Params } from '@core/commands/index'
import { InputDoc, sha256Hex, type CommandContext } from '@core/commands/context'
import { YonderError } from '@core/errors'
import { validate } from '@core/schema'
import { canonical, exists, writeAtomic } from './fs'
import { loadPdfNode, NeedsPassword } from './pdfjs'

export interface RunOptions {
  in?: string
  out?: string
  outDir?: string
  inPlace?: boolean
  overwrite?: boolean
  password?: string
  dryRun?: boolean
  author?: string
  deterministic?: boolean
  expectSha256?: string
}

export interface RunResult {
  ok: true
  command: string
  target?: { file: string; sha256: string }
  wrote?: string[]
  dryRun?: boolean
  revBefore?: number
  revAfter?: number
  outputSha256?: string
  result: Record<string, unknown>
}

const MAX_PDF_BYTES = 1024 * 1024 * 1024

async function readPdf(path: string): Promise<Uint8Array> {
  let stat
  try {
    stat = await fs.stat(path)
  } catch {
    throw new YonderError('YP_NOT_FOUND', `No such file: ${path}`)
  }
  if (!stat.isFile()) throw new YonderError('YP_INVALID_INPUT', `${path} is not a file`)
  if (stat.size > MAX_PDF_BYTES) throw new YonderError('YP_INVALID_INPUT', `${path} is larger than 1 GB`)
  const buf = await fs.readFile(path)
  if (!buf.subarray(0, 1024).toString('latin1').includes('%PDF-')) throw new YonderError('YP_INVALID_INPUT', `${path} is not a PDF`)
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

export function makeContext(opts: RunOptions, doc?: InputDoc): CommandContext {
  const deterministic = Boolean(opts.deterministic || process.env.YONDER_DETERMINISTIC === '1')
  let counter = 0
  return {
    doc,
    async readFile(path: string): Promise<Uint8Array> {
      try {
        const buf = await fs.readFile(path)
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
      } catch {
        throw new YonderError('YP_NOT_FOUND', `No such file: ${path}`)
      }
    },
    loadPdfjs: async (bytes, password) => {
      try {
        return await loadPdfNode(bytes, password)
      } catch (err) {
        if (err instanceof NeedsPassword) throw new YonderError('YP_NEEDS_PASSWORD', err.message, 'Pass --password-file <file> or set YONDER_PDF_PASSWORD. Encrypted documents can be read but not edited.')
        throw err
      }
    },
    deterministic,
    now: () => (deterministic ? Date.UTC(2026, 0, 1) : Date.now()),
    newId: () => (deterministic ? `a${String(++counter).padStart(4, '0')}` : crypto.randomUUID()),
    author: opts.author
  }
}

async function planOutput(cmd: Command, opts: RunOptions, inPath?: string): Promise<{ out?: string; outDir?: string }> {
  if (cmd.produces === 'none') return {}
  if (cmd.produces === 'files') {
    if (!opts.outDir) throw new YonderError('YP_USAGE', `${cmd.name} writes several files: give --out-dir <dir>`)
    return { outDir: opts.outDir }
  }
  let out = opts.out
  if (cmd.produces === 'document' && opts.inPlace) {
    if (!inPath) throw new YonderError('YP_USAGE', '--in-place needs --in')
    if (out && (await canonical(out)) !== inPath) throw new YonderError('YP_USAGE', 'Give either --out or --in-place, not both')
    return { out: inPath }
  }
  if (!out) throw new YonderError('YP_USAGE', cmd.produces === 'document' ? 'Give --out <file> (or --in-place to overwrite the input)' : 'Give --out <file>')
  const outC = await canonical(out)
  if (inPath && outC === inPath) throw new YonderError('YP_SAME_FILE', '--out is the same file as --in', 'Use --in-place to overwrite the input deliberately.')
  if (!opts.overwrite && (await exists(outC))) throw new YonderError('YP_OUTPUT_EXISTS', `${out} already exists`, 'Pass --overwrite to replace it.')
  return { out: outC }
}

export async function runHeadless(name: string, params: Params, opts: RunOptions): Promise<RunResult> {
  const cmd = get(name)
  if (!cmd) throw new YonderError('YP_USAGE', `Unknown command "${name}"`, 'Run `yonder-pdf --help` for the list.')
  if (cmd.scope === 'app') throw new YonderError('YP_APP_NOT_RUNNING', `${cmd.name} needs the Yonder PDF app (not available headlessly yet)`)
  const errs = validate(cmd.params, params)
  if (errs.length) throw new YonderError('YP_INVALID_INPUT', errs.join('; '), `Run \`yonder-pdf ${cmd.name} --help\` for the parameters.`)

  let doc: InputDoc | undefined
  let inPath: string | undefined
  let inSha: string | undefined
  if (cmd.needsDoc) {
    if (!opts.in) throw new YonderError('YP_USAGE', `${cmd.name} needs --in <file>`)
    inPath = await canonical(opts.in)
    const bytes = await readPdf(inPath)
    inSha = await sha256Hex(bytes)
    if (opts.expectSha256 && opts.expectSha256.toLowerCase() !== inSha) throw new YonderError('YP_REV_MISMATCH', `${opts.in} has changed (sha256 ${inSha})`, 'Re-read the document and retry with the current --expect-sha256.')
    doc = new InputDoc(makeContext(opts).loadPdfjs, bytes, opts.password)
  }
  const plan = await planOutput(cmd, opts, inPath)
  const ctx = makeContext(opts, doc)
  try {
    const outcome = await cmd.run(ctx, params)
    const res: RunResult = { ok: true, command: cmd.name, result: outcome.result }
    if (inPath && inSha) res.target = { file: inPath, sha256: inSha }
    if (cmd.produces === 'document' && doc) {
      const bytes = await doc.commit()
      res.revBefore = 0
      res.revAfter = doc.rev + 1
      res.outputSha256 = await sha256Hex(bytes)
      if (opts.dryRun) res.dryRun = true
      else {
        await writeAtomic(plan.out!, bytes)
        res.wrote = [plan.out!]
      }
    } else if (cmd.produces === 'file') {
      const file = outcome.outputs?.[0]
      if (!file) throw new YonderError('YP_INTERNAL', `${cmd.name} produced no output`)
      res.outputSha256 = await sha256Hex(file.bytes)
      if (opts.dryRun) res.dryRun = true
      else {
        await writeAtomic(plan.out!, file.bytes)
        res.wrote = [plan.out!]
      }
    } else if (cmd.produces === 'files') {
      const dir = plan.outDir!
      const stem = inPath ? basename(inPath, extname(inPath)) : 'output'
      const paths = (outcome.outputs ?? []).map((o) => join(dir, `${stem}-${o.name}`))
      if (!opts.overwrite) for (const p of paths) if (await exists(p)) throw new YonderError('YP_OUTPUT_EXISTS', `${p} already exists`, 'Pass --overwrite to replace existing parts.')
      if (opts.dryRun) res.dryRun = true
      else {
        await fs.mkdir(dir, { recursive: true })
        for (let i = 0; i < paths.length; i++) await writeAtomic(paths[i], outcome.outputs![i].bytes)
        res.wrote = paths
      }
      res.result = { ...res.result, files: paths }
    }
    return res
  } finally {
    await doc?.destroy()
  }
}

export { dirname }
