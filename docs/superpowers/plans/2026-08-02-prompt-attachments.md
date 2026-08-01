# Prompt Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Users attach files (images, PDFs, text-like files) to a chat message via drag-and-drop, paste, or a paperclip picker; a pure planner routes each attachment to the best wire form the active provider/model can consume; bytes persist once in a capped IndexedDB store referenced from history.

**Architecture:** Spec at `docs/superpowers/specs/2026-08-02-prompt-attachments-design.md`. New pure modules (`src/agent/attachmentPlan.ts`, `src/data/attachmentRefs.ts`) carry all routing/serialization logic and are unit-tested; a capped store (`src/data/attachments.ts`, modeled on `screenshots.ts`) holds bytes; `src/ui/attachments.ts` is the impure ingestion/assembly glue; `Chat.tsx` wires composer state, three ingestion surfaces, and the save/load dehydrate–hydrate boundary.

**Tech Stack:** React 18, TypeScript strict, Vercel AI SDK v5 (`ModelMessage` `file` parts), pdf.js (already bundled, lazy-loaded), Vitest, IndexedDB.

## Global Constraints

- Code style: **no semicolons**, single quotes, 2-space indent, `interface` for object shapes, `/** ... */` on exports, explain non-obvious *why* in block comments.
- Type-check with `npm run typecheck` — **never `npx tsc`** (fetches a decoy package).
- Tests: `npm test` (Vitest). Run the full suite before every commit.
- **Never construct a `file` part with a non-image mediaType for the `compatible` adapter path** — the adapter throws `UnsupportedFunctionalityError` and 400s the whole request. The planner is the single enforcement point.
- Images reach the model ONLY as user-message `{ type: 'file', mediaType: 'image', data: <dataURL> }` parts (never in tool results) — the existing shape at `Chat.tsx:1569`.
- Work in a git worktree (concurrent sessions run on main). After `EnterWorktree`: `git reset --hard main` (base lags), and symlink `node_modules` from the main checkout. Use worktree-absolute paths in every Edit/Read.
- Commit after each task, message style `feat(attachments): ...`, ending with the `Claude-Session:` trailer only (no Co-Authored-By / Generated-with lines).
- File sizes given as raw bytes; base64 inflates ~4/3 — native-PDF caps already account for it.

---

### Task 1: Provider profiles — native-document capability flags

**Files:**
- Modify: `src/data/providerProfiles.ts` (interface ~line 29-49, each profile in `PROFILES`)
- Test: `src/data/providerProfiles.test.ts` (exists — append)

**Interfaces:**
- Consumes: nothing new.
- Produces: `ProviderProfile.supportsNativeDocuments: boolean` and `ProviderProfile.nativeDocMaxBytes: number` (0 when unsupported), readable via the existing `profileFor(kind)`.

- [ ] **Step 1: Write the failing test** — append to `src/data/providerProfiles.test.ts`:

```ts
describe('native document support', () => {
  it('only the two native adapters accept native PDF parts', () => {
    expect(profileFor('anthropic').supportsNativeDocuments).toBe(true)
    expect(profileFor('openai').supportsNativeDocuments).toBe(true)
    for (const kind of ['openrouter', 'groq', 'ollama', 'lmstudio', 'custom'] as const) {
      expect(profileFor(kind).supportsNativeDocuments).toBe(false)
      expect(profileFor(kind).nativeDocMaxBytes).toBe(0)
    }
  })

  it('caps native PDFs below each provider request ceiling after base64 inflation', () => {
    // Anthropic: 32MB request cap → 20MB raw (~27MB as base64) leaves prompt headroom.
    expect(profileFor('anthropic').nativeDocMaxBytes).toBe(20 * 1024 * 1024)
    // OpenAI: 50MB per-request cap → 35MB raw (~47MB as base64).
    expect(profileFor('openai').nativeDocMaxBytes).toBe(35 * 1024 * 1024)
  })
})
```

- [ ] **Step 2: Run to verify failure** — `npm test -- providerProfiles` → FAIL (property missing).

- [ ] **Step 3: Implement** — add to the `ProviderProfile` interface:

```ts
  /**
   * Whether this kind's adapter converts an application/pdf `file` part into a
   * native document block (Anthropic `document`, OpenAI Responses `input_file`).
   * The compatible adapter does NOT — it throws on non-image file parts, so the
   * attachment planner must never route a raw PDF at a compatible provider.
   */
  supportsNativeDocuments: boolean
  /** Raw-byte ceiling for a native PDF part (base64 inflates ~4/3 toward the provider's request cap). 0 when unsupported. */
  nativeDocMaxBytes: number
```

Then per profile: `anthropic` → `supportsNativeDocuments: true, nativeDocMaxBytes: 20 * 1024 * 1024`; `openai` → `true, 35 * 1024 * 1024`; the other five kinds → `false, 0`.

- [ ] **Step 4: Run to verify pass** — `npm test -- providerProfiles` → PASS; `npm run typecheck` → clean.

- [ ] **Step 5: Commit** — `git add src/data/providerProfiles.ts src/data/providerProfiles.test.ts && git commit` (`feat(attachments): provider profiles learn native-document capability`).

---

### Task 2: Pure attachment planner — classification, routing, text budgeting

**Files:**
- Create: `src/agent/attachmentPlan.ts`
- Test: `src/agent/attachmentPlan.test.ts`

**Interfaces:**
- Consumes: nothing (pure; **no Chrome, no AI-SDK imports** — keep it that way).
- Produces (used by Tasks 5/6/7):

