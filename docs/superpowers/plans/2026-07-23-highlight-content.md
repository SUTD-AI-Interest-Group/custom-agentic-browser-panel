# HighlightContent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A gated `HighlightContent` tool that scrolls the active tab to a passage/region and marks it like a highlighter pen (webpages), or jumps a PDF viewer to the page and shows a rendered image with the passage marked (PDFs).

**Architecture:** A pure cross-chunk text matcher (`highlightText.ts`) is shared by the webpage path (chunks = DOM text nodes, applied via the CSS Custom Highlight API through self-contained injections in a new `highlight.ts`) and the PDF path (chunks = pdf.js text items, painted onto a canvas render in `pdf.ts`). The tool in `tools.ts` dispatches on "active tab is a PDF" and gates through `requestApproval`. Highlights deliberately outlive the turn; `Chat.tsx` clears them at the next fresh turn.

**Tech Stack:** TypeScript strict, Chrome MV3 (`chrome.scripting.executeScript`), CSS Custom Highlight API, pdf.js (`pdfjs-dist`), Vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-23-highlight-content-design.md`.
- Code style: no semicolons, single quotes, 2-space indent, `interface` for shapes, `/** ... */` on exports.
- Injected functions (`inj*`) must be fully self-contained: no closures over outer scope, no imports; everything arrives as args; elements re-found via DOM stamps.
- Every tool routes through `requestApproval`; no image data in tool return values.
- Repo is shared with concurrent sessions: commit with explicit pathspecs only (`git commit -m "…" -- <files>`), never `git commit -a`. Do not commit `package.json`/`package-lock.json`.
- Verify each task with `npm run typecheck` (fast) and finish with `npm run build && npm test`.

---

### Task 1: Pure cross-chunk matcher — `highlightText.ts`

**Files:**
- Create: `src/platform/highlightText.ts`
- Test: `src/platform/highlightText.test.ts`

**Interfaces:**
- Produces: `findTextInChunks(chunks: string[], query: string): ChunkMatch` where `ChunkMatch = { count: number; first: ChunkRange | null }` and `ChunkRange = { startChunk: number; startOffset: number; endChunk: number; endOffset: number }` (`endOffset` exclusive). Consumed by Task 2 (DOM text nodes) and Task 3 (PDF text items).

- [ ] **Step 1: Write the failing tests**

```ts
// src/platform/highlightText.test.ts
import { describe, expect, it } from 'vitest'
import { findTextInChunks } from './highlightText'

