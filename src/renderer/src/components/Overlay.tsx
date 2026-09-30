import { useEffect, useRef, useState, type ReactNode } from 'react'
import { MessageSquare } from 'lucide-react'
import type { PageViewport } from '@/pdf/pdfjs'
import { StampGraphic } from './StampGraphic'
import { useStore, type Doc } from '@/store/app'
import { arrowHeadPoints } from '@core/types'
import { defaultPlacement } from '@/pdf/signature'
import {
  NOTE_ICON_SIZE,
  boundsOf,
  canResize,
  newId,
  normalizeRect,
  translate,
  type Annotation,
  type ImageAnnotation,
  type LineAnnotation,
  type Point,
  type Rect,
  type TextAnnotation
} from '@core/types'

interface VRect {
  x: number
  y: number
  w: number
  h: number
}

type Handle = 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'e' | 'w'

type Gesture =
  | { type: 'draw'; start: Point; cur: Point }
  | { type: 'ink'; paths: Point[][]; last: Point }
  | { type: 'move'; id: string; start: Point; orig: Annotation; moved: boolean }
  | { type: 'resize'; id: string; handle: Handle; orig: Annotation; origBox: VRect; moved: boolean }
  | { type: 'end'; id: string; which: 'from' | 'to'; orig: LineAnnotation; moved: boolean }

