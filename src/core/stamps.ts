// Stamps (design §17): the standard set, default sizing, and the one layout
// function shared by the PDF writer and the on-screen overlay so a stamp looks
// the same while placing it and after saving.
import { sanitizeForWinAnsi } from './types'

export interface StampPreset {
  id: string
  label: string
  color: string
  /** Standard /Name for the Stamp annotation (PDF 32000-1 §12.5.6.12) when one exists. */
  pdfName?: string
  /** Adds "name · date" as a second line when placed. */
  dynamic?: boolean
}

const GREEN = '#1a7f37'
const RED = '#cf222e'
const BLUE = '#0969da'
const ORANGE = '#bc4c00'
const GRAY = '#57606a'
const AMBER = '#9a6700'

export const STAMP_PRESETS: StampPreset[] = [
  { id: 'approved', label: 'APPROVED', color: GREEN, pdfName: 'Approved' },
  { id: 'not-approved', label: 'NOT APPROVED', color: RED, pdfName: 'NotApproved' },
  { id: 'draft', label: 'DRAFT', color: GRAY, pdfName: 'Draft' },
  { id: 'final', label: 'FINAL', color: GREEN, pdfName: 'Final' },
  { id: 'completed', label: 'COMPLETED', color: GREEN },
  { id: 'confidential', label: 'CONFIDENTIAL', color: RED, pdfName: 'Confidential' },
  { id: 'for-public-release', label: 'FOR PUBLIC RELEASE', color: BLUE, pdfName: 'ForPublicRelease' },
  { id: 'not-for-public-release', label: 'NOT FOR PUBLIC RELEASE', color: RED, pdfName: 'NotForPublicRelease' },
  { id: 'for-comment', label: 'FOR COMMENT', color: BLUE, pdfName: 'ForComment' },
  { id: 'void', label: 'VOID', color: RED },
  { id: 'preliminary-results', label: 'PRELIMINARY RESULTS', color: BLUE },
  { id: 'information-only', label: 'INFORMATION ONLY', color: BLUE },
  { id: 'rejected', label: 'REJECTED', color: RED },
  { id: 'paid', label: 'PAID', color: GREEN },
  { id: 'received', label: 'RECEIVED', color: BLUE, dynamic: true },
  { id: 'reviewed', label: 'REVIEWED', color: BLUE, dynamic: true },
  { id: 'revised', label: 'REVISED', color: AMBER, dynamic: true },
  { id: 'sign-here', label: 'SIGN HERE', color: ORANGE },
  { id: 'initial-here', label: 'INITIAL HERE', color: ORANGE },
  { id: 'witness', label: 'WITNESS', color: ORANGE }
]

export const STAMP_COLORS = [GREEN, RED, BLUE, ORANGE, AMBER, GRAY, '#8250df', '#1a1a1a']

export const MAX_STAMP_LABEL = 60
export const MAX_STAMP_SUBLABEL = 80

/** Smallest box a stamp may be created in or resized to (points). */
export const MIN_STAMP_WIDTH = 24
export const MIN_STAMP_HEIGHT = 12

/** The text exactly as it is drawn: whitespace collapsed, unsupported characters shown as '?'. Shared by preview and writer. */
export function stampDisplayText(text: string): string {
  return sanitizeForWinAnsi(text.replace(/\s+/g, ' ').trim())
}

/** Normalise user input for a label; throws a plain Error with a user-facing message. */
export function normalizeStampLabel(input: string): string {
  const label = input.replace(/\s+/g, ' ').trim()
  if (!label) throw new Error('Stamp text must not be empty')
  if (label.length > MAX_STAMP_LABEL) throw new Error(`Stamp text is limited to ${MAX_STAMP_LABEL} characters`)
  return label
}

export type SavedStampEntry =
  | { id: string; type: 'text'; label: string; color: string; withName: boolean; withDate: boolean; createdAt: number }
  | { id: string; type: 'image'; dataUrl: string; width: number; height: number; createdAt: number }

export const MAX_SAVED_STAMPS = 40
export const MAX_STAMP_DATA_URL = 1536 * 1024

