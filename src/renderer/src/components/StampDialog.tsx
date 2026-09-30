// Stamp dialog (design §17): standard stamps, custom text stamps and image
// stamps, with a small saved library. Picking one arms the placing tool; the
// next click on a page drops it.
import { useEffect, useState, type ReactNode } from 'react'
import { ImagePlus, X } from 'lucide-react'
import type { SavedStamp } from '@shared/api'
import { imageInfo } from '@core/images'
import { MAX_STAMP_LABEL, STAMP_COLORS, STAMP_PRESETS, defaultStampSize, stampSublabel, type StampPreset } from '@core/stamps'
import { isWinAnsi } from '@core/types'
import { useStore } from '@/store/app'
import { loadImageFile, todayString } from '@/pdf/signature'
import { Modal } from './ui'
import { StampGraphic } from './StampGraphic'

const MAX_IMAGE_SIDE = 1200

/** Tile preview: the stamp at its natural size, scaled down to fit the tile. */
function Preview({ label, sublabel, color }: { label: string; sublabel?: string; color: string }): ReactNode {
  const size = defaultStampSize(label, sublabel)
  return (
    <div style={{ width: '100%', maxWidth: size.width, aspectRatio: `${size.width} / ${size.height}` }}>
      <StampGraphic label={label} sublabel={sublabel} color={color} width={size.width} height={size.height} />
    </div>
  )
}

