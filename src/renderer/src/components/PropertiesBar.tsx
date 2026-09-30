import type { ReactNode } from 'react'
import { Trash2 } from 'lucide-react'
import { useActiveDoc, useStore } from '@/store/app'
import { KIND_LABEL } from '@core/types'

const COLORS = ['#ffd400', '#ff9d00', '#e5484d', '#e93d82', '#8e4ec6', '#3b6ff5', '#0ea5e9', '#30a46c', '#1a1a1a', '#6b7280', '#ffffff', '#00000000', '#7c3aed', '#a16207']

/** Contextual properties for the active tool or selection. Hidden for select/hand with no selection. */
export function PropertiesBar(): ReactNode {
  const doc = useActiveDoc()
  const tool = useStore((s) => s.tool)
  const style = useStore((s) => s.style)
  const setStyle = useStore((s) => s.setStyle)
  const remove = useStore((s) => s.removeAnnotations)
  const setDialog = useStore((s) => s.setDialog)

  const selected = doc ? doc.annotations.filter((a) => doc.selectedIds.includes(a.id)) : []
  const kind = selected.length === 1 ? selected[0].kind : selected.length ? 'multiple' : tool
  const showFor = (k: string): boolean => (selected.length ? selected.some((a) => a.kind === k) : tool === k)
  const hasColor = !['select', 'hand', 'image', 'multiple'].includes(kind) || selected.some((a) => 'color' in a)
  const hasStroke = ['ink', 'rect', 'ellipse', 'line', 'arrow'].some(showFor)
  const hasFill = ['rect', 'ellipse'].some(showFor)
  const hasOpacity = ['highlight', 'underline', 'strikeout', 'ink', 'rect', 'ellipse', 'line', 'arrow', 'stamp'].some(showFor)
  const hasFont = showFor('text')

  if (!doc || ((tool === 'select' || tool === 'hand') && !selected.length)) return null
  if (tool === 'image' && !selected.length) {
    return (
      <aside className="props">
        <h4>Place</h4>
        <div className="hint">Click on the page to place it. Drag the corner handle afterwards to resize.</div>
      </aside>
    )
  }
  if (tool === 'stamp' && !selected.length) {
    return (
      <aside className="props">
        <h4>Place stamp</h4>
        <div className="hint">Click on the page to place the stamp. Hold Shift while clicking to place several. Select a stamp afterwards to move, resize or recolour it. Esc cancels.</div>
      </aside>
    )
  }

  return (
    <aside className="props">
      <h4>{selected.length ? (selected.length === 1 ? KIND_LABEL[selected[0].kind] : `${selected.length} selected`) : KIND_LABEL[kind as keyof typeof KIND_LABEL] ?? 'Tool'}</h4>
      {hasColor && (
        <div>
          <div className="row" style={{ marginBottom: 6 }}>
            <label>Color</label>
          </div>
          <div className="colors">
            {COLORS.filter((c) => c !== '#00000000').map((c) => (
              <button key={c} className={'color' + (style.color === c ? ' active' : '')} style={{ background: c }} onClick={() => setStyle({ color: c })} title={c} />
            ))}
            <input
              type="color"
              value={style.color.length === 7 ? style.color : '#000000'}
              onChange={(e) => setStyle({ color: e.target.value })}
              title="Custom color"
              style={{ width: 22, height: 22, padding: 0, border: 'none', background: 'transparent' }}
            />
          </div>
        </div>
      )}
      {hasFill && (
        <div>
          <div className="row" style={{ marginBottom: 6 }}>
            <label>Fill</label>
          </div>
          <div className="colors">
            <button className={'color none' + (style.fill === null ? ' active' : '')} onClick={() => setStyle({ fill: null })} title="No fill" />
            {COLORS.filter((c) => c !== '#00000000' && c !== '#1a1a1a').map((c) => (
              <button key={c} className={'color' + (style.fill === c ? ' active' : '')} style={{ background: c }} onClick={() => setStyle({ fill: c })} title={c} />
            ))}
          </div>
        </div>
      )}
      {hasStroke && (
        <div className="row">
          <label>Stroke</label>
          <input type="range" min={0.5} max={20} step={0.5} value={style.width} onChange={(e) => setStyle({ width: parseFloat(e.target.value) })} />
          <span className="val">{style.width}</span>
        </div>
      )}
      {hasOpacity && (
        <div className="row">
          <label>Opacity</label>
          <input type="range" min={0.1} max={1} step={0.05} value={style.opacity} onChange={(e) => setStyle({ opacity: parseFloat(e.target.value) })} />
          <span className="val">{Math.round(style.opacity * 100)}%</span>
        </div>
      )}
      {hasFont && (
        <div className="row">
          <label>Font size</label>
          <input type="range" min={6} max={72} step={1} value={style.fontSize} onChange={(e) => setStyle({ fontSize: parseInt(e.target.value, 10) })} />
          <span className="val">{style.fontSize}</span>
        </div>
      )}
      {selected.length === 1 && selected[0].kind === 'note' && (
        <button className="btn" onClick={() => setDialog({ type: 'note', id: selected[0].id })}>
          Edit note text
        </button>
      )}
      {selected.length > 0 && (
        <div className="btn-row">
          <button className="btn danger" onClick={() => remove(selected.map((a) => a.id))}>
            <Trash2 /> Delete
          </button>
        </div>
      )}
      {!selected.length && ['highlight', 'underline', 'strikeout'].includes(tool) && <div className="hint">Drag across text to mark it up.</div>}
      {!selected.length && tool === 'text' && <div className="hint">Click or drag on the page to add a text box.</div>}
      {!selected.length && tool === 'note' && <div className="hint">Click on the page to add a sticky note.</div>}
      {!selected.length && tool === 'rect' && <div className="hint">Note: a filled rectangle hides content visually but does not remove it. It is not redaction.</div>}
    </aside>
  )
}