```ts
export type AttachmentKind = 'image' | 'pdf' | 'text'
export const MAX_ATTACHMENTS = 10
export const PAGE_BUDGET = 20
export const IMAGE_MAX_BYTES = 20 * 1024 * 1024
export const PDF_MAX_BYTES = 50 * 1024 * 1024
export const TEXT_FILE_MAX_BYTES = 2 * 1024 * 1024
export const INLINE_TEXT_BUDGET = 48_000
export const PDF_TEXT_BUDGET = 48_000
export function classifyIncomingFile(name: string, mimeType: string, byteSize: number): { kind: AttachmentKind } | { error: string }
export function looksBinary(sample: string): boolean
export interface AttachmentDescriptor { kind: AttachmentKind; name: string; byteSize: number; pageCount?: number }
export interface DeliveryContext { supportsNativeDocuments: boolean; nativeDocMaxBytes: number; visionCapable: boolean }
export type DeliveryRoute =
  | { route: 'image-part' }
  | { route: 'image-note'; note: string }
  | { route: 'native-pdf' }
  | { route: 'pdf-pages'; pages: number[]; truncationNote: string | null }
  | { route: 'pdf-text'; budget: number }
  | { route: 'inline-text'; budget: number }
export function planAttachmentDelivery(att: AttachmentDescriptor, ctx: DeliveryContext): DeliveryRoute
export function pageCaption(name: string, page: number, pageCount: number): string
export function formatInlineTextBlock(name: string, text: string, budget: number): string
```

- [ ] **Step 1: Write the failing tests** — `src/agent/attachmentPlan.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  classifyIncomingFile, formatInlineTextBlock, looksBinary, pageCaption,
  planAttachmentDelivery, IMAGE_MAX_BYTES, PAGE_BUDGET, PDF_MAX_BYTES,
  PDF_TEXT_BUDGET, TEXT_FILE_MAX_BYTES,
} from './attachmentPlan'

const native = { supportsNativeDocuments: true, nativeDocMaxBytes: 20 * 1024 * 1024, visionCapable: true }
const compatVision = { supportsNativeDocuments: false, nativeDocMaxBytes: 0, visionCapable: true }
const compatBlind = { supportsNativeDocuments: false, nativeDocMaxBytes: 0, visionCapable: false }
const pdf = (bytes: number, pages: number) => ({ kind: 'pdf' as const, name: 'r.pdf', byteSize: bytes, pageCount: pages })

describe('classifyIncomingFile', () => {
  it('classifies by MIME first, extension as fallback', () => {
    expect(classifyIncomingFile('a.png', 'image/png', 10)).toEqual({ kind: 'image' })
    expect(classifyIncomingFile('a.pdf', 'application/pdf', 10)).toEqual({ kind: 'pdf' })
    expect(classifyIncomingFile('notes.md', '', 10)).toEqual({ kind: 'text' })
    expect(classifyIncomingFile('data.csv', 'text/csv', 10)).toEqual({ kind: 'text' })
    expect(classifyIncomingFile('script.py', 'application/octet-stream', 10)).toEqual({ kind: 'text' })
  })
  it('rejects unsupported types with the filename in the error', () => {
    const r = classifyIncomingFile('deck.pptx', 'application/vnd.ms-powerpoint', 10)
    expect('error' in r && r.error).toContain('deck.pptx')
  })
  it('rejects oversize per kind', () => {
    expect('error' in classifyIncomingFile('a.png', 'image/png', IMAGE_MAX_BYTES + 1)).toBe(true)
    expect('error' in classifyIncomingFile('a.pdf', 'application/pdf', PDF_MAX_BYTES + 1)).toBe(true)
    expect('error' in classifyIncomingFile('a.txt', 'text/plain', TEXT_FILE_MAX_BYTES + 1)).toBe(true)
  })
})

describe('looksBinary', () => {
  it('flags NUL/control-heavy samples, passes prose and code', () => {
    expect(looksBinary('hello\nworld\t{}')).toBe(false)
    expect(looksBinary('PK   ')).toBe(true)
  })
})

describe('planAttachmentDelivery', () => {
  it('routes images by vision', () => {
    const img = { kind: 'image' as const, name: 'shot.png', byteSize: 1000 }
    expect(planAttachmentDelivery(img, native)).toEqual({ route: 'image-part' })
    const blind = planAttachmentDelivery(img, compatBlind)
    expect(blind.route).toBe('image-note')
    if (blind.route === 'image-note') expect(blind.note).toContain('shot.png')
  })
  it('routes small PDFs natively on native-doc providers', () => {
    expect(planAttachmentDelivery(pdf(1024, 5), native)).toEqual({ route: 'native-pdf' })
  })
  it('oversized PDF on a native provider degrades to the fallback ladder', () => {
    const r = planAttachmentDelivery(pdf(21 * 1024 * 1024, 5), native)
    expect(r.route).toBe('pdf-pages')
  })
  it('renders page screenshots on vision-capable non-native providers, budgeted', () => {
    const short = planAttachmentDelivery(pdf(1024, 5), compatVision)
    expect(short).toEqual({ route: 'pdf-pages', pages: [1, 2, 3, 4, 5], truncationNote: null })
    const long = planAttachmentDelivery(pdf(1024, 60), compatVision)
    if (long.route !== 'pdf-pages') throw new Error(long.route)
    expect(long.pages).toHaveLength(PAGE_BUDGET)
    expect(long.truncationNote).toContain(`first ${PAGE_BUDGET} of 60 pages`)
  })
  it('falls back to text extraction for blind models', () => {
    expect(planAttachmentDelivery(pdf(1024, 5), compatBlind)).toEqual({ route: 'pdf-text', budget: PDF_TEXT_BUDGET })
  })
  it('text files inline everywhere', () => {
    const t = { kind: 'text' as const, name: 'notes.md', byteSize: 100 }
    expect(planAttachmentDelivery(t, native).route).toBe('inline-text')
    expect(planAttachmentDelivery(t, compatBlind).route).toBe('inline-text')
  })
})

describe('formatInlineTextBlock', () => {
  it('wraps content in a named fence', () => {
    const b = formatInlineTextBlock('notes.md', 'hello', 100)
    expect(b).toContain('--- attached file: notes.md ---')
    expect(b).toContain('hello')
    expect(b).not.toContain('truncated')
  })
  it('truncates over budget with a notice', () => {
    const b = formatInlineTextBlock('big.txt', 'x'.repeat(200), 100)
    expect(b).toContain('[truncated — file continues')
    expect(b.length).toBeLessThan(400)
  })
})

describe('pageCaption', () => {
  it('names the file and page', () => {
    expect(pageCaption('r.pdf', 3, 42)).toBe('r.pdf — page 3 of 42')
  })
})
```

