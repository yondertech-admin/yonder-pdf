import { useEffect, useState, type ReactNode } from 'react'
import {
  ArrowRight,
  Circle,
  FolderOpen,
  Hand,
  Highlighter,
  Minus,
  MousePointer2,
  PanelLeft,
  Pen,
  PenTool,
  Printer,
  Redo2,
  RotateCw,
  Save,
  Search,
  Square,
  StickyNote,
  Strikethrough,
  Type,
  Underline,
  Undo2,
  ZoomIn,
  ZoomOut,
  CalendarDays,
  ChevronDown
} from 'lucide-react'
import { useActiveDoc, useStore } from '@/store/app'
import type { Tool } from '@core/types'

interface ToolDef {
  tool: Tool
  label: string
  icon: ReactNode
  key: string
}

const TOOLS: ToolDef[] = [
  { tool: 'select', label: 'Select', icon: <MousePointer2 />, key: 'V' },
  { tool: 'hand', label: 'Hand', icon: <Hand />, key: 'H' }
]
const MARKUP: ToolDef[] = [
  { tool: 'highlight', label: 'Highlight', icon: <Highlighter />, key: '1' },
  { tool: 'underline', label: 'Underline', icon: <Underline />, key: '2' },
  { tool: 'strikeout', label: 'Strikethrough', icon: <Strikethrough />, key: '3' },
  { tool: 'ink', label: 'Pen', icon: <Pen />, key: '4' }
]
const SHAPES: ToolDef[] = [
  { tool: 'rect', label: 'Rectangle', icon: <Square />, key: '5' },
  { tool: 'ellipse', label: 'Ellipse', icon: <Circle />, key: '6' },
  { tool: 'line', label: 'Line', icon: <Minus />, key: '7' },
  { tool: 'arrow', label: 'Arrow', icon: <ArrowRight />, key: '8' }
]
const TEXT: ToolDef[] = [
  { tool: 'text', label: 'Text box', icon: <Type />, key: 'T' },
  { tool: 'note', label: 'Sticky note', icon: <StickyNote />, key: 'N' }
]

function ToolButton({ def }: { def: ToolDef }): ReactNode {
  const tool = useStore((s) => s.tool)
  const color = useStore((s) => s.style.color)
  const setTool = useStore((s) => s.setTool)
  const doc = useActiveDoc()
  const colored = !['select', 'hand'].includes(def.tool)
  return (
    <button
      className={'tbtn' + (tool === def.tool ? ' active' : '') + (colored ? ' has-swatch' : '')}
      title={`${def.label} (${def.key})`}
      onClick={() => setTool(def.tool)}
      disabled={!doc || (colored && doc.readOnly)}
    >
      {def.icon}
      {colored && tool === def.tool && <span className="swatch" style={{ background: color }} />}
    </button>
  )
}

