import { useEffect, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { useActiveDoc, useStore } from '@/store/app'
import { useMenuCommands, runCommand } from '@/hooks/useMenuCommands'
import { Toolbar } from '@/components/Toolbar'
import { Sidebar } from '@/components/Sidebar'
import { Viewer } from '@/components/Viewer'
import { PropertiesBar } from '@/components/PropertiesBar'
import { FindBar } from '@/components/FindBar'
import { Welcome } from '@/components/Welcome'
import { StatusBar } from '@/components/StatusBar'
import { AdSlot } from '@/components/AdSlot'
import { Dialogs } from '@/components/Dialogs'
import { Banners } from '@/components/Banner'
import type { MenuCommand, OpenedFile } from '@shared/api'

const KEY_TOOLS: Record<string, MenuCommand> = {
  v: 'tool:select',
  h: 'tool:hand',
  '1': 'tool:highlight',
  '2': 'tool:underline',
  '3': 'tool:strikeout',
  '4': 'tool:ink',
  '5': 'tool:rect',
  '6': 'tool:ellipse',
  '7': 'tool:line',
  '8': 'tool:arrow',
  t: 'tool:text',
  n: 'tool:note'
}

function isTyping(): boolean {
  const el = document.activeElement as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

export function App(): ReactNode {
  const s = useStore()
  const doc = useActiveDoc()
  const [dropping, setDropping] = useState(false)
  useMenuCommands()

  useEffect(() => {
    void s.init()
    const offs = [
      window.yonder.on('open-files', (files: OpenedFile[]) => void useStore.getState().openFiles(files)),
      window.yonder.on('close-request', () => {
        void useStore.getState().closeAll().then((ok) => ok && window.yonder.window.closeConfirmed())
      }),
      window.yonder.on('update-status', (st) => {
        useStore.getState().setUpdateStatus(st)
        if (st.state === 'none') useStore.getState().showToast('You are on the latest version.')
        if (st.state === 'error') useStore.getState().showToast(`Update check failed: ${st.message}`, 'error')
      }),
      window.yonder.on('fullscreen', (v) => useStore.getState().setFullscreen(v))
    ]
    window.yonder.window.ready()
    return () => offs.forEach((off) => off())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Theme.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => {
      const dark = s.theme === 'dark' || (s.theme === 'system' && mq.matches)
      document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [s.theme])

  // Keyboard shortcuts not covered by menu accelerators.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isTyping()) return
      const st = useStore.getState()
      const d = st.docs.find((x) => x.id === st.activeId)
      if (e.key === 'Escape') {
        if (st.find.open) st.setFind({ open: false, matches: [], current: -1 })
        else if (st.tool !== 'select') st.setTool('select')
        else if (d?.selectedIds.length) st.select([])
        else if (d?.selectedPages.length) st.selectPages([])
        return
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && d?.selectedIds.length) {
        e.preventDefault()
        st.removeAnnotations(d.selectedIds)
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const cmd = KEY_TOOLS[e.key.toLowerCase()]
      if (cmd && d) {
        e.preventDefault()
        runCommand(cmd)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Drag & drop anywhere in the window.
  useEffect(() => {
    let depth = 0
    const over = (e: DragEvent): void => {
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const enter = (e: DragEvent): void => {
      e.preventDefault()
      depth++
      if (Array.from(e.dataTransfer?.items ?? []).some((i) => i.kind === 'file')) setDropping(true)
    }
    const leave = (): void => {
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDropping(false)
    }
    const drop = async (e: DragEvent): Promise<void> => {
      e.preventDefault()
      depth = 0
      setDropping(false)
      const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'))
      const opened: OpenedFile[] = []
      for (const f of files) {
        const r = await window.yonder.doc.openDropped(f)
        if (r) opened.push(r)
      }
      if (opened.length) await useStore.getState().openFiles(opened)
    }
    window.addEventListener('dragover', over)
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
  }, [])

  // Mark document dirty when AcroForm values change (pdf.js annotationStorage).
  useEffect(() => {
    if (!doc) return
    const storage = doc.pdf.annotationStorage as unknown as { onSetModified: (() => void) | null }
    storage.onSetModified = () => useStore.getState().markFormEdited(doc.id)
    return () => {
      storage.onSetModified = null
    }
  }, [doc?.pdf, doc?.id, doc?.name])

  const isMac = window.yonder.platform === 'darwin'
  return (
    <div className="app">
      <div className={'titlebar' + (isMac && !s.fullscreen ? '' : ' no-inset')}>
        {(!isMac || s.docs.length === 0) && <span className="brand">Yonder PDF</span>}
        <div className="tabs">
          {s.docs.map((d) => (
            <div key={d.id} className={'tab' + (d.id === s.activeId ? ' active' : '')} onClick={() => s.setActive(d.id)} onAuxClick={(e) => e.button === 1 && void s.closeDoc(d.id)} title={d.location ? `${d.location}/${d.name}` : d.name}>
              {d.dirty && <span className="dot" />}
              <span className="name">{d.name}</span>
              <button
                className="close"
                title="Close"
                onClick={(e) => {
                  e.stopPropagation()
                  void s.closeDoc(d.id)
                }}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      </div>
      <Toolbar />
      <div className="main" style={{ position: 'relative' }}>
        {s.sidebarOpen ? <Sidebar /> : <div />}
        {doc ? (
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
            <Banners />
            <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex' }}>
              <Viewer key={doc.id} doc={doc} />
              <FindBar />
            </div>
          </div>
        ) : (
          <Welcome />
        )}
        <PropertiesBar />
      </div>
      <div className="bottom">
        <StatusBar />
        <AdSlot />
      </div>
      <Dialogs />
      {s.toast && <div className={'toast' + (s.toast.kind === 'error' ? ' error' : '')}>{s.toast.text}</div>}
      {s.busy && (
        <div className="busy">
          <div className="card">
            <div>{s.busy.label}</div>
            {s.busy.percent !== undefined && <progress max={100} value={s.busy.percent} />}
            {s.busy.cancel && (
              <button className="btn" onClick={s.busy.cancel} style={{ alignSelf: 'flex-end' }}>
                Cancel
              </button>
            )}
          </div>
        </div>
      )}
      {dropping && <div className="drop-overlay">Drop PDF files to open</div>}
    </div>
  )
}