- [ ] **Step 2: Run to verify failure** — `npm test -- attachmentPlan` → FAIL (module not found).

- [ ] **Step 3: Implement** `src/agent/attachmentPlan.ts` (header comment explaining it is the single place that knows which wire form each provider can consume, and why the compat adapter must never see a raw PDF):

```ts
const IMAGE_MIME = /^image\/(png|jpeg|webp|gif)$/
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|yaml|yml|xml|html|css|js|jsx|ts|tsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|sh|toml|ini|log|sql)$/i

export function classifyIncomingFile(name, mimeType, byteSize) {
  if (IMAGE_MIME.test(mimeType)) {
    return byteSize > IMAGE_MAX_BYTES ? { error: `"${name}" is larger than the 20 MB image limit.` } : { kind: 'image' }
  }
  if (mimeType === 'application/pdf' || /\.pdf$/i.test(name)) {
    return byteSize > PDF_MAX_BYTES ? { error: `"${name}" is larger than the 50 MB PDF limit.` } : { kind: 'pdf' }
  }
  if (mimeType.startsWith('text/') || TEXT_EXT.test(name)) {
    return byteSize > TEXT_FILE_MAX_BYTES ? { error: `"${name}" is larger than the 2 MB text-file limit.` } : { kind: 'text' }
  }
  return { error: `"${name}" is not a supported type (images, PDFs, and text files only).` }
}

export function looksBinary(sample: string): boolean {
  let control = 0
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i)
    if (c === 0) return true
    if (c < 32 && c !== 9 && c !== 10 && c !== 13) control++
  }
  return sample.length > 0 && control / sample.length > 0.05
}

export function planAttachmentDelivery(att, ctx): DeliveryRoute {
  if (att.kind === 'image') {
    return ctx.visionCapable
      ? { route: 'image-part' }
      : { route: 'image-note', note: `[The user attached the image "${att.name}", but this model cannot read images — say so rather than guessing its contents.]` }
  }
  if (att.kind === 'pdf') {
    if (ctx.supportsNativeDocuments && att.byteSize <= ctx.nativeDocMaxBytes) return { route: 'native-pdf' }
    if (ctx.visionCapable) {
      const total = att.pageCount ?? 1
      const shown = Math.min(total, PAGE_BUDGET)
      const pages = Array.from({ length: shown }, (_, i) => i + 1)
      const truncationNote = total > shown
        ? `[Only the first ${shown} of ${total} pages of "${att.name}" are shown as images.]`
        : null
      return { route: 'pdf-pages', pages, truncationNote }
    }
    return { route: 'pdf-text', budget: PDF_TEXT_BUDGET }
  }
  return { route: 'inline-text', budget: INLINE_TEXT_BUDGET }
}

export function pageCaption(name, page, pageCount) { return `${name} — page ${page} of ${pageCount}` }

export function formatInlineTextBlock(name, text, budget) {
  const truncated = text.length > budget
  const body = truncated ? text.slice(0, budget) : text
  const tail = truncated ? `\n[truncated — file continues past the ${budget.toLocaleString()}-character budget]` : ''
  return `--- attached file: ${name} ---\n${body}${tail}\n--- end of ${name} ---`
}
```

(Write full typed signatures per the Interfaces block; snippets above show logic, not final formatting.)

- [ ] **Step 4: Run to verify pass** — `npm test -- attachmentPlan` → PASS; `npm run typecheck` → clean.

- [ ] **Step 5: Commit** — `feat(attachments): pure delivery planner (classification, routing, budgets)`.

---

### Task 3: History dehydrate/hydrate — attachment refs

**Files:**
- Create: `src/data/attachmentRefs.ts`
- Test: `src/data/attachmentRefs.test.ts`

**Interfaces:**
- Consumes: `import type { ModelMessage } from 'ai'` (type-only, same as `conversations.ts`).
- Produces (used by Task 7):

```ts
export interface AttachmentRef { id: string; page?: number }
export function lycheeProviderOptions(ref: AttachmentRef): { lychee: { attachmentId: string; page?: number } }
export function dehydrateHistory(history: ModelMessage[]): ModelMessage[]
export function hydrateHistory(history: ModelMessage[], resolve: (ref: AttachmentRef) => Promise<string | null>): Promise<ModelMessage[]>
```

Sentinel format: `data` string `lychee-attachment:<id>` or `lychee-attachment:<id>#page=<n>`. Parts are recognized by `part.providerOptions?.lychee?.attachmentId` (dehydrate) or the sentinel prefix (hydrate). The `lychee` namespace is invisible on the wire — adapters read only their own key.

