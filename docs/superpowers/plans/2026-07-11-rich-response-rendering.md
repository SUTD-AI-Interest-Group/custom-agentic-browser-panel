# Rich Response Rendering — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Richer rendering of assistant response objects — link preview cards, code-block polish (label/copy/lazy highlight/collapse), and structured data (JSON tree, table polish) — plus a small KaTeX display robustness win.

**Architecture:** Generalize the block segmenter (`splitImageBlocks` → `splitBlocks`) so `AssistantText` renders each block with a dedicated React component (images/links/json) while prose stays in `marked`. Code-block enhancements run in a post-render `useEffect`; the highlighter is dynamically imported into its own chunk; table polish is CSS.

**Tech Stack:** React 18, Vite 6, TS (strict), `marked ^15`, `marked-katex-extension`, `katex`, `dompurify`, `highlight.js` (new, lazy).

## Global Constraints

- **No test suite** (per CLAUDE.md). Each task verifies via `npm run build` (`tsc --noEmit && vite build`) + manual `/verify-extension`. Pure units get a throwaway `npx tsx` check (created, run, deleted — not committed).
- **Browser verification is out of scope for subagents** (can't load the extension). Implementers stop at `npm run build` + `npx tsx` checks + commit. Do NOT attempt to reload Chrome or observe rendering.
- **Code style:** no semicolons (ASI), single quotes, 2-space indent, `interface` for object shapes / `type` for unions, `/** … */` on exported symbols.
- **Bundle:** `highlight.js` MUST be dynamically `import()`ed (its own lazy chunk), never statically imported into `Markdown`/`Chat`.
- **Security:** fetched OG HTML is parsed with `DOMParser` and only `meta`/`title` **text** is read — never injected as HTML. OG/link text renders as React children (auto-escaped), never `dangerouslySetInnerHTML`.
- **Commits:** pathspec-scope every commit. **No Claude attribution / Co-Authored-By / "Generated with" trailers.**
- **Isolation:** implemented in a git worktree (this plan is authored there).

## Shared Types (defined in Task 2, referenced later)

```ts
// src/ui/blocks.ts
export interface LinkRef { url: string; text: string }
export type Block =
  | { type: 'markdown'; text: string }
  | { type: 'images'; urls: string[] }
  | { type: 'links'; links: LinkRef[]; raw: string }
  | { type: 'json'; value: unknown; raw: string }
export function splitBlocks(text: string): Block[]
```

## File Structure

- **Modify** `src/ui/mathDelimiters.ts` — block-isolate `\[…\]` display math (Task 1).
- **Create** `src/ui/blocks.ts`; **delete** `src/ui/imageBlocks.ts` (Task 2).
- **Create** `src/platform/linkPreview.ts` (Task 3); **modify** `src/data/settings.ts` (flag).
- **Create** `src/ui/LinkCard.tsx` (Task 4); **modify** `src/ui/settings/GeneralTab.tsx` (toggle).
- **Create** `src/ui/codeEnhance.ts` (Tasks 5–6); **modify** `src/ui/Markdown.tsx`.
- **Create** `src/ui/JsonTree.tsx` (Task 7).
- **Modify** `src/ui/Chat.tsx` (`AssistantText`) across Tasks 2/4/7; `src/ui/styles.css` across Tasks 4–8.

Task order: 1 (KaTeX) → 2 (segmenter) → 3 (link data) → 4 (link cards) → 5 (code header/copy/collapse) → 6 (lazy highlight) → 7 (JSON tree) → 8 (table polish). Tasks 4/7 flip `AssistantText` branches that Task 2 leaves as markdown fallbacks, so every task is independently shippable.

---

### Task 1: KaTeX — block-isolate `\[…\]` display math

**Context:** The reported raw-`$$` symptom could not be reproduced against current code (full-message pipeline renders 31/31 equations) — it is a **stale build**, resolved by rebuild + reload (a human step, not part of this task). We do the one safe robustness win here: make the unambiguous `\[…\]` display form render as a clean, reliably-tokenized centered block. We deliberately do NOT match literal `$$…$$` in the normalizer — that would reintroduce `$5 … $10` currency false-positives that `marked-katex-extension`'s `nonStandard:false` rule avoids.

**Files:**
- Modify: `src/ui/mathDelimiters.ts`
- Temp (not committed): `md.check.ts` at repo root

**Interfaces:**
- Produces: `normalizeMathDelimiters` unchanged signature; `\[X\]` now yields a blank-line-isolated `$$` block; `\(X\)` still yields inline `$X$`; literal `$$` and `$` untouched.

- [ ] **Step 1: Write the regression check (repo root `md.check.ts`)**

```ts
import { normalizeMathDelimiters as n } from './src/ui/mathDelimiters'

const cases: [string, string][] = [
  // \[...\] display → blank-line-isolated $$ block
  ['before \\[a^2+b^2=c^2\\] after', 'before \n\n$$\na^2+b^2=c^2\n$$\n\n after'],
  // \(...\) inline unchanged
  ['area \\(\\pi r^2\\).', 'area $\\pi r^2$.'],
  // literal $$ NOT touched (no currency/false-positive risk)
  ['it costs $$5 and $$10', 'it costs $$5 and $$10'],
  // inline $...$ untouched
  ['inline $a^2$ ok', 'inline $a^2$ ok'],
  // code-guarded: \[ inside a fence is left alone
  ['```\n\\[x\\]\n```', '```\n\\[x\\]\n```'],
]
let ok = true
for (const [input, expected] of cases) {
  const got = n(input)
  if (got !== expected) { ok = false; console.log(`FAIL\n in:  ${JSON.stringify(input)}\n exp: ${JSON.stringify(expected)}\n got: ${JSON.stringify(got)}`) }
}
console.log(ok ? 'ALL PASS' : 'FAILURES ABOVE')
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx tsx md.check.ts`
Expected: FAIL — case 1 currently yields `before $$a^2+b^2=c^2$$ after` (inline `$$`), not the block form.

- [ ] **Step 3: Edit `src/ui/mathDelimiters.ts`** — change only the display branch to emit block-isolated form:

```ts
/** Convert `\(…\)` → `$…$` and `\[…\]` → a blank-line-isolated `$$` block
 *  (so marked-katex-extension's block rule always tokenizes display math),
 *  but never inside code. Literal `$$…$$` is intentionally left untouched to
 *  avoid currency false-positives. */
export function normalizeMathDelimiters(text: string): string {
  return text.replace(CODE_OR_MATH, (match, _backticks, display, inline) => {
    if (display !== undefined) return `\n\n$$\n${display.trim()}\n$$\n\n`
    if (inline !== undefined) return `$${inline}$`
    return match
  })
}
```

(The `CODE_OR_MATH` regex and the comment block above it are unchanged from current.)

- [ ] **Step 4: Run the check → PASS**

Run: `npx tsx md.check.ts`
Expected: `ALL PASS`.

- [ ] **Step 5: Clean up + build + commit**

```bash
rm md.check.ts
npm run build   # must PASS
git commit -m "feat: render \\[…\\] display math as an isolated block" -- src/ui/mathDelimiters.ts
```

---

### Task 2: Block segmenter `splitBlocks`

**Files:**
- Create: `src/ui/blocks.ts`
- Delete: `src/ui/imageBlocks.ts`
- Modify: `src/ui/Chat.tsx` (imports + `AssistantText`)
- Temp (not committed): `blocks.check.ts` at repo root

**Interfaces:**
- Produces: `splitBlocks(text): Block[]` and `Block`/`LinkRef` types (see Shared Types).
- Consumes: nothing new.

- [ ] **Step 1: Write `blocks.check.ts` (repo root)**

```ts
import { splitBlocks } from './src/ui/blocks'

function shape(text: string) { return splitBlocks(text).map((b) => b.type).join(',') }
let ok = true
const expect = (label: string, got: string, exp: string) => {
  if (got !== exp) { ok = false; console.log(`FAIL ${label}\n exp: ${exp}\n got: ${got}`) }
}
// two image lines → images
expect('img-run', shape('![a](https://x.com/a.png)\n![b](https://x.com/b.png)'), 'images')
// one image line → markdown (fallback, like today)
expect('img-single', shape('![a](https://x.com/a.png)'), 'markdown')
// one standalone link → links (single card is allowed)
expect('link-single', shape('https://example.com/article'), 'links')
// two standalone links → one links block
expect('link-run', shape('https://a.com\nhttps://b.com'), 'links')
// markdown link alone → links
expect('md-link', shape('[Read more](https://example.com/x)'), 'links')
// inline link inside prose → markdown (not a card)
expect('inline-link', shape('see https://example.com here'), 'markdown')
// ```json block → json
expect('json', shape('```json\n{"a":1}\n```'), 'json')
// plain fenced code → markdown
expect('code', shape('```\nconsole.log(1)\n```'), 'markdown')
// non-object json (number) → markdown code
expect('json-scalar', shape('```json\n42\n```'), 'markdown')
// ordering preserved: prose, link, prose
expect('order', shape('hello\n\nhttps://a.com\n\nbye'), 'markdown,links,markdown')
console.log(ok ? 'ALL PASS' : 'FAILURES ABOVE')
```

- [ ] **Step 2: Run → fail (module missing)**

Run: `npx tsx blocks.check.ts` → FAIL (cannot find `./src/ui/blocks`).

- [ ] **Step 3: Create `src/ui/blocks.ts`**

```ts
// Splits an assistant text part into ordered typed blocks so each renders with
// a dedicated component: runs of image URLs → a carousel, standalone links → link
// cards, standalone JSON → a tree, everything else → markdown. Generalizes the
// former splitImageBlocks. Detection is line-based (with fenced-code awareness)
// and conservative: only whole-line links/images and whole fenced blocks are
// pulled out, so anything inline in prose stays in the markdown block.

/** A link/image reference on its own line. */
export interface LinkRef {
  url: string
  text: string
}

/** An ordered piece of a rendered assistant text part. */
export type Block =
  | { type: 'markdown'; text: string }
  | { type: 'images'; urls: string[] }
  | { type: 'links'; links: LinkRef[]; raw: string }
  | { type: 'json'; value: unknown; raw: string }

const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|avif|bmp|svg|ico)$/i
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+/
const MD_LINK = /^!?\[([^\]]*)\]\(\s*(\S+?)\s*(?:"[^"]*")?\)$/
const ANGLE = /^<(\S+)>$/
const FENCE = /^\s{0,3}(```|~~~)(.*)$/
/** Cap on JSON body size rendered as a tree; larger falls back to a code block. */
const JSON_MAX = 20000

function asUrl(token: string): URL | null {
  try {
    const u = new URL(token)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null
  } catch {
    return null
  }
}

function isImageUrl(u: URL): boolean {
  return IMAGE_EXT.test(u.pathname)
}

interface LineLink {
  url: string
  text: string
  isImage: boolean
}

/** If `line` is *only* a link/image (bare, autolinked, or markdown link),
 *  optionally led by a bullet, return it; else null. */
function extractLineLink(line: string): LineLink | null {
  let rest = line.trim()
  if (!rest) return null
  rest = rest.replace(BULLET, '').trim()
  if (!rest) return null

  const md = rest.match(MD_LINK)
  if (md) {
    const u = asUrl(md[2])
    if (!u) return null
    return { url: md[2], text: md[1] || md[2], isImage: rest.startsWith('!') || isImageUrl(u) }
  }
  const angle = rest.match(ANGLE)
  if (angle) {
    const u = asUrl(angle[1])
    return u ? { url: angle[1], text: angle[1], isImage: isImageUrl(u) } : null
  }
  if (/^\S+$/.test(rest)) {
    // Bare URL — trim trailing sentence punctuation from the href/text.
    const token = rest.replace(/[.,;:!?)]+$/, '')
    const u = asUrl(token)
    return u ? { url: token, text: token, isImage: isImageUrl(u) } : null
  }
  return null
}

/** Parse a fenced block body as JSON only when it is an object/array (and the
 *  info string is `json` or the body clearly looks like JSON). */
function tryJson(lang: string, body: string): unknown {
  const trimmed = body.trim()
  if (!trimmed || trimmed.length > JSON_MAX) return undefined
  if (lang !== 'json' && !/^[[{]/.test(trimmed)) return undefined
  try {
    const v = JSON.parse(trimmed)
    return typeof v === 'object' && v !== null ? v : undefined
  } catch {
    return undefined
  }
}

export function splitBlocks(text: string): Block[] {
  const out: Block[] = []
  let md: string[] = []
  let imgRun: { url: string; line: string }[] = []
  let linkRun: { ref: LinkRef; line: string }[] = []

  const flushMd = () => {
    if (md.length) {
      out.push({ type: 'markdown', text: md.join('\n') })
      md = []
    }
  }
  const flushImg = () => {
    if (imgRun.length >= 2) {
      flushMd()
      out.push({ type: 'images', urls: imgRun.map((r) => r.url) })
    } else {
      for (const r of imgRun) md.push(r.line)
    }
    imgRun = []
  }
  const flushLink = () => {
    if (linkRun.length >= 1) {
      flushMd()
      out.push({
        type: 'links',
        links: linkRun.map((r) => r.ref),
        raw: linkRun.map((r) => r.line).join('\n'),
      })
    }
    linkRun = []
  }
  const flushRuns = () => {
    flushImg()
    flushLink()
  }

  const lines = text.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const fence = line.match(FENCE)
    if (fence) {
      flushRuns()
      const marker = fence[1]
      const lang = fence[2].trim().toLowerCase()
      const body: string[] = []
      let j = i + 1
      let closed = false
      for (; j < lines.length; j++) {
        if (lines[j].trim().startsWith(marker)) {
          closed = true
          break
        }
        body.push(lines[j])
      }
      const end = closed ? j + 1 : j
      const raw = lines.slice(i, end).join('\n')
      const value = tryJson(lang, body.join('\n'))
      if (value !== undefined) {
        flushMd()
        out.push({ type: 'json', value, raw })
      } else {
        md.push(raw)
      }
      i = end
      continue
    }

    const link = extractLineLink(line)
    if (link && link.isImage) {
      flushLink()
      imgRun.push({ url: link.url, line })
      i++
      continue
    }
    if (link) {
      flushImg()
      linkRun.push({ ref: { url: link.url, text: link.text }, line })
      i++
      continue
    }

    flushRuns()
    md.push(line)
    i++
  }
  flushRuns()
  flushMd()
  return out
}
```

- [ ] **Step 4: Run the check → PASS**

Run: `npx tsx blocks.check.ts` → `ALL PASS`.

- [ ] **Step 5: Wire `AssistantText` (in `src/ui/Chat.tsx`)**

Replace the `splitImageBlocks` import (line ~5) with `splitBlocks`:

```tsx
import { splitBlocks } from './blocks'
```

Rewrite `AssistantText` (currently ~line 1310) — links/json fall back to markdown until Tasks 4/7 land, so this is a no-visible-change increment:

```tsx
// Renders one assistant text part as ordered blocks: image runs → carousel,
// standalone links → cards, standalone JSON → tree, else markdown. (Link/JSON
// components are wired in later tasks; until then they render as markdown.)
function AssistantText({ text }: { text: string }) {
  const blocks = useMemo(() => splitBlocks(text), [text])
  return (
    <>
      {blocks.map((b, i) => {
        if (b.type === 'images') return <ImageCarousel key={i} urls={b.urls} />
        if (b.type === 'markdown') return <Markdown key={i} text={b.text} />
        return <Markdown key={i} text={b.raw} />
      })}
    </>
  )
}
```

- [ ] **Step 6: Delete the old module, clean up, build, commit**

```bash
rm src/ui/imageBlocks.ts blocks.check.ts
npm run build   # must PASS (confirms nothing else imports imageBlocks)
git commit -m "refactor: generalize splitImageBlocks into typed splitBlocks" -- src/ui/blocks.ts src/ui/imageBlocks.ts src/ui/Chat.tsx
```

---

### Task 3: Link preview module + settings flag

**Files:**
- Create: `src/platform/linkPreview.ts`
- Modify: `src/data/settings.ts` (add `fetchLinkPreviews`)
- Temp (not committed): `og.check.ts` at repo root

**Interfaces:**
- Produces:
  - `parseOpenGraph(html: string, baseUrl: string): LinkPreview | null` — pure, testable.
  - `getLinkPreview(url: string): Promise<LinkPreview | null>` — cached fetch; returns null when disabled/failed.
  - `interface LinkPreview { title?: string; description?: string; image?: string; siteName?: string }`
  - `settings.fetchLinkPreviews: boolean` (default `true`).

- [ ] **Step 1: Add the settings flag** in `src/data/settings.ts`

In `interface Settings` (line ~94) add:

```ts
  /** Fetch OpenGraph previews for standalone links (privacy: contacts linked
   *  sites). When false, link cards show favicon + domain only. */
  fetchLinkPreviews?: boolean
```

In the `EMPTY` default (line ~144) add `fetchLinkPreviews: true,`.

- [ ] **Step 2: Write `og.check.ts` (repo root)** — tests the pure parser only (no network)

```ts
import { parseOpenGraph } from './src/platform/linkPreview'

const html = `<html><head>
  <title>Fallback Title</title>
  <meta property="og:title" content="OG Title">
  <meta property="og:description" content="A description">
  <meta property="og:image" content="/img/card.png">
  <meta property="og:site_name" content="Example">
</head></html>`
const p = parseOpenGraph(html, 'https://example.com/post')
let ok = true
const eq = (label: string, got: unknown, exp: unknown) => {
  if (got !== exp) { ok = false; console.log(`FAIL ${label}: got ${JSON.stringify(got)} exp ${JSON.stringify(exp)}`) }
}
eq('title', p?.title, 'OG Title')
eq('description', p?.description, 'A description')
eq('image-resolved', p?.image, 'https://example.com/img/card.png')
eq('siteName', p?.siteName, 'Example')
// fallback to <title> when no og:title
const p2 = parseOpenGraph('<title>Only Title</title>', 'https://x.com')
eq('title-fallback', p2?.title, 'Only Title')
// no metadata → null
eq('empty', parseOpenGraph('<html></html>', 'https://x.com'), null)
console.log(ok ? 'ALL PASS' : 'FAILURES ABOVE')
```

- [ ] **Step 3: Run → fail (module missing)**

Run: `npx tsx og.check.ts` → FAIL.

- [ ] **Step 4: Create `src/platform/linkPreview.ts`**

```ts
// Client-side link previews for standalone links. host_permissions:["<all_urls>"]
// exempts these cross-origin reads from CORS, so no backend/proxy is needed.
// The OG parser is pure (testable without network); getLinkPreview adds a memory
// + chrome.storage.local cache and a timeout, and is gated by a privacy setting.

import { getSettings } from '../data/settings'

/** OpenGraph-derived preview data; every field optional. */
export interface LinkPreview {
  title?: string
  description?: string
  image?: string
  siteName?: string
}

/** Extract OG/meta preview data from raw HTML. Returns null when nothing useful
 *  is present. `baseUrl` resolves a relative og:image. Pure — no network. */
export function parseOpenGraph(html: string, baseUrl: string): LinkPreview | null {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const meta = (sel: string): string | undefined => {
    const el = doc.querySelector(sel)
    const v = el?.getAttribute('content')?.trim()
    return v || undefined
  }
  const title = meta('meta[property="og:title"]') ?? doc.querySelector('title')?.textContent?.trim() || undefined
  const description =
    meta('meta[property="og:description"]') ?? meta('meta[name="description"]')
  const siteName = meta('meta[property="og:site_name"]')
  let image = meta('meta[property="og:image"]') ?? meta('meta[property="og:image:url"]')
  if (image) {
    try {
      image = new URL(image, baseUrl).href
    } catch {
      image = undefined
    }
  }
  if (!title && !description && !image && !siteName) return null
  return { title, description, image, siteName }
}

// ---------------------------------------------------------------------------
// Cache + fetch
// ---------------------------------------------------------------------------

const TTL_MS = 7 * 24 * 60 * 60 * 1000
const TIMEOUT_MS = 6000
const mem = new Map<string, LinkPreview | null>()

interface CacheEntry {
  data: LinkPreview | null
  ts: number
}

function cacheKey(url: string): string {
  return `linkPreview:${url}`
}

/** Cached OpenGraph preview for `url`. Returns null when disabled, cached-null,
 *  or on any fetch/parse failure (caller falls back to favicon + domain). */
export async function getLinkPreview(url: string): Promise<LinkPreview | null> {
  if (mem.has(url)) return mem.get(url)!
  const settings = await getSettings().catch(() => null)
  if (settings && settings.fetchLinkPreviews === false) return null

  const key = cacheKey(url)
  try {
    const stored = (await chrome.storage.local.get(key))[key] as CacheEntry | undefined
    if (stored && Date.now() - stored.ts < TTL_MS) {
      mem.set(url, stored.data)
      return stored.data
    }
  } catch {
    // storage unavailable — fall through to a live fetch
  }

  let data: LinkPreview | null = null
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow' })
    if (res.ok && (res.headers.get('content-type') ?? '').includes('text/html')) {
      data = parseOpenGraph(await res.text(), res.url || url)
    }
  } catch {
    data = null
  }

  mem.set(url, data)
  try {
    await chrome.storage.local.set({ [key]: { data, ts: Date.now() } satisfies CacheEntry })
  } catch {
    // ignore storage write failures
  }
  return data
}
```

*(Note: confirm `getSettings` is the exported accessor in `src/data/settings.ts`; if the export name differs, use the actual one — check with `grep -n "export .*function get" src/data/settings.ts`.)*

- [ ] **Step 5: Run the check → PASS**

Run: `npx tsx og.check.ts` → `ALL PASS`. (tsx provides a DOM? No — `DOMParser` is browser-only. See Step 6.)

- [ ] **Step 6: Make the parser check runnable, then clean up**

`DOMParser` is not available in Node/tsx. For the check only, run it with a tiny shim so the pure parser is still exercised:

```bash
npx tsx --import ./og-shim.mts og.check.ts   # if this fails, skip per note below
```

If a DOM shim isn't readily available in this environment, SKIP executing `og.check.ts` and instead verify `parseOpenGraph` by inspection + `npm run build` (the browser has `DOMParser` natively). Note in your report which path you took. Then:

```bash
rm -f og.check.ts og-shim.mts
npm run build   # must PASS
git commit -m "feat: client-side OpenGraph link-preview module + privacy flag" -- src/platform/linkPreview.ts src/data/settings.ts
```

---

### Task 4: LinkCard component + settings toggle + wire `links`

**Files:**
- Create: `src/ui/LinkCard.tsx`
- Modify: `src/ui/Chat.tsx` (`AssistantText` links branch), `src/ui/settings/GeneralTab.tsx` (toggle), `src/ui/styles.css`

**Interfaces:**
- Consumes: `LinkRef` (blocks.ts), `getLinkPreview`/`LinkPreview` (linkPreview.ts), `faviconUrl` (Chat.tsx — export it if not already).
- Produces: `LinkCardStack({ links: LinkRef[] })`.

- [ ] **Step 1: Export `faviconUrl`** from `src/ui/Chat.tsx`

`faviconUrl` (line ~147) is currently module-local. Add `export` so `LinkCard` can reuse Chrome's favicon cache:

```tsx
export function faviconUrl(pageUrl: string, size = 32): string {
```

- [ ] **Step 2: Create `src/ui/LinkCard.tsx`**

```tsx
import { useEffect, useState } from 'react'
import type { LinkRef } from './blocks'
import { getLinkPreview, type LinkPreview } from '../platform/linkPreview'
import { faviconUrl } from './Chat'

// A run of standalone links, each a card: favicon + domain + link text shown
// immediately, then upgraded with OpenGraph title/description/image if a
// client-side fetch resolves (see linkPreview.ts; gated by a privacy setting).

export default function LinkCardStack({ links }: { links: LinkRef[] }) {
  return (
    <div className="link-cards">
      {links.map((l, i) => (
        <LinkCard key={i} link={l} />
      ))}
    </div>
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

function LinkCard({ link }: { link: LinkRef }) {
  const [preview, setPreview] = useState<LinkPreview | null>(null)
  const [imgOk, setImgOk] = useState(true)
  const host = hostOf(link.url)

  useEffect(() => {
    let live = true
    void getLinkPreview(link.url).then((p) => {
      if (live) setPreview(p)
    })
    return () => {
      live = false
    }
  }, [link.url])

  const title = preview?.title || link.text || host
  const showImage = imgOk && !!preview?.image

  return (
    <a className="link-card" href={link.url} target="_blank" rel="noreferrer">
      {showImage && (
        <span className="link-card-thumb">
          <img src={preview!.image} alt="" loading="lazy" onError={() => setImgOk(false)} />
        </span>
      )}
      <span className="link-card-body">
        <span className="link-card-site">
          <img className="link-card-favicon" src={faviconUrl(link.url)} alt="" />
          {preview?.siteName || host}
        </span>
        <span className="link-card-title">{title}</span>
        {preview?.description && <span className="link-card-desc">{preview.description}</span>}
      </span>
    </a>
  )
}
```

- [ ] **Step 3: Route `links` to the component** in `AssistantText` (`src/ui/Chat.tsx`)

Add the import and replace the links fallback:

```tsx
import LinkCardStack from './LinkCard'
```
```tsx
        if (b.type === 'images') return <ImageCarousel key={i} urls={b.urls} />
        if (b.type === 'links') return <LinkCardStack key={i} links={b.links} />
        if (b.type === 'markdown') return <Markdown key={i} text={b.text} />
        return <Markdown key={i} text={b.raw} /> // json → markdown until Task 7
```

- [ ] **Step 4: Add the privacy toggle** in `src/ui/settings/GeneralTab.tsx`

First `grep -n "checkbox\|type=\"checkbox\"\|onChange" src/ui/settings/GeneralTab.tsx` to copy the file's existing toggle pattern. Add a labeled checkbox bound to `settings.fetchLinkPreviews` (default treated as `true` when undefined) that persists via the tab's existing settings-save path:

```tsx
<label className="check">
  <input
    type="checkbox"
    checked={settings.fetchLinkPreviews !== false}
    onChange={(e) => save({ ...settings, fetchLinkPreviews: e.target.checked })}
  />
  Fetch link previews (contacts linked sites for title/description/image)
</label>
```

Match the actual prop/handler names in that file (the `save`/`update` function and `settings` object may be named differently — use what the file already uses).

- [ ] **Step 5: Add CSS** to `src/ui/styles.css` (append near the image-carousel rules)

```css
.link-cards { display: flex; flex-direction: column; gap: 8px; margin: 8px 0; }
.link-card {
  display: flex; gap: 10px; text-decoration: none; color: inherit;
  border: 1px solid var(--border); border-radius: 12px; overflow: hidden;
  background: var(--pill-bg); transition: border-color 0.15s;
}
.link-card:hover { border-color: var(--accent, #888); }
.link-card-thumb { flex: 0 0 88px; }
.link-card-thumb img { width: 88px; height: 100%; object-fit: cover; display: block; }
.link-card-body { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; min-width: 0; }
.link-card-site { display: flex; align-items: center; gap: 5px; font-size: 11px; opacity: 0.7; }
.link-card-favicon { width: 13px; height: 13px; border-radius: 3px; }
.link-card-title { font-weight: 600; font-size: 13px; line-height: 1.3; }
.link-card-desc {
  font-size: 12px; opacity: 0.75; line-height: 1.35;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
```

- [ ] **Step 6: Build + commit**

```bash
npm run build   # must PASS
git commit -m "feat: link preview cards with lazy OpenGraph upgrade" -- src/ui/LinkCard.tsx src/ui/Chat.tsx src/ui/settings/GeneralTab.tsx src/ui/styles.css
```

---

### Task 5: Code blocks — language label, copy, collapse

**Files:**
- Create: `src/ui/codeEnhance.ts`
- Modify: `src/ui/Markdown.tsx`, `src/ui/styles.css`

**Interfaces:**
- Produces: `enhanceCodeBlocks(root: HTMLElement): void` — idempotent DOM enhancer.
- Consumes: nothing (highlighting added in Task 6).

- [ ] **Step 1: Create `src/ui/codeEnhance.ts`**

```ts
// Post-render enhancement of `.markdown pre` code blocks: a header bar (language
// label + copy button) and a collapse toggle for tall blocks. Runs against the
// DOM produced by marked → DOMPurify (dangerouslySetInnerHTML), so it operates
// imperatively and is idempotent (guarded by data-enhanced). Syntax highlighting
// is layered on in Task 6.

const COLLAPSE_PX = 360

/** Enhance every not-yet-enhanced <pre> under `root`. Safe to call repeatedly. */
export function enhanceCodeBlocks(root: HTMLElement): void {
  const pres = root.querySelectorAll<HTMLPreElement>('pre:not([data-enhanced])')
  pres.forEach((pre) => {
    pre.setAttribute('data-enhanced', '1')
    const code = pre.querySelector('code')
    const lang = languageOf(code)

    const wrap = document.createElement('div')
    wrap.className = 'code-block'
    pre.replaceWith(wrap)

    const header = document.createElement('div')
    header.className = 'code-block-header'
    const label = document.createElement('span')
    label.className = 'code-block-lang'
    label.textContent = lang || 'text'
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.className = 'code-block-copy'
    copy.textContent = 'Copy'
    copy.addEventListener('click', () => {
      void navigator.clipboard.writeText(code?.textContent ?? '').then(() => {
        copy.textContent = 'Copied'
        setTimeout(() => (copy.textContent = 'Copy'), 1200)
      })
    })
    header.append(label, copy)

    wrap.append(header, pre)

    // Collapse tall blocks behind a toggle.
    requestAnimationFrame(() => {
      if (pre.scrollHeight > COLLAPSE_PX) {
        wrap.classList.add('code-collapsed')
        const toggle = document.createElement('button')
        toggle.type = 'button'
        toggle.className = 'code-block-toggle'
        toggle.textContent = 'Show more'
        toggle.addEventListener('click', () => {
          const open = wrap.classList.toggle('code-open')
          toggle.textContent = open ? 'Show less' : 'Show more'
        })
        wrap.append(toggle)
      }
    })
  })
}

function languageOf(code: Element | null): string {
  const cls = code?.className ?? ''
  const m = cls.match(/language-([\w-]+)/)
  return m ? m[1] : ''
}
```

- [ ] **Step 2: Call it from `Markdown`** (`src/ui/Markdown.tsx`)

Add a ref + effect (keep the existing render pipeline unchanged):

```tsx
import { useEffect, useMemo, useRef } from 'react'
// ...existing imports...
import { enhanceCodeBlocks } from './codeEnhance'
```
```tsx
export default function Markdown({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const html = useMemo(() => {
    const normalized = normalizeMathDelimiters(text)
    const raw = marked.parse(normalized, { async: false }) as string
    return DOMPurify.sanitize(raw, { ADD_TAGS: ['semantics', 'annotation'], ADD_ATTR: ['encoding'] })
  }, [text])
  useEffect(() => {
    if (ref.current) enhanceCodeBlocks(ref.current)
  }, [html])
  return <div className="markdown" ref={ref} dangerouslySetInnerHTML={{ __html: html }} />
}
```

- [ ] **Step 3: Add CSS** to `src/ui/styles.css`

```css
.code-block { border: 1px solid var(--border); border-radius: 10px; overflow: hidden; margin: 8px 0; }
.code-block-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 4px 10px; background: var(--pill-bg); border-bottom: 1px solid var(--border);
  font-size: 11px;
}
.code-block-lang { text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.6; }
.code-block-copy, .code-block-toggle {
  border: none; background: none; color: inherit; cursor: pointer; font: inherit;
  font-size: 11px; opacity: 0.7; padding: 2px 6px; border-radius: 6px;
}
.code-block-copy:hover, .code-block-toggle:hover { opacity: 1; background: var(--border); }
.code-block pre { margin: 0; border: none; border-radius: 0; }
.code-block.code-collapsed pre { max-height: 360px; overflow: hidden; }
.code-block.code-collapsed.code-open pre { max-height: none; }
.code-block-toggle { display: block; width: 100%; border-top: 1px solid var(--border); background: var(--pill-bg); }
```

- [ ] **Step 4: Build + commit**

```bash
npm run build   # must PASS
git commit -m "feat: code block header (language + copy) and collapse" -- src/ui/codeEnhance.ts src/ui/Markdown.tsx src/ui/styles.css
```

---

### Task 6: Lazy syntax highlighting

**Files:**
- Modify: `src/ui/codeEnhance.ts`, `package.json`

**Interfaces:** unchanged public surface; highlighting applied inside `enhanceCodeBlocks`.

- [ ] **Step 1: Add the dependency**

```bash
npm install highlight.js
```

- [ ] **Step 2: Lazy-highlight in `codeEnhance.ts`**

Add a lazy loader and call it per code block. Append to `src/ui/codeEnhance.ts`:

```ts
// Lazy highlight.js core with a curated common-language set, loaded once and
// shared. Dynamic import keeps it out of the initial sidepanel bundle.
let hljsPromise: Promise<typeof import('highlight.js/lib/core').default> | null = null
async function loadHljs() {
  if (!hljsPromise) {
    hljsPromise = (async () => {
      const { default: hljs } = await import('highlight.js/lib/core')
      const langs: [string, () => Promise<{ default: unknown }>][] = [
        ['javascript', () => import('highlight.js/lib/languages/javascript')],
        ['typescript', () => import('highlight.js/lib/languages/typescript')],
        ['python', () => import('highlight.js/lib/languages/python')],
        ['bash', () => import('highlight.js/lib/languages/bash')],
        ['json', () => import('highlight.js/lib/languages/json')],
        ['xml', () => import('highlight.js/lib/languages/xml')],
        ['css', () => import('highlight.js/lib/languages/css')],
      ]
      await Promise.all(
        langs.map(async ([name, imp]) => hljs.registerLanguage(name, ((await imp()).default) as never)),
      )
      return hljs
    })()
  }
  return hljsPromise
}

/** Highlight one code element with the lazily-loaded engine. Idempotent. */
export async function highlightCode(code: HTMLElement, lang: string): Promise<void> {
  if (code.dataset.highlighted) return
  const hljs = await loadHljs()
  code.dataset.highlighted = '1'
  const result = hljs.getLanguage(lang)
    ? hljs.highlight(code.textContent ?? '', { language: lang })
    : hljs.highlightAuto(code.textContent ?? '')
  code.innerHTML = result.value
  code.classList.add('hljs')
}
```

In `enhanceCodeBlocks`, after computing `code`/`lang`, kick off highlighting (fire-and-forget):

```ts
    if (code) void highlightCode(code, lang)
```

- [ ] **Step 3: Build + commit**

```bash
npm run build   # must PASS; confirm highlight.js lands in a SEPARATE chunk (not sidepanel.js) in the build output
git commit -m "feat: lazy-loaded syntax highlighting for code blocks" -- src/ui/codeEnhance.ts package.json package-lock.json
```

Note in your report the build's chunk list showing an `hljs`/`highlight` chunk distinct from `sidepanel.js`.

---

### Task 7: JSON tree + wire `json`

**Files:**
- Create: `src/ui/JsonTree.tsx`
- Modify: `src/ui/Chat.tsx` (`AssistantText` json branch), `src/ui/styles.css`

**Interfaces:**
- Consumes: `json` block `{ value: unknown }`.
- Produces: `JsonTree({ value: unknown })`.

- [ ] **Step 1: Create `src/ui/JsonTree.tsx`**

```tsx
import { useState } from 'react'

// Renders a parsed JSON value (from a standalone ```json block) as a collapsible
// key/value tree. Objects/arrays are expandable; primitives are shown inline
// with type coloring. Deep nodes start collapsed to keep large payloads compact.

export default function JsonTree({ value }: { value: unknown }) {
  return (
    <div className="json-tree">
      <Node k={null} value={value} depth={0} />
    </div>
  )
}

function Node({ k, value, depth }: { k: string | null; value: unknown; depth: number }) {
  const isContainer = value !== null && typeof value === 'object'
  const [open, setOpen] = useState(depth < 2)

  if (!isContainer) {
    return (
      <div className="json-row" style={{ paddingLeft: depth * 14 }}>
        {k !== null && <span className="json-key">{k}:</span>}
        <span className={`json-val json-${valueType(value)}`}>{format(value)}</span>
      </div>
    )
  }

  const entries: [string, unknown][] = Array.isArray(value)
    ? value.map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, unknown>)
  const brace = Array.isArray(value) ? ['[', ']'] : ['{', '}']

  return (
    <div className="json-node">
      <div className="json-row json-branch" style={{ paddingLeft: depth * 14 }} onClick={() => setOpen((o) => !o)}>
        <span className="json-caret">{open ? '▾' : '▸'}</span>
        {k !== null && <span className="json-key">{k}:</span>}
        <span className="json-brace">{brace[0]}{!open && `… ${entries.length}`}{!open && brace[1]}</span>
      </div>
      {open && (
        <>
          {entries.map(([ck, cv]) => (
            <Node key={ck} k={ck} value={cv} depth={depth + 1} />
          ))}
          <div className="json-row json-brace" style={{ paddingLeft: depth * 14 }}>{brace[1]}</div>
        </>
      )}
    </div>
  )
}

