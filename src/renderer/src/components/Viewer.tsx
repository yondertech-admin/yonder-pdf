import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useStore, type Doc } from '@/store/app'
import { PageView } from './PageView'

const GAP = 14
const PAD = 14

interface Layout {
  tops: number[]
  widths: number[]
  heights: number[]
  total: number
}

export function Viewer({ doc }: { doc: Doc }): ReactNode {
  const tool = useStore((s) => s.tool)
  const setZoom = useStore((s) => s.setZoom)
  const setCurrentPage = useStore((s) => s.setCurrentPage)
  const select = useStore((s) => s.select)
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [scrollTop, setScrollTop] = useState(0)
  const [dragging, setDragging] = useState(false)
  const lastRequest = useRef<number>(0)

  // Container size → fit modes.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  const swap = doc.rotation % 180 !== 0
  const maxW = useMemo(() => Math.max(...doc.pages.map((p) => (swap ? p.height : p.width))), [doc.pages, swap])
  const maxH = useMemo(() => Math.max(...doc.pages.map((p) => (swap ? p.width : p.height))), [doc.pages, swap])

  useEffect(() => {
    if (!size.w || doc.zoomMode === 'custom') return
    const availW = size.w - PAD * 2 - 2
    const availH = size.h - PAD * 2 - 2
    const fitW = availW / maxW
    const z = doc.zoomMode === 'fit-width' ? fitW : Math.min(fitW, availH / maxH)
    if (Math.abs(z - doc.zoom) > 0.0005) setZoom(Math.max(0.1, z), doc.zoomMode)
  }, [size, doc.zoomMode, doc.zoom, maxW, maxH, setZoom])

  const layout: Layout = useMemo(() => {
    const tops: number[] = []
    const widths: number[] = []
    const heights: number[] = []
    let y = PAD
    for (const p of doc.pages) {
      const w = Math.round((swap ? p.height : p.width) * doc.zoom)
      const h = Math.round((swap ? p.width : p.height) * doc.zoom)
      tops.push(y)
      widths.push(w)
      heights.push(h)
      y += h + GAP
    }
    return { tops, widths, heights, total: y - GAP + PAD }
  }, [doc.pages, doc.zoom, swap])

  // Scroll requests (go to page).
  useEffect(() => {
    const r = doc.scrollRequest
    if (!r || r.token === lastRequest.current || !ref.current) return
    lastRequest.current = r.token
    ref.current.scrollTop = Math.max(0, layout.tops[r.page] - PAD)
  }, [doc.scrollRequest, layout])

  // Keep the same page in view when zoom changes.
  const prevZoom = useRef(doc.zoom)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || prevZoom.current === doc.zoom) return
    const ratio = doc.zoom / prevZoom.current
    prevZoom.current = doc.zoom
    if (el.scrollTop === 0) return // initial fit or at top: keep the top of the document in place
    const center = el.scrollTop + el.clientHeight / 2
    el.scrollTop = center * ratio - el.clientHeight / 2
  }, [doc.zoom])

  // Current page = page closest to the viewport centre.
  const onScroll = useCallback((): void => {
    const el = ref.current
    if (!el) return
    setScrollTop(el.scrollTop)
    const mid = el.scrollTop + el.clientHeight / 3
    let best = 0
    for (let i = 0; i < layout.tops.length; i++) {
      if (layout.tops[i] <= mid) best = i
      else break
    }
    setCurrentPage(best)
  }, [layout, setCurrentPage])
  useEffect(onScroll, [onScroll])

  // ⌘/Ctrl + wheel (and trackpad pinch) zooms.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const d = useStore.getState().docs.find((x) => x.id === doc.id)
      if (!d) return
      const factor = Math.exp(-e.deltaY * (e.ctrlKey && !e.metaKey ? 0.01 : 0.002))
      useStore.getState().setZoom(d.zoom * factor)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [doc.id])

  // Hand tool panning.
  const pan = useRef<{ x: number; y: number; sl: number; st: number } | null>(null)

  const viewportH = size.h
  const first = Math.max(0, layout.tops.findIndex((t, i) => t + layout.heights[i] >= scrollTop - viewportH))
  const visible = new Set<number>()
  for (let i = first; i < doc.pages.length; i++) {
    if (layout.tops[i] > scrollTop + viewportH * 2) break
    visible.add(i)
  }

  return (
    <div
      ref={ref}
      className={'viewer' + (tool === 'hand' ? ' hand' : '') + (dragging ? ' dragging' : '')}
      onScroll={onScroll}
      tabIndex={0}
      onPointerDown={(e) => {
        if (tool === 'hand' && ref.current) {
          pan.current = { x: e.clientX, y: e.clientY, sl: ref.current.scrollLeft, st: ref.current.scrollTop }
          setDragging(true)
          e.currentTarget.setPointerCapture(e.pointerId)
        } else if (tool === 'select' && !(e.target as HTMLElement).closest('.hit, .handle, .text-annot, .img-annot, .note-icon, .text-edit')) {
          if (doc.selectedIds.length) select([])
        }
      }}
      onPointerMove={(e) => {
        if (pan.current && ref.current) {
          ref.current.scrollLeft = pan.current.sl - (e.clientX - pan.current.x)
          ref.current.scrollTop = pan.current.st - (e.clientY - pan.current.y)
        }
      }}
      onPointerUp={() => {
        pan.current = null
        setDragging(false)
      }}
    >
      <div className="pages" style={{ height: layout.total, width: Math.max(size.w, Math.max(...layout.widths) + PAD * 2), position: 'relative', display: 'block', padding: 0 }}>
        {doc.pages.map((_, i) => (
          <div
            key={i}
            style={{
              position: 'absolute',
              top: layout.tops[i],
              left: Math.max(PAD, (size.w - layout.widths[i]) / 2),
              width: layout.widths[i],
              height: layout.heights[i]
            }}
          >
            <PageView doc={doc} index={i} width={layout.widths[i]} height={layout.heights[i]} visible={visible.has(i)} />
          </div>
        ))}
      </div>
    </div>
  )
}
