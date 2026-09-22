// "Install Command Line Tool…": symlink the packaged `yonder-pdf` shim into
// the user's PATH (design §14.4, §15 #20). ~/.local/bin first (no elevation),
// /usr/local/bin when writable. Refuses to link into a mounted DMG or a
// translocated copy, and only ever replaces links that point at a Yonder PDF
// bundle.
import { app, dialog, type BrowserWindow } from 'electron'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const LINK_NAME = 'yonder-pdf'

function shimPath(): string {
  return join(process.resourcesPath, 'bin', LINK_NAME)
}

async function candidates(): Promise<string[]> {
  const dirs = [join(homedir(), '.local', 'bin'), '/usr/local/bin']
  const out: string[] = []
  for (const d of dirs) {
    try {
      await fs.mkdir(d, { recursive: true })
      await fs.access(d, 2 /* W_OK */)
      out.push(d)
    } catch {
      /* not writable */
    }
  }
  return out
}

async function existingLink(path: string): Promise<'none' | 'ours' | 'foreign'> {
  try {
    const st = await fs.lstat(path)
    if (!st.isSymbolicLink()) return 'foreign'
    const target = await fs.readlink(path)
    return /Yonder PDF\.app\/Contents\/Resources\/bin\/yonder-pdf$/.test(target) || target === shimPath() ? 'ours' : 'foreign'
  } catch {
    return 'none'
  }
}

export async function installCli(win: BrowserWindow | null): Promise<void> {
  const msg = (message: string, detail: string, type: 'info' | 'error' | 'warning' = 'info'): Promise<unknown> => (win ? dialog.showMessageBox(win, { type, message, detail, buttons: ['OK'] }) : dialog.showMessageBox({ type, message, detail, buttons: ['OK'] }))
  if (!app.isPackaged) return void (await msg('Development build', 'Use `npm run cli -- <command>` while developing; the installer only exists in packaged builds.', 'warning'))
  const shim = shimPath()
  const appPath = app.getPath('exe')
  if (appPath.startsWith('/Volumes/') || appPath.includes('/AppTranslocation/')) return void (await msg('Move Yonder PDF to Applications first', 'The command line tool must point at a permanent copy of the app, not a mounted disk image or a quarantined copy.', 'warning'))
  try {
    await fs.access(shim, 1 /* X_OK */)
  } catch {
    return void (await msg('Command line tool not found', `Expected ${shim}. This build may have been packaged without it.`, 'error'))
  }
  const dirs = await candidates()
  if (!dirs.length) return void (await msg('No writable location', 'Neither ~/.local/bin nor /usr/local/bin is writable.', 'error'))
  const dir = dirs[0]
  const link = join(dir, LINK_NAME)
  const state = await existingLink(link)
  if (state === 'foreign') return void (await msg('A different yonder-pdf is already there', `${link} exists and was not created by Yonder PDF. Remove it first if you want the app to install its command there.`, 'warning'))
  if (state === 'ours') await fs.unlink(link)
  await fs.symlink(shim, link)
  const onPath = (process.env.PATH ?? '').split(':').includes(dir)
  await msg(`Installed ${LINK_NAME}`, `${link} → ${shim}\n\n${onPath ? 'Open a new terminal and run `yonder-pdf --help`.' : `Add ${dir} to your PATH (e.g. in ~/.zshrc: export PATH="${dir}:$PATH"), then run \`yonder-pdf --help\`.`}\n\nFor Claude Code: claude mcp add yonder-pdf -- ${link} mcp`)
}

export async function uninstallCli(win: BrowserWindow | null): Promise<void> {
  const removed: string[] = []
  for (const dir of [join(homedir(), '.local', 'bin'), '/usr/local/bin']) {
    const link = join(dir, LINK_NAME)
    if ((await existingLink(link)) === 'ours') {
      try {
        await fs.unlink(link)
        removed.push(link)
      } catch {
        /* not writable */
      }
    }
  }
  const opts = { type: 'info' as const, message: removed.length ? 'Command line tool removed' : 'Nothing to remove', detail: removed.join('\n') || 'No yonder-pdf link installed by Yonder PDF was found.', buttons: ['OK'] }
  await (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts))
}
