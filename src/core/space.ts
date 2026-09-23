// View space ↔ user space. Every coordinate the CLI/API accepts or reports is
// in *view space*: the page as displayed (after /Rotate and the CropBox
// offset), origin bottom-left, points. Annotations are stored in unrotated
// PDF user space (§4.1), so this converter sits at the boundary — built from
// the same pdf.js PageViewport the app uses (§12 #14), so scans with a
// /Rotate 270 flag get their stamp where the user sees the table.
import type { PageViewport } from 'pdfjs-dist'
import type { Point, Quad, Rect } from './types'

export class ViewSpace {
  constructor(private readonly vp: PageViewport) {}

  /** Displayed page size. */
  get width(): number {
    return this.vp.width
  }
  get height(): number {
    return this.vp.height
  }

  toUser(p: Point): Point {
    const [x, y] = this.vp.convertToPdfPoint(p.x, this.vp.height - p.y)
    return { x, y }
  }

  toView(p: Point): Point {
    const [x, yTop] = this.vp.convertToViewportPoint(p.x, p.y)
    return { x, y: this.vp.height - yTop }
  }

  rectToUser(r: Rect): Rect {
    return normalize(this.toUser({ x: r.x, y: r.y }), this.toUser({ x: r.x + r.width, y: r.y + r.height }))
  }

  rectToView(r: Rect): Rect {
    return normalize(this.toView({ x: r.x, y: r.y }), this.toView({ x: r.x + r.width, y: r.y + r.height }))
  }

  /** Quads keep their corner order (ul, ur, ll, lr as seen) but are re-expressed in the other space. */
  quadToUser(q: Quad): Quad {
    return mapQuad(q, (p) => this.toUser(p))
  }

  quadToView(q: Quad): Quad {
    return mapQuad(q, (p) => this.toView(p))
  }

  pathsToUser(paths: Point[][]): Point[][] {
    return paths.map((path) => path.map((p) => this.toUser(p)))
  }

  /** A displacement in view space expressed in user space. */
  deltaToUser(d: Point): Point {
    const o = this.toUser({ x: 0, y: 0 })
    const p = this.toUser(d)
    return { x: p.x - o.x, y: p.y - o.y }
  }
}

function normalize(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) }
}

function mapQuad(q: Quad, f: (p: Point) => Point): Quad {
  const out: number[] = []
  for (let i = 0; i < 8; i += 2) {
    const p = f({ x: q[i], y: q[i + 1] })
    out.push(p.x, p.y)
  }
  return out as Quad
}

export const roundRect = (r: Rect): Rect => ({ x: +r.x.toFixed(2), y: +r.y.toFixed(2), width: +r.width.toFixed(2), height: +r.height.toFixed(2) })
