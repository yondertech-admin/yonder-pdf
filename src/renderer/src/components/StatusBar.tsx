import type { ReactNode } from 'react'
import { useActiveDoc, useStore } from '@/store/app'

export function StatusBar(): ReactNode {
  const doc = useActiveDoc()
  const tool = useStore((s) => s.tool)
  const update = useStore((s) => s.updateStatus)
  return (
    <div className="statusbar">
      {doc ? (
        <>
          <span>
            Page {doc.currentPage + 1} of {doc.pages.length}
          </span>
          <span>{Math.round(doc.zoom * 100)}%</span>
          {doc.rotation !== 0 && <span>View rotated {doc.rotation}°</span>}
          {doc.annotations.length > 0 && <span>{doc.annotations.length} annotation{doc.annotations.length === 1 ? '' : 's'}</span>}
          {doc.readOnly && <span>Read-only</span>}
          <span className="muted">{tool === 'select' ? '' : `Tool: ${tool}`}</span>
        </>
      ) : (
        <span>No document open</span>
      )}
      <span className="spacer" />
      {update.state === 'available' && !update.canInstall && (
        <button className="btn" style={{ height: 20, fontSize: 11 }} onClick={() => void window.yonder.shell.openExternal(update.releaseUrl)}>
          Update {update.version} available
        </button>
      )}
      {update.state === 'downloading' && <span>Downloading update {update.percent}%</span>}
      {update.state === 'ready' && (
        <button
          className="btn"
          style={{ height: 20, fontSize: 11 }}
          onClick={() => void useStore.getState().closeAll().then((ok) => { if (ok) void window.yonder.update.install() })}
        >
          Restart to update to {update.version}
        </button>
      )}
      <span className="muted">Yonder PDF {window.yonder.version}</span>
    </div>
  )
}
