// `yonder-pdf` — command-line front-end of the registry (design §14.4).
// Output is JSON on stdout (pretty by default, one line with --json); errors
// are JSON on stderr with the exit codes from core/errors.
import { readFileSync } from 'node:fs'
import { commands, describe, get, groups, type Command } from '@core/commands/index'
import { exitCodeFor, toYonderError, YonderError } from '@core/errors'
import { coerce, type Schema } from '@core/schema'
import { runHeadless, type RunOptions } from '@node/runner'

declare const __YONDER_VERSION__: string

const GLOBAL: Record<string, { type: 'string' | 'boolean'; help: string }> = {
  in: { type: 'string', help: 'Input PDF' },
  out: { type: 'string', help: 'Output file (edits, extract, merge)' },
  'out-dir': { type: 'string', help: 'Output directory (split)' },
  'in-place': { type: 'boolean', help: 'Overwrite the input file (atomic)' },
  overwrite: { type: 'boolean', help: 'Replace an existing output' },
  'password-file': { type: 'string', help: 'File containing the document password (encrypted PDFs are read-only)' },
  'expect-sha256': { type: 'string', help: 'Fail unless the input still has this hash' },
  'dry-run': { type: 'boolean', help: 'Resolve everything and report, write nothing' },
  author: { type: 'string', help: 'Author name written into annotations' },
  deterministic: { type: 'boolean', help: 'Fixed ids and timestamps (tests)' },
  json: { type: 'boolean', help: 'Compact single-line JSON output' },
  doc: { type: 'string', help: 'Live document in the running app (needs the app; coming in the next milestone)' },
  help: { type: 'boolean', help: 'Show help' }
}

const camel = (k: string): string => k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
const kebab = (k: string): string => k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())

/** Positional arguments per command, in order. */
const POSITIONAL: Record<string, string[]> = { find: ['query'], 'annotate.text': ['content'], 'annotate.note': ['content'] }

interface Parsed {
  command?: string
  options: Record<string, string | boolean>
  params: Record<string, unknown>
  positionals: string[]
}

/** Parameters whose schema is an array take every following non-flag token ("--files a.pdf b.pdf"). */
function arrayParams(cmd: Command | undefined): Set<string> {
  const out = new Set<string>()
  const schema = cmd?.params
  if (schema && 'type' in schema && schema.type === 'object') for (const [k, v] of Object.entries(schema.properties)) if ('type' in v && v.type === 'array') out.add(kebab(k))
  return out
}

function parseArgv(argv: string[]): Parsed {
  const out: Parsed = { options: {}, params: {}, positionals: [] }
  const raw: Record<string, Array<string | boolean>> = {}
  let i = 0
  if (argv[0] && !argv[0].startsWith('-')) {
    out.command = argv[0]
    i = 1
  }
  const multi = arrayParams(out.command ? get(out.command) : undefined)
  for (; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') {
      out.positionals.push(...argv.slice(i + 1))
      break
    }
    if (!a.startsWith('--')) {
      out.positionals.push(a)
      continue
    }
    let key = a.slice(2)
    let value: string | boolean | undefined
    const eq = key.indexOf('=')
    if (eq >= 0) {
      value = key.slice(eq + 1)
      key = key.slice(0, eq)
    }
    if (key.startsWith('no-') && value === undefined) {
      key = key.slice(3)
      value = false
    }
    if (value === undefined && multi.has(key)) {
      while (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) (raw[key] ??= []).push(argv[++i])
      if (!raw[key]) raw[key] = []
      continue
    }
    if (value === undefined) {
      const next = argv[i + 1]
      const isGlobalBool = GLOBAL[key]?.type === 'boolean'
      if (next !== undefined && !next.startsWith('--') && !isGlobalBool) {
        value = next
        i++
      } else value = true
    }
    ;(raw[key] ??= []).push(value)
  }
  for (const [key, values] of Object.entries(raw)) {
    if (key in GLOBAL) out.options[key] = values[values.length - 1]
    else out.params[camel(key)] = multi.has(key) ? values : values.length === 1 ? values[0] : values
  }
  return out
}


