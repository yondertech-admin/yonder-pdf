// Read-only access to the app's settings file from the headless CLI (saved
// signatures). Same location Electron uses for userData; the app owns writes.
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SavedSignatureRef } from '@core/commands/context'

export function userDataDir(): string {
  if (process.env.YONDER_USER_DATA) return process.env.YONDER_USER_DATA
  const home = homedir()
  switch (process.platform) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'Yonder PDF')
    case 'win32':
      return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Yonder PDF')
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'Yonder PDF')
  }
}

export async function readSavedSignatures(): Promise<SavedSignatureRef[]> {
  try {
    const raw = JSON.parse(await fs.readFile(join(userDataDir(), 'yonder-pdf.json'), 'utf8')) as { signatures?: unknown }
    const list = Array.isArray(raw.signatures) ? raw.signatures : []
    return list.filter((x): x is SavedSignatureRef => !!x && typeof x === 'object' && typeof (x as SavedSignatureRef).id === 'string' && typeof (x as SavedSignatureRef).dataUrl === 'string')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}
