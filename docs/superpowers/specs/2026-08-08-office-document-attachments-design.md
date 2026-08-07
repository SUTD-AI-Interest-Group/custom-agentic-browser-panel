# Office document attachments: docx, pptx, xlsx, ODF, RTF and EPUB uploads

**Date:** 2026-08-08 · **Status:** Approved (library: officeParser slim; integration: lazy-imported prebuilt bundle; scope: office+ODF+RTF+EPUB only; spreadsheets: manifest + fair-share rows; embedded images: out of scope for v1) · Implemented 2026-08-08

## Summary

`classifyIncomingFile` accepts three things today — images, PDF, and text-like files by extension.
Everything else is rejected with *"is not a supported type"*, which means **docx, pptx, xlsx,
odt, odp, ods, rtf and epub all bounce** — most of what "document upload" means to a user after
PDF.

This adds a fourth attachment kind, `'document'`, delivered as budgeted text down the ladder
`planAttachmentDelivery` already establishes. Parsing is [officeParser](https://github.com/harshankur/officeParser)
7.5.1's **slim browser bundle**, lazy-imported so it costs nothing until someone actually attaches
an office file. A new impure shell (`src/platform/office.ts`) turns bytes into a small normalized
model; a new pure module (`src/platform/officeText.ts`) turns that model into the text the model
sees, under two different budget policies. The existing PDF path is untouched.

## Why officeParser, and why the slim bundle specifically

The hard constraint is Lychee's: **everything runs client-side, in the panel, with no remote code
execution.** That eliminates the entire tier every mainstream agent harness actually uses —
MarkItDown, Docling, Unstructured and all API converters are Python or server-side. The QuickJS
sandbox in `src/exec/` does not help either: it cannot run python-docx. So the field is JS/WASM
libraries, which is small.

Verified against the published package (7.5.1, MIT), not just the docs:

| Property | Finding |
|---|---|
| CSP safety | **0** occurrences of `eval(`, `new Function(`, `importScripts(`, or script-element injection in `officeparser.browser.slim.mjs` |
| Remote hosts | **none** — the only absolute URLs are XML namespace URIs (`w3.org`, `adobe.com`) |
| Node builtins | `fs` appears **only** in `cli.js`; the entire parser core is builtin-free |
| Core deps | `fflate` + `@xmldom/xmldom` (both pure JS, browser-safe) |
| Bundle | 2.72 MB raw / **845 KB gzipped** |

The **standard** bundle is disqualified: it resolves the pdf.js worker and Tesseract language data
from jsDelivr at runtime, which is exactly the remote-code path the product forbids. The **slim**
bundle exists specifically for Manifest V3 and strips both. Using it is not optional.

### Alternatives considered

- **`office-oxide-wasm` 0.1.8** (MIT/Apache-2.0) — Rust→WASM, `toMarkdown()`/`toIr()`, and the
  only candidate covering **legacy binary `.doc/.xls/.ppt`**. Memory-safe parsing of hostile input
  in a WASM sandbox is a strictly better security posture. Rejected for v1 on maturity alone:
  v0.1.8, 95 stars, 70 commits, first released 2026-07-22. **Revisit in ~6 months.**
- **mammoth + SheetJS + a hand-written pptx parser** — best byte efficiency and mammoth is a
  decade proven, but SheetJS's npm distribution is **stale at 0.18.5 (2022)** carrying unpatched
  CVE-2023-30533 (prototype pollution) and CVE-2024-22363 (ReDoS); fixes ship only from
  `cdn.sheetjs.com`. Three moving parts, a supply-chain wart, and we would own the pptx parser.
- **`@silurus/ooxml`** (MIT, Rust/WASM, 10.9 MB) — a canvas *viewer*, not an extractor. Wrong tool
  for text. Potentially interesting later as a render→image source for the vision ladder.

### Why the prebuilt bundle rather than a PDF-free source build

`pdfjs-dist` is confined to `PdfParser.js`/`defaults.js`/`envUtils.js` and reached through a
**dynamic import** in `utils/moduleLoader.js`; every per-format parser (Word, Excel, PowerPoint,
OpenOffice, RTF) has zero edges to it or to any Node builtin. Bundling from those source modules
would cut the chunk to roughly `fflate + xmldom + parsers` (~250–350 KB) and avoid shipping a
second copy of pdf.js.

Rejected anyway. The `exports` map publishes only `.` and `./slim`, so this requires patching or
vendoring and pins us to internal module paths the author may rename in any patch release — on a
library whose own security policy states *"a parser of this size will have attack vectors I have
not found."* That warning is the argument **for** staying on the supported path: we want `npm
update` to deliver parser security fixes with zero re-verification. The ~600 KB saving is one
time; the maintenance cost is permanent. Lazy-importing already removes the cost users feel.

**Follow-up:** open an upstream request for a `slim-nopdf` bundle or `./parsers/*` subpath
exports, and switch when it lands.

## Accepted types & limits

| Extension | MIME | Shape |
|---|---|---|
| `.docx` | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` | prose |
| `.pptx` | `…presentationml.presentation` | prose (per slide) |
| `.xlsx` | `…spreadsheetml.sheet` | workbook |
| `.odt` / `.odp` / `.ods` | `application/vnd.oasis.opendocument.{text,presentation,spreadsheet}` | prose / prose / workbook |
| `.rtf` | `application/rtf`, `text/rtf` | prose |
| `.epub` | `application/epub+zip` | prose (segmented on level-1 headings — see note) |

- **Per-file cap: 25 MB.** Office files are zip-compressed; 25 MB is already enormous, and the
  decompression limit below is the real guard.
- **Char budget: 48,000**, matching `PDF_TEXT_BUDGET` and `INLINE_TEXT_BUDGET`.
- **Unchanged:** `.csv`, `.md`, `.html`, `.txt` and the rest of `TEXT_EXT` keep routing to
  `inline-text`. officeParser also parses those, but they work today and rerouting them would add
  regression surface to a working path for no user-visible gain.
- **PDF is unchanged** and stays on `src/platform/pdf.ts`, which is better integrated (LRU cache,
  the pdf-inspector WASM text engine, page rendering, the `ReadPdf` tool).

## Architecture

The split mirrors what the PDF subsystem already does: an impure Chrome-coupled shell over a
pure, tested core.

### `src/platform/office.ts` — the parser shell (new)

Bytes in, normalized model out. It never formats text.

- `getOfficeParser()` — lazy `await import('officeparser/slim')`, mirroring `getPdfjs()`. This is
  what makes the 845 KB a code-split chunk rather than panel startup cost.
- `parseOfficeDocument(bytes, id, name): Promise<OfficeDoc>` — walks officeParser's AST into the
  normalized model.
- LRU cache keyed by attachment id, so the attach-time parse is reused at send time (the same
  reason `pdf.ts` caches).
- `OfficeError extends Error`, mirroring `PdfError`.
- Runs in page-like contexts only (side panel, offscreen host — never the service worker),
  consistent with `pdf.ts`.

### `src/platform/officeText.ts` — pure formatting (new)

Owns the normalized model *types* and every formatting and budget decision. No officeParser
import, no Chrome — testable with hand-built fixtures.

It lives in `src/platform/` rather than `src/agent/` because `pdfText.ts` and `pdfExtract.ts` set
that precedent: pure format mechanics sit beside their format. `src/agent/attachmentPlan.ts` is
about provider delivery, which is a different concern.

```ts
export type OfficeDoc =
  | {
      shape: 'prose'
      format: 'docx' | 'odt' | 'rtf' | 'epub' | 'pptx'
      /** Slides, chapters, or a single body segment. */
      segments: { label: string; text: string }[]
      imageCount: number
    }
  | {
      shape: 'workbook'
      format: 'xlsx' | 'ods'
      sheets: { name: string; rows: string[][]; rowCount: number; colCount: number }[]
    }
