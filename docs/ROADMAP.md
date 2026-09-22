# Roadmap

## Phase 1 — Core viewer + editor (0.1.x) — in this repo
Viewer, annotations with appearance streams, visual signing, forms, page operations, print/export, ads, updater, macOS packaging.

Known limitations:
- Annotations already saved in a file render but cannot be edited (Phase 3).
- Password-protected PDFs open read-only.
- Saving a document that contains digital signature fields invalidates those signatures (the app warns).
- Print rasterizes pages (120–200 dpi depending on page count); vector printing is Phase 3.
- macOS builds are unsigned until a Developer ID is available; auto-update is check-only on macOS.

## Automation surface — CLI, local API, MCP (0.1.x → 0.2)
Per DESIGN.md §14: every feature reachable headlessly through `yonder-pdf` (CLI), a token-protected local socket API in the running app, and an MCP server, so agents such as Claude Code can inspect and edit PDFs with the app. Milestones A1–A4. From here on, every new feature ships with a registry command, not only UI.

## Phase 2 — E-signature workflows (0.2)
Per DESIGN.md §7 + §12: incremental-update writer, PAdES-B-B certificate signatures (self-signed or `.p12`), recipients & fields, guided signing, audit trail with signed manifest, completion certificate, macOS Share sheet for sending, verification panel.

## Phase 3 — Pro tools (0.3+)
Edit existing annotations, redaction (true content removal), OCR (offline), compress, password protect/unlock, compare, stamps, measurements, bookmark editing, limited text editing, PDF/A, image → PDF, batch, crash-recovery journal.