describe('findTextInChunks', () => {
  it('finds a passage inside a single chunk with exact offsets', () => {
    const m = findTextInChunks(['The quick brown fox'], 'quick brown')
    expect(m.count).toBe(1)
    expect(m.first).toEqual({ startChunk: 0, startOffset: 4, endChunk: 0, endOffset: 15 })
  })

  it('is case-insensitive', () => {
    expect(findTextInChunks(['The QUICK brown fox'], 'quick BROWN')!.count).toBe(1)
  })

  it('matches across a mid-word chunk split (inline formatting)', () => {
    const m = findTextInChunks(["The author's child", 'hood was spent in Kyoto'], 'childhood was')
    expect(m.count).toBe(1)
    expect(m.first).toEqual({ startChunk: 0, startOffset: 13, endChunk: 1, endOffset: 8 })
  })

  it('matches when the page joins words with no whitespace (block boundary)', () => {
    const m = findTextInChunks(['Payment is due.', 'Late fees apply.'], 'due. Late fees')
    expect(m.count).toBe(1)
    expect(m.first!.startChunk).toBe(0)
    expect(m.first!.endChunk).toBe(1)
  })

  it('collapses whitespace runs and newlines on both sides', () => {
    const m = findTextInChunks(['Terms\n  and   conditions apply'], 'terms and conditions')
    expect(m.count).toBe(1)
  })

  it('counts every occurrence but locates the first', () => {
    const m = findTextInChunks(['ab ab ab'], 'ab')
    expect(m.count).toBe(3)
    expect(m.first).toEqual({ startChunk: 0, startOffset: 0, endChunk: 0, endOffset: 2 })
  })

  it('matches PDF-item style chunks with leading spaces', () => {
    const chunks = ['Termination.', ' Either party may', ' terminate with 30 days notice.']
    const m = findTextInChunks(chunks, 'Either party may terminate')
    expect(m.count).toBe(1)
    expect(m.first!.startChunk).toBe(1)
    expect(m.first!.endChunk).toBe(2)
  })

  it('returns no match for absent text or an empty query', () => {
    expect(findTextInChunks(['hello world'], 'goodbye')).toEqual({ count: 0, first: null })
    expect(findTextInChunks(['hello'], '   ')).toEqual({ count: 0, first: null })
    expect(findTextInChunks([], 'hello')).toEqual({ count: 0, first: null })
  })

  it('escapes regex metacharacters in the query', () => {
    const m = findTextInChunks(['Fee (see §4.2) applies'], '(see §4.2)')
    expect(m.count).toBe(1)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/platform/highlightText.test.ts`
Expected: FAIL — cannot resolve `./highlightText`.

- [ ] **Step 3: Implement the matcher**

```ts
// src/platform/highlightText.ts
// Pure cross-chunk text matching for the HighlightContent tool. Given the page
// as an ordered list of text chunks (DOM text nodes on a webpage, pdf.js text
// items on a PDF page), find a quoted passage and map it back to
// (chunk, offset) endpoints a Range or a canvas rect can be built from.
//
// Matching is deliberately forgiving in one direction: whitespace in the QUERY
// is optional in the page. Chunks concatenate with no separator, so a passage
// quoted from innerText ("foo\nbar") must still match two blocks that abut as
// "foobar", and a word split by inline markup ("child" + "hood") must match the
// quoted "childhood". Chrome-free and unit-tested — keep it that way.

/** Where the first occurrence starts and ends, as (chunk index, char offset). */
export interface ChunkRange {
  startChunk: number
  startOffset: number
  endChunk: number
  /** Exclusive, within endChunk. */
  endOffset: number
}

export interface ChunkMatch {
  /** Occurrences across all chunks (0 = not found). */
  count: number
  /** The first occurrence, or null when count is 0. */
  first: ChunkRange | null
}

const MAX_QUERY_CHARS = 1000

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Case-insensitive search for `query` across concatenated `chunks`. Whitespace
 * runs are collapsed on both sides, and each whitespace gap in the query is
 * optional in the page (see module comment). Returns every occurrence's count
 * and the first occurrence's chunk-relative endpoints.
 */
export function findTextInChunks(chunks: string[], query: string): ChunkMatch {
  const none: ChunkMatch = { count: 0, first: null }
  const tokens = query.trim().slice(0, MAX_QUERY_CHARS).toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return none

  // Raw concatenation, plus each chunk's start offset in it.
  const starts: number[] = []
  let raw = ''
  for (const c of chunks) {
    starts.push(raw.length)
    raw += c
  }
  if (raw.length === 0) return none

  // Normalized haystack (lowercased, whitespace runs collapsed to one space)
  // with a map from each normalized char back to a raw index. A collapsed space
  // maps to the following non-space char — endpoints never land on a space
  // (tokens are trimmed), so that approximation is invisible to callers.
  let norm = ''
  const map: number[] = []
  let pendingSpace = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (/\s/.test(ch)) {
      pendingSpace = norm.length > 0
      continue
    }
    if (pendingSpace) {
      norm += ' '
      map.push(i)
      pendingSpace = false
    }
    norm += ch.toLowerCase()
    map.push(i)
  }

  const re = new RegExp(tokens.map(escapeRegExp).join(' ?'), 'g')
  let count = 0
  let first: { index: number; length: number } | null = null
  for (let m = re.exec(norm); m !== null; m = re.exec(norm)) {
    if (!first) first = { index: m.index, length: m[0].length }
    count++
  }
  if (!first) return none

  const rawStart = map[first.index]
  const rawEnd = map[first.index + first.length - 1] + 1

  // Binary-search the chunk containing a raw index (probe rawEnd-1 for the end,
  // so an exclusive end that lands exactly on a boundary stays in-chunk).
  const locate = (rawIdx: number, forEnd: boolean) => {
    const probe = forEnd ? rawIdx - 1 : rawIdx
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= probe) lo = mid
      else hi = mid - 1
    }
    return { chunk: lo, offset: rawIdx - starts[lo] }
  }
  const s = locate(rawStart, false)
  const e = locate(rawEnd, true)
  return {
    count,
    first: { startChunk: s.chunk, startOffset: s.offset, endChunk: e.chunk, endOffset: e.offset },
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/platform/highlightText.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/platform/highlightText.ts src/platform/highlightText.test.ts
git commit -m "feat(highlight): pure cross-chunk passage matcher" -- src/platform/highlightText.ts src/platform/highlightText.test.ts
```

---

### Task 2: Webpage highlight module — `highlight.ts`

**Files:**
- Create: `src/platform/highlight.ts`

**Interfaces:**
- Consumes: `findTextInChunks` (Task 1).
- Produces (for Task 4/5):
  - `highlightTextOnPage(tabId: number, query: string, label?: string): Promise<{ found: boolean; count: number; message: string }>`
  - `highlightRegionOnPage(tabId: number, region: number, label?: string): Promise<{ found: boolean; message: string }>`
  - `clearAllHighlights(): Promise<void>`

- [ ] **Step 1: Write the module**

```ts
// src/platform/highlight.ts
// The "show me where" highlighter: scrolls the active tab to a passage or
// region and marks it like a highlighter pen. Distinct from presence.ts (the
// agent-is-acting overlay) in two deliberate ways: it is marker-yellow, not
// agent-blue, and it OUTLIVES the turn — the whole point is that the user reads
// the marked passage after the answer lands. Cleared at the next fresh turn
// (Chat.tsx), by replacement, or by navigation wiping the page.
//
// Text passages use the CSS Custom Highlight API (a Range registered in
// CSS.highlights + one injected ::highlight rule), which tracks reflow/resize
// natively. Regions (charts/figures — a background color would be invisible)
// get a document-space ring in an overlay root instead.
//
// Injected functions are fully self-contained (no closures/imports); the text
// path is two injections around the pure matcher: collect node texts → match in
// the panel (findTextInChunks) → re-walk and apply. Both walks share ONE
// injected function so the node order cannot drift between them.
import { findTextInChunks } from './highlightText'

const ROOT_ID = '__agent_highlight'
const STYLE_ID = '__agent_highlight_style'
const HL_NAME = 'agent-highlight'
const REGION_ATTR = 'data-agent-region'
// Bound the collect payload — beyond this the page is pathological.
const MAX_COLLECT_CHARS = 500_000

/** Tabs with a live highlight, so the next fresh turn can sweep them. */
const highlighted = new Set<number>()

interface ApplyPayload {
  startChunk: number
  startOffset: number
  endChunk: number
  endOffset: number
  label: string
}

// One function, two modes, one TreeWalker: 'collect' returns the text-node
// strings; 'apply' re-walks the SAME filter (same function ⇒ same order), builds
// the Range from the matched (chunk, offset) endpoints, registers the CSS
// highlight, scrolls, and places the pill + glow. The filter deliberately skips
// only definitely-invisible containers (script/style/…): per-node style checks
// are expensive and any nondeterminism between the two walks would misplace the
// Range.
async function injTextHighlight(
  rootId: string,
  styleId: string,
  hlName: string,
  maxChars: number,
  mode: 'collect' | 'apply',
  payload: ApplyPayload | null,
) {
  const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TEXTAREA)$/
  const nodes: Text[] = []
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const p = (node as Text).parentElement
      if (!p || SKIP.test(p.tagName.toUpperCase())) return NodeFilter.FILTER_REJECT
      if (!(node.textContent || '').length) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })
  let total = 0
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push(n as Text)
    total += (n.textContent || '').length
    if (total > maxChars) break
  }

  if (mode === 'collect') {
    return { texts: nodes.map((n) => n.textContent || ''), truncated: total > maxChars }
  }

  const p = payload!
  const startNode = nodes[p.startChunk]
  const endNode = nodes[p.endChunk]
  if (!startNode || !endNode) return { ok: false }
  const range = new Range()
  range.setStart(startNode, Math.min(p.startOffset, (startNode.textContent || '').length))
  range.setEnd(endNode, Math.min(p.endOffset, (endNode.textContent || '').length))

  // Custom Highlight API, feature-detected without relying on TS lib types
  // (the injected source is serialized; these globals are the page's own).
  const HighlightCtor = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight
  const registry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights
  if (!HighlightCtor || !registry) return { ok: false }
  const existing = registry.get(hlName) as { add(r: Range): void } | undefined
  if (existing) existing.add(range)
  else registry.set(hlName, new HighlightCtor(range))
  if (!document.getElementById(styleId)) {
    const style = document.createElement('style')
    style.id = styleId
    style.textContent = `::highlight(${hlName}){background-color:rgba(255,213,79,.55);color:inherit;}`
    document.head.appendChild(style)
  }

  range.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  // Let the smooth scroll (and any lazy-load reflow it triggers) settle, then
  // read the LIVE rect for the pill/glow — document-space, so later scrolling
  // doesn't detach them from the text.
  await new Promise((r) => setTimeout(r, 700))
  const rect = range.getBoundingClientRect()
  const docX = rect.left + window.scrollX
  const docY = rect.top + window.scrollY

  let root = document.getElementById(rootId)
  if (!root) {
    root = document.createElement('div')
    root.id = rootId
    root.style.cssText =
      'position:absolute;left:0;top:0;width:0;height:0;overflow:visible;z-index:2147483645;pointer-events:none;'
    document.documentElement.appendChild(root)
  }
  if (p.label) {
    const pill = document.createElement('div')
    pill.style.cssText =
      'position:absolute;padding:3px 8px;background:#ffd54f;color:#3d2e00;border-radius:6px;' +
      'font:600 12px system-ui;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.25);' +
      `transform:translateY(-130%);left:${docX}px;top:${docY}px;`
    pill.textContent = p.label
    root.appendChild(pill)
  }
  const glow = document.createElement('div')
  glow.style.cssText =
    `position:absolute;left:${docX - 6}px;top:${docY - 6}px;width:${rect.width + 12}px;` +
    `height:${rect.height + 12}px;border-radius:8px;pointer-events:none;` +
    'box-shadow:0 0 0 3px rgba(255,213,79,.9),0 0 26px 8px rgba(255,213,79,.55);'
  root.appendChild(glow)
  glow.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 1600, easing: 'ease-out', fill: 'forwards' })
  setTimeout(() => glow.remove(), 1700)
  return { ok: true }
}

