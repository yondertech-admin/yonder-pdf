// Headless execution of registry commands against files (design §14.4/14.5):
// resolves --in/--out, refuses ambiguous writes, loads the document once,
// runs the command, commits and writes atomically, and reports a uniform
// result. Used by the CLI and the MCP server; the app's local API will run the
// same code in a utility process.
import { promises as fs } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { get, type Command, type Params } from '@core/commands/index'
import { InputDoc, sha256Hex, type CommandContext } from '@core/commands/context'
import { toYonderError, YonderError } from '@core/errors'
import { validate } from '@core/schema'
import { readSavedSignatures } from './appdata'
import { canonical, exists, identity, withWriteLock, writeAtomic } from './fs'
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
  /** Required to rewrite a document that contains signature fields (§12 #17). */
  acknowledgeSignatureInvalidation?: boolean
}

export interface RunResult {
  ok: true
  command: string
  target?: { file: string; sha256: string }
  /** Ids of annotations created by this run (also inside nested batch results). */
  created: string[]
  warnings: string[]
  /** Files written, with hashes. Empty on dry runs and read-only commands. */
  outputs: Array<{ path: string; sha256: string }>
  dryRun?: boolean
  revBefore?: number
  revAfter?: number
  outputSha256?: string
  result: Record<string, unknown>
}

const LIMITS = { pdf: 1024 * 1024 * 1024, image: 64 * 1024 * 1024, json: 16 * 1024 * 1024 } as const

