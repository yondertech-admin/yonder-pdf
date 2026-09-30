import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, FilePlus, Images, List, MessageSquare, RotateCcw, RotateCw, Scissors, Trash2 } from 'lucide-react'
import { useActiveDoc, useStore, type Doc } from '@/store/app'
import { resolveDestination, type OutlineNode } from '@/pdf/pdfjs'
import { KIND_LABEL, type Annotation } from '@core/types'

export function Sidebar(): ReactNode {
  const tab = useStore((s) => s.sidebarTab)
  const setSidebar = useStore((s) => s.setSidebar)
  const doc = useActiveDoc()
  return (
    <aside className="sidebar">
      <div className="tabs">
        <button className={tab === 'thumbnails' ? 'active' : ''} onClick={() => setSidebar(true, 'thumbnails')} title="Pages">
          <Images /> Pages
        </button>
        <button className={tab === 'outline' ? 'active' : ''} onClick={() => setSidebar(true, 'outline')} title="Outline">
          <List /> Outline
        </button>
        <button className={tab === 'annotations' ? 'active' : ''} onClick={() => setSidebar(true, 'annotations')} title="Annotations">
          <MessageSquare /> Notes
        </button>
      </div>
      <div className="body">
        {!doc && <div className="empty">Open a document to see its pages.</div>}
        {doc && tab === 'thumbnails' && <Thumbnails key={doc.id + ':' + doc.reloadToken} doc={doc} />}
        {doc && tab === 'outline' && <Outline doc={doc} />}
        {doc && tab === 'annotations' && <AnnotationList doc={doc} />}
      </div>
      {doc && tab === 'thumbnails' && <PageActions doc={doc} />}
    </aside>
  )
}

function PageActions({ doc }: { doc: Doc }): ReactNode {
  const s = useStore()
  const n = doc.selectedPages.length
  const disabled = doc.readOnly
  const title = n ? `${n} selected` : `page ${doc.currentPage + 1}`
  return (
    <div className="actions">
      <button className="tbtn" title={`Rotate ${title} clockwise`} disabled={disabled} onClick={() => void s.rotatePages(null, 90)}>
        <RotateCw />
      </button>
      <button className="tbtn" title={`Rotate ${title} counterclockwise`} disabled={disabled} onClick={() => void s.rotatePages(null, -90)}>
        <RotateCcw />
      </button>
      <button className="tbtn" title="Insert blank page after current" disabled={disabled} onClick={() => void s.insertBlank(null)}>
        <FilePlus />
      </button>
      <button className="tbtn" title={`Extract ${title}`} onClick={() => void s.extractPages(n ? doc.selectedPages : [doc.currentPage])}>
        <Scissors />
      </button>
      <span style={{ flex: 1 }} />
      <button className="tbtn" title={`Delete ${title}`} disabled={disabled || doc.pages.length <= 1} onClick={() => void s.deletePages(null)}>
        <Trash2 />
      </button>
    </div>
  )
}

const THUMB_W = 140

