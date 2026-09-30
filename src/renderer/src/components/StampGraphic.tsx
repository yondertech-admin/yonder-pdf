import type { ReactNode } from 'react'
import { stampDisplayText, stampLayout } from '@core/stamps'

let measureCtx: CanvasRenderingContext2D | null = null

/** Width of `text` at font size 1 in the stamp face (the PDF writer uses Helvetica metrics; these are within a few percent). */
export function measureStampText(text: string, bold: boolean): number {
  measureCtx ??= document.createElement('canvas').getContext('2d')
  if (!measureCtx) return text.length * (bold ? 0.62 : 0.5)
  measureCtx.font = `${bold ? '700' : '400'} 100px Helvetica, Arial, sans-serif`
  return measureCtx.measureText(text).width / 100
}

/**
 * A text stamp drawn with the same layout function the PDF writer uses
 * (design §17). `width`/`height` are in points; the SVG scales to its box.
 */
export function StampGraphic({ label: rawLabel, sublabel: rawSublabel, color, width, height, opacity = 1 }: { label: string; sublabel?: string; color: string; width: number; height: number; opacity?: number }): ReactNode {
  // Exactly the text the PDF writer draws: unsupported characters already shown as "?".
  const label = stampDisplayText(rawLabel) || ' '
  const sublabel = rawSublabel ? stampDisplayText(rawSublabel) : undefined
  const L = stampLayout(width, height, label, sublabel || undefined, measureStampText)
  const face = 'Helvetica, Arial, sans-serif'
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height="100%" preserveAspectRatio="none" style={{ display: 'block', opacity, overflow: 'hidden' }} aria-label={label}>
      <rect x={L.inset} y={L.inset} width={Math.max(0, width - 2 * L.inset)} height={Math.max(0, height - 2 * L.inset)} rx={L.radius} fill={color} fillOpacity={0.1} stroke={color} strokeWidth={L.border} />
      <text x={L.label.x} y={height - L.label.y} fontFamily={face} fontWeight={700} fontSize={L.label.size} fill={color}>
        {label}
      </text>
      {sublabel && L.sublabel && (
        <text x={L.sublabel.x} y={height - L.sublabel.y} fontFamily={face} fontSize={L.sublabel.size} fill={color}>
          {sublabel}
        </text>
      )}
    </svg>
  )
}