// Region ring: re-find the region by its [rN] stamp, scroll, wait for the
// scroll/lazy-load to settle, then read the LIVE rect (the indexed rect is
// stale by then — see the regionIndex invariant) and ring it in document space.
async function injRegionHighlight(rootId: string, attr: string, region: number, label: string) {
  const el = document.querySelector(`[${attr}="${region}"]`)
  if (!el) return { found: false }
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  await new Promise((r) => setTimeout(r, 700))
  const rect = el.getBoundingClientRect()
  const docX = rect.left + window.scrollX
  const docY = rect.top + window.scrollY

  let root = document.getElementById(rootId)
  if (!root) {
    root = document.createElement('div')
    root.id = rootId
    root.style.cssText =
      'position:absolute;left:0;top:0;width:0;height:0;overflow:visible;z-index:2147483645;pointer-events:none;'
    document.documentElement.appendChild(root)
  }
  const pad = 5
  const ring = document.createElement('div')
  ring.style.cssText =
    `position:absolute;left:${docX - pad}px;top:${docY - pad}px;width:${rect.width + pad * 2}px;` +
    `height:${rect.height + pad * 2}px;border:2.5px solid rgba(255,193,7,.95);border-radius:8px;` +
    'box-shadow:0 0 0 4px rgba(255,213,79,.28);pointer-events:none;'
  root.appendChild(ring)
  if (label) {
    const pill = document.createElement('div')
    pill.style.cssText =
      'position:absolute;padding:3px 8px;background:#ffd54f;color:#3d2e00;border-radius:6px;' +
      'font:600 12px system-ui;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.25);' +
      `transform:translateY(-130%);left:${docX - pad}px;top:${docY - pad}px;`
    pill.textContent = label
    root.appendChild(pill)
  }
  ring.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 350, easing: 'ease-out', fill: 'both' })
  return { found: true }
}