export function Overlay({ doc, index, viewport }: { doc: Doc; index: number; viewport: PageViewport }): ReactNode {
  const tool = useStore((s) => s.tool)
  const style = useStore((s) => s.style)
  const pendingImage = useStore((s) => s.pendingImage)
  const pendingStamp = useStore((s) => s.pendingStamp)
  const find = useStore((s) => s.find)
  // Actions are stable references; read them once (zustand v5 requires stable selector snapshots).
  const actions = useRef({
    add: useStore.getState().addAnnotation,
    update: useStore.getState().updateAnnotation,
    select: useStore.getState().select,
    setPendingImage: useStore.getState().setPendingImage,
    setPendingStamp: useStore.getState().setPendingStamp,
    setDialog: useStore.getState().setDialog,
    setTool: useStore.getState().setTool,
    remove: useStore.getState().removeAnnotations
  }).current
  const root = useRef<SVGSVGElement>(null)
  const gesture = useRef<Gesture | null>(null)
  const [, bump] = useState(0)
  const rerender = (): void => bump((n) => n + 1)
  const [editing, setEditing] = useState<string | null>(null)
  const [hover, setHover] = useState<Point | null>(null)

  const z = doc.zoom
  const annots = doc.annotations.filter((a) => a.page === index)
  const selectable = tool === 'select' && !doc.readOnly

  const toV = (p: Point): Point => {
    const [x, y] = viewport.convertToViewportPoint(p.x, p.y)
    return { x, y }
  }
  const toP = (x: number, y: number): Point => {
    const [px, py] = viewport.convertToPdfPoint(x, y)
    return { x: px, y: py }
  }
  const rectToV = (r: Rect): VRect => {
    const a = toV({ x: r.x, y: r.y })
    const b = toV({ x: r.x + r.width, y: r.y + r.height })
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) }
  }
  const vToRect = (v: VRect): Rect => normalizeRect(toP(v.x, v.y), toP(v.x + v.w, v.y + v.h))
  const local = (e: { clientX: number; clientY: number }): Point => {
    const r = root.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  const pageRotate = doc.pages[index]?.rotate ?? 0
  /** On-screen rotation of content placed for orientation `placed` (page /Rotate at placement time). */
  const screenRot = (placed: number): number => ((pageRotate - placed + doc.rotation) % 360 + 360) % 360
  const contentDims = (b: VRect, placed: number): { cw: number; ch: number } => (screenRot(placed) % 180 ? { cw: b.h, ch: b.w } : { cw: b.w, ch: b.h })

  // Auto-open editor for freshly created text annotations.
  useEffect(() => {
    if (editing && !doc.annotations.some((a) => a.id === editing)) setEditing(null)
  }, [doc.annotations, editing])

  // ---------- gestures ----------
  const onPointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0 || doc.readOnly) return
    const p = local(e)
    if (tool === 'ink') {
      gesture.current = { type: 'ink', paths: [[toP(p.x, p.y)]], last: p }
      root.current!.setPointerCapture(e.pointerId)
      rerender()
    } else if (tool === 'rect' || tool === 'ellipse' || tool === 'line' || tool === 'arrow' || tool === 'text') {
      gesture.current = { type: 'draw', start: p, cur: p }
      root.current!.setPointerCapture(e.pointerId)
      rerender()
    } else if (tool === 'note') {
      const box: VRect = { x: p.x, y: p.y, w: NOTE_ICON_SIZE * z, h: NOTE_ICON_SIZE * z }
      const r = vToRect(box)
      const id = newId()
      actions.add({ id, page: index, createdAt: Date.now(), kind: 'note', at: { x: r.x, y: r.y + r.height }, text: '', color: style.color, rotate: pageRotate })
      actions.setTool('select')
      actions.setDialog({ type: 'note', id })
    } else if (tool === 'image' && pendingImage) {
      const { width, height } = defaultPlacement(pendingImage, pendingImage.role)
      const sw = (doc.rotation % 180 ? height : width) * z
      const sh = (doc.rotation % 180 ? width : height) * z
      const r = vToRect({ x: p.x - sw / 2, y: p.y - sh / 2, w: sw, h: sh })
      const id = newId()
      actions.add({ id, page: index, createdAt: Date.now(), kind: 'image', rect: r, dataUrl: pendingImage.dataUrl, role: pendingImage.role, rotate: pageRotate })
      actions.setPendingImage(null)
      actions.select([id])
    } else if (tool === 'stamp' && pendingStamp) {
      // Centre the stamp on the click, upright for the current view (like signatures).
      const sw = (doc.rotation % 180 ? pendingStamp.height : pendingStamp.width) * z
      const sh = (doc.rotation % 180 ? pendingStamp.width : pendingStamp.height) * z
      const r = vToRect({ x: p.x - sw / 2, y: p.y - sh / 2, w: sw, h: sh })
      actions.add({ id: newId(), page: index, createdAt: Date.now(), kind: 'stamp', rect: r, label: pendingStamp.label, ...(pendingStamp.sublabel ? { sublabel: pendingStamp.sublabel } : {}), color: pendingStamp.color, opacity: 1, ...(pendingStamp.preset ? { preset: pendingStamp.preset } : {}), rotate: pageRotate })
      // Shift-click keeps the stamp armed for the next page or spot (Esc to stop).
      if (!e.shiftKey) actions.setPendingStamp(null)
    }
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    const g = gesture.current
    if (tool === 'image' || tool === 'stamp') setHover(local(e))
    if (!g) return
    const p = local(e)
    switch (g.type) {
      case 'draw':
        g.cur = p
        rerender()
        break
      case 'ink':
        if (Math.hypot(p.x - g.last.x, p.y - g.last.y) >= 1.5) {
          g.paths[g.paths.length - 1].push(toP(p.x, p.y))
          g.last = p
          rerender()
        }
        break
      case 'move': {
        const cur = toP(p.x, p.y)
        const dx = cur.x - g.start.x
        const dy = cur.y - g.start.y
        if (!g.moved && Math.hypot(dx, dy) * z < 2) return
        if (!g.moved) {
          g.moved = true
          actions.update(g.id, {}, { history: true })
        }
        actions.update(g.id, translate(g.orig, dx, dy), { history: false })
        break
      }
      case 'resize': {
        if (!g.moved) {
          g.moved = true
          actions.update(g.id, {}, { history: true })
        }
        const b = { ...g.origBox }
        const h = g.handle
        const min = 6
        if (h.includes('w')) {
          const nx = Math.min(p.x, b.x + b.w - min)
          b.w = b.x + b.w - nx
          b.x = nx
        }
        if (h.includes('e')) b.w = Math.max(min, p.x - b.x)
        if (h.includes('n')) {
          const ny = Math.min(p.y, b.y + b.h - min)
          b.h = b.y + b.h - ny
          b.y = ny
        }
        if (h.includes('s')) b.h = Math.max(min, p.y - b.y)
        if (g.orig.kind === 'image') {
          // Keep aspect ratio, anchored on the opposite corner.
          const ratio = g.origBox.h / g.origBox.w
          const w = Math.max(b.w, b.h / ratio)
          const nh = w * ratio
          if (h.includes('w')) b.x = g.origBox.x + g.origBox.w - w
          if (h.includes('n')) b.y = g.origBox.y + g.origBox.h - nh
          b.w = w
          b.h = nh
        }
        actions.update(g.id, { rect: vToRect(b) } as Partial<Annotation>, { history: false })
        break
      }
      case 'end': {
        if (!g.moved) {
          g.moved = true
          actions.update(g.id, {}, { history: true })
        }
        actions.update(g.id, { [g.which]: toP(p.x, p.y) } as Partial<Annotation>, { history: false })
        break
      }
    }
  }

  const onPointerUp = (e: React.PointerEvent): void => {
    const g = gesture.current
    gesture.current = null
    if (!g) return
    const p = local(e)
    const base = { id: newId(), page: index, createdAt: Date.now() }
    if (g.type === 'draw') {
      const dist = Math.hypot(p.x - g.start.x, p.y - g.start.y)
      if (tool === 'text') {
        const h = (style.fontSize * 1.2 + 6) * z
        const w = 180 * z
        const box: VRect = dist > 10 ? { x: Math.min(g.start.x, p.x), y: Math.min(g.start.y, p.y), w: Math.abs(p.x - g.start.x), h: Math.abs(p.y - g.start.y) } : { x: g.start.x, y: g.start.y, w, h }
        const a: TextAnnotation = { ...base, kind: 'text', rect: vToRect(box), text: '', fontSize: style.fontSize, color: style.color, rotate: pageRotate }
        actions.add(a)
        setEditing(a.id)
      } else if (dist > 3) {
        if (tool === 'rect' || tool === 'ellipse') {
          actions.add({ ...base, kind: tool, rect: normalizeRect(toP(g.start.x, g.start.y), toP(p.x, p.y)), color: style.color, fill: style.fill, width: style.width, opacity: style.opacity })
        } else if (tool === 'line' || tool === 'arrow') {
          actions.add({ ...base, kind: tool, from: toP(g.start.x, g.start.y), to: toP(p.x, p.y), color: style.color, width: style.width, opacity: style.opacity })
        }
      }
    } else if (g.type === 'ink') {
      if (g.paths[0].length >= 1) actions.add({ ...base, kind: 'ink', paths: g.paths, color: style.color, width: style.width, opacity: style.opacity })
    }
    rerender()
  }

  const startMove = (e: React.PointerEvent, a: Annotation): void => {
    if (!selectable || e.button !== 0) return
    e.stopPropagation()
    const p = local(e)
    if (e.shiftKey) actions.select(doc.selectedIds.includes(a.id) ? doc.selectedIds.filter((x) => x !== a.id) : [...doc.selectedIds, a.id])
    else if (!doc.selectedIds.includes(a.id)) actions.select([a.id])
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    gesture.current = { type: 'move', id: a.id, start: toP(p.x, p.y), orig: a, moved: false }
  }
  const startResize = (e: React.PointerEvent, a: Annotation, handle: Handle): void => {
    e.stopPropagation()
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    gesture.current = { type: 'resize', id: a.id, handle, orig: a, origBox: rectToV(boundsOf(a)), moved: false }
  }
  const startEnd = (e: React.PointerEvent, a: LineAnnotation, which: 'from' | 'to'): void => {
    e.stopPropagation()
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    gesture.current = { type: 'end', id: a.id, which, orig: a, moved: false }
  }

  // ---------- rendering ----------
  const hitProps = (a: Annotation): Record<string, unknown> =>
    selectable ? { className: 'hit', onPointerDown: (e: React.PointerEvent) => startMove(e, a), style: { pointerEvents: 'auto' } } : { style: { pointerEvents: 'none' } }

  const renderSvg = (a: Annotation): ReactNode => {
    switch (a.kind) {
      case 'highlight':
      case 'underline':
      case 'strikeout':
        return (
          <g key={a.id} {...hitProps(a)} opacity={a.opacity} style={{ mixBlendMode: a.kind === 'highlight' ? 'multiply' : 'normal', ...(hitProps(a).style as object) }}>
            {a.quads.map((q, i) => {
              const ul = toV({ x: q[0], y: q[1] }),
                ur = toV({ x: q[2], y: q[3] }),
                ll = toV({ x: q[4], y: q[5] }),
                lr = toV({ x: q[6], y: q[7] })
              const t = Math.max(1, Math.hypot(ll.x - ul.x, ll.y - ul.y) * 0.07)
              if (a.kind === 'highlight') return <polygon key={i} points={`${ul.x},${ul.y} ${ur.x},${ur.y} ${lr.x},${lr.y} ${ll.x},${ll.y}`} fill={a.color} />
              // Underline along the bottom edge, strikeout through the middle (rotation-aware via interpolation).
              const f = a.kind === 'underline' ? 0.93 : 0.5
              const p1 = { x: ul.x + (ll.x - ul.x) * f, y: ul.y + (ll.y - ul.y) * f }
              const p2 = { x: ur.x + (lr.x - ur.x) * f, y: ur.y + (lr.y - ur.y) * f }
              return (
                <g key={i}>
                  <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke={a.color} strokeWidth={t} />
                  <polygon points={`${ul.x},${ul.y} ${ur.x},${ur.y} ${lr.x},${lr.y} ${ll.x},${ll.y}`} fill="transparent" />
                </g>
              )
            })}
          </g>
        )
      case 'ink': {
        const d = a.paths
          .map((path) => {
            const pts = path.map(toV)
            if (pts.length === 1) return `M${pts[0].x},${pts[0].y} L${pts[0].x + 0.1},${pts[0].y}`
            return 'M' + pts.map((p) => `${p.x},${p.y}`).join(' L')
          })
          .join(' ')
        return (
          <g key={a.id} {...hitProps(a)} opacity={a.opacity}>
            <path d={d} fill="none" stroke={a.color} strokeWidth={a.width * z} strokeLinecap="round" strokeLinejoin="round" />
            <path d={d} fill="none" stroke="transparent" strokeWidth={Math.max(12, a.width * z)} strokeLinecap="round" />
          </g>
        )
      }
      case 'rect': {
        const b = rectToV(a.rect)
        return <rect key={a.id} {...hitProps(a)} x={b.x} y={b.y} width={b.w} height={b.h} fill={a.fill ?? 'transparent'} stroke={a.color} strokeWidth={a.width * z} opacity={a.opacity} />
      }
      case 'ellipse': {
        const b = rectToV(a.rect)
        return <ellipse key={a.id} {...hitProps(a)} cx={b.x + b.w / 2} cy={b.y + b.h / 2} rx={b.w / 2} ry={b.h / 2} fill={a.fill ?? 'transparent'} stroke={a.color} strokeWidth={a.width * z} opacity={a.opacity} />
      }
      case 'line':
      case 'arrow': {
        const f = toV(a.from),
          t = toV(a.to)
        const head = a.kind === 'arrow' ? arrowHeadPoints(a.from, a.to, a.width).map(toV) : null
        return (
          <g key={a.id} {...hitProps(a)} opacity={a.opacity}>
            <line x1={f.x} y1={f.y} x2={t.x} y2={t.y} stroke={a.color} strokeWidth={a.width * z} strokeLinecap="round" />
            {head && <polygon points={`${t.x},${t.y} ${head[0].x},${head[0].y} ${head[1].x},${head[1].y}`} fill={a.color} stroke={a.color} strokeWidth={a.width * z} strokeLinejoin="round" />}
            <line x1={f.x} y1={f.y} x2={t.x} y2={t.y} stroke="transparent" strokeWidth={Math.max(12, a.width * z)} />
          </g>
        )
      }
      default:
        return null
    }
  }

  const renderHtml = (a: Annotation): ReactNode => {
    if (a.kind !== 'text' && a.kind !== 'image' && a.kind !== 'note' && a.kind !== 'stamp') return null
    const b = rectToV(boundsOf(a))
    const { cw, ch } = contentDims(b, a.rotate ?? pageRotate)
    const common: React.CSSProperties = {
      left: b.x + b.w / 2,
      top: b.y + b.h / 2,
      width: cw,
      height: ch,
      transform: `translate(-50%, -50%) rotate(${screenRot(a.rotate ?? pageRotate)}deg)`,
      pointerEvents: selectable ? 'auto' : 'none'
    }
    if (a.kind === 'text') {
      if (editing === a.id) return null
      return (
        <div key={a.id} className="text-annot" style={{ ...common, fontSize: a.fontSize * z, color: a.color }} onPointerDown={(e) => startMove(e, a)} onDoubleClick={() => selectable && setEditing(a.id)}>
          {a.text || <span style={{ opacity: 0.4 }}>Double-click to edit</span>}
        </div>
      )
    }
    if (a.kind === 'image') {
      return (
        <div key={a.id} className="img-annot" style={common} onPointerDown={(e) => startMove(e, a)}>
          <img src={a.dataUrl} alt={a.role} draggable={false} />
        </div>
      )
    }
    if (a.kind === 'stamp') {
      return (
        <div key={a.id} className="stamp-annot" style={common} onPointerDown={(e) => startMove(e, a)}>
          <StampGraphic label={a.label} sublabel={a.sublabel} color={a.color} opacity={a.opacity} width={Math.max(1, cw / z)} height={Math.max(1, ch / z)} />
        </div>
      )
    }
    return (
      <div key={a.id} className="note-icon" style={{ ...common, background: a.color }} title={a.text} onPointerDown={(e) => startMove(e, a)} onDoubleClick={() => selectable && actions.setDialog({ type: 'note', id: a.id })}>
        <MessageSquare />
      </div>
    )
  }

  const renderSelection = (a: Annotation): ReactNode => {
    const b = rectToV(boundsOf(a))
    const pad = 3
    const hs = 7
    const handles: Array<[Handle, number, number]> = [
      ['nw', b.x, b.y],
      ['ne', b.x + b.w, b.y],
      ['sw', b.x, b.y + b.h],
      ['se', b.x + b.w, b.y + b.h],
      ['n', b.x + b.w / 2, b.y],
      ['s', b.x + b.w / 2, b.y + b.h],
      ['e', b.x + b.w, b.y + b.h / 2],
      ['w', b.x, b.y + b.h / 2]
    ]
    const cursor: Record<Handle, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' }
    return (
      <g key={'sel-' + a.id}>
        <rect className="sel-box" x={b.x - pad} y={b.y - pad} width={b.w + pad * 2} height={b.h + pad * 2} />
        {canResize(a) &&
          handles
            .filter(([h]) => a.kind !== 'image' || h.length === 2)
            .map(([h, x, y]) => (
              <rect key={h} className="handle hit" x={x - hs / 2} y={y - hs / 2} width={hs} height={hs} style={{ cursor: cursor[h], pointerEvents: 'auto' }} onPointerDown={(e) => startResize(e, a, h)} />
            ))}
        {(a.kind === 'line' || a.kind === 'arrow') &&
          (['from', 'to'] as const).map((which) => {
            const p = toV(a[which])
            return <circle key={which} className="handle end hit" cx={p.x} cy={p.y} r={5} style={{ pointerEvents: 'auto' }} onPointerDown={(e) => startEnd(e, a, which)} />
          })}
      </g>
    )
  }

  const renderPreview = (): ReactNode => {
    const g = gesture.current
    if (!g) return null
    if (g.type === 'ink') {
      const d = g.paths.map((path) => 'M' + path.map(toV).map((p) => `${p.x},${p.y}`).join(' L')).join(' ')
      return <path d={d} fill="none" stroke={style.color} strokeWidth={style.width * z} strokeLinecap="round" strokeLinejoin="round" opacity={style.opacity} />
    }
    if (g.type === 'draw') {
      const x = Math.min(g.start.x, g.cur.x),
        y = Math.min(g.start.y, g.cur.y),
        w = Math.abs(g.cur.x - g.start.x),
        h = Math.abs(g.cur.y - g.start.y)
      if (tool === 'rect' || tool === 'text') return <rect x={x} y={y} width={w} height={h} fill={tool === 'text' ? 'rgba(59,111,245,0.08)' : (style.fill ?? 'transparent')} stroke={tool === 'text' ? 'var(--accent)' : style.color} strokeWidth={tool === 'text' ? 1 : style.width * z} strokeDasharray={tool === 'text' ? '4 3' : undefined} opacity={style.opacity} />
      if (tool === 'ellipse') return <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} fill={style.fill ?? 'transparent'} stroke={style.color} strokeWidth={style.width * z} opacity={style.opacity} />
      if (tool === 'line' || tool === 'arrow') {
        const head = tool === 'arrow' ? arrowHeadPoints(toP(g.start.x, g.start.y), toP(g.cur.x, g.cur.y), style.width).map(toV) : null
        return (
          <g opacity={style.opacity}>
            <line x1={g.start.x} y1={g.start.y} x2={g.cur.x} y2={g.cur.y} stroke={style.color} strokeWidth={style.width * z} strokeLinecap="round" />
            {head && <polygon points={`${g.cur.x},${g.cur.y} ${head[0].x},${head[0].y} ${head[1].x},${head[1].y}`} fill={style.color} />}
          </g>
        )
      }
    }
    return null
  }

  const pageMatches = find.open ? find.matches.map((m, i) => ({ m, i })).filter(({ m }) => m.page === index) : []
  const editingAnnot = editing ? (annots.find((a) => a.id === editing) as TextAnnotation | undefined) : undefined

  return (
    <>
      <svg
        ref={root}
        className="overlay"
        width={viewport.width}
        height={viewport.height}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => setHover(null)}
      >
        {pageMatches.map(({ m, i }) =>
          m.rects.map((r, k) => {
            const b = rectToV(r)
            return <rect key={`${i}-${k}`} className={'find-hit' + (i === find.current ? ' current' : '')} x={b.x} y={b.y} width={b.w} height={b.h} rx={2} />
          })
        )}
        {annots.map(renderSvg)}
        {renderPreview()}
        {selectable && annots.filter((a) => doc.selectedIds.includes(a.id)).map(renderSelection)}
      </svg>
      {/* Pointer capture on an HTML annotation retargets events to that element; handling them here (its ancestor) completes the gesture. */}
      <div className="overlay-html" onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
        {annots.map(renderHtml)}
        {editingAnnot && <TextEditor a={editingAnnot} box={rectToV(editingAnnot.rect)} dims={contentDims(rectToV(editingAnnot.rect), editingAnnot.rotate ?? pageRotate)} rotation={screenRot(editingAnnot.rotate ?? pageRotate)} zoom={z} onDone={(text) => { if (text.trim()) actions.update(editingAnnot.id, { text }); else actions.remove([editingAnnot.id]); setEditing(null) }} />}
        {tool === 'image' && pendingImage && hover && (() => {
          const { width, height } = defaultPlacement(pendingImage, pendingImage.role)
          const sw = (doc.rotation % 180 ? height : width) * z
          const sh = (doc.rotation % 180 ? width : height) * z
          return <img className="ghost-image" src={pendingImage.dataUrl} alt="" style={{ left: hover.x - sw / 2, top: hover.y - sh / 2, width: sw, height: sh, transform: `rotate(${doc.rotation}deg)` }} />
        })()}
        {tool === 'stamp' && pendingStamp && hover && (
          <div className="ghost-stamp" style={{ left: hover.x, top: hover.y, width: pendingStamp.width * z, height: pendingStamp.height * z, transform: `translate(-50%, -50%) rotate(${doc.rotation}deg)` }}>
            <StampGraphic label={pendingStamp.label} sublabel={pendingStamp.sublabel} color={pendingStamp.color} width={pendingStamp.width} height={pendingStamp.height} />
          </div>
        )}
      </div>
    </>
  )
}

function TextEditor({ a, box, dims, rotation, zoom, onDone }: { a: TextAnnotation; box: VRect; dims: { cw: number; ch: number }; rotation: number; zoom: number; onDone: (text: string) => void }): ReactNode {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [text, setText] = useState(a.text)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  return (
    <textarea
      ref={ref}
      className="text-edit"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => onDone(text)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') onDone(text)
      }}
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        left: box.x + box.w / 2,
        top: box.y + box.h / 2,
        width: dims.cw,
        height: dims.ch,
        transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
        fontSize: a.fontSize * zoom,
        color: a.color
      }}
    />
  )
}

export type { ImageAnnotation }
