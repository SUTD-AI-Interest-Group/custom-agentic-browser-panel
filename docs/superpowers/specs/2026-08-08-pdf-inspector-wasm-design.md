# Replacing the PDF text extractor with pdf-inspector (WASM)

**Date:** 2026-08-08
**Status:** approved, implementing

## Why

`src/platform/pdf.ts` extracts PDF text by walking pdf.js `getTextContent()` items and
joining their `str` values with spaces. That join is the weakest part of the PDF
surface: it has no concept of headings, tables, or column order, so a two-column
paper arrives at the model as interleaved half-sentences and a financial table
arrives as a wall of numbers. It is also slow — one async worker round-trip per
page.

[pdf-inspector](https://github.com/firecrawl/pdf-inspector) is a Rust/`lopdf`
parser with a browser WASM build (`@firecrawl/pdf-inspector-wasm`) that does
position-aware extraction, multi-column reading order, table detection, and
Markdown conversion in one synchronous call.

Measured on this machine against the current pdf.js path:

| | pdf.js | pdf-inspector |
|---|---|---|
| 75-page extraction (GPT-3 paper, 6.7 MB) | ~1–3 s (75 async round-trips) | **218 ms** |
| Classification only | n/a | 61 ms |
| Single page | — | 40 ms |
| Text volume, 75 pp | 244,426 ch | 240,153 ch (−1.7%) |
| Output shape | raw text-item join | Markdown: headings, tables, columns, lists |

## The constraint that shapes everything

**pdf-inspector has no rasterizer.** Its entire API is:

```ts
processPdf(bytes, { pages?, password?, profile?, includePageMarkers?, includeImages? })
  → { pdfType, markdown?, pageCount, pagesNeedingOcr, ocrReasonsByPage,
      title?, confidence, layout, hasEncodingIssues }
detectPdf(bytes, { password? })   classifyPdf(bytes)   extractText(bytes) → string
```

`pdf.ts` does four jobs. pdf-inspector can do two:

| Job | Consumers | pdf-inspector |
|---|---|---|
| Per-page text | `ReadPdf` pages/search, research `FetchUrl`, blind-model attachments | yes — better, ~10× faster |
| Metadata | `ReadPdf` mode:`"outline"` | `title` only — **no `author`** |
| Bookmarks | `ReadPdf` mode:`"outline"` | none |
| Page → PNG | `ReadPdf` mode:`"view"`, `HighlightContent` PDF path, `planAttachmentDelivery`'s `pdf-pages` ladder | **impossible** |

Deleting pdf.js would therefore delete `mode:"view"`, PDF highlighting, and PDF
attachment vision — and would make **scanned PDFs unreadable altogether**, since
they have no text layer and would no longer have an image path either. That is
pointedly at odds with pdf-inspector's own selling point: `pagesNeedingOcr` names
exactly the pages that need eyes on them.

**Decision: pdf-inspector becomes the sole text/classification engine. pdf.js
stays, dynamically imported only where a raster or a bookmark is genuinely
needed.**

## Module layout

| File | Role |
|---|---|
| `src/platform/pdfExtract.ts` *(new, pure, tested)* | `splitPageMarkers()`, `stripMarkdown()`, `pdfErrorMessage()` |
| `src/platform/pdfWorker.ts` *(new, Vite entry → `dist/pdfWorker.js`)* | Module worker hosting the WASM |
| `src/platform/pdfEngine.ts` *(new)* | Panel/offscreen-side singleton worker client — the `ExecHost` analog |
| `src/platform/pdf.ts` *(rewritten)* | Fetch/sniff/cap, the LRU, and **all** pdf.js rendering; extraction delegates to `pdfEngine` |
| `src/platform/pdfText.ts` | `PageText` gains `plain`; `searchPages` matches and snippets on it |

`pdfWorker.ts` becomes a fourth rollup entry alongside `background`/`offscreen`,
spawned with `new Worker(chrome.runtime.getURL('pdfWorker.js'), {type:'module'})`.
That follows the repo's existing multi-entry convention instead of enabling
Vite's separate worker-bundling mode.

### Why a worker

Extraction is synchronous after `init()` — the library's own README says to call
it from a Web Worker for large documents. 218 ms on 75 pages is already visible
jank in the side panel, and the 500-page ceiling would be far worse. pdf.js
already runs off-thread; this keeps that property.

The worker fetches the WASM itself by URL (`import wasmUrl from '…?url'` in the
client, URL posted to the worker) rather than receiving transferred bytes. Unlike
`src/exec/`'s sandbox — which has an opaque origin and *cannot* fetch extension
resources — this worker is same-origin, so it can stream-compile directly and the
main thread never touches 4.8 MB.

`pdfEngine` FIFO-queues calls for the same reason `ExecHost.run()` does: the WASM
is single-threaded and synchronous, so concurrency buys nothing, and queuing means
a call's timeout clock starts when it actually begins rather than while it waits.

## The cache

Today's `CacheEntry` is `{task, doc, loaded}` — a live pdf.js handle, refcounted
because destroying one mid-render is the bug `planEviction` exists to prevent.
It becomes:

```ts
interface CacheEntry {
  bytes: Uint8Array                   // retained: the render path re-parses from these
  loaded: LoadedPdf                   // from the worker
  render?: Promise<{task, doc}>       // lazily created, only when a raster is needed
  meta?: Promise<{author, outline}>   // lazily created, only for mode:"outline"
}
```

One LRU, one refcount map, and **`planEviction` plus its six tests are
untouched** — eviction just also destroys `render` when present.

Net memory *drops*: today three fully-parsed pdf.js documents stay resident; now
it is three raw byte buffers plus at most a couple of lazily-parsed handles.

Retaining `bytes` is what stops `HighlightContent` (search for the page, then
render it) from fetching the document twice, and preserves `attachments.ts`'s 20
sequential page renders on a single parse.

## Markdown vs. plain text

Markdown emphasis lands mid-phrase. Measured on the Transformer paper, pdf.js
finds `"Encoder: The encoder is composed of a stack of"` on page 3; pdf-inspector
renders it `**Encoder:** The encoder is composed…`, so the literal search misses.
There were 249 such emphasis runs in that one document — not an edge case.

`PageText` therefore carries both forms:

- `text` — Markdown. Goes to the model via `assemblePagesText` (`ReadPdf
  mode:"pages"`, research's `FetchUrl`).
- `plain` — syntax-stripped. `searchPages` **matches and snippets** on it, so the
  model never receives a snippet it cannot quote back.

`renderPdfPageHighlighted` runs `stripMarkdown(query)` before `findTextInChunks`.
That covers both the snippet path and a model that quotes Markdown it saw in
`mode:"pages"`.

## Feature parity on the pdf.js side

`mode:"view"`, the PDF `HighlightContent` path, and the `pdf-pages` vision ladder
are untouched. `mode:"outline"` lazily parses with pdf.js for bookmarks **and**
`author` (the WASM exposes neither), best-effort: on failure it degrades to the
`firstPage` fallback that already exists in `tools.ts`.

## The upgrade worth taking

`pdfType` / `pagesNeedingOcr` / `hasEncodingIssues` replace today's guess
(`blocks.every(b => b.text.trim().length < 20)`):

- `mode:"pages"` on a scanned document names the exact pages needing eyes and
  steers to `mode:"view"`.
- A blind model handed a scanned attachment gets an honest note instead of empty
  text.

Scoped to those two notes. Redesigning the attachment ladder is out of scope.

## Error mapping

The WASM throws plain `Error`s with a `process PDF: ` prefix and readable tails,
verified empirically:

| Input | Message |
|---|---|
| garbage bytes | `process PDF: Not a PDF: file is not a PDF` |
| empty | `process PDF: Not a PDF: file is empty` |
| truncated PDF | `process PDF: Invalid PDF structure` |
| HTML | `process PDF: Not a PDF: file appears to be HTML` |

`pdfErrorMessage()` strips the prefix and maps these onto the existing actionable
`PdfError` sentences, keeping password/oversize/not-a-PDF wording stable.

## Buffer ownership

`processPdf` does **not** detach its input buffer (verified). But `postMessage`
transfer does, so the attachment path still needs its `bytes.slice()` copy before
posting — the same constraint as today's pdf.js comment, for a different reason.
The comment is preserved with updated rationale.

## Testing

- `pdfExtract.test.ts` — marker splitting (contiguous, gaps, preamble, single
  page, malformed) and Markdown stripping, including the exact `**Encoder:**`
  regression measured above.
- `pdfText.test.ts` — extended for `plain`-based search and snippets.
- `pdf.test.ts` — `planEviction` tests unchanged.
- `/verify-extension` end to end: `mode:"pages"`, `"search"`, `"outline"`,
  `"view"`, PDF `HighlightContent`, and a PDF attachment.

## Risks to verify, not assume

1. **4.8 MB WASM in Chrome.** Node's V8 crashed in a *background* wasm tier-up
   compile after producing correct results — a Node zone-allocator quirk rather
   than a library fault, but real Chrome behavior must be confirmed in the
   extension, not waved off.
2. **Module worker + MV3 CSP.** `'wasm-unsafe-eval'` is already in the manifest
   and workers inherit the creating page's CSP — confirm in practice.
3. **Bundle size.** `dist/` grows by ~4.8 MB. Well inside Chrome Web Store
   limits, but it is the largest single asset the extension ships.
4. **Markdown leaking** into places expecting plain text — the `plain` field and
   the `stripMarkdown(query)` call are the containment.
