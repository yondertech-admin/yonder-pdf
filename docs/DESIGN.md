# Yonder PDF — Design Document

Status: v1 draft (reviewed by Codex / GPT-6 Astra before implementation)
Owner: Yonder Tech
License: MIT (open source, see "Open source & distribution")

## 1. Product

Yonder PDF is a free, ad-supported desktop PDF application in the spirit of
Adobe Acrobat / PDF Expert, with DocuSign / PandaDoc style e-signature workflows.

Platform priority: **macOS first**, Windows second, Linux third. One codebase,
three installers.

Principles:

1. **No cloud, no accounts, no storage.** Documents never leave the user's machine
   unless the user explicitly shares them. There is no Yonder server that stores
   user data. Updates are served from GitHub Releases only.
2. **Open source.** Code lives on GitHub; releases are built by GitHub Actions
   from tagged commits. Anyone can audit what the app does.
3. **Free with ads.** A single, clearly bounded ad slot funds the app. Ads are
   sandboxed and can never touch the document or the file system.
4. **Native feel.** Native menus, keyboard shortcuts, file associations, drag &
   drop, dark/light mode, macOS traffic-light title bar.

## 2. Feature scope

### Phase 1 — Core viewer + editor (this milestone)

| Area | Features |
|---|---|
| Files | Open (dialog, drag & drop, Finder/Explorer double-click, `open-file` event), Save, Save As, Recent files, unsaved-changes guard, multiple documents as tabs |
| Viewing | Continuous scroll, zoom (in/out/fit width/fit page/actual size), page navigation, thumbnails sidebar, outline (bookmarks) sidebar, text selection, find in document (with hit highlighting), rotate view, dark/light UI theme |
| Annotate | Highlight, underline, strikeout (text-anchored), freehand ink, rectangle, ellipse, line, arrow, free text, sticky note. Color, stroke width, opacity, font size. Select / move / resize / delete. Annotations list sidebar |
| Sign | Signature dialog: draw (pressure-less smoothed ink), type (bundled handwriting fonts), image upload (auto white-background removal). Initials. Saved signatures (persisted locally in userData). Place, move, resize, then flattened into the page on save. Date stamp |
| Forms | Fill AcroForm fields (text, checkbox, radio, combo, list), values persisted on save. Flatten forms on export |
| Pages | Rotate, delete, reorder (drag in thumbnails), insert blank, insert from PDF, extract selected pages, merge PDFs, split |
| Output | Print (rasterized, reliable across platforms), export pages as PNG/JPEG, flatten annotations |
| App | Undo/redo, keyboard shortcuts, native menu, ad slot, auto-update via GitHub Releases, crash-free reload |

### Phase 2 — E-signature workflows (DocuSign / PandaDoc style)

See section 7. Also: certificate-based digital signatures (PAdES-style, self-signed
or user-provided `.p12`), audit trail, completion certificate.

### Phase 3 — Pro tools

Redaction (true content removal), OCR (tesseract.js, offline), compress/optimize,
password protect & unlock, document compare, stamps library, measurement tools,
bookmark editing, limited existing-text editing, PDF/A export, image → PDF,
batch operations.

Explicitly **out of scope**: cloud storage, accounts, collaboration servers,
telemetry.

## 3. Technology

| Concern | Choice | Why |
|---|---|---|
| Shell | Electron 44 | Most consistent rendering + printing across the three OSes; mature packaging, auto-update, file associations |
| Build | electron-vite 5 + Vite 7 | Single config for main / preload / renderer, fast HMR |
| UI | React 19 + TypeScript, Zustand for state | Small, predictable; no heavy UI kit so the app looks like itself |
| Rendering | pdf.js 6 (`pdfjs-dist`) | Best open-source renderer; text layer for selection/search; annotation layer for AcroForm widgets |
| Editing | pdf-lib | Pure-JS PDF writer: annotations with appearance streams, images, page operations, form flattening |
| Signing (Phase 2) | node-forge / `@signpdf` in the main process | PKCS#7 detached signatures, incremental updates |
| Packaging | electron-builder | dmg/zip (mac), nsis (win), AppImage/deb (linux); GitHub Releases publish |
| Updates | electron-updater, `github` provider | No Yonder server involved |
| Icons | lucide-react | Consistent, tree-shakable |
| Fonts | @fontsource (Dancing Script, Great Vibes, Homemade Apple, Caveat) | OFL-licensed handwriting fonts for typed signatures, bundled offline |

Rejected: Tauri (WebView2/WKWebView differences in canvas/print behaviour, weaker
auto-update story for three OSes), Qt/native (three codebases).

## 4. Architecture

```
┌─────────────────────────────── Electron main ───────────────────────────────┐
│ window mgmt · native menu · dialogs · recent files · settings (JSON in     │
│ userData) · print window · auto-updater · file associations · IPC handlers │
└─────────────────────────────▲──────────────────────────────────────────────┘
                              │ contextBridge (`window.yonder`) — typed, allow-listed
┌─────────────────────────────▼──────────────── Renderer (sandboxed) ─────────┐
│ React app                                                                   │
│  ├─ store/          Zustand: documents[], activeDoc, tool, theme, sidebar   │
│  ├─ pdf/            pdf.js loader · annotation model · pdf-lib writers      │
│  │                  page ops · search · print rasterizer · signature utils  │
│  ├─ components/     Toolbar · Sidebar (thumbs/outline/annots) · Viewer      │
│  │                  PageView (canvas + text layer + form layer + overlay)   │
│  │                  SignatureDialog · PropertiesBar · FindBar · AdSlot      │
│  └─ ads/            sandboxed <iframe> host + house-ad fallback             │
└─────────────────────────────────────────────────────────────────────────────┘
```

Security posture:

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`.
- Renderer talks to main only through a small typed API exposed by the preload.
  The renderer never receives raw file paths it can act on; main performs all
  disk I/O and returns bytes.
- Strict CSP on the renderer: `default-src 'self'`; the ad iframe is the only
  allowed remote origin (`frame-src`), and it is `sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"` with no `allow-same-origin`.
