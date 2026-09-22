# Yonder PDF

Free, open-source PDF viewer and editor for macOS, Windows and Linux. View, annotate, sign, fill forms and organise pages. No accounts, no cloud, no telemetry. A small ad banner keeps it free.

> Status: **0.1.0 – Phase 1 (core viewer + editor)**. macOS is the primary target; Windows and Linux builds come from the same code. E-signature workflows (DocuSign / PandaDoc style) are Phase 2 – see [docs/DESIGN.md](docs/DESIGN.md).

## Features

- **View**: continuous scroll, fit width / fit page / zoom, rotate, thumbnails, outline, text selection, find in document, dark & light themes, links, tabs for several documents
- **Annotate**: highlight, underline, strikethrough, pen, rectangle, ellipse, line, arrow, text box, sticky note; move, resize, recolour, delete; undo / redo
- **Sign**: draw, type (bundled handwriting fonts) or upload an image; saved signatures and initials; add today's date. Signatures are flattened into the page on save. *Visual signing only – certificate-based digital signatures are planned.*
- **Forms**: fill AcroForm fields (text, checkbox, radio, choice); values are saved
- **Pages**: rotate, reorder (drag thumbnails), delete, insert blank, insert from another PDF, extract, split, merge
- **Output**: save / save as (annotations are real PDF annotations with appearance streams, readable by Acrobat, Preview, Chrome…), flatten, export pages as PNG, print
- **App**: native menu and shortcuts, Finder / Explorer file association, drag & drop, recent files, unsaved-changes guard, updates from GitHub Releases
- **Automation**: every feature is also a command — `yonder-pdf` on the command line and an MCP server for AI agents such as Claude Code (see below)

## Install

Download the latest installer from [Releases](https://github.com/yondertech-admin/yonder-pdf/releases):

| Platform | File |
|---|---|
| macOS (Apple Silicon / Intel) | `Yonder PDF-x.y.z-arm64.dmg` / `Yonder PDF-x.y.z-x64.dmg` |
| Windows | `Yonder PDF Setup x.y.z.exe` |
| Linux | `Yonder PDF-x.y.z.AppImage` or `.deb` |

macOS builds are code-signed with the Yondertech Inc Developer ID but not yet notarized: on first launch, if Gatekeeper objects, open **System Settings → Privacy & Security** and click **Open Anyway**.

## Develop

```bash
npm install          # also copies pdf.js assets into src/renderer/public
npm run dev          # electron-vite with HMR
npm run typecheck
npm run build        # out/
npm run e2e          # drives the built app over CDP (macOS), writes e2e-out/
npm run dist:mac     # release/*.dmg (also dist:win, dist:linux)
scripts/release-mac.sh   # signed macOS installers → GitHub Release (maintainers)
```

Ad-free contributor build: `YONDER_ADS=off npm run build`.

Diagnostics while developing (unpackaged only): `YONDER_DEBUG=1` mirrors renderer console output to the terminal; `YONDER_SCREENSHOT=/tmp/shot.png` captures the window after four seconds and quits.

## Command line and agents

The same engine runs headlessly. Every command prints JSON; pages are 1-based, coordinates are PDF points (origin bottom-left), colours are hex. Placement commands accept a **text anchor** so an agent never needs coordinates:

```bash
npm run build:cli                                   # → out/cli (packaged builds ship it as `yonder-pdf`)
node out/cli/index.mjs info --in report.pdf
node out/cli/index.mjs find "Total due" --in invoice.pdf
node out/cli/index.mjs annotate.highlight --in invoice.pdf --out marked.pdf --text "Total due"
node out/cli/index.mjs annotate.text --in a.pdf --out b.pdf --text "Signature:" --align right --content "Ada Lovelace"
node out/cli/index.mjs forms.fill --in form.pdf --out filled.pdf --set name="Ada" --set agree=true
node out/cli/index.mjs pages.rotate --in a.pdf --in-place --pages 2-3 --by 90
node out/cli/index.mjs apply --in a.pdf --out b.pdf --ops '[{"command":"annotate.highlight","params":{"text":"Total"}},{"command":"pages.delete","params":{"pages":"4"}}]'
node out/cli/index.mjs schema --markdown            # the full reference, also in docs/CLI.md
```

Model Context Protocol: `node out/cli/index.mjs mcp` serves every command as a tool over stdio. For Claude Code:

```bash
claude mcp add yonder-pdf -- node /path/to/yonder-pdf/out/cli/index.mjs mcp
```

Headless today: inspect, search, annotate, sign with an image, fill and flatten forms, page operations, batch `apply`. Driving the running app (live documents, rendering, printing, typed signatures) is the next milestone — see `docs/DESIGN.md` §14.

## Architecture

Electron 44 · electron-vite · React 19 · TypeScript · pdf.js 6 (rendering, text layer, forms) · pdf-lib (writing annotations, page operations) · Zustand.

Read [docs/DESIGN.md](docs/DESIGN.md) for the full design, the security model (sandboxed renderer, handle-based IPC, strict CSP, sandboxed ad frame) and the roadmap. Design and code were reviewed with GPT-6 Astra via Codex; findings live in `docs/REVIEW-*.md`.

```
src/main       Electron main: window, menu, IPC, settings, printing, updater
src/preload    contextBridge API (window.yonder)
src/shared     IPC contract + shared types
src/core       Headless engine (no DOM): annotation model + writer, page ops, Session, text/search, forms, command registry
src/node       Node adapters: pdf.js legacy build, file I/O, headless runner
src/cli        `yonder-pdf` command line · src/mcp  MCP server (stdio)
src/renderer   React app: store/, pdf/ (pdf.js adapter, render, signature capture), components/, ads/
scripts/e2e    CDP-based end-to-end scenarios · scripts/unit  Node tests (page ops, CLI, MCP)
```

## Privacy

Documents never leave your computer. The only network traffic is the ad banner (a sandboxed frame from `yondertech.net/yonderpdf/ad`) and the update check against GitHub. Details: [docs/PRIVACY.md](docs/PRIVACY.md), [docs/ADS.md](docs/ADS.md).

## License

MIT © 2026 Yonder Tech. Handwriting fonts (Dancing Script, Great Vibes, Homemade Apple, Caveat) are under the SIL Open Font License.
