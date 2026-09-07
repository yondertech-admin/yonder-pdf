import { useState, type ReactNode } from 'react'
import { FileUp, FolderOpen, Layers, PenTool, ClipboardList, Clock } from 'lucide-react'
import { useStore } from '@/store/app'

export function Welcome(): ReactNode {
  const s = useStore()
  const [over, setOver] = useState(false)
  return (
    <div className="welcome">
      <div
        className={'drop' + (over ? ' over' : '')}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={() => setOver(false)}
      >
        <FileUp />
        <h1>Drop a PDF here</h1>
        <div>or</div>
        <button className="btn primary" onClick={() => void s.openDialog()}>
          <FolderOpen /> Open PDF…
        </button>
        <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
          View · annotate · sign · fill forms · organize pages
        </div>
      </div>
      <div>
        <h3>Quick actions</h3>
        <div className="quick">
          <button
            className="btn"
            onClick={async () => {
              await s.openDialog()
              if (useStore.getState().activeId) s.setDialog({ type: 'signature', kind: 'signature' })
            }}
          >
            <PenTool /> Sign a PDF
          </button>
          <button className="btn" onClick={() => void s.merge()}>
            <Layers /> Merge PDFs
          </button>
          <button className="btn" onClick={() => void s.openDialog()}>
            <ClipboardList /> Fill a form
          </button>
          <button className="btn" onClick={() => s.setDialog({ type: 'shortcuts' })}>
            <Clock /> Shortcuts
          </button>
        </div>
        <h3>Recent</h3>
        {s.recent.length === 0 ? (
          <div className="muted">No recent files yet.</div>
        ) : (
          <div className="recent">
            {s.recent.map((r) => (
              <button key={r.id} onClick={() => void s.openRecent(r.id)} title={r.location}>
                <span className="n">{r.name}</span>
                <span className="l">{r.location}</span>
              </button>
            ))}
            <button
              onClick={async () => {
                await window.yonder.doc.clearRecent()
                await s.refreshRecent()
              }}
            >
              <span className="l">Clear recent</span>
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
