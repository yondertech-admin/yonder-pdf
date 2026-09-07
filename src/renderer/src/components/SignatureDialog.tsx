import { useEffect, useRef, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import type { SavedSignature } from '@shared/api'
import { Modal } from './ui'
import { useStore } from '@/store/app'
import { SIGNATURE_FONTS, finalizeSignature, loadImageFile, renderTypedSignature, type SignatureImage } from '@/pdf/signature'

type Mode = 'draw' | 'type' | 'image' | 'saved'
const INK_COLORS = ['#111111', '#1d4ed8', '#7f1d1d']

export function SignatureDialog({ kind, onClose }: { kind: 'signature' | 'initials'; onClose: () => void }): ReactNode {
  const setPendingImage = useStore((s) => s.setPendingImage)
  const signerName = useStore((s) => s.signerName)
  const setSignerName = useStore((s) => s.setSignerName)
  const [saved, setSaved] = useState<SavedSignature[]>([])
  const [mode, setMode] = useState<Mode>('draw')
  const [remember, setRemember] = useState(true)
  const [color, setColor] = useState(INK_COLORS[0])
  const [typed, setTyped] = useState(signerName)
  const [font, setFont] = useState(SIGNATURE_FONTS[0])
  const [image, setImage] = useState<SignatureImage | null>(null)
  const [removeWhite, setRemoveWhite] = useState(true)
  const [rawImage, setRawImage] = useState<ImageBitmap | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const strokes = useRef<Array<Array<{ x: number; y: number }>>>([])
  const drawing = useRef(false)

  useEffect(() => {
    void window.yonder.signatures.list().then((list) => {
      const mine = list.filter((s) => s.kind === kind)
      setSaved(mine)
      if (mine.length) setMode('saved')
    })
  }, [kind])

  // Canvas setup with device pixel ratio.
  useEffect(() => {
    if (mode !== 'draw') return
    const c = canvasRef.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    const rect = c.getBoundingClientRect()
    c.width = Math.round(rect.width * dpr)
    c.height = Math.round(rect.height * dpr)
    redraw()
  }, [mode])

  const redraw = (): void => {
    const c = canvasRef.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, c.width, c.height)
    // baseline guide
    ctx.strokeStyle = '#e5e7eb'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(24, c.height / dpr - 44)
    ctx.lineTo(c.width / dpr - 24, c.height / dpr - 44)
    ctx.stroke()
    ctx.strokeStyle = color
    ctx.lineWidth = 2.6
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (const s of strokes.current) {
      if (s.length < 2) {
        ctx.beginPath()
        ctx.arc(s[0].x, s[0].y, 1.3, 0, Math.PI * 2)
        ctx.fillStyle = color
        ctx.fill()
        continue
      }
      ctx.beginPath()
      ctx.moveTo(s[0].x, s[0].y)
      for (let i = 1; i < s.length - 1; i++) {
        const mx = (s[i].x + s[i + 1].x) / 2
        const my = (s[i].y + s[i + 1].y) / 2
        ctx.quadraticCurveTo(s[i].x, s[i].y, mx, my)
      }
      ctx.lineTo(s[s.length - 1].x, s[s.length - 1].y)
      ctx.stroke()
    }
  }
  useEffect(redraw, [color])

  const pos = (e: React.PointerEvent): { x: number; y: number } => {
    const r = canvasRef.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  // Preload handwriting fonts so previews and the rendered PNG use them.
  useEffect(() => {
    for (const f of SIGNATURE_FONTS) void document.fonts.load(`48px ${f.family}`).catch(() => undefined)
  }, [])

  const result = async (): Promise<SignatureImage | null> => {
    if (mode === 'draw') {
      const c = canvasRef.current
      if (!c || !strokes.current.length) return null
      // Re-render strokes without the guide line onto a clean canvas.
      const clean = document.createElement('canvas')
      clean.width = c.width
      clean.height = c.height
      const ctx = clean.getContext('2d')!
      const dpr = window.devicePixelRatio || 1
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.strokeStyle = color
      ctx.fillStyle = color
      ctx.lineWidth = 2.6
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      for (const s of strokes.current) {
        ctx.beginPath()
        if (s.length < 2) {
          ctx.arc(s[0].x, s[0].y, 1.3, 0, Math.PI * 2)
          ctx.fill()
          continue
        }
        ctx.moveTo(s[0].x, s[0].y)
        for (let i = 1; i < s.length - 1; i++) ctx.quadraticCurveTo(s[i].x, s[i].y, (s[i].x + s[i + 1].x) / 2, (s[i].y + s[i + 1].y) / 2)
        ctx.lineTo(s[s.length - 1].x, s[s.length - 1].y)
        ctx.stroke()
      }
      return finalizeSignature(clean)
    }
    if (mode === 'type') return await renderTypedSignature(typed, font.family, color)
    if (mode === 'image') return image
    return null
  }

  const use = async (img: SignatureImage | null, persist: boolean): Promise<void> => {
    if (!img) return
    if (persist) {
      try {
        await window.yonder.signatures.add({ kind, dataUrl: img.dataUrl, width: img.width, height: img.height })
      } catch {
        /* too large or invalid: still usable this session */
      }
    }
    if (mode === 'type' && typed.trim() && !signerName) setSignerName(typed.trim())
    setPendingImage({ dataUrl: img.dataUrl, width: img.width, height: img.height, role: kind })
    onClose()
  }

  const pickImage = async (): Promise<void> => {
    const files = await window.yonder.doc.importDialog('image', false)
    if (!files.length) return
    const f = files[0]
    const mime = f.name.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg'
    const bmp = await loadImageFile(f.bytes, mime)
    setRawImage(bmp)
  }
  useEffect(() => {
    if (rawImage) setImage(finalizeSignature(rawImage, { removeWhite }))
  }, [rawImage, removeWhite])

  const title = kind === 'signature' ? 'Add signature' : 'Add initials'
  const canUse = mode === 'draw' ? strokes.current.length > 0 : mode === 'type' ? typed.trim().length > 0 : mode === 'image' ? Boolean(image) : false
  const [, force] = useState(0)

  return (
    <Modal
      title={title}
      onClose={onClose}
      wide
      footer={
        mode === 'saved' ? (
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        ) : (
          <>
            <label className="check" style={{ marginRight: 'auto' }}>
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Save for later
            </label>
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" disabled={!canUse} onClick={() => void result().then((img) => use(img, remember))}>
              Place {kind}
            </button>
          </>
        )
      }
    >
      <div className="seg" style={{ alignSelf: 'flex-start' }}>
        {saved.length > 0 && (
          <button className={mode === 'saved' ? 'active' : ''} onClick={() => setMode('saved')}>
            Saved
          </button>
        )}
        <button className={mode === 'draw' ? 'active' : ''} onClick={() => setMode('draw')}>
          Draw
        </button>
        <button className={mode === 'type' ? 'active' : ''} onClick={() => setMode('type')}>
          Type
        </button>
        <button className={mode === 'image' ? 'active' : ''} onClick={() => setMode('image')}>
          Image
        </button>
      </div>

      {mode === 'saved' && (
        <div className="saved-sigs">
          {saved.map((s) => (
            <div key={s.id} className="saved-sig" onClick={() => void use({ dataUrl: s.dataUrl, width: s.width, height: s.height }, false)} title="Use this one">
              <img src={s.dataUrl} alt="" />
              <button
                className="x"
                title="Remove"
                onClick={async (e) => {
                  e.stopPropagation()
                  await window.yonder.signatures.remove(s.id)
                  setSaved((list) => list.filter((x) => x.id !== s.id))
                }}
              >
                <X />
              </button>
            </div>
          ))}
        </div>
      )}

      {mode === 'draw' && (
        <>
          <canvas
            ref={canvasRef}
            className="sig-canvas"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId)
              drawing.current = true
              strokes.current.push([pos(e)])
              redraw()
            }}
            onPointerMove={(e) => {
              if (!drawing.current) return
              const s = strokes.current[strokes.current.length - 1]
              const p = pos(e)
              const last = s[s.length - 1]
              if (Math.hypot(p.x - last.x, p.y - last.y) > 1) {
                s.push(p)
                redraw()
              }
            }}
            onPointerUp={() => {
              drawing.current = false
              force((n) => n + 1)
            }}
          />
          <div className="row" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {INK_COLORS.map((c) => (
              <button key={c} className={'color' + (color === c ? ' active' : '')} style={{ background: c }} onClick={() => setColor(c)} />
            ))}
            <span style={{ flex: 1 }} />
            <button
              className="btn"
              onClick={() => {
                strokes.current = []
                redraw()
                force((n) => n + 1)
              }}
            >
              Clear
            </button>
          </div>
        </>
      )}

      {mode === 'type' && (
        <>
          <input type="text" placeholder={kind === 'signature' ? 'Your name' : 'Your initials'} value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
          <div className="sig-typed" style={{ fontFamily: font.family, color }}>
            {typed || 'Preview'}
          </div>
          <div className="fonts">
            {SIGNATURE_FONTS.map((f) => (
              <button key={f.id} className={font.id === f.id ? 'active' : ''} style={{ fontFamily: f.family }} onClick={() => setFont(f)}>
                {typed.trim() ? typed.trim().slice(0, 12) : f.label}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {INK_COLORS.map((c) => (
              <button key={c} className={'color' + (color === c ? ' active' : '')} style={{ background: c }} onClick={() => setColor(c)} />
            ))}
          </div>
        </>
      )}

      {mode === 'image' && (
        <>
          <div className="sig-preview">{image ? <img src={image.dataUrl} alt="" /> : <span className="muted">Choose a PNG or JPEG of your signature</span>}</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn" onClick={() => void pickImage()}>
              Choose image…
            </button>
            <label className="check">
              <input type="checkbox" checked={removeWhite} onChange={(e) => setRemoveWhite(e.target.checked)} /> Remove white background
            </label>
          </div>
        </>
      )}
      <div className="hint muted" style={{ fontSize: 12 }}>
        Visual signing: the {kind} is placed as an image and permanently drawn into the page when you save. Certificate-based digital signatures are planned.
      </div>
    </Modal>
  )
}