function injClear(rootId: string, styleId: string, hlName: string) {
  document.getElementById(rootId)?.remove()
  document.getElementById(styleId)?.remove()
  const registry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights
  registry?.delete(hlName)
}

/**
 * Find `query` in the page's text and mark it: marker-yellow background via the
 * Custom Highlight API, smooth-scrolled to center, optional label pill, brief
 * glow. Returns whether it was found plus the total occurrence count (first
 * occurrence is the one marked).
 */
export async function highlightTextOnPage(
  tabId: number,
  query: string,
  label = '',
): Promise<{ found: boolean; count: number; message: string }> {
  let collected: { texts: string[]; truncated: boolean } | undefined
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: injTextHighlight,
      args: [ROOT_ID, STYLE_ID, HL_NAME, MAX_COLLECT_CHARS, 'collect', null],
    })
    collected = res?.result as typeof collected
  } catch (err) {
    return {
      found: false,
      count: 0,
      message: `Cannot highlight on this page (${err instanceof Error ? err.message : 'it may be a restricted page'}).`,
    }
  }
  if (!collected) return { found: false, count: 0, message: 'Cannot read this page to highlight it.' }
  const m = findTextInChunks(collected.texts, query)
  if (!m.first) {
    return {
      found: false,
      count: 0,
      message:
        'That passage was not found on the page. Quote the text exactly as it appears (re-read with ReadPage if needed) — you may have paraphrased it.',
    }
  }
  const [applied] = await chrome.scripting.executeScript({
    target: { tabId },
    func: injTextHighlight,
    args: [ROOT_ID, STYLE_ID, HL_NAME, MAX_COLLECT_CHARS, 'apply', { ...m.first, label }],
  })
  if (!(applied?.result as { ok?: boolean } | undefined)?.ok) {
    return { found: false, count: m.count, message: 'Found the passage but could not mark it on this page.' }
  }
  highlighted.add(tabId)
  const many = m.count > 1 ? ` It appears ${m.count} times; the first occurrence is marked — quote a longer stretch to pin a different one.` : ''
  return { found: true, count: m.count, message: `Scrolled to the passage and highlighted it for the user.${many}` }
}

