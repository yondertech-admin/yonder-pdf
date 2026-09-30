// Tiny JSON settings store in userData. No external dependency, atomic writes.
import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DEFAULT_SETTINGS, type NewSavedStamp, type RecentEntry, type SavedSignature, type SavedStamp, type Settings } from '@shared/api'
import { writeAtomic } from './documents'
import { assertEmbeddable, imageInfo } from '@core/images'
import { MAX_SAVED_STAMPS, MAX_STAMP_DATA_URL, normalizeStampLabel, validSavedStamp } from '@core/stamps'

interface StoreShape {
  settings: Settings
  recent: Array<RecentEntry & { path: string }>
  signatures: SavedSignature[]
  stamps: SavedStamp[]
}

const MAX_RECENT = 15
const MAX_SIGNATURES = 20
const MAX_SIGNATURE_DATA_URL = 600 * 1024


let cache: StoreShape | null = null
let writing: Promise<void> = Promise.resolve()

function filePath(): string {
  return join(app.getPath('userData'), 'yonder-pdf.json')
}

async function load(): Promise<StoreShape> {
  if (cache) return cache
  try {
    const raw = await fs.readFile(filePath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<StoreShape>
    cache = {
      settings: { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) },
      recent: Array.isArray(parsed.recent) ? parsed.recent : [],
      signatures: Array.isArray(parsed.signatures) ? parsed.signatures : [],
      stamps: (Array.isArray(parsed.stamps) ? parsed.stamps.slice(0, MAX_SAVED_STAMPS) : []).map(validSavedStamp).filter((x): x is SavedStamp => x !== null)
    }
  } catch {
    cache = { settings: { ...DEFAULT_SETTINGS }, recent: [], signatures: [], stamps: [] }
  }
  return cache
}

function persist(): Promise<void> {
  const snapshot = JSON.stringify(cache, null, 2)
  writing = writing.then(() => writeAtomic(filePath(), Buffer.from(snapshot, 'utf8'))).catch(() => undefined)
  return writing
}

export async function getSettings(): Promise<Settings> {
  return { ...(await load()).settings }
}

export async function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> {
  if (!(key in DEFAULT_SETTINGS)) throw new Error('Unknown setting')
  const expected = typeof DEFAULT_SETTINGS[key]
  if (typeof value !== expected) throw new Error('Invalid setting value')
  const s = await load()
  s.settings[key] = value
  await persist()
}

export async function getRecent(): Promise<Array<RecentEntry & { path: string }>> {
  return [...(await load()).recent]
}

export async function addRecent(path: string, name: string, location: string): Promise<void> {
  const s = await load()
  s.recent = s.recent.filter((r) => r.path !== path)
  s.recent.unshift({ id: randomUUID(), name, location, path, openedAt: Date.now() })
  s.recent = s.recent.slice(0, MAX_RECENT)
  app.addRecentDocument(path)
  await persist()
}

export async function removeRecent(id: string): Promise<void> {
  const s = await load()
  s.recent = s.recent.filter((r) => r.id !== id)
  await persist()
}

export async function clearRecent(): Promise<void> {
  const s = await load()
  s.recent = []
  app.clearRecentDocuments()
  await persist()
}

export async function listSignatures(): Promise<SavedSignature[]> {
  return [...(await load()).signatures]
}

export async function addSignature(sig: Omit<SavedSignature, 'id' | 'createdAt'>): Promise<SavedSignature> {
  if (sig.kind !== 'signature' && sig.kind !== 'initials') throw new Error('Invalid signature kind')
  if (typeof sig.dataUrl !== 'string' || !sig.dataUrl.startsWith('data:image/png;base64,')) {
    throw new Error('Signature must be a PNG data URL')
  }
  if (sig.dataUrl.length > MAX_SIGNATURE_DATA_URL) throw new Error('Signature image is too large')
  if (!Number.isFinite(sig.width) || !Number.isFinite(sig.height)) throw new Error('Invalid size')
  const s = await load()
  const entry: SavedSignature = {
    id: randomUUID(),
    kind: sig.kind,
    dataUrl: sig.dataUrl,
    width: Math.round(sig.width),
    height: Math.round(sig.height),
    createdAt: Date.now()
  }
  s.signatures.unshift(entry)
  s.signatures = s.signatures.slice(0, MAX_SIGNATURES)
  await persist()
  return entry
}

export async function removeSignature(id: string): Promise<void> {
  const s = await load()
  s.signatures = s.signatures.filter((x) => x.id !== id)
  await persist()
}

export async function listStamps(): Promise<SavedStamp[]> {
  return [...(await load()).stamps]
}

/** Validates everything that came from the renderer before it is persisted (REVIEW-07 #1). */
export async function addStamp(input: NewSavedStamp): Promise<SavedStamp> {
  if (!input || typeof input !== 'object') throw new Error('Invalid stamp')
  let entry: SavedStamp
  if (input.type === 'text') {
    if (typeof input.label !== 'string') throw new Error('Invalid stamp text')
    const label = normalizeStampLabel(input.label)
    if (typeof input.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(input.color)) throw new Error('Invalid stamp colour')
    entry = { id: randomUUID(), type: 'text', label, color: input.color.toLowerCase(), withName: input.withName === true, withDate: input.withDate === true, createdAt: Date.now() }
  } else if (input.type === 'image') {
    if (typeof input.dataUrl !== 'string') throw new Error('Invalid stamp image')
    const m = input.dataUrl.match(/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/)
    if (!m) throw new Error('Stamp image must be a PNG or JPEG data URL')
    if (input.dataUrl.length > MAX_STAMP_DATA_URL) throw new Error('Stamp image is too large')
    // Dimensions come from the image itself, never from the caller; the bytes must decode.
    const bytes = new Uint8Array(Buffer.from(m[2], 'base64'))
    const info = imageInfo(bytes)
    if (info.mime !== `image/${m[1]}`) throw new Error('Stamp image type does not match its data')
    await assertEmbeddable(bytes, info)
    entry = { id: randomUUID(), type: 'image', dataUrl: input.dataUrl, width: info.width, height: info.height, createdAt: Date.now() }
  } else throw new Error('Invalid stamp type')
  const s = await load()
  s.stamps.unshift(entry)
  s.stamps = s.stamps.slice(0, MAX_SAVED_STAMPS)
  await persist()
  return entry
}

export async function removeStamp(id: string): Promise<void> {
  const s = await load()
  s.stamps = s.stamps.filter((x) => x.id !== id)
  await persist()
}