function Thumbnails({ doc }: { doc: Doc }): ReactNode {
  const s = useStore()
  const container = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<{ from: number; over: number | null; after: boolean } | null>(null)
  const lastClick = useRef<number>(doc.currentPage)

  useEffect(() => {
    const el = container.current?.querySelector<HTMLElement>(`[data-index="${doc.currentPage}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [doc.currentPage])

  const onClick = (i: number, e: React.MouseEvent): void => {
    if (e.metaKey || e.ctrlKey) {
      const set = new Set(doc.selectedPages)
      if (set.has(i)) set.delete(i)
      else set.add(i)
      s.selectPages([...set].sort((a, b) => a - b))
    } else if (e.shiftKey) {
      const a = Math.min(lastClick.current, i)
      const b = Math.max(lastClick.current, i)
      s.selectPages(Array.from({ length: b - a + 1 }, (_, k) => a + k))
    } else {
      s.selectPages([])
      s.goToPage(i)
    }
    lastClick.current = i
  }

  const onDrop = (): void => {
    if (!drag || drag.over === null) return setDrag(null)
    const moving = doc.selectedPages.includes(drag.from) ? doc.selectedPages : [drag.from]
    const rest = doc.pages.map((_, i) => i).filter((i) => !moving.includes(i))
    let target = drag.over + (drag.after ? 1 : 0)
    target -= moving.filter((i) => i < target).length
    const order = [...rest.slice(0, target), ...moving, ...rest.slice(target)]
    setDrag(null)
    if (order.some((v, i) => v !== i)) void s.reorderPages(order)
  }

  return (
    <div className="thumbs" ref={container}>
      {doc.pages.map((p, i) => (
        <Thumb
          key={i}
          doc={doc}
          index={i}
          info={p}
          current={i === doc.currentPage}
          selected={doc.selectedPages.includes(i)}
          dropClass={drag && drag.over === i ? (drag.after ? 'drop-after' : 'drop-before') : ''}
          onClick={(e) => onClick(i, e)}
          draggable={!doc.readOnly}
          onDragStart={() => setDrag({ from: i, over: null, after: false })}
          onDragOver={(e) => {
            e.preventDefault()
            const r = e.currentTarget.getBoundingClientRect()
            const after = e.clientY > r.top + r.height / 2
            setDrag((d) => (d ? { ...d, over: i, after } : d))
          }}
          onDrop={onDrop}
          onDragEnd={() => setDrag(null)}
        />
      ))}
    </div>
  )
}

function Thumb(props: {
  doc: Doc
  index: number
  info: { width: number; height: number }
  current: boolean
  selected: boolean
  dropClass: string
  onClick: (e: React.MouseEvent) => void
  draggable: boolean
  onDragStart: () => void
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void
  onDrop: () => void
  onDragEnd: () => void
}): ReactNode {
  const { doc, index, info } = props
  const ref = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [visible, setVisible] = useState(false)
  const rotation = doc.rotation
  const swap = rotation % 180 !== 0
  const w = swap ? info.height : info.width
  const h = swap ? info.width : info.height
  const scale = THUMB_W / w
  const cssH = Math.round(h * scale)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver((entries) => setVisible(entries.some((e) => e.isIntersecting)), { rootMargin: '300px' })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    let task: { cancel: () => void } | null = null
    void (async () => {
      const page = await doc.pdf.getPage(index + 1)
      if (cancelled) return
      const vp = page.getViewport({ scale: scale * Math.min(2, window.devicePixelRatio), rotation: (page.rotate + rotation) % 360 })
      const canvas = canvasRef.current
      if (!canvas) return
      canvas.width = Math.ceil(vp.width)
      canvas.height = Math.ceil(vp.height)
      const t = page.render({ canvas, viewport: vp })
      task = t
      try {
        await t.promise
      } catch {
        /* cancelled */
      }
    })()
    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [visible, doc.pdf, index, scale, rotation])

  return (
    <div
      ref={ref}
      data-index={index}
      className={'thumb' + (props.current ? ' current' : '') + (props.selected ? ' selected' : '') + (props.dropClass ? ' ' + props.dropClass : '')}
      onClick={props.onClick}
      draggable={props.draggable}
      onDragStart={props.onDragStart}
      onDragOver={props.onDragOver}
      onDrop={props.onDrop}
      onDragEnd={props.onDragEnd}
    >
      {visible ? <canvas ref={canvasRef} style={{ width: THUMB_W, height: cssH }} /> : <div className="ph" style={{ width: THUMB_W, height: cssH }} />}
      <span className="label">{index + 1}</span>
    </div>
  )
}

function Outline({ doc }: { doc: Doc }): ReactNode {
  if (!doc.outline || doc.outline.length === 0) return <div className="empty">This document has no outline.</div>
  return (
    <div className="outline">
      {doc.outline.map((n, i) => (
        <OutlineItem key={i} node={n} doc={doc} depth={0} />
      ))}
    </div>
  )
}

function OutlineItem({ node, doc, depth }: { node: OutlineNode; doc: Doc; depth: number }): ReactNode {
  const [open, setOpen] = useState(depth < 1)
  const goToPage = useStore((s) => s.goToPage)
  const go = async (): Promise<void> => {
    const p = await resolveDestination(doc.pdf, node.dest)
    if (p !== null) goToPage(p)
  }
  return (
    <div>
      <div className="outline-item" style={{ paddingLeft: 6 + depth * 14 }} onClick={() => void go()} title={node.title}>
        {node.items.length ? (
          <button
            className="tw"
            onClick={(e) => {
              e.stopPropagation()
              setOpen((o) => !o)
            }}
          >
            {open ? <ChevronDown /> : <ChevronRight />}
          </button>
        ) : (
          <span className="tw" />
        )}
        <span className="title">{node.title}</span>
      </div>
      {open && node.items.map((c, i) => <OutlineItem key={i} node={c} doc={doc} depth={depth + 1} />)}
    </div>
  )
}

function AnnotationList({ doc }: { doc: Doc }): ReactNode {
  const s = useStore()
  const list = [...doc.annotations].sort((a, b) => a.page - b.page || a.createdAt - b.createdAt)
  if (!list.length) return <div className="empty">No annotations yet. Annotations already saved in the file are shown on the page but cannot be edited in this version.</div>
  const describe = (a: Annotation): string => {
    if ('text' in a && a.text) return a.text
    if (a.kind === 'image') return a.role
    if (a.kind === 'stamp') return a.sublabel ? `${a.label} — ${a.sublabel}` : a.label
    return ''
  }
  return (
    <div className="annot-list">
      {list.map((a) => (
        <div
          key={a.id}
          className={'annot-item' + (doc.selectedIds.includes(a.id) ? ' selected' : '')}
          onClick={() => {
            s.setTool('select')
            s.goToPage(a.page)
            s.select([a.id])
          }}
        >
          <span className="sw" style={{ background: 'color' in a ? a.color : 'var(--fg-faint)' }} />
          <div className="meta">
            <div className="k">
              {KIND_LABEL[a.kind]} <span className="muted" style={{ fontWeight: 400 }}>· p.{a.page + 1}</span>
            </div>
            {describe(a) && <div className="t">{describe(a)}</div>}
          </div>
          <button
            className="del"
            title="Delete"
            onClick={(e) => {
              e.stopPropagation()
              s.removeAnnotations([a.id])
            }}
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}