function valueType(v: unknown): string {
  if (v === null) return 'null'
  return typeof v
}
function format(v: unknown): string {
  return typeof v === 'string' ? `"${v}"` : String(v)
}
```

- [ ] **Step 2: Route `json`** in `AssistantText` (`src/ui/Chat.tsx`)

```tsx
import JsonTree from './JsonTree'
```
```tsx
        if (b.type === 'images') return <ImageCarousel key={i} urls={b.urls} />
        if (b.type === 'links') return <LinkCardStack key={i} links={b.links} />
        if (b.type === 'json') return <JsonTree key={i} value={b.value} />
        return <Markdown key={i} text={b.text} />
```

- [ ] **Step 3: Add CSS** to `src/ui/styles.css`

```css
.json-tree {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
  border: 1px solid var(--border); border-radius: 10px; padding: 8px; margin: 8px 0;
  overflow-x: auto; background: var(--pill-bg);
}
.json-row { white-space: nowrap; line-height: 1.6; }
.json-branch { cursor: pointer; user-select: none; }
.json-caret { display: inline-block; width: 1em; opacity: 0.6; }
.json-key { color: var(--accent, #7a7); margin-right: 6px; }
.json-string { color: #4a8; }
.json-number { color: #c86; }
.json-boolean, .json-null { color: #a6a; }
.json-brace { opacity: 0.7; }
```

- [ ] **Step 4: Build + commit**

```bash
npm run build   # must PASS
git commit -m "feat: collapsible JSON tree for standalone json blocks" -- src/ui/JsonTree.tsx src/ui/Chat.tsx src/ui/styles.css
```

---

### Task 8: Table polish

**Files:**
- Modify: `src/ui/Markdown.tsx` (wrap tables), `src/ui/styles.css`

- [ ] **Step 1: Wrap tables via a marked renderer** in `src/ui/Markdown.tsx`

Add a table renderer to the module-load marked config so each table is scroll-wrapped:

```tsx
marked.use({
  renderer: {
    table(header, body) {
      return `<div class="table-scroll"><table><thead>${header}</thead><tbody>${body}</tbody></table></div>`
    },
  },
})
```

*(marked v15 renderer signature: confirm with `node -e "const {marked}=require('marked')"` or the marked v15 docs; if `table` receives a token object rather than `(header, body)`, adapt to `table(token){…}` returning the wrapped default. Verify the built output wraps tables.)*

- [ ] **Step 2: Add CSS** to `src/ui/styles.css`

```css
.table-scroll { overflow-x: auto; margin: 8px 0; border: 1px solid var(--border); border-radius: 10px; }
.markdown .table-scroll table { margin: 0; border: none; border-collapse: collapse; width: 100%; }
.markdown .table-scroll th, .markdown .table-scroll td { padding: 6px 10px; border-bottom: 1px solid var(--border); text-align: left; white-space: nowrap; }
.markdown .table-scroll thead th { position: sticky; top: 0; background: var(--pill-bg); font-weight: 600; }
.markdown .table-scroll tbody tr:nth-child(even) { background: color-mix(in srgb, var(--pill-bg) 50%, transparent); }
```

- [ ] **Step 3: Build + commit**

```bash
npm run build   # must PASS
git commit -m "feat: table polish (scroll container, sticky header, zebra)" -- src/ui/Markdown.tsx src/ui/styles.css
```

---

## Self-Review

**Spec coverage:** Phase 1 KaTeX → Task 1 (safe `\[…\]` subset; `$$` is reload-diagnosed, documented). Segmenter → Task 2. Link cards hybrid + privacy → Tasks 3–4. Code label/copy/collapse → Task 5; lazy highlight → Task 6. JSON tree → Task 7; table polish → Task 8. Auto-collapse long blocks → Task 5. ✓

**Placeholder scan:** No TODO/TBD. Two explicit "confirm the actual name/signature" notes (Task 3 `getSettings`, Task 4 GeneralTab pattern, Task 8 marked renderer) are verification instructions with a concrete fallback, not placeholders. ✓

**Type consistency:** `Block`/`LinkRef` defined in Task 2, consumed in Tasks 4/7. `LinkPreview`/`getLinkPreview`/`parseOpenGraph` defined in Task 3, consumed in Task 4. `enhanceCodeBlocks`/`highlightCode` defined Tasks 5–6. `faviconUrl` exported in Task 4 Step 1, consumed by LinkCard. `settings.fetchLinkPreviews` defined Task 3, read in Task 3 (`getLinkPreview`) and toggled Task 4. ✓

**Risks flagged for the implementer/reviewer:** marked v15 renderer signature (Task 8); `DOMParser` unavailable in tsx (Task 3 check has a documented skip); GeneralTab save-handler naming (Task 4). These are named with concrete resolution steps.