/** Runtime check for an entry read back from the settings file (the file is user-editable). Returns null when unusable. */
export function validSavedStamp(x: unknown): SavedStampEntry | null {
  if (!x || typeof x !== 'object') return null
  const e = x as Record<string, unknown>
  if (typeof e.id !== 'string' || !e.id || e.id.length > 80) return null
  const createdAt = typeof e.createdAt === 'number' && Number.isFinite(e.createdAt) ? e.createdAt : 0
  if (e.type === 'text') {
    if (typeof e.label !== 'string' || typeof e.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(e.color)) return null
    const label = e.label.replace(/\s+/g, ' ').trim()
    if (!label || label.length > MAX_STAMP_LABEL) return null
    return { id: e.id, type: 'text', label, color: e.color.toLowerCase(), withName: e.withName === true, withDate: e.withDate === true, createdAt }
  }
  if (e.type === 'image') {
    if (typeof e.dataUrl !== 'string' || !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(e.dataUrl) || e.dataUrl.length > MAX_STAMP_DATA_URL) return null
    if (typeof e.width !== 'number' || typeof e.height !== 'number' || !(e.width >= 1) || !(e.height >= 1) || !Number.isFinite(e.width) || !Number.isFinite(e.height)) return null
    return { id: e.id, type: 'image', dataUrl: e.dataUrl, width: Math.round(e.width), height: Math.round(e.height), createdAt }
  }
  return null
}

export function findPreset(id: string): StampPreset | undefined {
  const key = id.trim().toLowerCase().replace(/[\s_]+/g, '-')
  return STAMP_PRESETS.find((p) => p.id === key)
}

/** "Ada Lovelace · Sep 30, 2026" from whichever parts are present. */
export function stampSublabel(parts: { name?: string; date?: string }): string | undefined {
  const bits = [parts.name?.trim(), parts.date?.trim()].filter((x): x is string => Boolean(x))
  return bits.length ? bits.join(' · ') : undefined
}

/** Default placed size in points for a label (and optional second line). */
export function defaultStampSize(label: string, sublabel?: string): { width: number; height: number } {
  const height = sublabel ? 46 : 34
  const labelW = label.length * (sublabel ? 10.2 : 11.6)
  const subW = (sublabel?.length ?? 0) * 4.9
  const width = Math.min(380, Math.max(84, Math.max(labelW, subW) + 30))
  return { width: Math.round(width), height }
}

export interface StampLayout {
  /** Inset of the border from the box edge, its width and corner radius. */
  inset: number
  border: number
  radius: number
  label: { size: number; x: number; y: number }
  sublabel?: { size: number; x: number; y: number }
}

/** Cap height of Helvetica / Helvetica-Bold as a fraction of the font size. */
const CAP = 0.72

/**
 * Lay a stamp out inside a `w × h` box (origin bottom-left, y up). `measure`
 * returns the width of `text` at font size 1 — pdf-lib metrics in the writer,
 * canvas metrics on screen. Text is scaled to fit, so resizing a stamp rescales it.
 */
export function stampLayout(w: number, h: number, label: string, sublabel: string | undefined, measure: (text: string, bold: boolean) => number): StampLayout {
  // Every dimension derives from the box, so a very small box yields very small text rather than overflow.
  const border = Math.min(3, Math.max(0.25, h * 0.06), w * 0.1)
  const inset = Math.min(border / 2 + 0.5, w / 4, h / 4)
  const innerW = Math.max(0, w - 2 * inset)
  const innerH = Math.max(0, h - 2 * inset)
  const radius = Math.max(0, Math.min(h * 0.22, w * 0.12, 9, innerW / 2, innerH / 2))
  const padX = Math.min(Math.max(5, h * 0.22), w * 0.18)
  const availW = Math.max(0.01, w - 2 * (inset + border / 2 + padX))
  const availH = Math.max(0.01, h - 2 * (inset + border / 2))
  const labelW1 = Math.max(0.01, measure(label, true))
  if (!sublabel) {
    const size = Math.min((availH * 0.62) / CAP, availW / labelW1)
    return { inset, border, radius, label: { size, x: (w - labelW1 * size) / 2, y: (h - size * CAP) / 2 } }
  }
  const subW1 = Math.max(0.01, measure(sublabel, false))
  const size = Math.min((availH * 0.42) / CAP, availW / labelW1)
  const subSize = Math.min((availH * 0.2) / CAP, availW / subW1, size * 0.6)
  const gap = availH * 0.13
  const block = size * CAP + gap + subSize * CAP
  const bottom = (h - block) / 2
  return {
    inset,
    border,
    radius,
    label: { size, x: (w - labelW1 * size) / 2, y: bottom + subSize * CAP + gap },
    sublabel: { size: subSize, x: (w - subW1 * subSize) / 2, y: bottom }
  }
}

/** A /Name for the Stamp annotation: the standard icon name when the preset has one. */
export function stampPdfName(preset?: string): string {
  return (preset && findPreset(preset)?.pdfName) || 'Custom'
}