async function readBounded(path: string, kind: keyof typeof LIMITS): Promise<Uint8Array> {
  let stat
  try {
    stat = await fs.stat(path)
  } catch {
    throw new YonderError('YP_NOT_FOUND', `No such file: ${path}`)
  }
  if (!stat.isFile()) throw new YonderError('YP_INVALID_INPUT', `${path} is not a file`)
  if (stat.size > LIMITS[kind]) throw new YonderError('YP_INVALID_INPUT', `${path} is larger than the ${kind} limit (${Math.round(LIMITS[kind] / 1024 / 1024)} MB)`)
  const buf = await fs.readFile(path)
  if (kind === 'pdf' && !buf.subarray(0, 1024).toString('latin1').includes('%PDF-')) throw new YonderError('YP_INVALID_INPUT', `${path} is not a PDF`)
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

export function makeContext(opts: RunOptions, doc?: InputDoc): CommandContext {
  const deterministic = Boolean(opts.deterministic || process.env.YONDER_DETERMINISTIC === '1')
  let counter = 0
  return {
    doc,
    readFile: readBounded,
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
    author: opts.author,
    savedSignatures: readSavedSignatures
  }
}

async function planOutput(cmd: Command, opts: RunOptions, inPath?: string): Promise<{ out?: string; outDir?: string }> {
  if (cmd.produces === 'none') return {}
  if (cmd.produces === 'files') {
    if (!opts.outDir) throw new YonderError('YP_USAGE', `${cmd.name} writes several files: give --out-dir <dir>`)
    return { outDir: opts.outDir }
  }
  const out = opts.out
  if (cmd.produces === 'document' && opts.inPlace) {
    if (!inPath) throw new YonderError('YP_USAGE', '--in-place needs --in')
    if (out && (await canonical(out)) !== inPath) throw new YonderError('YP_USAGE', 'Give either --out or --in-place, not both')
    return { out: inPath }
  }
  if (!out) throw new YonderError('YP_USAGE', cmd.produces === 'document' ? 'Give --out <file> (or --in-place to overwrite the input)' : 'Give --out <file>')
  const outC = await canonical(out)
  if (inPath && (outC === inPath || ((await identity(outC)) !== null && (await identity(outC)) === (await identity(inPath))))) throw new YonderError('YP_SAME_FILE', '--out is the same file as --in', 'Use --in-place to overwrite the input deliberately.')
  if (!opts.overwrite && (await exists(outC))) throw new YonderError('YP_OUTPUT_EXISTS', `${out} already exists`, 'Pass --overwrite to replace it.')
  return { out: outC }
}

/** Collect `created` ids and `warnings` from a (possibly nested) command result. */
function harvest(result: unknown, created: string[], warnings: string[]): void {
  if (Array.isArray(result)) return result.forEach((r) => harvest(r, created, warnings))
  if (!result || typeof result !== 'object') return
  const r = result as Record<string, unknown>
  if (typeof r.created === 'string') created.push(r.created)
  if (Array.isArray(r.warnings)) for (const w of r.warnings) if (typeof w === 'string' && !warnings.includes(w)) warnings.push(w)
  if (Array.isArray(r.ops)) harvest(r.ops, created, warnings)
}

/**
 * Publish one destination under its write lock. Replacing the input re-hashes
 * it inside the lock, immediately before the rename, so a concurrent writer
 * cannot slip between check and publication (REVIEW-06 #1).
 */
async function publish(path: string, bytes: Uint8Array, opts: RunOptions, inPath?: string, inSha?: string): Promise<void> {
  const replacingInput = inPath !== undefined && path === inPath
  await withWriteLock(path, async () => {
    if (replacingInput && inSha) {
      const nowSha = await sha256Hex(await readBounded(inPath, 'pdf'))
      if (nowSha !== inSha) throw new YonderError('YP_REV_MISMATCH', `${inPath} changed while the command was running; nothing was written`, 'Re-run the command.')
    }
    await writeAtomic(path, bytes, { exclusive: !opts.overwrite && !replacingInput })
  })
}

export async function runHeadless(name: string, params: Params, opts: RunOptions): Promise<RunResult> {
  const cmd = get(name)
  if (!cmd) throw new YonderError('YP_USAGE', `Unknown command "${name}"`, 'Run `yonder-pdf --help` for the list.')
  if (cmd.scope === 'app') throw new YonderError('YP_APP_NOT_RUNNING', `${cmd.name} needs the Yonder PDF app (not available headlessly yet)`)
  const errs = validate(cmd.params, params)
  if (errs.length) throw new YonderError('YP_INVALID_INPUT', errs.join('; '), `Run \`yonder-pdf ${cmd.name} --help\` for the parameters.`)

  const ctx0 = makeContext(opts)
  let doc: InputDoc | undefined
  let inPath: string | undefined
  let inSha: string | undefined
  try {
    if (cmd.needsDoc) {
      if (!opts.in) throw new YonderError('YP_USAGE', `${cmd.name} needs --in <file>`)
      inPath = await canonical(opts.in)
      const bytes = await readBounded(inPath, 'pdf')
      inSha = await sha256Hex(bytes)
      if (opts.expectSha256 && opts.expectSha256.toLowerCase() !== inSha) throw new YonderError('YP_REV_MISMATCH', `${opts.in} has changed (sha256 ${inSha})`, 'Re-read the document and retry with the current --expect-sha256.')
      doc = new InputDoc(ctx0.loadPdfjs, bytes, opts.password, { author: opts.author, now: ctx0.now() })
      if (cmd.produces !== 'none') {
        // Guards the UI enforces before any rewrite (§12 #17, §15 #8), applied centrally.
        await doc.assertEditable()
        if (cmd.produces === 'document' && (await doc.hasSignatures()) && !opts.acknowledgeSignatureInvalidation) {
          throw new YonderError('YP_SIGNATURES_PRESENT', 'The document contains signature fields; rewriting it invalidates any existing digital signatures', 'Pass --acknowledge-signature-invalidation to proceed, or write to a separate --out and keep the original.')
        }
      }
    }
    const plan = await planOutput(cmd, opts, inPath)
    const ctx = makeContext(opts, doc)
    const outcome = await cmd.run(ctx, params)
    const res: RunResult = { ok: true, command: cmd.name, created: [], warnings: [], outputs: [], result: outcome.result }
    harvest(outcome.result, res.created, res.warnings)
    if (doc) for (const w of doc.warnings) if (!res.warnings.includes(w)) res.warnings.push(w)
    if (inPath && inSha) res.target = { file: inPath, sha256: inSha }
    if (cmd.produces === 'document' && doc) {
      let bytes: Uint8Array
      try {
        bytes = await doc.commit()
      } catch (err) {
        const e = toYonderError(err)
        e.details = { ...(typeof e.details === 'object' && e.details ? e.details : {}), stage: 'commit', hint: 'An earlier operation produced content that could not be serialised; nothing was written.' }
        throw e
      }
      res.revBefore = 0
      res.revAfter = doc.rev
      res.outputSha256 = await sha256Hex(bytes)
      if (opts.dryRun) res.dryRun = true
      else {
        await publish(plan.out!, bytes, opts, inPath, inSha)
        res.outputs.push({ path: plan.out!, sha256: res.outputSha256 })
      }
    } else if (cmd.produces === 'file') {
      const file = outcome.outputs?.[0]
      if (!file) throw new YonderError('YP_INTERNAL', `${cmd.name} produced no output`)
      res.outputSha256 = await sha256Hex(file.bytes)
      if (opts.dryRun) res.dryRun = true
      else {
        await publish(plan.out!, file.bytes, opts)
        res.outputs.push({ path: plan.out!, sha256: res.outputSha256 })
      }
    } else if (cmd.produces === 'files') {
      const files = outcome.outputs ?? []
      const stem = inPath ? basename(inPath, extname(inPath)) : 'output'
      if (opts.dryRun) {
        res.dryRun = true
        res.result = { ...res.result, files: files.map((o) => join(plan.outDir!, `${stem}-${o.name}`)) }
      } else {
        await fs.mkdir(plan.outDir!, { recursive: true })
        const dir = await canonical(plan.outDir!)
        const paths = files.map((o) => join(dir, `${stem}-${o.name}`))
        if (!opts.overwrite) for (const p of paths) if (await exists(p)) throw new YonderError('YP_OUTPUT_EXISTS', `${p} already exists`, 'Pass --overwrite to replace existing parts.')
        for (let i = 0; i < paths.length; i++) {
          try {
            await publish(paths[i], files[i].bytes, opts)
          } catch (err) {
            // Report what was already written so an agent can see the partial state (REVIEW-06 #6).
            const e = toYonderError(err)
            e.details = { ...(typeof e.details === 'object' && e.details ? e.details : {}), written: res.outputs, failedPath: paths[i] }
            throw e
          }
          res.outputs.push({ path: paths[i], sha256: await sha256Hex(files[i].bytes) })
        }
        res.result = { ...res.result, files: paths }
      }
    }
    return res
  } finally {
    await doc?.destroy()
  }
}
