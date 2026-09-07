import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AD_HOST } from '@shared/api'
import { adsConfig } from '@/ads/config'
import { useStore } from '@/store/app'

/**
 * The only remote content in the app. Hidden (and unloaded) in fullscreen,
 * while printing/exporting and while the signature dialog is open.
 */
export function AdSlot(): ReactNode {
  const fullscreen = useStore((s) => s.fullscreen)
  const busy = useStore((s) => s.busy)
  const dialog = useStore((s) => s.dialog)
  const hidden = !adsConfig.enabled || fullscreen || Boolean(busy) || dialog?.type === 'signature'
  const [ready, setReady] = useState(false)
  const [nonce, setNonce] = useState(0)
  const frame = useRef<HTMLIFrameElement>(null)

  // "ready" handshake: the host page posts {type:'yonder-ad-ready'}; without
  // it we fall back to the house ad (finding 25).
  useEffect(() => {
    if (hidden) return
    setReady(false)
    const onMsg = (e: MessageEvent): void => {
      if (e.source !== frame.current?.contentWindow) return
      if (e.data && typeof e.data === 'object' && (e.data as { type?: string }).type === 'yonder-ad-ready') setReady(true)
    }
    window.addEventListener('message', onMsg)
    const t = setTimeout(() => setReady((r) => r), adsConfig.timeoutMs)
    return () => {
      window.removeEventListener('message', onMsg)
      clearTimeout(t)
    }
  }, [hidden, nonce])

  // Refresh while focused; stop entirely when hidden.
  useEffect(() => {
    if (hidden) return
    const id = setInterval(() => {
      if (document.hasFocus()) setNonce((n) => n + 1)
    }, adsConfig.refreshSeconds * 1000)
    return () => clearInterval(id)
  }, [hidden])

  if (hidden) return null
  const src = `${adsConfig.url}&n=${nonce}`
  return (
    <div className="adslot" aria-label="Advertisement">
      <span className="tag">Ad</span>
      {!ready && (
        <div className="house">
          <span>
            <strong>{adsConfig.houseAd.headline}</strong> {adsConfig.houseAd.body}
          </span>
          <button className="btn" onClick={() => void window.yonder.shell.openExternal(adsConfig.houseAd.url)}>
            {adsConfig.houseAd.cta}
          </button>
        </div>
      )}
      <iframe
        ref={frame}
        key={nonce}
        title="Advertisement"
        src={src}
        sandbox="allow-scripts allow-popups"
        referrerPolicy="origin"
        loading="eager"
        style={ready ? undefined : { position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
        // @ts-expect-error non-standard but honoured by Chromium
        credentialless="true"
        data-origin={AD_HOST}
      />
    </div>
  )
}
