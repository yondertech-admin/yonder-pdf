// Tiny JSON settings store in userData. No external dependency, atomic writes.
import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DEFAULT_SETTINGS, type RecentEntry, type SavedSignature, type Settings } from '@shared/api'
import { writeAtomic } from './documents'

interface StoreShape {
  settings: Settings
  recent: Array<RecentEntry & { path: string }>
  signatures: SavedSignature[]
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
      signatures: Array.isArray(parsed.signatures) ? parsed.signatures : []
    }
  } catch {
    cache = { settings: { ...DEFAULT_SETTINGS }, recent: [], signatures: [] }
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
