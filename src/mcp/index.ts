// Model Context Protocol server over stdio: every registry command is a tool
// (design §14.4, §15 #17). stdout carries protocol frames only; everything
// else goes to stderr. Headless scope only in this milestone.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { commands, describe } from '@core/commands/index'
import { toYonderError } from '@core/errors'
import { s, validate, type Schema } from '@core/schema'
import { runHeadless, type RunOptions } from '@node/runner'

declare const __YONDER_VERSION__: string

const IO: Record<string, Schema> = {
  in: s.str('Input PDF path'),
  out: s.str('Output file path (edits, extract, merge)'),
  outDir: s.str('Output directory (split)'),
  inPlace: s.bool('Overwrite the input file'),
  overwrite: s.bool('Replace an existing output'),
  dryRun: s.bool('Resolve and report without writing'),
  author: s.str('Author name written into annotations'),
  expectSha256: s.str('Fail unless the input still has this SHA-256'),
  acknowledgeSignatureInvalidation: s.bool('Allow rewriting a document that has signature fields (existing digital signatures become invalid)')
}

const toolName = (name: string): string => 'yonder_' + name.replace(/[.-]/g, '_')

function toolSchema(params: Schema, needsDoc: boolean, produces: string): Schema {
  const base = 'type' in params && params.type === 'object' ? params : s.obj({})
  if (!('type' in base) || base.type !== 'object') return base
  const io: Record<string, Schema> = {}
  if (needsDoc) io.in = IO.in
  if (produces === 'document') Object.assign(io, { out: IO.out, inPlace: IO.inPlace, overwrite: IO.overwrite, dryRun: IO.dryRun, author: IO.author, expectSha256: IO.expectSha256, acknowledgeSignatureInvalidation: IO.acknowledgeSignatureInvalidation })
  if (produces === 'file') Object.assign(io, { out: IO.out, overwrite: IO.overwrite, dryRun: IO.dryRun })
  if (produces === 'files') Object.assign(io, { outDir: IO.outDir, overwrite: IO.overwrite, dryRun: IO.dryRun })
  return { type: 'object', properties: { ...io, ...base.properties }, required: [...(needsDoc ? ['in'] : []), ...(base.required ?? [])], additionalProperties: false }
}

export async function serve(): Promise<void> {
  // pdf.js and friends log through console.log; keep stdout clean for the protocol.
  console.log = (...args: unknown[]) => console.error(...args)
  const server = new Server({ name: 'yonder-pdf', version: __YONDER_VERSION__ }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: commands
      .filter((c) => c.scope !== 'app')
      .map((c) => ({
        name: toolName(c.name),
        title: c.name,
        description: `${c.description}${c.examples?.length ? ` CLI equivalent: ${c.examples[0]}` : ''} Pages are 1-based; coordinates are PDF points, origin bottom-left.`,
        inputSchema: toolSchema(c.params, c.needsDoc, c.produces) as Record<string, unknown>,
        annotations: { readOnlyHint: c.produces === 'none', destructiveHint: c.produces !== 'none', idempotentHint: c.produces === 'none', openWorldHint: false }
      }))
  }))
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const cmd = commands.find((c) => toolName(c.name) === req.params.name)
    if (!cmd) return { isError: true, content: [{ type: 'text', text: `Unknown tool ${req.params.name}` }] }
    const args = { ...((req.params.arguments ?? {}) as Record<string, unknown>) }
    // Validate the complete advertised schema (IO parameters included) before anything is interpreted (REVIEW-05 #2).
    const errs = validate(toolSchema(cmd.params, cmd.needsDoc, cmd.produces), args)
    if (errs.length) return { isError: true, content: [{ type: 'text', text: `YP_INVALID_INPUT: ${errs.join('; ')}` }], structuredContent: { error: { code: 'YP_INVALID_INPUT', message: errs.join('; ') } } }
    const opts: RunOptions = {}
    for (const key of Object.keys(IO)) {
      if (args[key] === undefined) continue
      ;(opts as Record<string, unknown>)[key] = args[key]
      delete args[key]
    }
    if (process.env.YONDER_PDF_PASSWORD) opts.password = process.env.YONDER_PDF_PASSWORD
    try {
      const res = await runHeadless(cmd.name, args, opts)
      const summary = res.outputs.length ? `${cmd.name}: wrote ${res.outputs.map((o) => o.path).join(', ')}` : res.dryRun ? `${cmd.name}: dry run, nothing written` : `${cmd.name}: ok`
      return { content: [{ type: 'text', text: summary + '\n' + JSON.stringify(res, null, 2) }], structuredContent: res as unknown as Record<string, unknown> }
    } catch (err) {
      const e = toYonderError(err)
      return { isError: true, content: [{ type: 'text', text: `${e.code}: ${e.message}${e.hint ? `\nHint: ${e.hint}` : ''}${e.details ? `\n${JSON.stringify(e.details)}` : ''}` }], structuredContent: { error: e.toJSON() } }
    }
  })
  await server.connect(new StdioServerTransport())
  console.error(`yonder-pdf mcp ${__YONDER_VERSION__}: ${describe().commands.length} tools`)
}
