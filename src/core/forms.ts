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
  page: number
  rect?: number[]
  kidIds?: string[]
}

const mapType = (t: string): FieldType =>
  t === 'text' ? 'text' : t === 'checkbox' ? 'checkbox' : t === 'radiobutton' ? 'radio' : t === 'combobox' ? 'combobox' : t === 'listbox' ? 'listbox' : t === 'button' ? 'button' : t === 'signature' ? 'signature' : 'unknown'

async function rawFields(pdf: PDFDocumentProxy): Promise<RawField[]> {
  const raw = (await pdf.getFieldObjects()) as unknown
  const entries: Array<[string, RawField[]]> = raw instanceof Map ? [...raw.entries()] : raw && typeof raw === 'object' ? Object.entries(raw as Record<string, RawField[]>) : []
  const out: RawField[] = []
  for (const [, list] of entries) for (const f of list) if (f.page >= 0 && f.rect && f.type) out.push(f)
  return out
}

export async function listFields(pdf: PDFDocumentProxy): Promise<FieldInfo[]> {
  const fields = await rawFields(pdf)
  return fields.map((f) => {
    const [x0, y0, x1, y1] = f.rect as number[]
    const ev = Array.isArray(f.exportValues) ? f.exportValues[0] : f.exportValues
    return {
      id: f.id,
      name: f.name,
      type: mapType(f.type),
      value: f.value,
      ...(f.defaultValue !== undefined ? { defaultValue: f.defaultValue } : {}),
      ...(ev !== undefined ? { exportValue: ev } : {}),
      ...(f.items ? { options: f.items.map((it) => ({ value: it.exportValue, label: it.displayValue })) } : {}),
      readOnly: f.editable === false,
      ...(f.multiline ? { multiline: true } : {}),
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
  const applied: Array<{ name: string; ids: string[] }> = []
  const store = pdf.annotationStorage
  for (const [name, value] of Object.entries(values)) {
    const widgets = byName.get(name)
    if (!widgets) throw new YonderError('YP_NOT_FOUND', `No form field named "${name}"`, `Known fields: ${[...byName.keys()].join(', ') || '(none)'}`)
    if (widgets.some((w) => w.editable === false)) throw new YonderError('YP_UNSUPPORTED', `Field "${name}" is read-only`)
    const type = mapType(widgets[0].type)
    const ids: string[] = []
    switch (type) {
      case 'text':
      case 'combobox': {
        if (typeof value !== 'string') throw new YonderError('YP_INVALID_INPUT', `Field "${name}" takes a string`)
        for (const w of widgets) {
          store.setValue(w.id, { value })
          ids.push(w.id)
        }
        break
      }
      case 'listbox': {
        const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : null
        if (!list) throw new YonderError('YP_INVALID_INPUT', `Field "${name}" takes a string or a list of strings`)
        for (const w of widgets) {
          store.setValue(w.id, { value: list })
          ids.push(w.id)
        }
        break
      }
      case 'checkbox': {
        for (const w of widgets) {
          const ev = Array.isArray(w.exportValues) ? w.exportValues[0] : w.exportValues
          const on = typeof value === 'boolean' ? value : value === ev || value === 'true' || value === 'on'
          store.setValue(w.id, { value: on })
          ids.push(w.id)
        }
        break
      }
      case 'radio': {
        if (typeof value !== 'string') throw new YonderError('YP_INVALID_INPUT', `Field "${name}" takes the export value of the option to select`)
        const options = widgets.map((w) => (Array.isArray(w.exportValues) ? w.exportValues[0] : w.exportValues) ?? '')
        if (!options.includes(value)) throw new YonderError('YP_INVALID_INPUT', `"${value}" is not an option of "${name}"`, `Options: ${options.join(', ')}`)
        for (const w of widgets) {
          const ev = Array.isArray(w.exportValues) ? w.exportValues[0] : w.exportValues
          store.setValue(w.id, { value: ev === value })
          ids.push(w.id)
        }
        break
      }
      default:
        throw new YonderError('YP_UNSUPPORTED', `Field "${name}" (${type}) cannot be filled`)
    }
    applied.push({ name, ids })
  }
  const bytes = await pdf.saveDocument()
  return { bytes, applied }
}
