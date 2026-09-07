1. **Major — [pageOps.ts:31](/Users/aeedpuganti/Code/yonderPDF/src/renderer/src/pdf/pageOps.ts:31):** Widget pruning fails: pdf-lib’s cached `getPages()` still includes removed pages; widgets without `/P` are retained unconditionally. Reproduced deleted fields surviving save/reopen and breaking flattening. Destinations/outlines also remain unrepaired. **Fix:** identify widgets through page `/Annots` and remove fields before deleting pages; repair affected destinations.

2. **Major — [app.ts:283](/Users/aeedpuganti/Code/yonderPDF/src/renderer/src/store/app.ts:283):** History rebasing only replaces identical byte references. Rotate a page, fill/save a field, then undo rotation: the older snapshot restores pre-fill values. **Fix:** preserve current field values by stable identity across every history reload.

3. **Major — [App.tsx:149](/Users/aeedpuganti/Code/yonderPDF/src/renderer/src/App.tsx:149):** `onSetModified` fires once per modified period, not per edit. Changes during `saveDocument()` can escape `rev`, then its completion resets the modified flag and save marks stale output clean. **Fix:** track individual storage mutations and compare their generation through serialization and disk commit.

4. **Major — [app.ts:386](/Users/aeedpuganti/Code/yonderPDF/src/renderer/src/store/app.ts:386):** Close bypasses the document lock, does not flush editors, and never rechecks dirty state after saving. Window close can discard a clean document’s pending text draft or edits made during save. **Fix:** flush before checking dirty state, serialize close with operations, and recheck the current revision before removal.

5. **Major — [Dialogs.tsx:268](/Users/aeedpuganti/Code/yonderPDF/src/renderer/src/components/Dialogs.tsx:268):** Sticky-note drafts still commit only on Done/close; blurring does nothing, while native file commands explicitly allow note dialogs. Save/print therefore omit the draft. **Fix:** register an explicit editor commit operation or store drafts in document state.

6. **Major — [app.ts:515](/Users/aeedpuganti/Code/yonderPDF/src/renderer/src/store/app.ts:515):** Flatten/export/print capture `d` before `flushEditors()` and subsequently use its stale annotations. Direct store calls, including toolbar Print, can omit the flushed text. **Fix:** reacquire the document after flushing and inside the operation lock.

7. **Major — [index.ts:114](/Users/aeedpuganti/Code/yonderPDF/src/main/index.ts:114):** Exact-origin comparison fixes lookalike hosts, but ad-referrer popups still bypass the destination allowlist and launch arbitrary HTTPS URLs without confirmation. **Fix:** apply destination validation and user confirmation to every external popup.

8. **Major, new — [documents.ts:62](/Users/aeedpuganti/Code/yonderPDF/src/main/documents.ts:62):** New files are explicitly chmod’d `0644`, bypassing restrictive umasks. With umask `077`, Save As now creates a world-readable PDF. **Fix:** default to `0600` or apply `0644 & ~process.umask()`; only treat `ENOENT` as a new destination.

9. **Major — [cdp.mjs:86](/Users/aeedpuganti/Code/yonderPDF/scripts/e2e/cdp.mjs:86):** E2E still kills pre-existing processes, including a developer’s running Yonder instance with unsaved work. Restricting the executable path does not establish ownership. **Fix:** isolate test profiles and terminate only recorded child processes.

10. **Major — [writer.ts:76](/Users/aeedpuganti/Code/yonderPDF/src/renderer/src/pdf/writer.ts:76):** Form-flatten failures remain swallowed, allowing partially flattened output to report success. §13 defers existing annotations, not failed form flattening. **Fix:** propagate failures or explicitly report unsupported fields before exporting.

11. **Minor — [pdfjs.ts:111](/Users/aeedpuganti/Code/yonderPDF/src/renderer/src/pdf/pdfjs.ts:111):** Field actions are also Maps in installed pdf.js; `Object.keys()` misses calculation/validation scripts. **Fix:** inspect `actions.size`, with an object fallback.

12. **Minor — [FindBar.tsx:24](/Users/aeedpuganti/Code/yonderPDF/src/renderer/src/components/FindBar.tsx:24):** Search still does not rerun when switching documents or replacing the PDF proxy. **Fix:** include active document/proxy identity in search dependencies and reset cancelled searching state.

13. **Minor — [print.ts:23](/Users/aeedpuganti/Code/yonderPDF/src/main/print.ts:23):** A renderer crash during `mkdir()` runs owner cleanup before registration; the resumed operation then registers an orphan job. **Fix:** track pending creation and owner cancellation, deleting the directory if creation finishes after owner death.

14. **Minor — [app.ts:205](/Users/aeedpuganti/Code/yonderPDF/src/renderer/src/store/app.ts:205):** Lock cleanup never matches: the map contains `run.catch(...)`, but cleanup compares against `run`. **Fix:** retain and compare the actual stored promise.

The deferred limitations in §13 accurately describe existing annotations, Unicode substitution, rotated markup, `/UserUnit`, and unbounded print decoding, subject to item 10. No new blocker found. Files unchanged.