// AcroForm listing and filling through pdf.js — the same backend the app uses
// (annotationStorage + saveDocument, design §12 #15–16, §15 #7), so appearance
// streams are generated identically in the app and headlessly.
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { YonderError } from './errors'
import type { Rect } from './types'

export type FieldType = 'text' | 'checkbox' | 'radio' | 'combobox' | 'listbox' | 'button' | 'signature' | 'unknown'

export interface FieldInfo {
  /** pdf.js widget id (e.g. "12R"); stable for a given file. */
  id: string
  name: string
  type: FieldType
  value: unknown
  defaultValue?: unknown
  /** Checkbox / radio export value. */
  exportValue?: string
  options?: Array<{ value: string; label: string }>
  readOnly: boolean
  multiline?: boolean
  /** Listbox: several options may be selected. */
  multiSelect?: boolean
  /** 0-based. */
  page: number
  rect: Rect
}

export type FieldValue = string | boolean | string[]

interface RawField {
  id: string
  name: string
  type: string
  value?: unknown
  defaultValue?: unknown
  exportValues?: string | string[]
  items?: Array<{ exportValue: string; displayValue: string }>
  editable?: boolean
  multiline?: boolean
  multipleSelection?: boolean
  page: number
  rect?: number[]
  kidIds?: string[]
}

const mapType = (t: string): FieldType =>
  t === 'text' ? 'text' : t === 'checkbox' ? 'checkbox' : t === 'radiobutton' ? 'radio' : t === 'combobox' ? 'combobox' : t === 'listbox' ? 'listbox' : t === 'button' ? 'button' : t === 'signature' ? 'signature' : 'unknown'

async function allFieldObjects(pdf: PDFDocumentProxy): Promise<RawField[]> {
  const raw = (await pdf.getFieldObjects()) as unknown
  const entries: Array<[string, RawField[]]> = raw instanceof Map ? [...raw.entries()] : raw && typeof raw === 'object' ? Object.entries(raw as Record<string, RawField[]>) : []
  const out: RawField[] = []
  for (const [, list] of entries) out.push(...list)
  return out
}

/** Widgets with geometry (what can be listed and filled). */
async function rawFields(pdf: PDFDocumentProxy): Promise<RawField[]> {
  return (await allFieldObjects(pdf)).filter((f) => f.page >= 0 && f.rect && f.type)
}

/** True when the document has any signature field, with or without a visible widget (§12 #17). */
export async function hasSignatureFields(pdf: PDFDocumentProxy): Promise<boolean> {
  return (await allFieldObjects(pdf)).some((f) => f.type === 'signature')
}

/** pdf.js field objects carry only the first selected value of a multi-select list box; the widget annotation has all of them. */
async function multiValues(pdf: PDFDocumentProxy, fields: RawField[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  const pages = new Set(fields.filter((f) => f.multipleSelection).map((f) => f.page))
  for (const pageIndex of pages) {
    const page = await pdf.getPage(pageIndex + 1)
    const annots = (await page.getAnnotations()) as Array<{ id: string; fieldValue?: unknown }>
    for (const a of annots) if (Array.isArray(a.fieldValue)) out.set(a.id, a.fieldValue.map(String))
  }
  return out
}

export async function listFields(pdf: PDFDocumentProxy): Promise<FieldInfo[]> {
  const fields = await rawFields(pdf)
  const multi = await multiValues(pdf, fields)
  return fields.map((f) => {
    const [x0, y0, x1, y1] = f.rect as number[]
    const ev = Array.isArray(f.exportValues) ? f.exportValues[0] : f.exportValues
    return {
      id: f.id,
      name: f.name,
      type: mapType(f.type),
      value: f.multipleSelection && multi.has(f.id) ? multi.get(f.id) : f.value,
      ...(f.defaultValue !== undefined ? { defaultValue: f.defaultValue } : {}),
      ...(ev !== undefined ? { exportValue: ev } : {}),
      ...(f.items ? { options: f.items.map((it) => ({ value: it.exportValue, label: it.displayValue })) } : {}),
      readOnly: f.editable === false,
      ...(f.multiline ? { multiline: true } : {}),
      ...(f.multipleSelection ? { multiSelect: true } : {}),
      page: f.page,
      rect: { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) }
    }
  })
}

