import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useActiveDoc, useStore } from '@/store/app'
import { Modal, ExternalLink } from './ui'
import { SignatureDialog } from './SignatureDialog'
import { parsePageRanges } from '@core/pageOps'

export function Dialogs(): ReactNode {
  const dialog = useStore((s) => s.dialog)
  const setDialog = useStore((s) => s.setDialog)
  const close = (): void => setDialog(null)
  if (!dialog) return null
  switch (dialog.type) {
    case 'signature':
      return <SignatureDialog kind={dialog.kind} onClose={close} />
    case 'goToPage':
      return <GoToPage onClose={close} />
    case 'shortcuts':
      return <Shortcuts onClose={close} />
    case 'privacy':
      return <Privacy onClose={close} />
    case 'about':
      return <About onClose={close} />
    case 'extract':
      return <Extract onClose={close} />
    case 'split':
      return <Split onClose={close} />
    case 'note':
      return <NoteEditor id={dialog.id} onClose={close} />
    case 'password':
      return <Password reason={dialog.reason} name={dialog.name} resolve={dialog.resolve} />
  }
}

function GoToPage({ onClose }: { onClose: () => void }): ReactNode {
  const doc = useActiveDoc()
  const goToPage = useStore((s) => s.goToPage)
  const [v, setV] = useState(doc ? String(doc.currentPage + 1) : '1')
  const submit = (): void => {
    const n = parseInt(v, 10)
    if (Number.isFinite(n)) goToPage(n - 1)
    onClose()
  }
  return (
    <Modal
      title="Go to page"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit}>
            Go
          </button>
        </>
      }
    >
      <div className="field">
        <label>Page number (1–{doc?.pages.length ?? 1})</label>
        <input type="number" min={1} max={doc?.pages.length ?? 1} value={v} autoFocus onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      </div>
    </Modal>
  )
}

const SHORTCUTS: Array<[string, string]> = [
  ['Open / Save / Save As', '⌘O · ⌘S · ⇧⌘S'],
  ['Print', '⌘P'],
  ['Find', '⌘F  (↩ next, ⇧↩ previous)'],
  ['Undo / Redo', '⌘Z · ⇧⌘Z'],
  ['Zoom in / out', '⌘+ · ⌘−  (or ⌘ + scroll / pinch)'],
  ['Fit width / Fit page / Actual size', '⌘0 · ⌘9 · ⌘1'],
  ['Rotate view', '⌘R'],
  ['Rotate page', '⌘] · ⌘['],
  ['Next / previous page', '⌘↓ · ⌘↑'],
  ['Go to page', '⌘G'],
  ['Toggle sidebar', '⇧⌘L'],
  ['Select / Hand', 'V · H'],
  ['Highlight / Underline / Strikethrough / Pen', '1 · 2 · 3 · 4'],
  ['Rectangle / Ellipse / Line / Arrow', '5 · 6 · 7 · 8'],
  ['Text box / Sticky note', 'T · N'],
  ['Add signature', '⇧⌘G'],
  ['Delete selected annotation', '⌫'],
  ['Back to Select tool / deselect', 'Esc']
]