- [ ] **Step 1: Write the failing tests** — `src/data/attachmentRefs.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { ModelMessage } from 'ai'
import { dehydrateHistory, hydrateHistory, lycheeProviderOptions } from './attachmentRefs'

const filePart = (data: string, id?: string, page?: number) => ({
  type: 'file' as const, mediaType: 'application/pdf', data,
  ...(id ? { providerOptions: lycheeProviderOptions({ id, page }) } : {}),
})
const msg = (parts: unknown[]): ModelMessage => ({ role: 'user', content: parts as never })

describe('dehydrateHistory', () => {
  it('swaps tagged file-part data for a sentinel, leaves untagged parts alone', () => {
    const history = [msg([filePart('data:application/pdf;base64,AAAA', 'a1'), filePart('data:image/png;base64,BBBB'), { type: 'text', text: 'hi' }])]
    const out = dehydrateHistory(history)
    const parts = out[0].content as never as { data?: string; text?: string }[]
    expect(parts[0].data).toBe('lychee-attachment:a1')
    expect(parts[1].data).toBe('data:image/png;base64,BBBB')
    expect(parts[2].text).toBe('hi')
    // input untouched (persistence must not mutate live history)
    expect((history[0].content as never as { data: string }[])[0].data).toContain('base64')
  })
  it('encodes a page ref', () => {
    const out = dehydrateHistory([msg([filePart('data:image/png;base64,CCCC', 'a2', 3)])])
    expect((out[0].content as never as { data: string }[])[0].data).toBe('lychee-attachment:a2#page=3')
  })
  it('passes string-content messages through untouched', () => {
    const history: ModelMessage[] = [{ role: 'user', content: 'plain' }]
    expect(dehydrateHistory(history)).toEqual(history)
  })
})

describe('hydrateHistory', () => {
  it('round-trips: resolve restores the original data', async () => {
    const original = [msg([filePart('data:application/pdf;base64,AAAA', 'a1')])]
    const out = await hydrateHistory(dehydrateHistory(original), async () => 'data:application/pdf;base64,AAAA')
    expect((out[0].content as never as { data: string }[])[0].data).toBe('data:application/pdf;base64,AAAA')
  })
  it('replaces an unresolvable ref with an explanatory text part', async () => {
    const out = await hydrateHistory(dehydrateHistory([msg([filePart('data:application/pdf;base64,AAAA', 'gone')])]), async () => null)
    const part = (out[0].content as never as { type: string; text?: string }[])[0]
    expect(part.type).toBe('text')
    expect(part.text).toContain('no longer available')
  })
  it('parses page refs back out for the resolver', async () => {
    const seen: unknown[] = []
    await hydrateHistory(dehydrateHistory([msg([filePart('d', 'a2', 7)])]), async (ref) => { seen.push(ref); return 'd' })
    expect(seen).toEqual([{ id: 'a2', page: 7 }])
  })
})
```

- [ ] **Step 2: Run to verify failure** — `npm test -- attachmentRefs` → FAIL.

- [ ] **Step 3: Implement.** Walk each message; when `content` is an array, map parts. Dehydrate: a part with `providerOptions.lychee.attachmentId` gets `data` replaced (build new objects — never mutate input). Hydrate: a part whose `data` is a string starting with `lychee-attachment:` is parsed (`#page=<n>` suffix optional); `resolve` returning null converts the whole part to `{ type: 'text', text: '[an attachment in this message ("<id>") is no longer available — it was pruned from local storage]' }`. Everything else passes through by reference.

- [ ] **Step 4: Run to verify pass** — `npm test -- attachmentRefs` → PASS; `npm run typecheck`.

- [ ] **Step 5: Commit** — `feat(attachments): dehydrate/hydrate attachment refs in persisted history`.

---

### Task 4: pdf.ts — byte-source loading and page rendering

**Files:**
- Modify: `src/platform/pdf.ts` (refactor `doLoad` ~188-239, `getEntry` ~241-263; add two exports)

**Interfaces:**
- Consumes: existing internals (`getPdfjs`, `renderPageToCanvas`, cache).
- Produces (used by Tasks 5/6/7):

```ts
export function loadPdfFromBytes(bytes: Uint8Array, key: string, titleFallback?: string): Promise<LoadedPdf>
export function renderPdfPageFromBytes(bytes: Uint8Array, key: string, pageNumber: number): Promise<{ dataUrl: string; width: number; height: number; pageCount: number; title: string }>
```

`key` is the attachment id; cache key is `bytes:<key>` so 20 sequential page renders parse the document once (same LRU, same `CACHE_MAX`).

- [ ] **Step 1: Refactor without behavior change.** Extract the parse-and-extract body of `doLoad` (everything after `fetchPdfBytes`, i.e. from `const pdfjs = await getPdfjs()` through the `return { task, doc, loaded }`) into:

```ts
async function parsePdfBytes(bytes: Uint8Array, sourceUrl: string, titleFallback: string): Promise<CacheEntry>
```

`doLoad` becomes: `const { bytes, finalUrl } = await fetchPdfBytes(url, credentials, signal); return parsePdfBytes(bytes, finalUrl, filenameOf(finalUrl))`. Inside `parsePdfBytes`, the `info.url` is `sourceUrl` and the title fallback is `titleFallback` instead of `filenameOf(finalUrl)`.

- [ ] **Step 2: Run the suite** — `npm test` → all green (pdfText tests unaffected); `npm run typecheck` → clean.

- [ ] **Step 3: Add the byte entry points.**