- No `remote`, no `shell.openExternal` on arbitrary URLs (allow-listed https only).

### 4.1 Document model (renderer)

```ts
interface OpenDocument {
  id: string
  filePath: string | null          // null = untitled / merged result
  title: string
  baseBytes: Uint8Array            // bytes WITHOUT uncommitted in-app annotations
  pdf: PDFDocumentProxy            // pdf.js handle built from baseBytes (+ form data)
  pageCount: number
  annotations: Annotation[]        // in-app editable layer, keyed by page index
  signatures: PlacedSignature[]    // image placements, flattened on save
  history: Snapshot[]; future: Snapshot[]  // undo / redo
  dirty: boolean
  view: { zoom: ZoomMode | number; page: number; rotation: 0|90|180|270 }
}
```

Coordinates for every annotation are stored in **PDF user space** (points,
origin bottom-left, unrotated page). The overlay converts with
`viewport.convertToViewportPoint` / `convertToPdfPoint`, so zoom and page
rotation never change stored data.

### 4.2 Annotation model

```ts
type Annotation =
  | { kind: 'highlight'|'underline'|'strikeout'; quads: Quad[]; color; opacity }
  | { kind: 'ink'; paths: Point[][]; color; width; opacity }
  | { kind: 'rect'|'ellipse'; rect; stroke; fill?; width; opacity }
  | { kind: 'line'|'arrow'; from; to; color; width; opacity }
  | { kind: 'text'; rect; text; fontSize; color }
  | { kind: 'note'; at; text; color }
  | { kind: 'image'; rect; png: Uint8Array; role: 'signature'|'initials'|'stamp'|'image' }
// all carry: id, page (0-based), createdAt
```

### 4.3 Save pipeline

```
baseBytes ──(pdf.js saveDocument if AcroForm values changed)──▶ formBytes
formBytes ──(pdf-lib: write annotations with /AP appearance streams,
             draw flattened images, optional flatten forms)──▶ outBytes
outBytes ──IPC──▶ main writes file atomically (temp + rename)
```

Annotations are written as real PDF annotation objects (`/Highlight`, `/Ink`,
`/Square`, `/Circle`, `/Line`, `/FreeText`, `/Text`) **with generated appearance
streams** so every viewer (Preview, Acrobat, Chrome) displays them identically.
Highlights use an `ExtGState` with `/BM /Multiply`. Signature images are drawn
directly into the page content (flattened) — a signature must not be movable
after signing.

After a save the in-app annotation layer stays editable in the session:
`baseBytes` is replaced by `formBytes` (not `outBytes`), so re-saving re-applies
the live annotation list instead of duplicating objects.

### 4.4 Page operations

All page operations run pdf-lib on `baseBytes` (after folding in form values),
produce new bytes, and **remap** the annotation list (delete → drop annotations on
that page and shift indices; reorder → permute; rotate → no change because
coordinates are unrotated user space). Then pdf.js reloads. Each op pushes an
undo snapshot `{ baseBytes, annotations, signatures }` — arrays are copied,
bytes are shared references, so snapshots are cheap.

### 4.5 Rendering per page