function Shortcuts({ onClose }: { onClose: () => void }): ReactNode {
  const mac = window.yonder.platform === 'darwin'
  const fmt = (s: string): string => (mac ? s : s.replace(/⌘/g, 'Ctrl+').replace(/⇧/g, 'Shift+').replace(/⌫/g, 'Del'))
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose}>
      <table className="kbd-table">
        <tbody>
          {SHORTCUTS.map(([what, keys]) => (
            <tr key={what}>
              <td>{what}</td>
              <td>
                <kbd>{fmt(keys)}</kbd>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  )
}

function Privacy({ onClose }: { onClose: () => void }): ReactNode {
  return (
    <Modal title="Privacy & ads" onClose={onClose}>
      <div className="prose">
        <p>
          <strong>Your documents stay on your computer.</strong> Yonder PDF has no accounts and no document backend. Files are read and written only when you
          open or save them. Nothing about your documents is ever uploaded.
        </p>
        <p>
          <strong>Ads keep the app free.</strong> The small banner at the bottom loads a page from <code>yondertech.net/yonderpdf/ad</code> in a sandboxed frame. That
          frame cannot read your documents, your files, or anything else in the app. Loading it does reveal your IP address to that host (and to the ad network
          it embeds), exactly like visiting a web page. When you are offline, a static message is shown instead.
        </p>
        <p>
          <strong>Updates come from GitHub.</strong> The app checks the GitHub Releases page of the open-source project for new versions. No other network
          requests are made.
        </p>
        <p>
          <strong>No analytics, no crash reporting.</strong> We do not collect usage data.
        </p>
        <p>
          Signatures you save are stored locally in the app's settings folder as images. "Signing" in this version is visual: it places an image of your
          signature in the document. Certificate-based digital signatures are planned for a future release.
        </p>
        <p>
          Source code: <ExternalLink href="https://github.com/yondertech-admin/yonder-pdf">github.com/yondertech-admin/yonder-pdf</ExternalLink>
        </p>
      </div>
    </Modal>
  )
}

function About({ onClose }: { onClose: () => void }): ReactNode {
  return (
    <Modal title="About Yonder PDF" onClose={onClose}>
      <div className="prose">
        <p>
          <strong>Yonder PDF</strong> {window.yonder.version} — free, open-source PDF viewer and editor for macOS, Windows and Linux.
        </p>
        <p>© 2026 Yonder Tech · MIT License</p>
        <p>
          Built with Electron, pdf.js and pdf-lib. Handwriting fonts: Dancing Script, Great Vibes, Homemade Apple and Caveat (SIL Open Font License).
        </p>
        <p>
          <ExternalLink href="https://github.com/yondertech-admin/yonder-pdf">Source code</ExternalLink> ·{' '}
          <ExternalLink href="https://github.com/yondertech-admin/yonder-pdf/issues">Report an issue</ExternalLink>
        </p>
      </div>
    </Modal>
  )
}

function Extract({ onClose }: { onClose: () => void }): ReactNode {
  const doc = useActiveDoc()
  const extract = useStore((s) => s.extractPages)
  const [v, setV] = useState(doc?.selectedPages.length ? doc.selectedPages.map((p) => p + 1).join(', ') : String((doc?.currentPage ?? 0) + 1))
  const [err, setErr] = useState('')
  const submit = (): void => {
    if (!doc) return
    try {
      const idx = parsePageRanges(v, doc.pages.length)
      if (!idx.length) throw new Error('Enter at least one page')
      onClose()
      void extract(idx)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <Modal
      title="Extract pages"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit}>
            Extract…
          </button>
        </>
      }
    >
      <div className="field">
        <label>Pages to extract into a new PDF (e.g. 1-3, 5, 8-10)</label>
        <input type="text" value={v} autoFocus onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
        {err && <div style={{ color: 'var(--danger)' }}>{err}</div>}
      </div>
      <div className="hint muted">Form fields on extracted pages are not carried over.</div>
    </Modal>
  )
}

function Split({ onClose }: { onClose: () => void }): ReactNode {
  const doc = useActiveDoc()
  const split = useStore((s) => s.splitDocument)
  const [every, setEvery] = useState('1')
  const n = Math.max(1, parseInt(every, 10) || 1)
  const parts = doc ? Math.ceil(doc.pages.length / n) : 0
  return (
    <Modal
      title="Split document"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={() => {
              onClose()
              void split(n)
            }}
          >
            Split into {parts} file{parts === 1 ? '' : 's'}…
          </button>
        </>
      }
    >
      <div className="field">
        <label>Pages per file</label>
        <input type="number" min={1} max={doc?.pages.length ?? 1} value={every} autoFocus onChange={(e) => setEvery(e.target.value)} />
      </div>
      <div className="hint muted">You will be asked for a folder; files are named after the document with a part number.</div>
    </Modal>
  )
}

function NoteEditor({ id, onClose }: { id: string; onClose: () => void }): ReactNode {
  const doc = useActiveDoc()
  const update = useStore((s) => s.updateAnnotation)
  const remove = useStore((s) => s.removeAnnotations)
  const a = doc?.annotations.find((x) => x.id === id)
  const [text, setText] = useState(a && 'text' in a ? a.text ?? '' : '')
  const pushed = useRef(false)
  useEffect(() => {
    if (!a) onClose()
  }, [a, onClose])
  if (!a) return null
  // Drafts are committed to document state on every change (one undo entry for the whole edit)
  // so Save/Print while the dialog is open never miss the text.
  const change = (v: string): void => {
    setText(v)
    update(id, { text: v } as never, { history: !pushed.current })
    pushed.current = true
  }
  const save = (): void => {
    if (!text.trim() && a.kind === 'note') remove([id])
    onClose()
  }
  return (
    <Modal
      title="Sticky note"
      onClose={save}
      footer={
        <>
          <button className="btn danger" onClick={() => { remove([id]); onClose() }}>
            Delete
          </button>
          <span style={{ flex: 1 }} />
          <button className="btn primary" onClick={save}>
            Done
          </button>
        </>
      }
    >
      <textarea autoFocus value={text} onChange={(e) => change(e.target.value)} placeholder="Write your note…" />
    </Modal>
  )
}

function Password({ reason, name, resolve }: { reason: 'need' | 'wrong'; name: string; resolve: (pw: string | null) => void }): ReactNode {
  const [pw, setPw] = useState('')
  return (
    <Modal
      title="Password required"
      onClose={() => resolve(null)}
      footer={
        <>
          <button className="btn" onClick={() => resolve(null)}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => resolve(pw)} disabled={!pw}>
            Open
          </button>
        </>
      }
    >
      <p style={{ margin: 0 }}>
        {reason === 'wrong' ? 'The password was incorrect. ' : ''}
        Enter the password to open <strong>{name}</strong>. It will open in read-only mode.
      </p>
      <input type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && pw && resolve(pw)} />
    </Modal>
  )
}