```ts
/** Byte-source variant of getEntry: sniffs, parses, and caches under `bytes:<key>`. */
async function getBytesEntry(bytes: Uint8Array, key: string, titleFallback?: string): Promise<CacheEntry> {
  const cacheKey = `bytes:${key}`
  const hit = cache.get(cacheKey)
  if (hit) {
    cache.delete(cacheKey)
    cache.set(cacheKey, hit)
    return hit
  }
  if (bytes.byteLength > MAX_PDF_BYTES) throw new PdfError('This PDF is larger than the 50 MB limit.')
  if (!sniffPdf(bytes)) throw new PdfError('This file is not a PDF (no %PDF header found).')
  const pending = parsePdfBytes(bytes, `attachment:${key}`, titleFallback ?? key)
  cache.set(cacheKey, pending)
  pending.catch(() => cache.delete(cacheKey))
  for (const [k, v] of cache) {
    if (cache.size <= CACHE_MAX) break
    cache.delete(k)
    v.then((e) => e.task.destroy().catch(() => {})).catch(() => {})
  }
  return pending
}
```

`loadPdfFromBytes` returns `(await getBytesEntry(...)).loaded`; `renderPdfPageFromBytes` mirrors `renderPdfPage` (page-bounds check, `renderPageToCanvas`, PNG data URL) but calls `getBytesEntry`.

- [ ] **Step 4: Verify** — `npm run typecheck` and `npm test` → green (no unit test exercises pdf.js here — the module is DOM/worker-bound like the rest of pdf.ts; end-to-end coverage lands in Task 10).

- [ ] **Step 5: Commit** — `feat(attachments): pdf.ts accepts raw bytes (dropped files have no URL)`.

---

### Task 5: Capped attachments store

**Files:**
- Create: `src/data/attachments.ts`
- Modify: `src/data/storage.ts` (usage list ~line 23, the two clear paths ~60/65, erase-all ~95)
- Modify: `src/ui/library/ConversationsList.tsx` (delete path, ~line 65)

**Interfaces:**
- Consumes: `AttachmentKind` (Task 2), `estimateBytes`/`StoreUsage` from `./usage`, `makeThumb` from `./screenshots` (exported).
- Produces (used by Tasks 6/7):

```ts
export interface AttachmentMeta {
  id: string
  kind: AttachmentKind
  name: string
  byteSize: number
  pageCount?: number
  /** 240px JPEG preview for image attachments; absent for docs. */
  thumbDataUrl?: string
}
export interface StoredAttachment { id: string; conversationId: string; meta: AttachmentMeta; dataUrl: string; createdAt: number; bytes: number }
export function saveAttachment(a: { id: string; conversationId: string; meta: AttachmentMeta; dataUrl: string }): Promise<void>
export function getAttachment(id: string): Promise<StoredAttachment | null>
export function deleteAttachmentsForConversation(conversationId: string): Promise<void>
export function pruneAttachments(): Promise<{ deleted: number }>
export function clearAttachments(): Promise<void>
export function attachmentsUsage(): Promise<StoreUsage>
```

- [ ] **Step 1: Implement the store** as a structural copy of `screenshots.ts` (its header comment explains the separate-DB rationale — echo it): DB `lychee-attachments`, version 1, single store `attachments` keyed by `id` with a `createdAt` index. Constants `MAX_TOTAL_BYTES = 100 * 1024 * 1024`, `MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000`. `dataUrl` holds the original file (`data:application/pdf;base64,...`, `data:image/png;...`, or `data:text/plain;...`); `bytes` via the same `approxBytes` base64 math. `saveAttachment` fires `void pruneAttachments().catch(() => {})` best-effort, exactly like `saveShot`. No unit tests (IndexedDB modules in this codebase are covered end-to-end, like `screenshots.ts`).

- [ ] **Step 2: Wire the Data tab and lifecycle** — in `storage.ts`, mirror every `clearShots`/`shotsUsage` call site with `clearAttachments`/`attachmentsUsage` (import both; check all five lines: 12, 23, 60, 65, 95). In `ConversationsList.tsx`, alongside `deleteShotsForConversation(id)` add `deleteAttachmentsForConversation(id).catch(() => {})`. Give the usage row a distinct `detail` (`'N files'`).

- [ ] **Step 3: Verify** — `npm run typecheck`, `npm test` → green; `npm run build` → clean.

- [ ] **Step 4: Commit** — `feat(attachments): capped lychee-attachments store wired into Data tab and deletes`.

---

### Task 6: Composer attachment model — ingestion and assembly glue

**Files:**
- Create: `src/ui/attachments.ts`

**Interfaces:**
- Consumes: Task 2 planner + constants, Task 4 `loadPdfFromBytes`/`renderPdfPageFromBytes`, Task 5 store + `AttachmentMeta`, `makeThumb` (screenshots.ts), `profileFor` (providerProfiles), `ensureVisionCapability` (agent/vision), `assemblePagesText` (platform/pdfText), `CapturedImage` (platform/capture), `providerKind`/`ProviderConfig` (data/settings), `lycheeProviderOptions` (Task 3).
- Produces (used by Task 7):

```ts
export type ComposerAttachment =
  | { kind: 'image'; id: string; name: string; dataUrl: string; width: number; height: number; thumbDataUrl: string }
  | { kind: 'pdf'; id: string; name: string; bytes: Uint8Array; byteSize: number; pageCount: number }
  | { kind: 'text'; id: string; name: string; text: string; byteSize: number }
export interface IngestResult { attachments: ComposerAttachment[]; errors: string[] }
export function ingestFiles(files: File[], existingCount: number): Promise<IngestResult>
export function fromCapturedImage(img: CapturedImage, name?: string): Promise<ComposerAttachment>
export function attachmentUiMetas(atts: ComposerAttachment[]): AttachmentMeta[]
export interface OutgoingFilePart { type: 'file'; mediaType: string; filename?: string; data: string; providerOptions?: ReturnType<typeof lycheeProviderOptions> }
export interface AssembledAttachments { parts: OutgoingFilePart[]; appendText: string; notes: string[]; errors: string[] }
export function assembleAttachments(atts: ComposerAttachment[], o: { provider: ProviderConfig; modelId: string; conversationId: string }): Promise<AssembledAttachments>
export function dataUrlToBytes(dataUrl: string): Uint8Array
```