```

Segments come from the **AST**, not from generated Markdown — the AST already carries `sheetName`
and per-slide structure, so we never re-parse text to recover boundaries the parser already knew.

The AST shape was confirmed by parsing generated fixtures against 7.5.1 (2026-08-08). `ast.content`
holds the nodes; prose documents yield `{ type: 'heading' | 'paragraph', … }`, and workbooks yield:

```
{ type: 'sheet', metadata: { sheetName },
  children: [ { type: 'row',
                children: [ { type: 'cell', text, metadata: { row, col } } ] } ] }
```

**Cells are sparse and carry 0-based `{ row, col }`.** A row with a gap simply omits that cell, so
`rows` must be rebuilt **by column index**, not by array position — otherwise a blank B2 silently
shifts C2 left into its place and every downstream value is misaligned by one column.

Three claims in an earlier draft of this spec were **disproved during implementation** and are
corrected here:

- **epub has no `chapter` or `section` node type** — they do not exist in officeParser at all. Every
  spine XHTML flattens into the same heading/paragraph stream as docx. Segmentation therefore falls
  back to an epub-only heuristic that cuts on level-1 headings, degrading to a single segment when a
  book has none. pptx and odp *do* group under real `slide` nodes; docx and odt do not group at all.
- **`imageCount` cannot come from `ast.attachments.length`.** That array is populated only when
  `extractAttachments: true`, and it also counts charts. Worse, the flag is not merely a payload
  toggle: `WordParser.js:585` wraps docx image-*node* construction in `if (config.extractAttachments)`,
  and `RtfParser.js:963` does the same, while `PowerPointParser.js:643` and `OpenOfficeParser.js:534`
  build image nodes unconditionally. So docx and rtf yield **zero** image nodes without the flag.
  `office.ts` sets it unconditionally and counts `type === 'image'` content nodes. The attachment
  payloads are discarded — `ast` is local to `doParse` and never cached.
- **`decompressionLimits` applies to OOXML and ODF only**, per officeParser's own docs — not epub or
  rtf. For those two the zip-bomb guard is the 25 MB `MAX_OFFICE_BYTES` pre-parse cap alone.

`ast.to('markdown')` emits an empty YAML frontmatter block (`---\n---`) when metadata is absent,
which the formatter strips.

### Modified files

| File | Change |
|---|---|
| `src/agent/attachmentPlan.ts` | `AttachmentKind` gains `'document'`; office extension/MIME table + 25 MB cap in `classifyIncomingFile`; new `{ route: 'document-text'; budget }` |
| `src/ui/attachments.ts` | `ComposerAttachment` gains a `document` variant; `ingestDocument()`; one new branch in `assembleAttachments` |
| `src/ui/Chat.tsx` | ~4 render sites — file icon and chip subtitle ("12 slides", "3 sheets") |
| `src/data/attachments.ts` | `AttachmentMeta` optional `segmentCount`/`sheetCount` for the chip |

**One route, not two.** `planAttachmentDelivery`'s job is *what this provider can consume*, and
prose and workbooks are both text. The prose/workbook distinction is a property of parsed content,
so it belongs in the formatter. This keeps the planner's routing matrix about provider capability.

## Data flow

```
attach:  drop/paste/pick → classifyIncomingFile → 'document'
         → ingestDocument → parseOfficeDocument     ← 845 KB chunk loads here, once per session
         → OfficeDoc cached by id → composer chip

