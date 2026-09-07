// Ad slot configuration (design §6 / §12). The slot loads a page served by
// Yonder's own static host; that page decides what to show, so the network
// can change without an app release. The iframe is sandboxed without
// allow-same-origin, and every popup is denied by main and forwarded to the
// system browser only when it is an https URL originating from the ad frame.
import { AD_HOST } from '@shared/api'

export const adsConfig = {
  enabled: typeof __YONDER_ADS__ === 'undefined' ? true : __YONDER_ADS__,
  url: `${AD_HOST}/yonderpdf/ad?v=1`,
  refreshSeconds: 60,
  /** Shown when offline or when the host page has not sent a "ready" ping within `timeoutMs`. */
  timeoutMs: 6000,
  houseAd: {
    headline: 'Yonder PDF is free and open source.',
    body: 'Ads keep it that way. Star the project on GitHub or sponsor a release.',
    cta: 'View on GitHub',
    url: 'https://github.com/yondertech-admin/yonder-pdf'
  }
}