/**
 * Set values in pdf.js's annotationStorage and serialise. Text: string;
 * checkbox: boolean or its export value; radio: the export value of the button
 * to select; combobox: string; listbox: string or string[]. Read-only fields
 * and unknown names are errors before anything is written.
 */
export async function fillFields(pdf: PDFDocumentProxy, values: Record<string, FieldValue>): Promise<{ bytes: Uint8Array; applied: Array<{ name: string; ids: string[] }> }> {
  const fields = await rawFields(pdf)
  const byName = new Map<string, RawField[]>()
  for (const f of fields) byName.set(f.name, [...(byName.get(f.name) ?? []), f])
  const known = [...byName.keys()]
  // Validate every assignment first so a bad one leaves the storage untouched.
  const plan: Array<{ name: string; writes: Array<{ id: string; value: unknown }> }> = []
  for (const [name, value] of Object.entries(values)) {
    const widgets = byName.get(name)
    if (!widgets) throw new YonderError('YP_NOT_FOUND', `No form field named "${name}"`, `Known fields: ${known.join(', ') || '(none)'}`)
    if (widgets.some((w) => w.editable === false)) throw new YonderError('YP_UNSUPPORTED', `Field "${name}" is read-only`)
    const type = mapType(widgets[0].type)
    const writes: Array<{ id: string; value: unknown }> = []
    const exportOf = (w: RawField): string | undefined => (Array.isArray(w.exportValues) ? w.exportValues[0] : w.exportValues)
    switch (type) {
      case 'text': {
        if (typeof value !== 'string') throw new YonderError('YP_INVALID_INPUT', `Field "${name}" takes a string`)
        for (const w of widgets) writes.push({ id: w.id, value })
        break
      }
      case 'combobox':
      case 'listbox': {
        const options = (widgets[0].items ?? []).map((it) => it.exportValue)
        const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : null
        if (!list) throw new YonderError('YP_INVALID_INPUT', `Field "${name}" takes a string${type === 'listbox' ? ' or a list of strings' : ''}`)
        if (type === 'combobox' && list.length !== 1) throw new YonderError('YP_INVALID_INPUT', `Field "${name}" is a combo box: give exactly one value`)
        if (type === 'listbox' && list.length > 1 && !widgets[0].multipleSelection) throw new YonderError('YP_INVALID_INPUT', `Field "${name}" allows a single selection`)
        const unknownValues = list.filter((v) => options.length && !options.includes(v))
        if (unknownValues.length) throw new YonderError('YP_INVALID_INPUT', `"${unknownValues[0]}" is not an option of "${name}"`, `Options: ${options.join(', ')}`)
        for (const w of widgets) writes.push({ id: w.id, value: type === 'combobox' ? list[0] : list })
        break
      }
      case 'checkbox': {
        for (const w of widgets) {
          const ev = exportOf(w)
          let on: boolean
          if (typeof value === 'boolean') on = value
          else if (value === 'true' || value === 'on' || (ev !== undefined && value === ev)) on = true
          else if (value === 'false' || value === 'off' || value === 'Off') on = false
          else throw new YonderError('YP_INVALID_INPUT', `Checkbox "${name}" takes true/false${ev ? ` or its export value "${ev}"` : ''}`)
          writes.push({ id: w.id, value: on })
        }
        break
      }
      case 'radio': {
        if (typeof value !== 'string') throw new YonderError('YP_INVALID_INPUT', `Field "${name}" takes the export value of the option to select`)
        const options = widgets.map((w) => exportOf(w) ?? '')
        if (!options.includes(value)) throw new YonderError('YP_INVALID_INPUT', `"${value}" is not an option of "${name}"`, `Options: ${options.join(', ')}`)
        for (const w of widgets) writes.push({ id: w.id, value: exportOf(w) === value })
        break
      }
      default:
        throw new YonderError('YP_UNSUPPORTED', `Field "${name}" (${type}) cannot be filled`)
    }
    plan.push({ name, writes })
  }
  const store = pdf.annotationStorage
  for (const { writes } of plan) for (const w of writes) store.setValue(w.id, { value: w.value })
  const bytes = await pdf.saveDocument()
  return { bytes, applied: plan.map((p) => ({ name: p.name, ids: p.writes.map((w) => w.id) })) }
}
