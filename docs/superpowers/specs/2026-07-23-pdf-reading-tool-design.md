# PDF Reading, Search & Q&A — Design

**Date:** 2026-07-23
**Status:** Approved (brainstormed interactively; user approved architecture and tool design)

## Problem

PDFs are a perception blind spot. Chrome renders PDFs in a plugin viewer with no
scriptable DOM, so `ReadPage` fails or returns nothing on a PDF tab, the deictic
attach path ("summarize this pdf") attaches an error block, and the research
pipeline's `FetchUrl` rejects `application/pdf` responses and then wastes a tab
lease on a rendered-tab escalation that cannot help (`researchRender.ts` marks a
pdf.js path as future work). The agent needs to read, search, and answer
questions about the PDF the user has open — and research needs PDF text (e.g.
the `pdfUrl` results `SearchAcademic` already returns).

## Decisions (from brainstorming)

- **Scope:** both consumers — a foreground `ReadPdf` agent tool *and* PDF
  extraction wired into research's `FetchUrl`.
- **Vision:** text extraction is the primary path, plus rendering a chosen page
  to an image (scanned PDFs, figures) via the existing `imageQueue`/shot-store
  machinery.
- **Search/Q&A:** agent-driven paged reading + keyword search with page-numbered
  snippets. No embeddings (Anthropic has no embeddings endpoint — would break
  the model-agnostic constraint).
- **Targets:** the active tab's PDF by default; an optional `url` param reads a
  linked PDF without navigating. Approval cards name the document.
- **Tool shape:** one modal `ReadPdf` tool (mirrors `ReadPage`'s mode pattern),
  one catalog entry to discover.

## Architecture

**Dependency:** `pdfjs-dist`, dynamically imported (Vite code-splits it; the
worker is emitted as an extension asset via `?url`). No manifest/CSP changes and
no new permissions — extension pages may run same-origin workers, and
`host_permissions: <all_urls>` already exempts the byte fetch from CORS.

**Contexts:** pdf.js needs a page-like context. Both consumers already live in
one: `ReadPdf` executes in the side panel; research's `FetchUrl` executes in the
offscreen document. The service worker never touches pdf.js.

### New files

- `src/platform/pdf.ts` — Chrome/pdf.js-coupled core: fetch PDF bytes
  (size-capped ~50 MB, `%PDF-` magic sniff so extension-less URLs work; http(s)
  and file: only), parse, extract per-page text, resolve the bookmark outline to
  page numbers, render a page to a PNG data URL (~1400 px long edge). Module-level
  LRU cache (~3 docs, keyed by URL + credentials mode) of extracted text and doc
  handles so repeated search/read/view calls don't refetch or reparse; evicted
  docs are destroyed.
- `src/platform/pdfText.ts` — **pure** (no Chrome/pdf.js imports):
  `looksLikePdfUrl()`, `sniffPdf()` (magic bytes), `parsePageRange("3-7,12")`,
  `searchPages()` (case-insensitive literal search → `{page, snippet}` matches,
  capped, with total/per-page counts), `assemblePagesText()` (char-budgeted
  per-page assembly with explicit included/omitted page lists), outline
  flattening. Unit-tested in `pdfText.test.ts`.

### Touched files

- `src/tools/tools.ts` — the `ReadPdf` tool (below) in `createAgentTools()`;
  `ReadPage`/`ReadTabs`-style approval gating; `ReadPage` returns a "this tab is
  a PDF — use ReadPdf" hint instead of a scripting error on a PDF tab, so the
  model self-heals into discovering the tool through `ToolSearch`/`GetTool`.
- `src/platform/webFetch.ts` — `fetchReadable` returns an exported `PDF_CONTENT`
  sentinel error for `application/pdf` responses (mirrors the
  `SEARCH_RATE_LIMITED` sentinel-escalation pattern).
- `src/tools/research.ts` — `FetchUrl` short-circuits `looksLikePdfUrl` URLs to
  the PDF extractor, and routes the `PDF_CONTENT` sentinel there too; PDFs never
  reach the rendered-tab escalation. Research fetches stay cookie-less and
  SSRF-guarded (`isFetchableUrl` on input and final URL). Text returns with
  `[page N]` markers under the existing ~20 k-char budget; the source is added to
  the notebook as `fetchedVia: 'headless'`.
- `src/data/settings.ts` — `TOOL_CATALOG` entry
  `{ name: 'ReadPdf', group: 'reading', label: 'Read / search the open PDF' }`
  (default policy `ask`), so it appears in Settings → Permissions.
- `src/ui/Chat.tsx` — the deictic/auto-attach path detects a failed/empty
  `readTabContent` on a PDF-looking URL and attaches title + page count + a
  short first-page snippet via the shared core (plain hint on failure) instead
  of an error block.

## The `ReadPdf` tool

One tool, four modes. Every call gates through `requestApproval` with a
mode-specific summary. Defaults to the active tab's PDF; optional `url` targets
a linked PDF (the card names it). The foreground fetch sends the user's cookies
(`credentials: 'include'`) so a PDF the user can see behind a login, the agent
can read too.

- **`outline`** — `{title, author, pageCount, bookmarks: [{title, page}]}`
  (capped ~100 entries) plus a first-page snippet when there are no bookmarks.
- **`pages`** — `pages: "3-7,12"` → per-page text under a ~25 k-char total
  budget (mirrors `MAX_TEXT_CHARS`); overflow returns what fits plus the omitted
  page numbers so the model narrows the range. Near-empty text across the range
  ⇒ "no text layer — looks scanned; use mode:'view'" note.
- **`search`** — case-insensitive literal query across all pages → up to ~40
  `{page, snippet}` matches plus counts. The Q&A workhorse: search → read hit
  pages → answer with page citations.
- **`view`** — renders page N to PNG. Follows the screenshot invariants exactly:
  saved to the shot store as a user-facing artifact (`ShotCard` renders it),
  routed via `planShotDelivery` (send/blind/budget) sharing the per-turn
  `shotImagesUsed` budget, and reaches the model **only** through `imageQueue`
  with a caption that says what it is ("Page 4 of '<title>' — a plain PDF page
  render, no numbered boxes"). The tool returns `{shotId, page, note}` — never
  image data.

## Error handling

All failures return `{error}` sentences the model can act on: password-protected
PDFs; `file://` without the file-access toggle (instructs the user to enable
"Allow access to file URLs" in `chrome://extensions`); not-a-PDF (magic bytes
fail → "use ReadPage"); oversize; network failures. `view` on a text-only model
follows the existing `blind` note pattern.

## Testing

- `pdfText.test.ts` — Vitest over the pure module: URL heuristic, magic sniff,
  range parsing (bad specs, out-of-range, reversed), search/snippets (case,
  caps, multi-page), budget assembly (inclusion/omission lists, truncation
  flags), outline flattening.
- Existing suites must stay green (`agent.test.ts` disclosure/repair invariants
  cover ReadPdf automatically via the derived catalog).
- End-to-end via `/verify-extension`: build, reload, open a PDF, exercise
  outline/pages/search/view and the research FetchUrl path.

## Known limitations (v1)

- No cMap/standard-font assets bundled: CJK-heavy PDFs may extract imperfect
  text and page renders may substitute fonts. Revisit if it bites.
- Literal keyword search only (no stemming/semantic recall) — the model
  compensates by trying synonyms, which it is prompted toward by the tool
  description.
- OCR for scanned PDFs is out of scope; `view` mode + a vision model is the
  fallback.