- [ ] **Step 1: Implement ingestion.** `ingestFiles`: enforce `MAX_ATTACHMENTS` against `existingCount` (overflow files → one error line); per file `classifyIncomingFile(file.name, file.type, file.size)`; then per kind:
  - image → read as data URL (FileReader), decode via `Image`, downscale on a canvas when the long edge exceeds 1400 (same math as `cropShot`, PNG stays PNG, JPEG re-encodes as JPEG 0.9), `thumbDataUrl` via `makeThumb`
  - pdf → `new Uint8Array(await file.arrayBuffer())`, then `loadPdfFromBytes(bytes, id, file.name)` for `pageCount` (this doubles as early validation: password/corrupt PDFs error here at attach time, not at send; catch `PdfError` into `errors`)
  - text → `await file.text()`, reject when `looksBinary(text.slice(0, 512))` or empty
  Each success gets `id: crypto.randomUUID()`. Errors never abort the batch — the rest of the files still attach.
- [ ] **Step 2: Implement `fromCapturedImage`** (wraps a camera/right-click `CapturedImage` with `kind`, `name` default `'Screenshot'`, and an awaited `makeThumb`) and `attachmentUiMetas` (straight mapping; image thumb = `thumbDataUrl`, doc metas carry `pageCount`/`byteSize`).
- [ ] **Step 3: Implement assembly.** `assembleAttachments`:
  1. `const profile = profileFor(providerKind(o.provider))`; `const visionCapable = await ensureVisionCapability(o.provider, o.modelId).catch(() => false)`
  2. Per attachment, build the descriptor, call `planAttachmentDelivery`, then execute the route:
     - `image-part` → part `{ type: 'file', mediaType: 'image', data: att.dataUrl, providerOptions: lycheeProviderOptions({ id: att.id }) }`
     - `image-note` → note into `appendText`
     - `native-pdf` → bytes→data URL (`data:application/pdf;base64,` + chunked btoa), part with `mediaType: 'application/pdf'`, `filename: att.name`, tagged providerOptions
     - `pdf-pages` → for each planned page `renderPdfPageFromBytes(att.bytes, att.id, p)` → image part tagged `{ id: att.id, page: p }`; append `pageCaption(...)` lines and the `truncationNote` to `appendText` so the model can name what it is looking at
     - `pdf-text` → `loadPdfFromBytes` then `assemblePagesText(loaded.pages, loaded.pages.map((x) => x.page), budget)`; join blocks as `[page N]\n<text>`, note omitted/truncated pages explicitly
     - `inline-text` → `formatInlineTextBlock(att.name, att.text, budget)` into `appendText`
  3. `saveAttachment` for every attachment (original bytes/dataUrl + meta) — write failures degrade to a console.warn and an unpersisted send, never a failed send
  4. A per-attachment runtime failure (render/extract threw) appends `[attachment "<name>" could not be processed: <message>]` to `errors` and `appendText`, and processing continues
  5. `notes` gets one journal line, e.g. `[attached: report.pdf (12 pages), notes.md]`
- [ ] **Step 4: Verify** — `npm run typecheck`, `npm test` → green (glue module; its pure inputs are already covered by Tasks 2/3 tests).
- [ ] **Step 5: Commit** — `feat(attachments): composer ingestion + provider-aware assembly glue`.

---

### Task 7: Chat.tsx + agent.ts wiring — state, send path, persistence boundary

**Files:**
- Modify: `src/agent/agent.ts` (UIMessage, ~line 46-80)
- Modify: `src/ui/Chat.tsx` (all touchpoints below)

**Interfaces:**
- Consumes: everything from Tasks 3/5/6.
- Produces: `MessageSpec.attachments: ComposerAttachment[]` (replaces `images`); `UIMessage.attachments?: AttachmentMeta[]`.

- [ ] **Step 1: agent.ts** — add to `UIMessage` (keep `images?: string[]` with a comment marking it legacy-render-only for conversations saved before attachments):

```ts
  /** Attachment chips on a user message: thumbnail metas for images, icon+name for files. */
  attachments?: AttachmentMeta[]
```

(`import type { AttachmentMeta } from '../data/attachments'`.)

- [ ] **Step 2: MessageSpec and composer state.** In `Chat.tsx`: `MessageSpec.images: CapturedImage[]` → `attachments: ComposerAttachment[]` (line ~146); state `const [attachments, setAttachments] = useState<ComposerAttachment[]>([])` (line ~535). Then chase every compile error — the full touchpoint list, verified against current line numbers:
  - `capture()` ~1246 → `const img = await captureRegion(); if (img) setAttachments((a) => [...a, att])` with `const att = await fromCapturedImage(img)`
  - `handleComposerAction` ~1763-1796: `images: CapturedImage[]` → `attachments: ComposerAttachment[]`; the image branch wraps with `fromCapturedImage(await fetchImageAsCapturedImage(action.srcUrl), 'Image from page')`
  - `composeSpec` ~1600: `images: attachments` → `attachments`
  - `mergeQueuedSpec` ~1726: concat `attachments`
  - `retractQueued` ~1819: `setAttachments(queued.attachments)`
  - steer-strip preview ~2678: `queued.attachments.length` with copy `file${...s}` instead of `screenshot`
  - send-button disabled ~2928 already reads `attachments.length` — unchanged
