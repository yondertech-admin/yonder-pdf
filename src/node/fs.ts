// File-system helpers shared by the Electron main process and the CLI.
import { promises as fs } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** Atomic write: temp file in the same directory, fsync, then rename over target. */
export async function writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
  const dir = dirname(path)
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`)
  // Keep the target's permissions (a private 0600 file must stay private); new files honour the umask.
  let mode = 0o666 & ~process.umask()
  try {
    mode = (await fs.stat(path)).mode & 0o777
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const fh = await fs.open(tmp, 'wx', 0o600)
  try {
    await fh.writeFile(bytes)
    await fh.sync()
    if (process.platform !== 'win32') await fh.chmod(mode)
  } finally {
    await fh.close()
  }
  try {
    await fs.rename(tmp, path)
  } catch (err) {
    await fs.rm(tmp, { force: true })
    throw err
  }
}

export async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

/** realpath when the file exists, else the resolved absolute path (for outputs that do not exist yet). */
export async function canonical(path: string): Promise<string> {
  try {
    return await fs.realpath(path)
  } catch {
    const dir = await fs.realpath(dirname(path)).catch(() => dirname(path))
    return join(dir, basename(path))
  }
}
