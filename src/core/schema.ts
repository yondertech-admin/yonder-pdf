// A deliberately small JSON Schema subset: enough to describe every command's
// parameters for agents (MCP tools, `schema` output) and to validate inputs
// before any writer runs. No external validator dependency.
export type Schema =
  | { type: 'object'; properties: Record<string, Schema>; required?: string[]; additionalProperties?: boolean; description?: string }
  | { type: 'string'; description?: string; enum?: string[]; pattern?: string; minLength?: number }
  | { type: 'number' | 'integer'; description?: string; minimum?: number; maximum?: number; exclusiveMinimum?: number }
  | { type: 'boolean'; description?: string }
  | { type: 'array'; items: Schema; description?: string; minItems?: number; maxItems?: number }
  | { anyOf: Schema[]; description?: string }

export const s = {
  obj: (properties: Record<string, Schema>, required: string[] = [], description?: string): Schema => ({ type: 'object', properties, required, additionalProperties: false, ...(description ? { description } : {}) }),
  /** An object with free-form keys (validated later by the consumer). */
  record: (description: string): Schema => ({ type: 'object', properties: {}, additionalProperties: true, description }),
  str: (description: string, extra: { enum?: string[]; pattern?: string; minLength?: number } = {}): Schema => ({ type: 'string', description, ...extra }),
  num: (description: string, extra: { minimum?: number; maximum?: number; exclusiveMinimum?: number } = {}): Schema => ({ type: 'number', description, ...extra }),
  int: (description: string, extra: { minimum?: number; maximum?: number } = {}): Schema => ({ type: 'integer', description, ...extra }),
  bool: (description: string): Schema => ({ type: 'boolean', description }),
  arr: (items: Schema, description: string, extra: { minItems?: number; maxItems?: number } = {}): Schema => ({ type: 'array', items, description, ...extra }),
  anyOf: (schemas: Schema[], description: string): Schema => ({ anyOf: schemas, description })
}

export function validate(schema: Schema, value: unknown, path = '$'): string[] {
  const errs: string[] = []
  if ('anyOf' in schema) {
    const attempts = schema.anyOf.map((sub) => validate(sub, value, path))
    if (!attempts.some((a) => a.length === 0)) errs.push(`${path}: no accepted form matched (${attempts.map((a) => a[0]).join(' | ')})`)
    return errs
  }
  switch (schema.type) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return [`${path}: expected an object`]
      const v = value as Record<string, unknown>
      for (const key of schema.required ?? []) if (v[key] === undefined) errs.push(`${path}.${key}: required`)
      for (const [key, sub] of Object.entries(v)) {
        if (sub === undefined) continue
        const ps = schema.properties[key]
        if (!ps) {
          if (schema.additionalProperties === false) errs.push(`${path}.${key}: unknown parameter`)
          continue
        }
        errs.push(...validate(ps, sub, `${path}.${key}`))
      }
      return errs
    }
    case 'string':
      if (typeof value !== 'string') return [`${path}: expected a string`]
      if (schema.enum && !schema.enum.includes(value)) errs.push(`${path}: must be one of ${schema.enum.join(', ')}`)
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) errs.push(`${path}: does not match ${schema.pattern}`)
      if (schema.minLength !== undefined && value.length < schema.minLength) errs.push(`${path}: must not be empty`)
      return errs
    case 'number':
    case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value)) return [`${path}: expected a finite number`]
      if (schema.type === 'integer' && !Number.isInteger(value)) errs.push(`${path}: expected an integer`)
      if (schema.minimum !== undefined && value < schema.minimum) errs.push(`${path}: must be ≥ ${schema.minimum}`)
      if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) errs.push(`${path}: must be > ${schema.exclusiveMinimum}`)
      if (schema.maximum !== undefined && value > schema.maximum) errs.push(`${path}: must be ≤ ${schema.maximum}`)
      return errs
    case 'boolean':
      return typeof value === 'boolean' ? [] : [`${path}: expected true or false`]
    case 'array': {
      if (!Array.isArray(value)) return [`${path}: expected an array`]
      if (schema.minItems !== undefined && value.length < schema.minItems) errs.push(`${path}: needs at least ${schema.minItems} item(s)`)
      if (schema.maxItems !== undefined && value.length > schema.maxItems) errs.push(`${path}: at most ${schema.maxItems} item(s)`)
      value.forEach((item, i) => errs.push(...validate(schema.items, item, `${path}[${i}]`)))
      return errs
    }
  }
}

/** Coerce CLI string values into the types the schema expects (numbers, booleans, JSON arrays/objects). */
export function coerce(schema: Schema, value: unknown): unknown {
  if (typeof value !== 'string') return value
  if ('anyOf' in schema) {
    for (const sub of schema.anyOf) {
      const c = coerce(sub, value)
      if (validate(sub, c).length === 0) return c
    }
    return value
  }
  switch (schema.type) {
    case 'number':
    case 'integer': {
      const n = Number(value)
      return value.trim() === '' || Number.isNaN(n) ? value : n
    }
    case 'boolean':
      return value === 'true' || value === '1' || value === 'yes' ? true : value === 'false' || value === '0' || value === 'no' ? false : value
    case 'array':
    case 'object':
      try {
        return JSON.parse(value)
      } catch {
        return schema.type === 'array' ? value.split(/\s*,\s*/).map((v) => coerce(schema.items, v)) : value
      }
    default:
      return value
  }
}
