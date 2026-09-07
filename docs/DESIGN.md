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
  Yonder's own static host** (e.g. `https://ads.yondertech.net/yonderpdf/banner`).
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

- Repo: `github.com/yondertech/yonder-pdf` (MIT). `CONTRIBUTING.md`,
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
