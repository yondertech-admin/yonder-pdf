# Ad slot — operator notes

The app never talks to an ad network directly. It loads **one** page,
`https://ads.yondertech.net/yonderpdf/banner?v=1&n=<refresh>`, in a sandboxed
iframe (`allow-scripts allow-popups`, no `allow-same-origin`). That host page
decides what to render, so the network, sizes and creatives can change without
an app release.

## Contract between the host page and the app

- Post `{ type: 'yonder-ad-ready' }` to `window.parent` once a creative is
  actually displayed. Until then (and if it never arrives within 6 s) the app
  shows the built-in house ad. This is the "no-fill" signal.
- Links must open with `target="_blank"` (or `window.open`). The app's main
  process denies child windows and forwards **https** URLs whose referrer is the
  ad host to the system browser. `http:`, `javascript:` and everything else is
  dropped silently.
- The slot is 90 px tall at full window width (50 px under 900 px wide). Let
  the creative scale; do not assume a fixed width.
- Requests stop when the slot is hidden (fullscreen, printing, signature dialog)
  and resume with a fresh `n` value every 60 s while the window is focused.
- Serve a strict `Content-Security-Policy` on the host page; the app's CSP only
  restricts which frame loads, not what the frame loads.

## Network eligibility

Google AdSense does not permit serving inside desktop (Electron) applications.
Carbon and EthicalAds have placement policies about refresh rate and formats
that must be agreed before launch. Start with house/direct ads; switch the host
page once a network has approved this placement.

## Turning ads off

`YONDER_ADS=off npm run build` compiles an ad-free build (the slot is not
rendered at all). This is for contributors and self-builders; official releases
ship with ads.