- [ ] **Step 3: Bubbles.** `startFreshTurn` ~1655 and `injectSteer` ~1700: replace `images: images.map((i) => i.dataUrl)` with `attachments: attachmentUiMetas(spec.attachments)` on the pushed `UIMessage`.
- [ ] **Step 4: buildUserTurn** (~1499-1591). Signature: `images: CapturedImage[]` → `attachments: ComposerAttachment[]`. Where the message is assembled (~1562):

```ts
const assembled = await assembleAttachments(attachments, {
  provider: selected.provider, modelId: selected.modelId, conversationId,
})
if (assembled.appendText) modelText = `${modelText}\n\n${assembled.appendText}`
const message: ModelMessage = assembled.parts.length > 0
  ? { role: 'user', content: [...assembled.parts, ...(modelText ? [{ type: 'text' as const, text: modelText }] : [])] }
  : { role: 'user', content: modelText }
```

(`selected` is the same resolved provider/model object `composeSpec` guards on and `runTurnChain` reads at ~1913 — confirm its exact shape at the call site and destructure accordingly.) Journal note ~1583 becomes `notes.push(...assembled.notes)`; surface `assembled.errors` through the existing `setCaptureError` line if non-empty.

- [ ] **Step 5: Persistence boundary.** Save effect ~845: `history: dehydrateHistory(historyRef.current)` and `regen` wrapped so `regen.opener` (a ModelMessage) rides through `dehydrateHistory([opener])[0]` when present. Restore effect ~717-726: hydrate before installing —

```ts
const resolveRef = async (ref: AttachmentRef): Promise<string | null> => {
  const rec = await getAttachment(ref.id)
  if (!rec) return null
  if (ref.page === undefined) return rec.dataUrl
  // Rendered PDF pages are derived, not stored — re-render from the original
  // bytes (the parse is cached across the 20 pages of one document).
  try {
    return (await renderPdfPageFromBytes(dataUrlToBytes(rec.dataUrl), ref.id, ref.page)).dataUrl
  } catch { return null }
}
historyRef.current = await hydrateHistory(c.history, resolveRef)
```

and hydrate `c.regen?.opener` the same way before `setRegenTarget`.

- [ ] **Step 6: Verify** — `npm run typecheck` → clean (this task is done only when every `spec.images` reference is gone: `grep -n 'spec\.images\|\.images\b' src/ui/Chat.tsx` shows only the legacy `UIMessage.images` render path); `npm test` → green; `npm run build` → clean.
- [ ] **Step 7: Commit** — `feat(attachments): route composer attachments through planner, store, and history boundary`.

---

### Task 8: Ingestion surfaces — paperclip, drag-and-drop overlay, paste

**Files:**
- Modify: `src/ui/Chat.tsx` (composer JSX ~2841-2941, textarea ~2718, new effect near the other mount effects)
- Modify: `src/ui/styles.css` (new `.drop-overlay`, `.attach-btn` beside `.cam-btn` rules ~2900s)

**Interfaces:**
- Consumes: `ingestFiles` (Task 6).
- Produces: a single `addFiles(files: File[])` helper all three surfaces call.

- [ ] **Step 1: `addFiles`** in Chat:

```ts
async function addFiles(files: File[]) {
  if (files.length === 0) return
  setCaptureError(null)
  const { attachments: added, errors } = await ingestFiles(files, attachments.length)
  if (added.length > 0) setAttachments((a) => [...a, ...added])
  if (errors.length > 0) setCaptureError(errors.join(' '))
}
```

- [ ] **Step 2: Paperclip picker.** Beside the `cam-btn` (~2875): a `.attach-btn` button with a paperclip SVG that clicks a hidden `<input type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/*,.md,.csv,.json,.ts,.tsx,.js,.py,.log,.yaml,.yml,.toml,.xml,.html">` (ref-triggered, `e.target.value = ''` reset after read — the SkillEditor.tsx:205 pattern). Disabled when `!selected`.
- [ ] **Step 3: Drag-and-drop.** One mount effect with window-level listeners. Depth-counter pattern; **`preventDefault` on both `dragover` and `drop` whenever the drag carries files, page-wide** — without it a missed drop navigates the side panel to the file, which has no recovery UX:

```ts
useEffect(() => {
  let depth = 0
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')
  const enter = (e: DragEvent) => { if (hasFiles(e)) { depth++; setDropTarget(true) } }
  const leave = (e: DragEvent) => { if (hasFiles(e) && --depth <= 0) { depth = 0; setDropTarget(false) } }
  const over = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault() }
  const drop = (e: DragEvent) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    depth = 0
    setDropTarget(false)
    void addFilesRef.current(Array.from(e.dataTransfer?.files ?? []))
  }
  window.addEventListener('dragenter', enter)
  window.addEventListener('dragleave', leave)
  window.addEventListener('dragover', over)
  window.addEventListener('drop', drop)
  return () => { /* remove all four */ }
}, [])
```

(`addFilesRef` is a ref updated each render, the same stale-closure pattern as `composerActionRef` ~1804.) `dropTarget` renders a full-panel `.drop-overlay` ("Drop files to attach") with `pointer-events: none`.
- [ ] **Step 4: Paste.** On the textarea: `onPaste={(e) => { const files = Array.from(e.clipboardData?.files ?? []); if (files.length > 0) { e.preventDefault(); void addFiles(files) } }}` — text pastes are untouched.
- [ ] **Step 5: Styles.** `.attach-btn` mirrors `.cam-btn`; `.drop-overlay` is `position: absolute; inset: 0` over the panel with a dashed `--accent` border, `--pill-bg`-tinted backdrop, centered label; both themed via existing tokens only.
- [ ] **Step 6: Verify** — `npm run typecheck`, `npm test`, `npm run build` → green. Manual smoke deferred to Task 10.
- [ ] **Step 7: Commit** — `feat(attachments): drag-drop overlay, paste-to-attach, paperclip picker`.