/**
 * Ring one visual region ([rN] from ReadPage mode:"regions"): smooth-scroll to
 * it, then draw a document-space ring + optional label pill around its live rect.
 */
export async function highlightRegionOnPage(
  tabId: number,
  region: number,
  label = '',
): Promise<{ found: boolean; message: string }> {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: injRegionHighlight,
      args: [ROOT_ID, REGION_ATTR, region, label],
    })
    if (!(res?.result as { found?: boolean } | undefined)?.found) {
      return {
        found: false,
        message: `No region [r${region}] on this page — the page may have changed. Re-run ReadPage(mode:"regions") and use a fresh number.`,
      }
    }
  } catch (err) {
    return {
      found: false,
      message: `Cannot highlight on this page (${err instanceof Error ? err.message : 'it may be a restricted page'}).`,
    }
  }
  highlighted.add(tabId)
  return { found: true, message: `Scrolled to region [r${region}] and highlighted it for the user.` }
}

/**
 * Sweep highlights from every tab that has one. Called at the START of the next
 * fresh turn (Chat.tsx) — deliberately NOT in the turn's teardown `finally`,
 * unlike the presence overlay: highlights must outlive their turn so the user
 * can read what was marked.
 */
export async function clearAllHighlights(): Promise<void> {
  const ids = [...highlighted]
  highlighted.clear()
  await Promise.all(
    ids.map((id) =>
      chrome.scripting
        .executeScript({ target: { tabId: id }, func: injClear, args: [ROOT_ID, STYLE_ID, HL_NAME] })
        .catch(() => {}),
    ),
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/platform/highlight.ts
git commit -m "feat(highlight): on-page passage/region highlighter module" -- src/platform/highlight.ts
```

---

### Task 3: PDF highlighted render — `pdf.ts`

**Files:**
- Modify: `src/platform/pdf.ts` (refactor `renderPdfPage`'s canvas body into a shared helper; add `renderPdfPageHighlighted`)

**Interfaces:**
- Consumes: `findTextInChunks` (Task 1), existing `getEntry`/`getPdfjs`/`RENDER_LONG_EDGE`.
- Produces (for Task 4): `renderPdfPageHighlighted(url: string, pageNumber: number, query: string, opts?: { credentials?: RequestCredentials; signal?: AbortSignal }): Promise<{ dataUrl: string; width: number; height: number; pageCount: number; title: string; matched: boolean; matchCount: number }>`

- [ ] **Step 1: Add the import and refactor the render body**

Add to the imports at the top of `src/platform/pdf.ts`:

```ts
import { findTextInChunks } from './highlightText'
```

Replace the body of `renderPdfPage` (keep its signature and doc comment) and add the helper directly above it:

```ts
// Shared canvas render for renderPdfPage / renderPdfPageHighlighted: one page,
// scaled so its long edge is RENDER_LONG_EDGE device pixels.
async function renderPageToCanvas(doc: PDFDocumentProxy, pageNumber: number) {
  const page = await doc.getPage(pageNumber)
  const base = page.getViewport({ scale: 1 })
  const scale = Math.min(3, Math.max(0.3, RENDER_LONG_EDGE / Math.max(base.width, base.height)))
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new PdfError('Could not create a canvas to render the page.')
  await page.render({ canvas, canvasContext: ctx, viewport }).promise
  return { page, canvas, ctx, viewport }
}
```

New `renderPdfPage` body:

```ts
export async function renderPdfPage(
  url: string,
  pageNumber: number,
  opts?: { credentials?: RequestCredentials; signal?: AbortSignal },
): Promise<{ dataUrl: string; width: number; height: number; pageCount: number; title: string }> {
  const { doc, loaded } = await getEntry(url, opts)
  if (pageNumber < 1 || pageNumber > doc.numPages) {
    throw new PdfError(`No page ${pageNumber} — this PDF has ${doc.numPages} pages.`)
  }
  const { canvas } = await renderPageToCanvas(doc, pageNumber)
  return {
    dataUrl: canvas.toDataURL('image/png'),
    width: canvas.width,
    height: canvas.height,
    pageCount: doc.numPages,
    title: loaded.info.title,
  }
}
```

- [ ] **Step 2: Add `renderPdfPageHighlighted`**

Append after `renderPdfPage`:

```ts
/** The subset of a pdf.js text item the highlighter needs (TextMarkedContent has no `str`). */
interface PdfTextItem {
  str: string
  transform: number[]
  width: number
  height: number
}

/**
 * Render one page with `query` marked like a highlighter pen. The match runs
 * over the page's text items (findTextInChunks — the same matcher the webpage
 * path uses, so PDF items that omit inter-word spaces still match); each
 * matched item's box is mapped through the viewport transform and painted as a
 * translucent multiply rect, so the text stays legible under the marker.
 * `matched:false` means the passage wasn't found on THIS page — the plain
 * render is returned so the caller can still show the page.
 */
export async function renderPdfPageHighlighted(
  url: string,
  pageNumber: number,
  query: string,
  opts?: { credentials?: RequestCredentials; signal?: AbortSignal },
): Promise<{
  dataUrl: string
  width: number
  height: number
  pageCount: number
  title: string
  matched: boolean
  matchCount: number
}> {
  const { doc, loaded } = await getEntry(url, opts)
  if (pageNumber < 1 || pageNumber > doc.numPages) {
    throw new PdfError(`No page ${pageNumber} — this PDF has ${doc.numPages} pages.`)
  }
  const { page, canvas, ctx, viewport } = await renderPageToCanvas(doc, pageNumber)
  const content = await page.getTextContent()
  const items = (content.items as unknown[]).filter(
    (it): it is PdfTextItem => typeof (it as PdfTextItem).str === 'string',
  )
  const m = findTextInChunks(items.map((it) => it.str), query)
  if (m.first) {
    const pdfjs = await getPdfjs()
    ctx.globalCompositeOperation = 'multiply'
    ctx.fillStyle = 'rgba(255,213,79,0.6)'
    for (let i = m.first.startChunk; i <= m.first.endChunk; i++) {
      const it = items[i]
      // Item transform is in PDF space; composing with the viewport transform
      // yields the device-space baseline origin. Glyph height falls out of the
      // composed matrix's scale component.
      const tx = pdfjs.Util.transform(viewport.transform, it.transform)
      const h = Math.hypot(tx[2], tx[3]) || it.height * viewport.scale
      const w = it.width * viewport.scale
      ctx.fillRect(tx[4] - 1, tx[5] - h, w + 2, h * 1.2)
    }
    ctx.globalCompositeOperation = 'source-over'
  }
  return {
    dataUrl: canvas.toDataURL('image/png'),
    width: canvas.width,
    height: canvas.height,
    pageCount: doc.numPages,
    title: loaded.info.title,
    matched: m.first !== null,
    matchCount: m.count,
  }
}
```

- [ ] **Step 3: Typecheck and run the suite**

Run: `npm run typecheck && npx vitest run src/platform`
Expected: exit 0; all platform tests pass (pdf.ts itself is Chrome/DOM-coupled — the matcher it now shares is the tested part).

- [ ] **Step 4: Commit**

```bash
git add src/platform/pdf.ts
git commit -m "feat(pdf): render a page with a matched passage highlighted" -- src/platform/pdf.ts
```

---

### Task 4: The `HighlightContent` tool — `tools.ts` + `settings.ts`

**Files:**
- Modify: `src/tools/tools.ts` (imports; new tool after `ReadPdf`; tip lines in `ReadPage` text mode and `ReadPdf` search results)
- Modify: `src/data/settings.ts` (TOOL_CATALOG entry)

**Interfaces:**
- Consumes: `highlightTextOnPage` / `highlightRegionOnPage` (Task 2), `renderPdfPageHighlighted` (Task 3), existing `looksLikePdfUrl`, `searchPages`, `loadPdf`, `saveShot`, `requestApproval`, `pageControl`.
- Produces: tool name `HighlightContent` (referenced by Task 5's comment and the tip copy).

- [ ] **Step 1: Wire imports in `tools.ts`**

Extend the existing import lines:

```ts
import { loadPdf, renderPdfPage, renderPdfPageHighlighted, PdfError, type LoadedPdf } from '../platform/pdf'
import { highlightTextOnPage, highlightRegionOnPage } from '../platform/highlight'
```

- [ ] **Step 2: Add the tool to `createAgentTools`, directly after the `ReadPdf` entry**

```ts
    HighlightContent: tool({
      description:
        'Show the user exactly WHERE on the page your answer comes from: scroll the active tab to a passage or region and mark it like a highlighter pen. Use this proactively whenever your answer is grounded in a specific passage, clause, figure, or section of the page or PDF the user is viewing ("which part mentions…", "what are the terms…"). Pass `text` (the passage, quoted exactly from the page/PDF) or `region` (an [rN] from ReadPage mode:"regions"); calls accumulate, so highlight each clause of a multi-part answer. On a PDF tab the viewer jumps to the page and the user is shown that page rendered with the passage marked. Highlights stay visible after your answer. Asks the user for permission first (except while a page-control session already owns this tab).',
      inputSchema: z.object({
        text: z
          .string()
          .optional()
          .describe('The passage to highlight, quoted exactly as it appears on the page or PDF (a phrase to a couple of sentences).'),
        region: z
          .number()
          .optional()
          .describe('A region number from ReadPage(mode:"regions"), e.g. 2 for [r2] — for charts/figures/tables (webpages only).'),
        label: z.string().optional().describe('Optional short callout shown beside the highlight, e.g. "Termination clause".'),
        page: z
          .number()
          .optional()
          .describe('PDF only: the page the passage is on (from ReadPdf search/pages). Omit to search the whole PDF.'),
        reason: z.string().describe('Short reason shown to the user, e.g. "To show where the terms are stated"'),
      }),
      execute: async ({ text, region, label, page, reason }) => {
        if (!text?.trim() && region === undefined)
          return { error: 'Pass either `text` (a quoted passage) or `region` (an [rN] number).' }
        const tab = await getActiveTab()
        if (tab?.id === undefined) return { error: 'No active tab found.' }
        const isPdf = looksLikePdfUrl(tab.url ?? '')
        if (isPdf && region !== undefined)
          return { error: 'The active tab is a PDF — regions do not exist there. Pass `text` (optionally with a `page` from ReadPdf search).' }

        // Same exemption as the other perception tools: an open control session
        // already covers pointing at the page it is driving.
        const open = pageControl.session()
        const owned = !!open && open.active && open.tabId === tab.id
        if (!owned) {
          const summary =
            region !== undefined
              ? `Highlight a region on this page`
              : `Highlight “${text!.trim().slice(0, 60)}${text!.trim().length > 60 ? '…' : ''}” on ${isPdf ? 'the PDF' : 'this page'}`
          const approved = await requestApproval({ toolName: 'HighlightContent', summary, reason })
          if (!approved) return DENIED
        }

        if (isPdf) {
          const creds = { credentials: 'include' as const }
          const target = tab.url!
          try {
            let targetPage = page
            if (!targetPage) {
              const loaded = await loadPdf(target, creds)
              const found = searchPages(loaded.pages, text!)
              if ('error' in found) return { error: found.error }
              if (found.totalMatches === 0) {
                return {
                  found: false,
                  note: 'That passage was not found in the PDF. Quote the text exactly as ReadPdf returned it (mode:"search" finds its page), or pass a `page` number.',
                }
              }
              targetPage = found.matches[0].page
            }
            const r = await renderPdfPageHighlighted(target, targetPage, text!, creds)
            // Same contract as the screenshot tools: the render is a USER
            // artifact (ShotCard). It never rides imageQueue — the model already
            // knows the text it asked to highlight.
            const shotId = await saveShot({
              dataUrl: r.dataUrl,
              width: r.width,
              height: r.height,
              url: target,
              title: r.title,
              label: label?.trim() || `PDF page ${targetPage} — highlighted`,
              conversationId,
            })
            // Best-effort jump: Chrome honors #page=N on load; an already-open
            // viewer may ignore a fragment-only change. The in-chat render
            // carries the answer regardless.
            try {
              await chrome.tabs.update(tab.id, { url: `${target.split('#')[0]}#page=${targetPage}` })
            } catch {
              /* best-effort */
            }
            return {
              ok: true,
              shotId,
              page: targetPage,
              pageCount: r.pageCount,
              note: `Sent the PDF viewer to page ${targetPage} and showed the user that page with the passage marked${r.matched ? '' : ' (the passage could not be located on that rendered page, so the plain page was shown)'}. The image was not sent to you — you already know the text.`,
            }
          } catch (err) {
            if (err instanceof PdfError) return { error: err.message }
            return { error: `Could not highlight in the PDF (${err instanceof Error ? err.message : String(err)}).` }
          }
        }

        if (region !== undefined) {
          const r = await highlightRegionOnPage(tab.id, region, label)
          return r.found ? { ok: true, note: r.message } : { error: r.message }
        }
        const r = await highlightTextOnPage(tab.id, text!, label)
        return r.found ? { ok: true, occurrences: r.count, note: r.message } : { error: r.message }
      },
    }),
```

- [ ] **Step 3: Add the proactive tips**

In `ReadPage`'s text-mode tail (currently `return await readTabContent(tab.id)`):

```ts
        if (mode === 'dom') return await readTabDom(tab.id, MAX_DOM_CHARS)
        const content = await readTabContent(tab.id)
        if ('error' in content && content.error) return content
        return {
          ...content,
          tip: 'When your answer comes from a specific passage on this page, call HighlightContent with that exact text to scroll to it and mark it for the user.',
        }
```

In `ReadPdf`'s search mode, after the existing `capped` note logic, add:

```ts
          if (r.totalMatches > 0) {
            notes.push('To point the user at a passage in their viewer, call HighlightContent with the matched text and its page number.')
          }
```

- [ ] **Step 4: Add the permissions-catalog entry in `settings.ts`**

In `TOOL_CATALOG`, after the `ReadPdf` line:

```ts
  { name: 'HighlightContent', group: 'reading', label: 'Highlight a passage on the page' },
```

- [ ] **Step 5: Typecheck and run the tool-discovery/agent tests**

Run: `npm run typecheck && npx vitest run src/tools src/agent`
Expected: exit 0; all pass (the catalog is derived, so `HighlightContent` becomes discoverable and self-healing via `repairToolCall` automatically).

- [ ] **Step 6: Commit**

```bash
git add src/tools/tools.ts src/data/settings.ts
git commit -m "feat(highlight): HighlightContent tool — scroll to and mark cited passages" -- src/tools/tools.ts src/data/settings.ts
```

---

### Task 5: Lifetime wiring — `Chat.tsx`

**Files:**
- Modify: `src/ui/Chat.tsx` (import; clear-at-fresh-turn in `startFreshTurn`; teardown comment in `runTurnChain`'s `finally`)

**Interfaces:**
- Consumes: `clearAllHighlights` (Task 2).

- [ ] **Step 1: Import**

Beside the existing presence import (`src/ui/Chat.tsx:44`):

```ts
import { clearAllHighlights } from '../platform/highlight'
```

- [ ] **Step 2: Clear at the start of a fresh turn**

In `startFreshTurn`, right after `steerQueueRef.current = []` (the orphaned-steer reset around line 1427):

```ts
    // A fresh question starts from a clean page: sweep any passage highlights
    // the previous turn left behind. Deliberately here and NOT in runTurnChain's
    // finally — unlike the presence overlay, highlights must OUTLIVE their turn
    // so the user can read what was marked (see src/platform/highlight.ts).
    void clearAllHighlights()
```

Do NOT add this to `continueTask` — a continued task is the same question, and its highlights should stay.

- [ ] **Step 3: Flag the asymmetry at the teardown site**

In `runTurnChain`'s `finally`, extend the existing comment above `void unmountAllPresence()`:

```ts
      // Tear down ambient presence on any tab the chain touched (navigate/inspect
      // mount the frame outside a session, so endSession alone won't clear them).
      // Passage highlights (highlight.ts) are deliberately NOT cleared here —
      // they outlive the turn so the user can read what was marked; the next
      // fresh turn sweeps them (see startFreshTurn).
      void unmountAllPresence()
```

- [ ] **Step 4: Full build + suite**

Run: `npm run build && npm test`
Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/ui/Chat.tsx
git commit -m "feat(highlight): highlights persist past the turn, swept at the next fresh turn" -- src/ui/Chat.tsx
```

---

### Task 6: End-to-end verification

- [ ] **Step 1:** `npm run build && npm test` — both green (final gate).
- [ ] **Step 2:** Ask the user to reload the unpacked extension (`chrome://extensions` → ↻) and exercise: (a) on an article, ask "which part mentions X?" — expect the HighlightContent approval card, then scroll + yellow marker + optional label, persisting after the answer; (b) same question again — previous highlight sweeps at the new turn; (c) on a PDF tab, expect the viewer jump + the marked page render in chat. Playwright MCP is not loaded in this session, so the browser half is the user's.
