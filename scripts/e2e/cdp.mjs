// Minimal Chrome DevTools Protocol driver for end-to-end checks against the
// built app (`npm run build` first). Usage:
//   node scripts/e2e/cdp.mjs scripts/e2e/annotate.mjs [file.pdf]
// Scenarios receive { cdp, sleep, S } where S is a scratch directory.
import { spawn } from 'node:child_process'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const S = process.env.E2E_OUT ?? resolve(root, 'e2e-out')
mkdirSync(S, { recursive: true })
const port = Number(process.env.E2E_PORT ?? 9333)
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

class CDP {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)
      }
    }
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails)))
    return r.result.value
  }
  async shot(path) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(path, Buffer.from(r.data, 'base64'))
    console.log('screenshot', path)
  }
  async mouse(type, x, y, extra = {}) {
    await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra })
  }
  async click(x, y, opts = {}) {
    await this.mouse('mouseMoved', x, y)
    await this.mouse('mousePressed', x, y, opts)
    await this.mouse('mouseReleased', x, y, opts)
  }
  async drag(x1, y1, x2, y2, steps = 12) {
    await this.mouse('mouseMoved', x1, y1)
    await this.mouse('mousePressed', x1, y1)
    for (let i = 1; i <= steps; i++) {
      await this.mouse('mouseMoved', x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps, { buttons: 1 })
      await sleep(8)
    }
    await this.mouse('mouseReleased', x2, y2)
  }
  async key(key, extra = {}) {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, ...extra })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, ...extra })
  }
  async type(text) {
    for (const ch of text) await this.send('Input.dispatchKeyEvent', { type: 'char', text: ch })
  }
  async center(sel) {
    return this.eval(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, top: r.top, width: r.width, height: r.height } })()`)
  }
  async page(i = 0) {
    return this.center(`.page[data-page-index="${i}"]`)
  }
  /** Evaluate with `st` (store state) and `d` (active document) in scope. */
  async store(expr) {
    return this.eval(`(() => { const st = window.__yonderStore.getState(); const d = st.docs.find(x => x.id === st.activeId); return (${expr}) })()`)
  }
}

export async function launch(pdf, env = {}) {
  // Only processes this runner started earlier (recorded in e2e-out/.pids) are killed.
  const pidFile = resolve(S, '.pids')
  try {
    const { readFileSync, rmSync } = await import('node:fs')
    for (const pid of readFileSync(pidFile, 'utf8').split('\n').filter(Boolean)) {
      try {
        process.kill(Number(pid), 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
    rmSync(pidFile, { force: true })
    await sleep(400)
  } catch {
    /* no previous run */
  }
  // Launch the Electron binary itself (the node_modules/.bin shim would leave the real app orphaned on kill).
  const electronBin = createRequire(resolve(root, 'package.json'))('electron')
  const proc = spawn(electronBin, [`--remote-debugging-port=${port}`, '.', ...(pdf ? [pdf] : [])], {
    cwd: root,
    env: { ...process.env, YONDER_DEBUG: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  writeFileSync(pidFile, `${proc.pid}\n`, { flag: 'a' })
  proc.stdout.on('data', (d) => process.stdout.write('[app] ' + d))
  proc.stderr.on('data', (d) => {
    const t = String(d)
    if (!/task_policy|DevTools listening|trace-warnings|ERR_NAME_NOT_RESOLVED/.test(t)) process.stdout.write('[app] ' + t)
  })
  let list = []
  for (let i = 0; i < 40; i++) {
    try {
      list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      if (list.some((p) => p.type === 'page' && p.url.includes('index.html'))) break
    } catch {
      /* not up yet */
    }
    await sleep(400)
  }
  const target = list.find((p) => p.type === 'page' && p.url.includes('index.html'))
  if (!target) throw new Error('App window not found on the debugging port')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r) => (ws.onopen = r))
  const cdp = new CDP(ws)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  for (let i = 0; i < 60; i++) {
    const ok = await cdp.eval(pdf ? `!!document.querySelector('.page canvas')` : `!!document.querySelector('.welcome')`).catch(() => false)
    if (ok) break
    await sleep(300)
  }
  await sleep(1200)
  return { cdp, proc, sleep, S, close: () => { try { ws.close() } catch {} proc.kill('SIGKILL') } }
}

if (process.argv[1] && process.argv[1].endsWith('cdp.mjs') && process.argv[2]) {
  const app = await launch(process.argv[3] ?? resolve(root, 'test-fixtures/sample.pdf'))
  let failed = false
  try {
    const sc = await import(pathToFileURL(resolve(process.argv[2])).href)
    await sc.default({ ...app })
  } catch (e) {
    failed = true
    console.error('SCENARIO ERROR', e)
  } finally {
    app.close()
    setTimeout(() => process.exit(failed ? 1 : 0), 300)
  }
}