---

### Task 9: Chips and bubble rendering

**Files:**
- Modify: `src/ui/Chat.tsx` (composer attachment row ~2700-2717; user-bubble render ~3180-3190)
- Modify: `src/ui/styles.css` (extend `.attachment-row` family ~2930-2977; new `.attachment-file`, `.msg-attachments`)

**Interfaces:**
- Consumes: `ComposerAttachment`, `AttachmentMeta`.
- Produces: UI only.

- [ ] **Step 1: Composer chips.** The attachment row maps over the union: `kind === 'image'` keeps the current `<img>` thumb (`att.thumbDataUrl`); docs render `.attachment-file` — a pill with a kind glyph (📄-style inline SVG for pdf, a code/file SVG for text), the filename (ellipsized, `title` attr for full name), and `12 pages` / `48 KB` as the sub-label. Both keep the existing hover `× .attachment-remove`. A PDF still parsing shows the chip with a "reading…" sub-label (ingestion is async; append attachments only when ready — the simple path — so this state only needs a `capturing`-style boolean on the paperclip/drop flow: reuse `capturing` → rename-free, set it around `addFiles`).
- [ ] **Step 2: Bubble chips.** Where user bubbles render `msg-images` (~3183), also render `msg.attachments`: image metas as thumbnails (from `thumbDataUrl`), doc metas as compact `.attachment-file` chips (name + pages/size, non-interactive). Keep the legacy `msg.images` branch for old conversations.
- [ ] **Step 3: Styles** — `.attachment-file` uses the `.context-pill` recipe (rounded-full, `--pill-bg`, `--border`, hover-reveal remove) at `.attachment-thumb` height so the row lines up; `.msg-attachments` mirrors `.msg-images` spacing.
- [ ] **Step 4: Verify** — `npm run typecheck`, `npm run build` → green.
- [ ] **Step 5: Commit** — `feat(attachments): file chips in composer and message bubbles`.

---

### Task 10: Docs, end-to-end verification, merge

**Files:**
- Modify: `CLAUDE.md` (Architecture invariants)
- Modify: `docs/superpowers/specs/2026-08-02-prompt-attachments-design.md` (one number)
- Modify: `README.md` (feature tour — one bullet)

- [ ] **Step 1: CLAUDE.md invariant** — add one bullet under Architecture invariants:

> **User attachments route through the delivery planner.** `planAttachmentDelivery` (`src/agent/attachmentPlan.ts`, pure/tested) is the only place allowed to decide an attachment's wire form: native PDF parts exist only for the two native adapters (`supportsNativeDocuments` in `providerProfiles.ts`) — the OpenAI-compatible adapter throws on any non-image file part, 400ing the whole request — and everything else degrades to rendered pages (vision) or extracted text (blind, via the vision probe). Attachment bytes live once in the capped `lychee-attachments` DB (`src/data/attachments.ts`); persisted history holds `lychee-attachment:<id>` sentinels swapped at the `dehydrateHistory`/`hydrateHistory` boundary (`src/data/attachmentRefs.ts`) — never inline file data in a stored conversation.

- [ ] **Step 2: Spec correction** — in the spec's Supporting changes, OpenAI `nativeDocMaxBytes` 45MB → **35MB** (45MB raw exceeds the 50MB request cap after base64 inflation; caught during implementation planning).
- [ ] **Step 3: README** — one line in the feature tour: attach images/PDFs/text files by drag-drop, paste, or the paperclip; delivery adapts to the provider.
- [ ] **Step 4: Full verification** — `npm run typecheck` && `npm test` && `npm run build`, then run the `/verify-extension` flow end to end: load `dist/`, then (a) drop a PNG + send on any provider — image part arrives, chip renders in bubble; (b) drop a small PDF on an Anthropic or OpenAI provider — model answers from the document; (c) same PDF on a compat provider (Ollama/Groq) with a vision model — page screenshots arrive (network tab shows `image_url` parts, no `file` part); (d) same with a text-only model — extracted text in the prompt, no image parts; (e) paste a screenshot from the clipboard; (f) attach a `.md` file — fenced block visible in the request; (g) reload the panel, reopen the conversation — chips render, then send a follow-up (history rehydrated, request succeeds); (h) drop a `.pptx` → error line, nothing attached; (i) Data tab shows the Attachments row; deleting the conversation removes its rows.
- [ ] **Step 5: Commit + merge** — commit docs (`docs(attachments): invariants, README, spec byte-cap correction`), then follow superpowers:finishing-a-development-branch to merge the worktree branch into main (pathspec-scoped commits already; verify `git log main..HEAD` is clean after merge before ExitWorktree with discard).

---

## Self-review notes

- **Spec coverage:** UX surfaces (Task 8), chips/bubbles (Task 9), store + Data tab + deletes (Task 5), planner matrix incl. blind-image note (Task 2), native caps via profiles (Task 1), pdf bytes (Task 4), dehydrate/hydrate incl. pruned→note and regen.opener (Tasks 3/7), buildUserTurn/steer inheritance (Task 7 — injectSteer shares buildUserTurn so steers need no extra work), errors-per-file-never-batch-abort (Tasks 2/6/8), out-of-scope items untouched.
- **Deliberate deviations from spec, both narrowing:** OpenAI cap 35MB not 45MB (Task 10 amends the spec); "attachments written at send time" is honored — ingestion holds bytes in memory only, the store write happens in `assembleAttachments`.
- **Type consistency:** `ComposerAttachment`/`AttachmentMeta`/`DeliveryRoute`/`AttachmentRef` names and fields match across Tasks 2/3/5/6/7 (checked by grep while drafting).