send:    planAttachmentDelivery → 'document-text' → cached OfficeDoc
         → formatProse | formatWorkbook (pure) → appended text block
         → original bytes persisted to lychee-attachments
```

Parsing at attach time is deliberate: a corrupt or password-protected file fails **in the
composer**, not halfway through a send. `ingestPdf` already works this way.

## Budget policies

### Prose — sequential greedy

Same semantics as `assemblePagesText`: segments in reading order, the segment that crosses the
budget is truncated and flagged, later segments land in `omitted` and are named in the note.
Reading order matters more than fairness inside a document. Mirroring the proven shape keeps the
two modules legible side by side.

`pdfText.ts` is **not** refactored to share this. A concurrent session is actively working in
`src/platform/pdf*.ts` (`95d3a58`), and a shared-helper refactor would collide for no benefit.

### Workbook — manifest plus fair-share rows

A flattened 5,000-row workbook consumes the entire budget inside sheet 1, and the model never
learns sheets 2 and 3 exist. So:

1. **The manifest is emitted first and is never truncated** — sheet names, dimensions and column
   headers for every sheet. It is small, bounded, and it is the thing that must survive. The
   header row is **the sheet's first row**, taken as-is; no heuristic tries to detect whether it
   is really a header, and a sheet whose first row is data simply shows that data as its headers.
2. The remaining budget is split **equally per sheet**, then any share a small sheet does not use
   is **redistributed** to sheets that want more. Redistribution **repeats until no sheet is
   under-using its share** (or the budget is exhausted), so one tiny sheet does not leave its
   surplus stranded after a single pass. A 12-row `Notes` sheet always appears; a 5,000-row `Q1`
   cannot starve it.
3. Rows are emitted as **CSV, not Markdown tables** — markedly fewer tokens per cell for identical
   information, and models read CSV fine.
4. Every sheet header states `rows a–b of N`, so truncation is always visible to the model.

```
[workbook: sales.xlsx — 3 sheets]
  Q1 (1,204 rows × 8 cols): Date, Region, Rep, Units, Price…
  Q2 (1,190 rows × 8 cols): Date, Region, Rep, Units, Price…
  Notes (12 rows × 2 cols): Topic, Detail