function coerceParams(cmd: Command, params: Record<string, unknown>): Record<string, unknown> {
  const schema = cmd.params
  if (!('type' in schema) || schema.type !== 'object') return params
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(params)) {
    const ps: Schema | undefined = schema.properties[k]
    if (!ps) {
      out[k] = v
      continue
    }
    if (Array.isArray(v) && 'type' in ps && ps.type === 'array') {
      // A single JSON array literal ("--ops '[…]'") is the whole value; otherwise each token is one item.
      const parsed = v.length === 1 && typeof v[0] === 'string' && v[0].trim().startsWith('[') ? coerce(ps, v[0]) : undefined
      out[k] = Array.isArray(parsed) ? parsed : v.map((x) => coerce(ps.items, x))
    }
    else if (Array.isArray(v)) out[k] = coerce(ps, v[v.length - 1])
    else if (v === true && !('type' in ps && ps.type === 'boolean')) out[k] = v // let validation report the missing value
    else out[k] = coerce(ps, v)
  }
  return out
}

function usage(): string {
  const lines = [`yonder-pdf ${__YONDER_VERSION__} — Yonder PDF from the command line (and for agents).`, '', 'Usage: yonder-pdf <command> [--in file] [--out file] [options] [params]', '', 'Commands:']
  for (const g of groups()) {
    lines.push(`  ${g}`)
    for (const c of commands.filter((x) => x.group === g)) lines.push(`    ${c.name.padEnd(22)} ${c.description.split(/(?<=\.)\s/)[0]}`)
  }
  lines.push('  meta', '    schema                 JSON description of every command (--markdown for docs)', '    version', '    mcp                    Run as a Model Context Protocol server over stdio', '', 'Global options:')
  for (const [k, v] of Object.entries(GLOBAL)) lines.push(`  --${k.padEnd(16)} ${v.help}`)
  lines.push('', 'Pages are 1-based. Coordinates are PDF points, origin bottom-left, unrotated page. Colours are hex.', 'Every command prints JSON; `yonder-pdf <command> --help` shows its parameters.')
  return lines.join('\n')
}

function commandHelp(cmd: Command): string {
  const lines = [`yonder-pdf ${cmd.name}`, '', cmd.description, '', `Scope: ${cmd.scope}   Needs --in: ${cmd.needsDoc ? 'yes' : 'no'}   Writes: ${cmd.produces === 'document' ? '--out / --in-place' : cmd.produces === 'file' ? '--out' : cmd.produces === 'files' ? '--out-dir' : 'nothing'}`, '', 'Parameters:']
  const schema = cmd.params
  if ('type' in schema && schema.type === 'object') {
    const req = new Set(schema.required ?? [])
    for (const [k, v] of Object.entries(schema.properties)) {
      const type = 'anyOf' in v ? v.anyOf.map((x) => ('type' in x ? x.type : 'any')).join('|') : v.type
      lines.push(`  --${kebab(k).padEnd(14)} ${type.padEnd(8)} ${req.has(k) ? '(required) ' : ''}${v.description ?? ''}`)
    }
  }
  if (POSITIONAL[cmd.name]) lines.push('', `Positional: ${POSITIONAL[cmd.name].join(' ')}`)
  if (cmd.examples?.length) lines.push('', 'Examples:', ...cmd.examples.map((e) => '  ' + e))
  return lines.join('\n')
}

function markdown(): string {
  const d = describe()
  const lines = ['# yonder-pdf command reference', '', `API version ${d.apiVersion}. Generated by \`yonder-pdf schema --markdown\`; do not edit by hand.`, '', 'Pages are 1-based. Coordinates are PDF points, origin bottom-left, unrotated page. Colours are hex (`#rrggbb`). Every command prints JSON.', '', '## Global options', '']
  for (const [k, v] of Object.entries(GLOBAL)) lines.push(`- \`--${k}\` — ${v.help}`)
  lines.push('', 'Exit codes: 0 ok · 1 failed · 2 usage/validation · 3 app not running · 4 conflict (output exists, same file, hash mismatch).', '')
  for (const g of groups()) {
    lines.push(`## ${g}`, '')
    for (const c of d.commands.filter((x) => x.group === g)) {
      lines.push(`### \`${c.name}\``, '', c.description, '', `Scope: ${c.scope} · needs \`--in\`: ${c.needsDoc ? 'yes' : 'no'} · writes: ${c.produces}`, '')
      if ('type' in c.params && c.params.type === 'object') {
        const req = new Set(c.params.required ?? [])
        const entries = Object.entries(c.params.properties)
        if (entries.length) {
          lines.push('| Parameter | Type | Description |', '|---|---|---|')
          for (const [k, v] of entries) {
            const type = 'anyOf' in v ? v.anyOf.map((x) => ('type' in x ? x.type : 'any')).join(' \\| ') : v.type
            lines.push(`| \`--${kebab(k)}\`${req.has(k) ? ' (required)' : ''} | ${type} | ${(v.description ?? '').replace(/\|/g, '\\|')} |`)
          }
          lines.push('')
        }
      }
      if (c.examples.length) lines.push('```', ...c.examples, '```', '')
    }
  }
  return lines.join('\n')
}