export function Toolbar(): ReactNode {
  const doc = useActiveDoc()
  const s = useStore()
  const [zoomText, setZoomText] = useState('')
  const [pageText, setPageText] = useState('')
  const [signMenu, setSignMenu] = useState(false)

  useEffect(() => setZoomText(doc ? `${Math.round(doc.zoom * 100)}%` : ''), [doc?.zoom, doc?.id])
  useEffect(() => setPageText(doc ? String(doc.currentPage + 1) : ''), [doc?.currentPage, doc?.id])

  const commitZoom = (): void => {
    const n = parseFloat(zoomText.replace('%', ''))
    if (Number.isFinite(n) && n > 0) s.setZoom(n / 100)
    else setZoomText(doc ? `${Math.round(doc.zoom * 100)}%` : '')
  }
  const commitPage = (): void => {
    const n = parseInt(pageText, 10)
    if (Number.isFinite(n) && doc) s.goToPage(n - 1)
    else setPageText(doc ? String(doc.currentPage + 1) : '')
  }

  const canEdit = Boolean(doc) && !doc?.readOnly
  return (
    <div className="toolbar">
      <div className="group">
        <button className="tbtn" title="Toggle sidebar (⌘⇧L)" onClick={() => s.setSidebar(!s.sidebarOpen)}>
          <PanelLeft />
        </button>
        <button className="tbtn" title="Open (⌘O)" onClick={() => void s.openDialog()}>
          <FolderOpen />
        </button>
        <button className="tbtn" title="Save (⌘S)" onClick={() => void s.save()} disabled={!canEdit}>
          <Save />
        </button>
        <button className="tbtn" title="Print (⌘P)" onClick={() => void s.print()} disabled={!doc}>
          <Printer />
        </button>
      </div>
      <span className="sep" />
      <div className="group">
        <button className="tbtn" title="Undo (⌘Z)" onClick={() => void s.undo()} disabled={!doc?.history.length}>
          <Undo2 />
        </button>
        <button className="tbtn" title="Redo (⇧⌘Z)" onClick={() => void s.redo()} disabled={!doc?.future.length}>
          <Redo2 />
        </button>
      </div>
      <span className="sep" />
      <div className="group">
        {TOOLS.map((t) => (
          <ToolButton key={t.tool} def={t} />
        ))}
      </div>
      <span className="sep" />
      <div className="group">
        {MARKUP.map((t) => (
          <ToolButton key={t.tool} def={t} />
        ))}
      </div>
      <span className="sep" />
      <div className="group">
        {SHAPES.map((t) => (
          <ToolButton key={t.tool} def={t} />
        ))}
      </div>
      <span className="sep" />
      <div className="group">
        {TEXT.map((t) => (
          <ToolButton key={t.tool} def={t} />
        ))}
      </div>
      <span className="sep" />
      <div className="group" style={{ position: 'relative' }}>
        <button className={'tbtn' + (s.tool === 'image' ? ' active' : '')} title="Sign" disabled={!canEdit} onClick={() => setSignMenu((v) => !v)}>
          <PenTool />
          <span>Sign</span>
          <ChevronDown size={12} />
        </button>
        {signMenu && (
          <div
            style={{
              position: 'absolute',
              top: 34,
              left: 0,
              zIndex: 30,
              background: 'var(--bg-elev)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              boxShadow: 'var(--shadow)',
              padding: 4,
              minWidth: 180,
              display: 'flex',
              flexDirection: 'column'
            }}
            onMouseLeave={() => setSignMenu(false)}
          >
            <button className="tbtn" style={{ justifyContent: 'flex-start' }} onClick={() => { setSignMenu(false); s.setDialog({ type: 'signature', kind: 'signature' }) }}>
              <PenTool /> Add signature…
            </button>
            <button className="tbtn" style={{ justifyContent: 'flex-start' }} onClick={() => { setSignMenu(false); s.setDialog({ type: 'signature', kind: 'initials' }) }}>
              <Type /> Add initials…
            </button>
            <button className="tbtn" style={{ justifyContent: 'flex-start' }} onClick={() => { setSignMenu(false); window.dispatchEvent(new CustomEvent('yonder:menu', { detail: 'sign:date' })) }}>
              <CalendarDays /> Add date
            </button>
          </div>
        )}
      </div>
      <span className="spacer" />
      <div className="group">
        <button className="tbtn" title="Rotate view (⌘R)" onClick={() => s.rotateView(90)} disabled={!doc}>
          <RotateCw />
        </button>
        <span className="sep" />
        <input
          className="page-field"
          value={pageText}
          disabled={!doc}
          onChange={(e) => setPageText(e.target.value)}
          onBlur={commitPage}
          onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget.blur(), commitPage())}
          aria-label="Page"
        />
        <span className="muted" style={{ padding: '0 4px' }}>
          / {doc?.pages.length ?? 0}
        </span>
        <span className="sep" />
        <button className="tbtn" title="Zoom out (⌘−)" onClick={() => s.zoomOut()} disabled={!doc}>
          <ZoomOut />
        </button>
        <input
          className="zoom-field"
          value={zoomText}
          disabled={!doc}
          onChange={(e) => setZoomText(e.target.value)}
          onBlur={commitZoom}
          onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget.blur(), commitZoom())}
          aria-label="Zoom"
        />
        <button className="tbtn" title="Zoom in (⌘+)" onClick={() => s.zoomIn()} disabled={!doc}>
          <ZoomIn />
        </button>
        <span className="sep" />
        <button className={'tbtn' + (s.find.open ? ' active' : '')} title="Find (⌘F)" onClick={() => s.setFind({ open: !s.find.open })} disabled={!doc}>
          <Search />
        </button>
      </div>
    </div>
  )
}
