// The registry: every capability as data (name, schema, scope) plus `apply`
// for batches. Front-ends (CLI, MCP, local API) iterate this list; nothing is
// hard-coded per transport.
import { toYonderError, YonderError } from '../errors'
import { s, validate, type Schema } from '../schema'
import { annotateCommands } from './annotate'
import { requireDoc, type Command, type CommandContext, type Outcome, type Params } from './context'
import { documentCommands } from './document'
import { exportCommands } from './export'
import { formsCommands } from './forms'
import { pagesCommands } from './pages'

export const API_VERSION = 1

const base: Command[] = [...documentCommands, ...annotateCommands, ...pagesCommands, ...formsCommands, ...exportCommands]

export const apply: Command = {
  name: 'apply',
  group: 'batch',
  description: 'Run several commands on one document with a single load and save. --ops is a JSON array of {command, params}; later ops may reference an earlier result with "$N.created" (N = 0-based op index) and see pages as left by previous ops. Nothing is written if any op fails.',
  scope: 'both',
  needsDoc: true,
  produces: 'document',
  params: s.obj({
    ops: s.arr(s.obj({ command: s.str('Command name'), params: s.record('Parameters of that command') }, ['command']), 'Operations in order', { minItems: 1, maxItems: 500 }),
    opsFile: s.str('JSON file holding the ops array (instead of --ops)')
  }),
  examples: ['yonder-pdf apply --in a.pdf --out b.pdf --ops \'[{"command":"annotate.highlight","params":{"text":"Total due"}},{"command":"pages.rotate","params":{"pages":"1","by":90}}]\'', 'yonder-pdf apply --in a.pdf --out b.pdf --ops-file edits.json'],
  async run(ctx, p): Promise<Outcome> {
    requireDoc(ctx)
    let list = p.ops as Array<{ command: string; params?: Params }> | undefined
    if (p.opsFile !== undefined) {
      if (list) throw new YonderError('YP_USAGE', 'Give either --ops or --ops-file')
      const bytes = await ctx.readFile(String(p.opsFile), 'json')
      let text = ''
      for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)))
      try {
        list = JSON.parse(decodeURIComponent(escape(text)))
      } catch {
        throw new YonderError('YP_INVALID_INPUT', '--ops-file is not valid JSON')
      }
      const errs = validate((apply.params as { properties: Record<string, Schema> }).properties.ops, list)
      if (errs.length) throw new YonderError('YP_INVALID_INPUT', errs.join('; '))
    }
    if (!list) throw new YonderError('YP_USAGE', 'Give --ops (JSON array) or --ops-file')
    const results: unknown[] = []
    for (let i = 0; i < list.length; i++) {
      const op = list[i]
      // Everything for one op — reference resolution, validation, execution — is attributed to it (REVIEW-05 #18).
      const attribute = (err: unknown): YonderError => {
        const e = toYonderError(err)
        if (e.code === 'YP_INTERNAL' && !/^Op \d+/.test(e.message)) e.message = `Op ${i} (${op.command}): ${e.message}`
        e.details = { ...(typeof e.details === 'object' && e.details ? e.details : {}), failedIndex: i, command: op.command }
        return e
      }
      try {
        const cmd = get(op.command)
        if (!cmd) throw new YonderError('YP_USAGE', `Op ${i}: unknown command "${op.command}"`)
        if (cmd.name === 'apply' || cmd.produces === 'file' || cmd.produces === 'files' || !cmd.needsDoc) throw new YonderError('YP_UNSUPPORTED', `Op ${i}: ${cmd.name} cannot run inside a batch (it produces separate files)`)
        const params = resolveRefs(op.params ?? {}, results, i)
        const errs = validate(cmd.params, params)
        if (errs.length) throw new YonderError('YP_INVALID_INPUT', `Op ${i} (${cmd.name}): ${errs.join('; ')}`)
        const out = await cmd.run(ctx, params)
        results.push(out.result)
      } catch (err) {
        throw attribute(err)
      }
    }
    return { result: { ops: results } }
  }
}

/** Replace "$N.path.to.value" strings with values from earlier results. */
function resolveRefs(params: Params, results: unknown[], index: number): Params {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const m = v.match(/^\$(\d+)((?:\.[A-Za-z0-9_]+)*)$/)
      if (!m) return v
      const n = Number(m[1])
      if (n >= index) throw new YonderError('YP_INVALID_INPUT', `Op ${index}: "${v}" refers to a result that does not exist yet`)
      let cur: unknown = results[n]
      for (const key of m[2].split('.').filter(Boolean)) cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[key] : undefined
      if (cur === undefined) throw new YonderError('YP_INVALID_INPUT', `Op ${index}: "${v}" is not present in that result`)
      return cur
    }
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]))
    return v
  }
  return walk(params) as Params
}

export const commands: Command[] = [...base, apply]

export function get(name: string): Command | undefined {
  return commands.find((c) => c.name === name)
}

export function groups(): string[] {
  return [...new Set(commands.map((c) => c.group))]
}

/** Machine-readable description of every command (design §14.3 `schema`). */
export function describe(): { apiVersion: number; commands: Array<{ name: string; group: string; description: string; scope: Command['scope']; needsDoc: boolean; produces: Command['produces']; params: Schema; examples: string[] }> } {
  return {
    apiVersion: API_VERSION,
    commands: commands.map((c) => ({ name: c.name, group: c.group, description: c.description, scope: c.scope, needsDoc: c.needsDoc, produces: c.produces, params: c.params, examples: c.examples ?? [] }))
  }
}

export type { Command, CommandContext, Outcome, Params }