function print(value: unknown, compact: boolean): void {
  process.stdout.write((compact ? JSON.stringify(value) : JSON.stringify(value, null, 2)) + '\n')
}

export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgv(argv)
  const compact = parsed.options.json === true
  if (!parsed.command || (parsed.command === undefined && parsed.options.help)) {
    process.stdout.write(usage() + '\n')
    return parsed.options.help ? 0 : 2
  }
  if (parsed.command === 'version' || parsed.command === '--version') {
    print({ version: __YONDER_VERSION__, apiVersion: describe().apiVersion }, compact)
    return 0
  }
  if (parsed.command === 'schema') {
    if (parsed.params.markdown) process.stdout.write(markdown())
    else print(describe(), compact)
    return 0
  }
  if (parsed.command === 'mcp') {
    // Sibling bundle produced by vite.cli.config.ts; resolved at runtime.
    const mod = (await import(/* @vite-ignore */ new URL('./mcp.mjs', import.meta.url).href)) as { serve(): Promise<void> }
    await mod.serve()
    return 0
  }
  if (parsed.command === 'help') {
    process.stdout.write(usage() + '\n')
    return 0
  }
  const cmd = get(parsed.command)
  if (!cmd) {
    process.stderr.write(JSON.stringify({ error: { code: 'YP_USAGE', message: `Unknown command "${parsed.command}"`, hint: 'Run yonder-pdf --help' } }) + '\n')
    return 2
  }
  if (parsed.options.help) {
    process.stdout.write(commandHelp(cmd) + '\n')
    return 0
  }
  const params = { ...parsed.params }
  for (const [i, key] of (POSITIONAL[cmd.name] ?? []).entries()) if (parsed.positionals[i] !== undefined && params[key] === undefined) params[key] = parsed.positionals[i]
  try {
    if (parsed.options.doc) throw new YonderError('YP_APP_NOT_RUNNING', '--doc (live documents) is not available yet; use --in <file>')
    let password: string | undefined = process.env.YONDER_PDF_PASSWORD
    if (typeof parsed.options['password-file'] === 'string') password = readFileSync(parsed.options['password-file'], 'utf8').replace(/\r?\n$/, '')
    const opts: RunOptions = {
      in: str(parsed.options.in),
      out: str(parsed.options.out),
      outDir: str(parsed.options['out-dir']),
      inPlace: parsed.options['in-place'] === true,
      overwrite: parsed.options.overwrite === true,
      dryRun: parsed.options['dry-run'] === true,
      deterministic: parsed.options.deterministic === true,
      author: str(parsed.options.author),
      expectSha256: str(parsed.options['expect-sha256']),
      password
    }
    const res = await runHeadless(cmd.name, coerceParams(cmd, params), opts)
    print(res, compact)
    return 0
  } catch (err) {
    const e = toYonderError(err)
    process.stderr.write(JSON.stringify({ error: e.toJSON() }, null, compact ? 0 : 2) + '\n')
    return exitCodeFor(e.code)
  }
}

const str = (v: string | boolean | undefined): string | undefined => (typeof v === 'string' ? v : undefined)

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (err) => {
    process.stderr.write(JSON.stringify({ error: { code: 'YP_INTERNAL', message: err instanceof Error ? err.message : String(err) } }) + '\n')
    process.exitCode = 1
  }
)