export function StampDialog({ onClose }: { onClose: () => void }): ReactNode {
  const signerName = useStore((s) => s.signerName)
  const setSignerName = useStore((s) => s.setSignerName)
  const setPendingStamp = useStore((s) => s.setPendingStamp)
  const setPendingImage = useStore((s) => s.setPendingImage)
  const showToast = useStore((s) => s.showToast)
  const [tab, setTab] = useState<'standard' | 'custom'>('standard')
  const [saved, setSaved] = useState<SavedStamp[]>([])
  const [text, setText] = useState('')
  const [color, setColor] = useState(STAMP_COLORS[1])
  const [withName, setWithName] = useState(false)
  const [withDate, setWithDate] = useState(false)
  const [save, setSave] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.yonder.stamps.list().then(setSaved).catch(() => setSaved([]))
  }, [])

  const secondLine = (name: boolean, date: boolean): string | undefined => stampSublabel({ name: name ? signerName : undefined, date: date ? todayString() : undefined })

  const placeText = (label: string, stampColor: string, sublabel: string | undefined, preset?: string): void => {
    setPendingStamp({ label, sublabel, color: stampColor, preset, ...defaultStampSize(label, sublabel) })
    onClose()
  }
  const placePreset = (p: StampPreset): void => placeText(p.label, p.color, p.dynamic ? secondLine(true, true) : undefined, p.id)

  const label = text.replace(/\s+/g, ' ').trim()
  const customSub = secondLine(withName, withDate)

  const placeCustom = async (): Promise<void> => {
    if (!label || busy) return
    setBusy(true)
    try {
      if (save) await window.yonder.stamps.add({ type: 'text', label, color, withName, withDate })
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setBusy(false)
    }
    placeText(label, color, customSub)
  }

  const fromImage = async (): Promise<void> => {
    if (busy) return
    const files = await window.yonder.doc.importDialog('image', false)
    if (!files.length) return
    setBusy(true)
    let bmp: ImageBitmap | null = null
    try {
      const f = files[0]
      // Check the header (type, dimensions, 64 MP ceiling) before anything is decoded (REVIEW-07 #2).
      const info = imageInfo(f.bytes)
      bmp = await loadImageFile(f.bytes, info.mime)
      const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bmp.width, bmp.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(bmp.width * scale))
      canvas.height = Math.max(1, Math.round(bmp.height * scale))
      canvas.getContext('2d')?.drawImage(bmp, 0, 0, canvas.width, canvas.height)
      const dataUrl = canvas.toDataURL('image/png')
      if (save) {
        try {
          await window.yonder.stamps.add({ type: 'image', dataUrl, width: canvas.width, height: canvas.height })
        } catch (err) {
          showToast(`Not saved to the library: ${err instanceof Error ? err.message : String(err)}`, 'error')
        }
      }
      setPendingImage({ dataUrl, width: canvas.width, height: canvas.height, role: 'stamp' })
      onClose()
    } catch (err) {
      showToast(`Could not read that image: ${err instanceof Error ? err.message : String(err)}`, 'error')
    } finally {
      bmp?.close()
      setBusy(false)
    }
  }

  const useSaved = (s: SavedStamp): void => {
    if (s.type === 'image') {
      setPendingImage({ dataUrl: s.dataUrl, width: s.width, height: s.height, role: 'stamp' })
      onClose()
    } else placeText(s.label, s.color, secondLine(s.withName, s.withDate))
  }
  const removeSaved = async (id: string): Promise<void> => {
    await window.yonder.stamps.remove(id)
    setSaved((list) => list.filter((x) => x.id !== id))
  }

  return (
    <Modal
      title="Stamp"
      onClose={onClose}
      wide
      footer={
        tab === 'custom' ? (
          <>
            <button className="btn" onClick={() => void fromImage()} disabled={busy}>
              <ImagePlus size={14} /> From image…
            </button>
            <span className="spacer" />
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" onClick={() => void placeCustom()} disabled={!label || busy}>
              Place
            </button>
          </>
        ) : (
          <>
            <span className="muted" style={{ fontSize: 12 }}>
              Pick a stamp, then click on the page to place it.
            </span>
            <span className="spacer" />
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
          </>
        )
      }
    >
      <div className="seg" style={{ marginBottom: 12, width: 'fit-content' }}>
        <button className={tab === 'standard' ? 'active' : ''} onClick={() => setTab('standard')}>
          Standard
        </button>
        <button className={tab === 'custom' ? 'active' : ''} onClick={() => setTab('custom')}>
          Custom
        </button>
      </div>

      {tab === 'standard' && (
        <div className="stamp-grid">
          {STAMP_PRESETS.map((p) => (
            <button key={p.id} className="stamp-tile" data-preset={p.id} title={p.dynamic ? `${p.label} — adds your name and today's date` : p.label} onClick={() => placePreset(p)}>
              <Preview label={p.label} sublabel={p.dynamic ? secondLine(true, true) : undefined} color={p.color} />
            </button>
          ))}
        </div>
      )}

      {tab === 'custom' && (
        <div className="stamp-custom">
          {saved.length > 0 && (
            <>
              <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                Saved stamps
              </div>
              <div className="stamp-grid" style={{ marginBottom: 14 }}>
                {saved.map((s) => (
                  <div key={s.id} className="stamp-tile saved" role="button" tabIndex={0} data-saved={s.id} onClick={() => useSaved(s)} onKeyDown={(e) => e.key === 'Enter' && useSaved(s)}>
                    {s.type === 'image' ? <img src={s.dataUrl} alt="Saved stamp" draggable={false} /> : <Preview label={s.label} sublabel={secondLine(s.withName, s.withDate)} color={s.color} />}
                    <button
                      className="x"
                      title="Remove from library"
                      onClick={(e) => {
                        e.stopPropagation()
                        void removeSaved(s.id)
                      }}
                    >
                      <X />
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
          <div className="field">
            <label>Stamp text</label>
            <input type="text" value={text} maxLength={MAX_STAMP_LABEL} placeholder="e.g. CHECKED" autoFocus onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void placeCustom()} />
          </div>
          <div className="field">
            <label>Colour</label>
            <div className="stamp-colors">
              {STAMP_COLORS.map((c) => (
                <button key={c} className={'color' + (c === color ? ' active' : '')} style={{ background: c }} title={c} onClick={() => setColor(c)} />
              ))}
            </div>
          </div>
          <div className="stamp-options">
            <label>
              <input type="checkbox" checked={withName} onChange={(e) => setWithName(e.target.checked)} /> Add my name
            </label>
            {withName && <input type="text" className="name" value={signerName} placeholder="Your name" onChange={(e) => setSignerName(e.target.value)} />}
            <label>
              <input type="checkbox" checked={withDate} onChange={(e) => setWithDate(e.target.checked)} /> Add today's date
            </label>
            <label>
              <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} /> Save to my stamps
            </label>
          </div>
          <div className="stamp-preview">{label ? <Preview label={label} sublabel={customSub} color={color} /> : <span className="muted">Preview</span>}</div>
          {!isWinAnsi(label + (customSub ?? '')) && (
            <div className="hint" style={{ marginTop: 8 }}>
              Some characters are not supported by the built-in stamp font and are shown as "?".
            </div>
          )}
        </div>
      )}
    </Modal>
  )
}