--- Q1 (rows 1–400 of 1,204) ---
Date,Region,Rep,Units,Price
2026-01-03,APAC,Chen,120,4.50
…
```

## Error handling

All failures are per-file and never abort the batch — `ingestFiles`'s existing contract.

- **Legacy `.doc` / `.xls` / `.ppt`** get a *specific* message: *"Legacy .doc isn't supported —
  re-save as .docx."* officeParser cannot read binary Office 97 formats at all, and a generic
  "unsupported type" is baffling when `.docx` works.
- **Password-protected or corrupt** → `OfficeError` surfaced at attach time, exactly as `PdfError`
  is today.
- **Zip bombs** → `decompressionLimits` tightened to **64 MB uncompressed / 2,000 entries**, far
  below officeParser's 512 MB / 10,000 default. The 25 MB attachment cap is the coarse outer gate.
- **Empty extraction** (an image-only deck) → suppress the empty block and emit the image count
  instead, so the model says *"this deck is 12 images I can't read"* rather than confabulating
  from near-empty text. A **workbook with no data rows** is a different case and still emits its
  manifest: "3 sheets, all empty" is itself the answer to the user's question.
- **Send-time failure** → the existing per-attachment catch in `assembleAttachments` already emits
  `[attachment "x" could not be processed: …]` and continues.

## Testing

**`src/platform/officeText.test.ts`** (pure — the bulk of the value):

- Fair-share: a 12-row sheet survives beside a 5,000-row sheet; unused share redistributes; the
  manifest is never truncated; `rows a–b of N` counts are accurate
- Sequential: the crossing segment is truncated and flagged; later segments are listed in `omitted`
- Empty extraction produces the image-count note, not an empty block
- CSV escaping — cells containing commas, quotes and embedded newlines
- Surrogate-safe slicing, the hazard `safeSliceEnd` already guards in `attachmentPlan.ts`

**`src/agent/attachmentPlan.test.ts`** (extended): every new extension and MIME classifies as
`'document'`; the 25 MB cap message; the legacy `.doc/.xls/.ppt` message; `document-text` routing
and budget. Plus a **regression guard**: `.csv`, `.md`, `.html` and `.txt` must still route to
`inline-text`.

**`src/platform/office.test.ts`** (integration): the slim bundle was confirmed on 2026-08-08 to
import and parse under plain Node ESM, so this is a commitment rather than an open question.
Fixtures are **generated in-test with `fflate`** — a few hundred bytes of OOXML XML zipped on the
fly — so the repo carries no binary test assets. Covers: docx → prose segments, a two-sheet xlsx →
workbook with correct sheet names, a **sparse row** rebuilt by column index, and
`decompressionLimits` rejecting an over-budget archive.

**Chrome-coupled** — `/verify-extension`: build, reload unpacked, attach a real docx/xlsx/pptx,
confirm the assembled block reaching the model. This remains the only way to prove the lazy import
and the composer flow work in the panel.

**Build acceptance checks:**

1. `dist/sidepanel.js` does not grow — the officeParser chunk must be **separately code-split**,
   proving the lazy import was not silently inlined.
2. No second `pdfjs` copy in the bundle beyond the existing one.

Check 2 is what catches the known failure mode of the chosen approach.

## Out of scope (explicit)

- **Embedded images / OCR.** The slim bundle stubs Tesseract by design. Documents report an image
  count but no image content in v1. Extracting embedded images as image parts (mirroring
  `pdf-pages`, capped, vision-gated) is the natural follow-up.
- **Legacy binary `.doc` / `.xls` / `.ppt`.** No client-side path exists in officeParser; revisit
  with `office-oxide-wasm`.
- **A `ReadDocument` agent tool** for office files fetched from the web. `office.ts` is
  byte-oriented so this stays cheap to add, but v1 is user uploads only.
- **Spreadsheet analysis via `RunCode`.** The manifest tells the model what exists; wiring bytes
  into QuickJS for on-demand querying is a separate feature.
- **Document generation.** officeParser can write docx/pdf/epub; `CreateArtifact` already owns
  user-facing output.