`PageView` stacks, in order: `<canvas>` (pdf.js render at `zoom × devicePixelRatio`,
`annotationMode: ENABLE_FORMS` so existing annotations render but widgets are
left to the layer), text layer (`pdfjs.TextLayer`), AcroForm layer
(`pdfjs.AnnotationLayer` with the document's `annotationStorage`), and the
**overlay** (`<svg>` for shapes/markup, absolutely positioned DOM for text and
images). Pages outside the viewport ± 2 are not rendered (virtualized) and their
canvases are released.

### 4.6 Printing

`window.print()` on the live viewer is unreliable (canvas scale, virtualized
pages). Instead the renderer rasterizes every page at 150 dpi (200 dpi for ≤ 20
pages) with annotations composited, sends PNGs to main, and main opens a hidden
`BrowserWindow` with one `<img>` per `@page` and calls `webContents.print()`.
Exact-size, works identically on all three OSes.

### 4.7 IPC surface (preload → main)

```
file:open(paths?) → {path,bytes}[]      file:save(path, bytes)      file:saveAs(bytes, suggestedName)
file:recent() / file:clearRecent()      app:print(pages: PNG[])     app:exportImages(...)
settings:get/set(key)                   signatures:list/add/remove  shell:openExternal(url)   // allow-listed
update:check / update:install           app:onOpenFile(cb)          menu:onCommand(cb)
```

## 5. UI design

Layout (macOS, default light theme; dark mirrors it):

```
┌ ● ● ●  Yonder PDF · report.pdf ─────────────────────────────────────────────┐
│ [Open][Save] │ [Select][Hand] │ [Highlight][Underline][Strike][Pen][Shapes ▾]│
│ [Text][Note] │ [Sign ▾] │ [Forms] │ [Pages ▾] │      zoom − 100% +  │ Find ⌕ │
├──────────┬────────────────────────────────────────────────────┬─────────────┤
│ Thumbs   │                                                    │ Properties  │
│ Outline  │               page canvas + layers                 │ (color,     │
│ Annots   │                                                    │  width,     │
│          │                                                    │  opacity…)  │
├──────────┴────────────────────────────────────────────────────┴─────────────┤
│ Page 3 / 12 · 100%                                      [   ad slot 90px  ]  │
└──────────────────────────────────────────────────────────────────────────────┘
```

- Title bar: `titleBarStyle: 'hiddenInset'` on macOS with a draggable region; a
  normal frame on Windows/Linux.
- Toolbar groups: File · Navigation tools · Markup · Draw/Shapes · Text · Sign ·
  Pages · Zoom · Find.
- Left sidebar tabs: Thumbnails (drag to reorder, multi-select for
  delete/extract/rotate), Outline, Annotations.
- Right properties bar appears contextually for the active tool / selection.
- Status bar: page indicator + zoom, and the ad slot pinned to the bottom-right
  (see 6).
- Visual language: neutral greys, one accent (`#3B6FF5`), 13 px system font
  (`-apple-system, Segoe UI, Ubuntu`), 6 px radius, subtle 1 px borders, no
  drop-shadow soup. Tool buttons 32 px, icons 18 px.
- Welcome screen when nothing is open: big drop target, Open button, recent
  list, quick actions (Merge, Sign, Fill form).

Keyboard: ⌘O open · ⌘S save · ⇧⌘S save as · ⌘P print · ⌘F find · ⌘+/− zoom ·
⌘0 fit width · ⌘1 actual size · ⌘Z/⇧⌘Z undo/redo · V select · H hand · 1..7
tools · Esc back to select · Delete removes selection.

## 6. Ads

- One slot, fixed height 90 px, full width of the status area on macOS/Windows
  desktop sizes, collapses to 50 px below 900 px window width. Hidden while
  printing, in fullscreen/presentation, and while the Signature dialog is open.
- Implementation: `<iframe sandbox src={config.url}>` loading a page **served by
  Yonder's own static host** (`https://yondertech.net/yonderpdf/ad`).
  That page decides what ad network / house ad to show, so ad-network changes
  never require an app release. If the iframe fails to load (offline), the slot
  shows a bundled house ad (static PNG + link). Refresh every 60 s while the
  window is focused.
- The ad origin is the only remote origin in the CSP. The iframe has no
  `allow-same-origin`, cannot read the document, and links open in the system
  browser through the allow-listed `shell.openExternal`.
- Note for the operator: Google AdSense policy does not permit serving inside
  Electron-style desktop apps; the slot host page should use a network that does
  (e.g. self-serve/house ads, EthicalAds, Carbon, or direct sponsorships). Ad
  behaviour and privacy are documented in-app under Help → Privacy.
- Config lives in `src/renderer/src/ads/config.ts`: `{ enabled, url, refreshSeconds, houseAd }`.
  A build flag `YONDER_ADS=off` produces an ad-free build for contributors.

## 7. E-signature workflows (Phase 2 design)

Goal: what people use DocuSign / PandaDoc for — prepare a document with fields,
send it to one or more people, they sign in order, everyone gets a tamper-evident
final copy with an audit trail — **without a Yonder server**.

### 7.1 Model

```ts
interface SigningRequest {
  id: string; title: string; createdAt; sender: Party
  recipients: Party[]            // { id, name, email, color, order, role: 'signer'|'viewer'|'approver' }
  fields: Field[]                // { id, page, rect, type: 'signature'|'initials'|'date'|'text'|'checkbox'|'name', recipientId, required }
  status: 'draft'|'sent'|'partially-signed'|'completed'|'declined'
  events: AuditEvent[]           // { at, who, what: 'created'|'viewed'|'signed'|'declined'|'completed', fieldId?, docHash }
}
```

### 7.2 Storage — inside the PDF

The request travels **inside the PDF itself**:

- Fields are written as real AcroForm widgets (signature fields as `/Sig` widgets,
  the rest as text/checkbox widgets) so any viewer shows where to sign.
- `SigningRequest` JSON (recipients, order, audit events) is embedded as a PDF
  file attachment `yonder-sign.json` (EmbeddedFiles name tree) and mirrored in
  XMP metadata for discoverability.
- Every signing action is appended as an **incremental update** with a
  certificate-based digital signature covering the whole byte range so far
  (PAdES-B style, SHA-256, PKCS#7 detached via node-forge). Any modification
  after that invalidates the signature. Each user gets a locally generated
  self-signed certificate on first use, and may import a `.p12` instead.
- Completion adds a final "Certificate of Completion" page (audit trail,
  document hash, signer list, timestamps) and a final signature.

### 7.3 Flow

1. **Prepare**: sender adds recipients and drags fields onto pages. Fields are
   colour-coded per recipient. Save → "Send".
2. **Send**: no relay server. The app hands the file to the OS: macOS Share
   sheet / default mail client with the PDF attached (Electron
   `shell.showItemInFolder` + `mailto:` with instructions), or the user drops it
   into any channel they already use (email, Drive, AirDrop, Slack).
3. **Sign**: recipient opens the PDF in Yonder PDF. The app detects
   `yonder-sign.json`, shows a guided banner ("You have 3 fields to complete —
   Start"), walks through fields with Next/Finish, and records `viewed`/`signed`
   events with their identity (name + email typed once, stored locally). Finish
   → incremental update + digital signature → "Send back / Send to next signer".
4. **Complete**: when the last required signer finishes, the app appends the
   completion certificate and marks the request `completed`. Everyone who opens
   it sees a green "Completed · all signatures valid" banner with a verify panel.

Optional, later and self-hostable: a tiny open-source relay (link + email
notification only, documents encrypted client-side) for people who want
DocuSign-style links. Not required for the flow above.

### 7.4 Templates

A `.yonder-template` is a PDF with fields but no recipients; "Use template" asks
for recipient details and produces a draft. Also reusable for bulk send.

## 8. Open source & distribution

- Repo: `github.com/yondertech-admin/yonder-pdf` (MIT). `CONTRIBUTING.md`,
  `CODE_OF_CONDUCT.md`, issue templates.
- CI (GitHub Actions): `ci.yml` — typecheck + build on push/PR for
  macos/windows/ubuntu. `release.yml` — on tag `v*`, build all three, upload
  installers + `latest*.yml` update manifests to the GitHub Release.
- Auto-update: `electron-updater` with the `github` provider reads those
  manifests. macOS auto-update requires the app to be **code-signed and
  notarized** (Apple Developer ID, $99/yr) — secrets go in the repo settings,
  never in code. Until then, macOS builds are unsigned `.dmg`s that users open
  with right-click → Open, and updates are check-only (open the release page).
- Versioning: semver, `CHANGELOG.md` generated from conventional commits.
- No analytics, no crash reporting by default; an opt-in Sentry can be
  discussed later.

## 9. Repository layout

```
yonderPDF/
  package.json  electron.vite.config.ts  electron-builder.yml
  tsconfig.json tsconfig.node.json tsconfig.web.json
  build/            icons (icon.icns / icon.ico / icon.png), entitlements.mac.plist
  resources/        house-ad.png
  docs/             DESIGN.md (this), PRIVACY.md, ROADMAP.md
  src/main/         index.ts menu.ts ipc.ts settings.ts print.ts updater.ts
  src/preload/      index.ts (+ api.d.ts shared types)
  src/renderer/     index.html  src/{main.tsx, App.tsx, store/, pdf/, components/, ads/, styles/}
  .github/workflows ci.yml release.yml
```

## 10. Review process

Every milestone is reviewed with `/codex` running **GPT-6 Astra**:

1. Design review (this document) before implementation.
2. Code review of the full tree after Phase 1, findings fixed and re-reviewed.
3. Security-focused pass over IPC, CSP and the ad sandbox.

## 11. Risks

| Risk | Mitigation |
|---|---|
| pdf.js API churn (v6 internals) | Pin exact minor; wrap TextLayer/AnnotationLayer in one adapter module |
| Appearance-stream correctness across viewers | Golden tests: save → reload in pdf.js → render → compare; manual check in Preview & Acrobat |
| Large PDFs (500+ pages) | Page virtualization, thumbnails rendered lazily at 0.2 scale, worker-based rendering |
| macOS notarization not yet available | Unsigned builds + check-only updater until Developer ID exists |
| Ad network policy | Host page indirection (6); house ad fallback |
| Electron bundle size (~100 MB) | Accepted for v1; asar + differential updates (blockmap) keep updates small |

## 12. Design review outcomes (Codex / GPT-6 Astra, 2026-09-07)

Full findings: `docs/REVIEW-01-design-astra.md`. Decisions:

| # | Decision |
|---|---|
| 1–7 (e-sign) | Phase 2 is re-scoped: it needs an **incremental-update writer** (append objects + xref + `/Prev` trailer, not `pdf-lib.save()`), PAdES-B-B signed attributes, OS-keychain-protected keys, a single canonical signed manifest (no XMP mirror), an affirmative consent/intent step, and macOS `ShareMenu` for sending. Status is derived from verified signatures, never from JSON. "Valid" UI separates integrity / identity trust / coverage. |
| 8 | Phase 1 signing is **visual signing only** and is labelled so in the UI. |
| 9 | Save is transactional: a document is marked clean only after main confirms the atomic write; edits during a save keep it dirty. |
| 10 | pdf.js always receives a **copy** of the bytes (`bytes.slice()`); canonical bytes are immutable. |
| 11 | Phase 1 edits only annotations created in the session; annotations already in the file render read-only. Import/edit of existing annotations is Phase 3. |
| 12 | A low-level annotation writer (`pdf/writer.ts`) owns dictionaries, `/AP` streams, `/ExtGState`, flags and popups. |
| 13 | Delete / reorder / rotate reuse the same `PDFDocument` and page refs (AcroForm, outlines preserved). Merge / extract / insert-from-file use `copyPages` and the UI warns that form fields and bookmarks from the *inserted* document are not carried over. |
| 14 | All conversions go through pdf.js `PageViewport` (handles CropBox offset + `/Rotate`); pdf-lib writes use the same user-space coordinates. `/UserUnit` is preserved untouched. |
| 15–16 | Form values are written by pdf.js `saveDocument()` (its appearance generation), never regenerated by pdf-lib. XFA, JavaScript calculations and submit actions are deferred and shown as unsupported. |
| 17 | Encrypted PDFs open via the pdf.js password prompt in **read-only mode**. PDFs containing `/Sig` fields show a banner and saving requires confirming "save an unsigned copy". |
| 18–19 | Print renders with `intent: 'print'`, `annotationMode: ENABLE_STORAGE` and `printAnnotationStorage`, composites live annotations, and streams pages one at a time to main (temp PNG files) with a cancel button; memory is bounded to one page. |
| 20 | Undo history is capped (25 entries) and snapshots deep-copy annotation objects. Form state is outside undo in Phase 1. Crash recovery is Phase 3. |
| 21 | IPC never accepts paths from the renderer. Main issues opaque **document handles**; `doc:save(handle, bytes)` and `doc:saveAs(handle, bytes)` resolve paths in main. Every handler validates the sender frame. |
| 22 | CSP: `default-src 'self'; script-src 'self'; worker-src 'self' blob:; img-src 'self' data: blob:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-src <ad-host>; connect-src 'self'`. Worker, CMaps, standard fonts, WASM and `pdf_viewer.css` are packaged. PDF-embedded JavaScript is disabled (`enableScripting: false`). |
| 23–26 | Ad frame: `sandbox="allow-scripts allow-popups"` (no escape, no same-origin). Main denies all child windows via `setWindowOpenHandler` and forwards allow-listed https URLs to the system browser — that is the click bridge. Requests stop when the slot is hidden. Launch with house/direct ads; network approval is an operator task, documented in `docs/ADS.md`. Privacy copy says "no document backend" and discloses the ad request. |
| 27 | Auto-install updates only for signed builds; unsigned builds are check-only. Dirty documents block installation until saved. |
| 28 | Acceptance criteria add: clickable links, keyboard form navigation, and "rectangle is not redaction" labelling. |

## 13. Code review outcomes (Codex / GPT-6 Astra, 2026-09-07)

Full findings: `docs/REVIEW-02-code-astra.md` (31 items). Fixed in the same day:
`getFieldObjects` Map handling (#1, blocker), exact-origin check for ad-frame
popups (#2), check-only updater on every platform until releases are signed
(#3), save/close before install (#4), permission-preserving atomic writes (#5),
form serialization failures now abort the operation (#6), per-document
operation lock + edit revision counter (#7), history rebased onto saved bytes
(#8), inline editors flushed before file operations (#9), inherited page
attributes materialised before reordering (#10), orphaned AcroForm widgets
pruned after page deletion (#11), layer stacking so forms/links/handles are
clickable in Select mode (#12), pointer-capture handling for HTML annotations
(#13), off-screen canvases and layers released (#14), Windows-safe print image
URLs and decode checks (#15), print job lifecycle and renderer-crash cleanup
(#17), shared pdf.js options for print/export copies (#18), `fieldObjects`
passed to every annotation layer (#19), placement orientation stored on
text/image/note annotations (#23), menu commands respect focus/busy/modal state
(#25), Sign dropdown no longer clipped (#26), e2e kills only its own Electron
(#27), date stamp placed through the page viewport (#28), cancellable search
generations (#29), XFA/JavaScript banners (#30), arrow-head bounds (#31).

Deferred, documented as limitations: flattening annotations that already
existed in the file (#20, Phase 3 with annotation import), Unicode fonts for
FreeText (#21 — non-WinAnsi characters become "?" and the user is told on save),
oriented quads for rotated text markup (#22), `/UserUnit` scaling (#24),
bounded decode memory in the print window (#16 — pages are written to disk one
at a time; Chromium decodes them all when the print dialog opens).

Second pass (`docs/REVIEW-03-code-astra.md`, 14 items, no new blockers): widget
pruning now keys off the deleted pages' `/Annots` refs, form values are carried
across history reloads, every DOM input/change in a form bumps the edit revision,
close waits for the document lock and re-checks dirtiness after saving, sticky
note drafts commit live, export/print re-read the document after flushing
editors, advertiser links ask for confirmation, new files honour the umask,
form-flatten failures abort the export, the e2e runner only kills processes it
started (and launches the Electron binary directly), search re-runs on document
switch, and the print-job registration race is closed. Verified by
`npm run e2e` and `npm run test:unit`.

## 14. Automation surface — CLI, local API, MCP (design v2, 2026-09-22)

Requirement (product owner, 2026-09-22): **every feature of Yonder PDF must be
reachable through a command line or a local API**, so that an external agent
such as Claude Code can open, inspect and edit PDFs with the app. The app itself
stays free of AI code: no model, no cloud calls, no telemetry. The agent lives
outside and calls in. v1 of this design was reviewed by Codex/Astra
(`docs/REVIEW-04-automation-design-astra.md`, 25 items); the decisions are in
§15 and are folded into the text below.

### 14.1 Principles

1. **One command registry, three front-ends.** Each capability is a `Command`
   `{ name, params: JSON Schema, result: JSON Schema, scope: 'headless'|'app', run }`.
   The registry is exposed as (a) the `yonder-pdf` CLI, (b) a JSON-RPC 2.0
   endpoint on a private local socket inside the running app, and (c) an MCP
   server over stdio. A feature is not "done" until it is in the registry; the
   UI is another caller of the same document services (§14.4).
2. **Headless first.** Parse, text, search, annotate, forms, page operations
   and flatten run in a plain Node process with no app. Rasterisation
   (`render`, `export images`, `print`), typed signatures (canvas fonts) and
   session control (`open`, `state`, undo/redo, selection) are **app-scoped**
   in v1. Headless rendering with `@napi-rs/canvas` is a product decision
   deferred to after A4, not a pdf.js limitation (§15 #16).
3. **Explicit targets, never guessed.** A command edits either a file
   (`--in <path>`) or a live document (`--doc <id>`). The CLI never switches
   between them on its own. Writing a file that is open in the app is refused
   (`YP_FILE_OPEN_IN_APP`, hint: use `--doc`), exporting to another path is
   allowed. Optional `--expect-rev` / `--expect-sha256` make edits conditional.
4. **Agent-friendly addressing.** Placement commands accept explicit PDF
   user-space geometry **or a text anchor** (`--text "Total due"
   [--occurrence N] [--page N] [--align below|above|left|right --offset x,y]`).
   Several matches without `--occurrence` is an error (`YP_AMBIGUOUS_ANCHOR`)
   that lists the candidates. `find` returns the same geometry with a
   `quality: 'exact' | 'estimated'` flag, so an agent can inspect, then edit.
   `--dry-run` resolves targets and reports warnings without writing.
5. **1-based pages and hex colours at the boundary**, 0-based and normalised
   internally. Rects are `x,y,w,h` in points, origin bottom-left, unrotated
   page (the §4.1 model). Every input is validated against the command's JSON
   Schema plus semantic checks (finite numbers, positive sizes, page in range,
   colour format) before any writer runs. Responses are JSON when `--json` is
   given (always for API/MCP).
6. **Same writers, semantic parity.** The CLI calls the same `writeAnnotations`,
   page-ops and form code as the app, so output is semantically identical
   (same objects, appearances, geometry). Byte identity is *not* promised:
   IDs, timestamps and `/ModDate` differ. `YONDER_DETERMINISTIC=1` fixes them
   for tests.
7. **Local only, same user only.** No TCP listener. The API socket lives in a
   `0700` directory under `userData`, the token in a `0600` file, and the
   handshake must present the token. Processes running as the same user are
   trusted — they can already read and write the user's files. No stronger
   guarantee is claimed (§15 #3).

### 14.2 Layout

```
src/core/                 headless engine — pure TS, no DOM, no Electron (tsconfig.core.json has no DOM lib)
  types.ts  writer.ts  pageOps.ts       moved from src/renderer/src/pdf (A1, done)
  session.ts                             Session: one pdf-lib PDFDocument + annotation list + page map; ops mutate, commit() saves once
  pdfjs-node.ts / pdfjs-browser.ts       adapters: legacy build + packaged CMap/font paths in Node; existing loader in the renderer
  text.ts                                pdf.js text extraction + literal search (regex deferred)
  forms.ts                               pdf.js annotationStorage + saveDocument() — the one form backend (§12 #15–16)
  anchors.ts                             text anchor → quads / rect, ambiguity + quality
  images.ts                              PNG/JPEG decode, white-background removal (pngjs), ImageAnnotation builder
  validate.ts                            schema + semantic validation, page/colour/rect parsers, ordered permutations
  commands/                              registry: document.ts annotate.ts pages.ts forms.ts export.ts app.ts index.ts
src/cli/                  argv front-end; built by vite.cli.config.ts (lib mode, node target) → out/cli/index.mjs
src/mcp/                  MCP stdio front-end (@modelcontextprotocol/sdk), same registry
src/main/api/             socket server, token, handshake, request routing, utilityProcess worker pool
src/renderer/src/services/documentService.ts   parameterised document operations shared by the store and the bridge
docs/CLI.md               generated from the registry (`yonder-pdf schema --markdown`)
```

### 14.3 Commands (registry v1) and coverage matrix

Headless commands take `--in` (and `--out` for edits); app commands take
`--doc <id>` (default: active document). Commands marked **both** accept either.

| Group | Command | Scope | Notes |
|---|---|---|---|
| document | `info` | both | pages (size, rotation, cropbox), metadata, outline, **capabilities** `{ encrypted, readOnly, hasForms, hasXfa, hasJs, hasSignatures }`, annotation count, `rev`, `sha256` |
| | `text [--page] [--layout] [--limit/--cursor]` | both | paginated; `--layout` adds per-line rects |
| | `find <query> [--page] [--case] [--limit/--cursor]` | both | literal only in v1; returns page, quads, `quality`, context, `matchId` bound to `rev` |
| | `annotations list` | both | each with `provenance: 'session' \| 'file'`, `editable`, `removable` |
| | `annotations update --id [--set k=v …] [--move dx,dy] [--rect …] [--text …]` | both | session annotations only; file annotations → `YP_UNSUPPORTED` (Phase 3) |
| | `annotations remove --id …` | both | session annotations only |
| annotate | `highlight / underline / strikeout` | both | `--text` anchor or `--quads`; colour, opacity |
| | `text` (FreeText) | both | `--rect` or `--at x,y --width`, font size, colour; non-WinAnsi characters reported in `warnings` |
| | `note`, `rect`, `ellipse`, `line`, `arrow`, `ink --path "x,y x,y …"` | both | geometry, stroke, fill, width, opacity |
| | `image / stamp --file png\|jpg [--remove-white]` | both | `--rect` or `--at + --width`; role image/stamp |
| | `date [--format]` | both | the toolbar date stamp |
| | `sign / initial --image file` | both | role signature/initials, flattened on save (visual signing, §12 #8) |
| | `sign / initial --typed "Name" --font …` | app | needs canvas fonts; `--saved <id>` uses a saved signature |
| | `signatures list / add --image / remove` | both | the saved-signature store (`settings` in main) |
| pages | `rotate --pages 1-3 --by 90\|-90\|180` | both | ranges use `parsePageRanges` |
| | `delete --pages`, `extract --pages --out`, `split --every N \| --ranges … --out-dir` | both | split output `<base>-<n>.pdf`, refuses collisions |
| | `reorder --order 3,1,2` | both | complete permutation, validated (not a range) |
| | `insert-blank --after N [--size]`, `insert --file x.pdf --after N`, `merge --files … --out` | both | `--after 0` = beginning; copy-based ops return `warnings: ['forms-dropped','outline-dropped']` (§12 #13) |
| forms | `fields` | both | name, type, value, export values, options, readOnly, widgets (page, rect) |
| | `fill --json file \| --set name=value …` | both | values typed: string \| boolean \| string[]; read-only fields rejected; pdf.js backend |
| | `flatten-forms` | both | |
| export | `flatten [--annotations] [--forms]` | both | session annotations only (file annotations unchanged, §13 #20) |
| | `render --page --dpi --format png\|jpeg --out` | app | writes to `--out` or a private artifact dir; ≤ 16 MiB inline over MCP as image content, else a resource |
| | `images --dpi --format --out-dir`, `print [--printer]` | app | |
| batch | `apply <ops.json>` | both | ordered single-input → single-output ops on one `Session`; page refs are post-previous-op; later ops may reference earlier results (`$ref`); one commit; on failure nothing is written and `failedIndex` is reported; live batch = one undo entry |
| app | `docs`, `open <file> [--page]`, `activate --doc`, `save [--doc]`, `save-as --out`, `close [--discard]`, `close-all`, `reveal`, `reload` | app | `close` on a dirty document is an error unless `--discard` |
| | `state [--doc]` | app | active doc, page, zoom, rotation, selection, tool, dirty, rev |
| | `view --page N \| --zoom fit-width\|fit-page\|actual\|<n> \| --rotate 0\|90\|180\|270` | app | |
| | `select --ids … \| --all \| --none`, `select-pages …` | app | |
| | `undo`, `redo` | app | |
| | `recent list / open <id> / clear` | app | |
| | `settings get/set theme\|sidebar\|signerName\|defaultZoom` | app | |
| | `update check` | app | `update install` stays UI-only (irreversible, needs a relaunch) |
| meta | `schema [--markdown]`, `version`, `status` (is the app running, API version) | headless | |

Coverage (every `Actions` member, `MenuCommand` and `YonderAPI` entry):

- Mapped above: open/openRecent/closeDoc/closeAll/setActive/save/saveAs/
  buildOutput/exportFlattened/exportImages/print/merge, add/update/remove
  annotations, select, undo/redo, zoom/rotation/page navigation, selectPages,
  every page op, extract/split, setTheme/setSidebar/setSignerName, runSearch,
  recent list/clear, signatures list/add/remove, update check.
- **Excluded, UI-only by nature:** `setTool`/`setStyle`/`setPendingImage`
  (tool state for pointer gestures; the CLI passes style per command),
  `setDialog`, `showToast`, `busy`, `setFullscreen`, `findNext` (cursor within
  the find bar), `markFormEdited` (internal callback), `app:onOpenFile` /
  `menu:onCommand` (event subscriptions), `shell:openExternal` (never a
  command), `update install`, the drawing canvas of the signature dialog
  (drawn signatures enter as `--image`).

### 14.4 Front-ends and the document service

**Document service (renderer).** `services/documentService.ts` holds the
parameterised operations the store actions currently inline: every function
takes an explicit `docId`, runs under the document's operation lock, flushes
open editors first, checks `expectRev` when given, and returns typed results or
throws structured errors. It is **non-interactive**: anything that would need
a dialog (password, overwrite, signature-invalidation consent) returns
`YP_NEEDS_INPUT` with `data.needs`. The Zustand actions become thin wrappers
that add UI concerns (toasts, dialogs, busy state). The bridge calls the
service, never the store.

**CLI.** `yonder-pdf` is `out/cli/index.mjs` executed by the app's Electron
binary with `ELECTRON_RUN_AS_NODE=1`. The `RunAsNode` fuse therefore stays
**enabled** (documented trade-off, §15 #19). The shim unsets `NODE_OPTIONS`,
`ELECTRON_RUN_AS_NODE` and `ELECTRON_*` before launching the GUI (`open`).
Packaging:
- macOS: `Contents/Resources/bin/yonder-pdf` (from `extraResources`, executable
  bit preserved, signed and notarised with the app). Menu *Yonder PDF ▸ Install
  Command Line Tool…* symlinks into `~/.local/bin` (created if needed, PATH
  hint shown), or `/usr/local/bin` when writable; refuses when the app runs
  from a DMG or a translocated path; *Uninstall* removes the link. The link
  targets the app's real path and is re-validated on each launch.
- Development: `npm run cli -- <args>` (runs `out/cli` under the dev Electron).
- Windows and Linux launchers: after the macOS release (§15 #21).

**Local API (app).** Main starts a JSON-RPC 2.0 server (newline-delimited
frames, ≤ 64 MiB each, larger rejected before parse) on
`userData/api/sock` (macOS/Linux, path length checked; Windows named pipe
`\\.\pipe\yonder-pdf-<random>`). `userData/api/endpoint.json` (`0600`, written
atomically) holds `{ apiVersion, socket, token, pid, startedAt }`; the token is
32 random bytes, per launch, never in argv, logs, renderer state or `schema`
output. A stale endpoint whose `pid` is dead is removed at startup. First frame
must be `auth { token }` within 2 s. Development, e2e and packaged builds use
separate `userData` profiles (`YONDER_PROFILE`). Requests carry an optional
`idempotencyKey`; the server keeps results for 10 minutes and replays them.

Headless commands received over the socket run in an Electron
`utilityProcess` worker (one per document, cancellable, 120 s time limit,
input ≤ 1 GiB, decoded image ≤ 64 MP), never on the main event loop. App
commands go to the renderer over one IPC channel `agent:command`
`{ requestId, docHandle?, command, params }` — params never contain paths;
main resolves `--in/--out/--file` into handles and request-scoped write
capabilities first. Replies are matched by `requestId`, validated
(`sender.frame` check as in `ipc.ts`), time out at 60 s, and fail with
`YP_RENDERER_GONE` if the window is destroyed.

**MCP.** `yonder-pdf mcp` uses `@modelcontextprotocol/sdk` (stdio transport,
initialize/capabilities handled by the SDK). stdout is protocol-only; every
diagnostic goes to stderr (pdf.js warnings are redirected). Each registry
command becomes a tool with its JSON Schema; results carry
`structuredContent` (the JSON) plus a one-line text summary, `isError` on
failure. Rendered pages ≤ 1 MiB return as image content; larger outputs are
written to a private `0700` artifact directory with a 24 h expiry and returned
as `yonder://artifact/<id>` resources that the server can read back.
Claude Code setup: `claude mcp add yonder-pdf -- yonder-pdf mcp`.

### 14.5 Contracts

- **Errors:** JSON-RPC `error.code` -32000…-32099 with
  `data: { code: 'YP_…', hint, details }`. CLI exit codes: 0 ok, 1 command
  failed, 2 usage/validation, 3 app not running, 4 conflict (`expect-rev`,
  file open in app, output exists).
- **Results** of every edit: `{ target: { file|docId }, revBefore, revAfter,
  sha256, created: [ids], warnings: [], outputs: [paths] }`.
- **Files:** paths are resolved with `realpath`; `--out` equal to `--in` is an
  error unless `--in-place`; an existing `--out` is refused unless
  `--overwrite`; "open in app" detection compares `realpath` + device/inode.
- **Guards:** encrypted documents are read-only (password via
  `--password-file`, `YONDER_PDF_PASSWORD` or an interactive prompt, never
  argv); documents with signature fields require
  `--acknowledge-signature-invalidation` before any rewrite (§12 #17); lossy
  copy-based operations report what was dropped.
- **Registry versioning:** `schema.apiVersion`; breaking changes bump it and
  the CLI prints a deprecation note for one minor release.

### 14.6 Testing

- Core unit tests under Node (`scripts/unit`): writer, pageOps, session,
  forms, anchors, validate; registry self-test (every command's example
  validates against its schema).
- Fixtures: `sample.pdf` plus encrypted, signed (`/Sig` field), AcroForm with
  checkbox/radio/choice, rotated + CropBox + `/UserUnit` pages, Unicode text,
  and malformed inputs.
- CLI golden tests with `YONDER_DETERMINISTIC=1`: structure (objects,
  `/Subtype`, `/AP`), form values after fill, rendered geometry of anchors.
- Socket e2e: the CDP harness launches the built app with an **isolated
  `userData`**, connects a Node client, runs `open → highlight --text → save`,
  asserts UI state, then tests auth failure, a bad frame, a renderer reload
  mid-request and restart cleanup.
- MCP smoke: `tools/list`, one `tools/call`, one resource read via the SDK client.
- Packaged: `yonder-pdf --version` from a signed, notarised, quarantined build.

### 14.7 Milestones (v2 order)

| # | Milestone | Exit criteria |
|---|---|---|
| A0 | Feasibility spikes | packaged `ELECTRON_RUN_AS_NODE` entry prints JSON and exit codes on the signed binary; pdf.js legacy build extracts text and fills a form in Node with packaged CMaps/fonts; stdio stays clean |
| A1 | Core extraction (**done**) + `Session` + `documentService` | app unchanged (`e2e`, unit); page ops run on the session; store actions call the service |
| A2 | Registry + validation + headless CLI (document, annotate, pages, forms, flatten, apply, schema) + MCP prototype + `docs/CLI.md` | golden tests pass; MCP `tools/list` works; schemas reviewed for agent use |
| A3 | Local API on macOS: socket, token, worker, bridge, app commands, `Install Command Line Tool…`, `extraResources` shim | socket e2e passes; shim works from a notarised build on a clean machine |
| A4 | MCP completion (resources, images), Windows/Linux launchers, headless render decision | Claude Code highlights text in a fixture through MCP; installer tests |

Each milestone gets a Codex/Astra review before it is declared done (§10).

## 15. Automation design review outcomes (Codex / GPT-6 Astra, 2026-09-22)

Full findings: `docs/REVIEW-04-automation-design-astra.md` (25 items). Decisions:

| # | Decision |
|---|---|
| 1 | No dirtiness-based routing. Explicit `--in` (file) or `--doc` (live) target; writing a file that is open in the app is refused; `--expect-rev`/`--expect-sha256` guards. (§14.1 #3) |
| 2 | A parameterised, locked, non-interactive `documentService` in the renderer is the backend for both the store and the bridge; store actions become wrappers. (§14.4) |
| 3 | Security model stated honestly: `0700` dir + `0600` token + handshake; same-user processes are trusted; no peer-UID/DACL claims. Windows pipe hardening is a prerequisite for enabling the API there (A4). |
| 4 | `endpoint.json` discovery file, atomic write, 2 s auth timeout, dead-pid cleanup, per-profile `userData`, token never in argv/logs/renderer/schema. |
| 5 | No generic registry call from the renderer. One `agent:command` IPC with request IDs, main-resolved handles and write capabilities, sender validation, timeouts, renderer-crash failure. |
| 6 | Headless work over the socket runs in `utilityProcess` workers with size/time/concurrency limits; frames capped at 64 MiB before parse; `find` is literal-only in v1 (no user regex). |
| 7 | Forms keep the pdf.js backend (`annotationStorage` + `saveDocument()`) in both app and CLI via `core/forms.ts`; typed values; read-only rejected; export values listed by `fields`. |
| 8 | `info.capabilities`; encrypted → read-only; signature-invalidation acknowledgement flag; lossy operations report drops; passwords never in argv. |
| 9 | Full coverage matrix in §14.3 with explicit exclusions (tool/style/dialog/toast/fullscreen/find cursor/event subscriptions/`update install`). |
| 10 | Annotation listing carries `provenance`/`editable`/`removable`; removing or flattening file annotations is `YP_UNSUPPORTED` until Phase 3; batch results expose created IDs and `$ref`. |
| 11 | Anchors return `quality`, are bound to `rev`, fail on ambiguity unless `--occurrence`, and take `--align/--offset`. Regex search deferred. |
| 12 | `reorder --order` is an ordered, complete permutation with its own validator; `insert --after 0` = beginning; all inputs validated before writers run. |
| 13 | `core/session.ts` (one pdf-lib document, ops mutate, single commit) replaces byte-in/byte-out for batches; batch limited to single-in/single-out ops; failure index; one undo entry live. |
| 14 | `realpath` + device/inode identity; `--in-place`/`--overwrite` explicit; split naming refuses collisions. |
| 15 | Typed signatures are app-scoped (canvas fonts); headless `sign` takes `--image` or `--saved`. No `@pdf-lib/fontkit` in v1. |
| 16 | Separate pdf.js adapters (`pdfjs-node.ts` legacy build with packaged CMap/font paths; existing loader in the renderer). Headless render is a deferred product decision. |
| 17 | MCP via the official SDK: stdout protocol-only, stderr diagnostics, `structuredContent` + `isError`, bounded image content, resources with implemented reads and expiry. |
| 18 | CLI built by a separate `vite.cli.config.ts` (lib/node), not an electron-vite target; core/cli/mcp typechecks in `npm run typecheck`. |
| 19 | `RunAsNode` fuse stays enabled; documented; A0 tests the signed binary; shim sanitises env before launching the GUI. |
| 20 | `extraResources` shim with exec bit, signed + notarised; install to `~/.local/bin` first, `/usr/local/bin` if writable; refuse DMG/translocated paths; uninstall + re-validation. |
| 21 | Windows/Linux launchers and installer work move to A4 (macOS first, per product priority). |
| 22 | `idempotencyKey` with 10-minute replay, `--dry-run`, rich edit results, `close --discard`, `YP_APP_NOT_RUNNING` with no silent fallback. |
| 23 | Full JSON-RPC 2.0 framing, `YP_*` codes in `error.data`, CLI exit codes, pagination for `text`/`find`/`annotations`, private artifact dir, `render`/`reload` registered. |
| 24 | Semantic parity instead of byte identity; `YONDER_DETERMINISTIC=1` for tests; tests check values, appearances and geometry. |
| 25 | Milestones reordered: A0 spikes first; `Session` + `documentService` in A1; MCP prototyped in A2; isolated e2e `userData`; fixture set expanded. |
