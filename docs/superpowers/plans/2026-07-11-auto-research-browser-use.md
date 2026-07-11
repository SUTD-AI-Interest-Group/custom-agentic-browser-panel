# Auto-research + Browser-use Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a headless background auto-research capability (search → fetch → extract → synthesize a cited report, surviving panel close) and harden the foreground browser-use loop (wait for async pages; fill forms from remembered profile data).

**Architecture:** Two independent subsystems. (A) **Auto-research** runs in an MV3 **offscreen document** (Web APIs + `chrome.runtime` messaging only), orchestrated by the service worker which owns all `chrome.*` work; it is a read-only web-egress sandbox with no tab/user-data access. (B) **Browser-use hardening** stays in the existing foreground `ControlSession` loop, which is the only place `chrome.scripting.executeScript` is available.

**Tech Stack:** React 18 + Vite 6 + TypeScript (strict), Vercel AI SDK v5 (`ai`, `@ai-sdk/openai-compatible`), Chrome MV3 (`offscreen`, `notifications`, `scripting`, `tabs`, `storage`, `alarms`). New dev-only: Vitest + jsdom.

## Global Constraints

_Every task's requirements implicitly include this section._

- **MV3, no backend, client-side only.** All model calls go direct to the user's configured OpenAI-compatible endpoint. `host_permissions: ["<all_urls>"]` is what exempts direct calls from CORS.
- **Code style (convention-only, match by hand):** no semicolons (ASI), single quotes, 2-space indent, `interface` for object shapes / `type` for unions, `/** ... */` on exported types/functions.
- **Every agent tool routes through the `requestApproval` gate** in `src/tools/tools.ts` before `execute()` proceeds — except benign read-only tools that auto-approve (existing `ReadSkill`/`ListAllSkills`). `StartResearch` **is gated**. The background research agent's internal tools (`WebSearch`/`FetchUrl`/`ExtractData`) are **not** individually gated — justified solely by the read-only, no-user-data sandbox.
- **Offscreen documents expose ONLY** `chrome.runtime.sendMessage`/`onMessage`, `chrome.runtime.getURL`, and standard Web APIs. **No `chrome.storage`, `chrome.tabs`, `chrome.notifications` in the offscreen doc.** The SW reads settings and passes config into the doc; the SW persists results and fires notifications.
- **Injected functions** (`inj*` in `src/platform/*`) run in the page's isolated world with no shared JS state: fully self-contained, no closures over outer scope, no imports; pass everything via `args`, re-find elements via `data-agent-idx`.
- **`chrome.runtime.sendMessage` broadcasts** to all other extension contexts. Async `onMessage` listeners must `return true`.
- **Never `eval`/`new Function`** (extension CSP). `ExtractData` builds validators from JSON schema via the AI SDK `jsonSchema()` helper.
- **Research fetch safety (verbatim):** `credentials: 'omit'`; reject non-`http(s)`, `localhost`, `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `::1`, `*.local`; per-URL `AbortSignal.timeout`; response size cap.
- **Manifest additions (verbatim):** add `"offscreen"` and `"notifications"` to `permissions`.
- **Verification model:** pure logic → Vitest (`npm test`, jsdom, dev-only, does not affect `vite build`). Chrome-integration → `npm run build` (typecheck) + a scripted manual `/verify-extension` check (Load unpacked `dist/`, reload after each build).
- **Git:** commit directly to `main` when executing solo, but this is substantial work — execute in a git worktree (per repo memory: concurrent sessions run on `main`); pathspec-scope commits to files this plan touches.

---

## File Structure

**Created:**
- `vitest.config.ts` — dev-only test runner config (jsdom env). Does not affect the extension build.
- `offscreen.html` — offscreen document shell (repo root, sibling of `sidepanel.html`).
- `src/background/offscreen.ts` — research host: message loop + runResearch; Web APIs + `chrome.runtime` only.
- `src/agent/research.ts` — research agent: system prompt + headless toolset + loop; reuses `createModel`.
- `src/tools/research.ts` — `StartResearch` (foreground, gated) tool def + research-tool factory (`WebSearch`, `FetchUrl`, `ExtractData`).
- `src/data/researchTasks.ts` — task state + message types; `chrome.storage.local` persistence (SW/panel only).
- `src/platform/webFetch.ts` — pure: DuckDuckGo-lite parse, HTML→readable-text, SSRF `isFetchableUrl`, `parseJsonLoose`.
- `src/platform/*.test.ts` — Vitest unit tests for the pure functions.

**Modified:**
- `public/manifest.json` — add `offscreen`, `notifications` permissions.
- `vite.config.ts` — add `offscreen.html` input.
- `package.json` — add `vitest`, `jsdom` devDeps + `test` script.
- `src/platform/pageActions.ts` — add `waitForStable()`. [#8]
- `src/tools/pageControl.ts` — add `'wait'` `ControlAction`; `runControlStep` auto-waits (replaces the 600 ms `setTimeout`). [#8]
- `src/tools/tools.ts` — register `ExtractData` (active tab), `AutofillForm` [#7], `StartResearch`; extend `ControlPage` schema with `wait`.
- `src/data/memory.ts` — add `'profile'` memory kind. [#7]
- `src/background.ts` — offscreen lifecycle (locked singleton) + research message persistence + notification (data-URL icon).
- `src/ui/Chat.tsx` — `ResearchTask` live card + `chrome.runtime.onMessage` listener.

---

# Phase 1 — Browser-use hardening (no new infra)

## Task 1: Dev-only Vitest tooling

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json` (scripts + devDependencies)

**Interfaces:**
- Produces: an `npm test` command running `*.test.ts` under jsdom. No change to `vite build`.

- [ ] **Step 1: Add devDeps and script**

Run:
```bash
npm install -D vitest jsdom
```
Then in `package.json` `"scripts"`, add:
```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 2: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

// Dev-only. Isolated from vite.config.ts so the extension build is untouched:
// vite build still uses vite.config.ts and never sees *.test.ts files.
export default defineConfig({
  test: {
    environment: 'jsdom', // gives DOMParser to the HTML-parsing tests
    globals: true,
    include: ['src/**/*.test.ts'],
  },
})
```

- [ ] **Step 3: Sanity test**

Create `src/platform/_sanity.test.ts`:
```ts
import { test, expect } from 'vitest'

test('vitest + jsdom wired up', () => {
  const doc = new DOMParser().parseFromString('<p id="x">hi</p>', 'text/html')
  expect(doc.getElementById('x')?.textContent).toBe('hi')
})
```

- [ ] **Step 4: Run**

Run: `npm test`
Expected: PASS (1 test). Then delete `src/platform/_sanity.test.ts`.

- [ ] **Step 5: Confirm the build is unaffected**

Run: `npm run build`
Expected: typecheck + `vite build` succeed; `dist/` contains no test files.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json vitest.config.ts
git commit -m "chore: add dev-only vitest (jsdom) for pure-unit tests"
```

---

## Task 2: `waitForStable` page-stability primitive [#8]

**Files:**
- Modify: `src/platform/pageActions.ts`

**Interfaces:**
- Produces: `waitForStable(tabId: number, opts?: { selector?: string; quietMs?: number; timeoutMs?: number }): Promise<{ ok: boolean; reason: string }>` — resolves when the DOM goes quiet for `quietMs` (default 400) OR `selector` appears, bounded by `timeoutMs` (default 6000). Never rejects.

- [ ] **Step 1: Add the injected function and wrapper**

In `src/platform/pageActions.ts`, add (self-contained injected fn — no outer refs):
```ts
// Resolves once the page settles: either `selector` appears, or the DOM stops
// mutating for `quietMs`. Bounded by `timeoutMs` so a never-quiet page (ads,
// polling) proceeds instead of hanging. Runs in the page's isolated world.
function injWaitStable(selector: string, quietMs: number, timeoutMs: number) {
  if (selector && document.querySelector(selector)) {
    return Promise.resolve({ ok: true, reason: 'selector-present' })
  }
  return new Promise<{ ok: boolean; reason: string }>((resolve) => {
    let quiet: number
    let hard: number
    const finish = (reason: string) => {
      try { obs.disconnect() } catch {}
      clearTimeout(quiet)
      clearTimeout(hard)
      resolve({ ok: true, reason })
    }
    const obs = new MutationObserver(() => {
      if (selector && document.querySelector(selector)) return finish('selector-appeared')
      clearTimeout(quiet)
      quiet = setTimeout(() => finish('quiet'), quietMs) as unknown as number
    })
    obs.observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, characterData: true,
    })
    quiet = setTimeout(() => finish('quiet'), quietMs) as unknown as number
    hard = setTimeout(() => finish('timeout'), timeoutMs) as unknown as number
  })
}

/**
 * Wait for the page to settle after an action: the DOM goes quiet for
 * `quietMs`, or `selector` appears, whichever first, bounded by `timeoutMs`.
 * executeScript awaits the injected promise. Never throws.
 */
export async function waitForStable(
  tabId: number,
  opts: { selector?: string; quietMs?: number; timeoutMs?: number } = {},
): Promise<{ ok: boolean; reason: string }> {
  const { selector = '', quietMs = 400, timeoutMs = 6000 } = opts
  try {
    return await inject(tabId, injWaitStable, [selector, quietMs, timeoutMs])
  } catch (err) {
    return { ok: false, reason: `wait failed (${err instanceof Error ? err.message : String(err)})` }
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run build`
Expected: PASS. (`inject` already exists in this file and awaits async `func` results.)

- [ ] **Step 3: Manual verify (deferred to Task 3's flow)**

`waitForStable` has no standalone UI yet — it is exercised in Task 3. No commit alone; commit with Task 3.

---

## Task 3: Auto-wait in the control loop + explicit `wait` action [#8]

**Files:**
- Modify: `src/tools/pageControl.ts`
- Modify: `src/tools/tools.ts` (ControlPage input schema + summary)

**Interfaces:**
- Consumes: `waitForStable` (Task 2).
- Produces: `ControlAction` union includes `'wait'`; `ControlSpec` gains `timeoutMs?: number`; `runControlStep` awaits stability after click/navigate/select/press instead of the fixed 600 ms.

- [ ] **Step 1: Extend the action types**

In `src/tools/pageControl.ts`, add `'wait'` to `ControlAction` and `timeoutMs` to `ControlSpec`:
```ts
export type ControlAction =
  | 'click' | 'type' | 'select' | 'scroll'
  | 'highlight' | 'navigate' | 'press' | 'wait'

export interface ControlSpec {
  action: ControlAction
  index?: number
  text?: string
  value?: string
  url?: string
  keys?: string
  direction?: 'up' | 'down' | 'toElement'
  label?: string
  sensitive?: boolean
  clear?: boolean
  /** Max ms to wait for stability (action='wait'); also caps post-action auto-wait. */
  timeoutMs?: number
}
```

- [ ] **Step 2: Import `waitForStable` and handle the `wait` action**

In `src/tools/pageControl.ts`, add `waitForStable` to the import from `'../platform/pageActions'`, and in `runRaw`'s switch add:
```ts
    case 'wait':
      return waitForStable(tabId, {
        selector: spec.text || undefined,
        timeoutMs: spec.timeoutMs,
      }).then((r) => ({ ok: r.ok, message: `waited (${r.reason})` }))
```
(`spec.text` doubles as an optional CSS selector to wait for.)

- [ ] **Step 3: Replace the hardcoded post-navigate delay with real stability waits**

In `runControlStep`, replace:
```ts
  // Navigation reloads the document; give it a beat before re-reading.
  if (spec.action === 'navigate') await new Promise((r) => setTimeout(r, 600))
```
with:
```ts
  // Let async pages settle before re-reading, instead of a fixed delay. Skip
  // for 'wait' (already waited) and 'highlight'/'scroll' (no state change).
  if (['click', 'type', 'select', 'navigate', 'press'].includes(spec.action)) {
    await waitForStable(tabId, { timeoutMs: spec.action === 'navigate' ? 8000 : 4000 })
  }
```

- [ ] **Step 4: Expose `wait` in the ControlPage tool schema**

In `src/tools/tools.ts`, in the `ControlPage` tool `inputSchema`:
- add `'wait'` to the `action` enum,
- add `timeoutMs: z.number().optional().describe('Max ms to wait for the page to settle (action=wait).')`,
- update the `action` `.describe(...)` / tool description to mention: `wait: pause until the page settles or an optional CSS selector (passed in text) appears`.

- [ ] **Step 5: Typecheck**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 6: Manual verify (`/verify-extension`)**

1. `npm run build`; reload unpacked in `chrome://extensions`.
2. Open the panel on a slow SPA (e.g. a site that lazy-loads a list). Ask the agent to control the page and click something that triggers async content, then read the page.
3. Confirm the re-read element list reflects the *loaded* content (not the pre-load state) — i.e. the auto-wait caught up.
4. Ask the agent to `wait` for a selector that never appears; confirm it proceeds after the timeout (message `waited (timeout)`), no hang.

- [ ] **Step 7: Commit**

```bash
git add src/platform/pageActions.ts src/tools/pageControl.ts src/tools/tools.ts
git commit -m "feat: wait for page stability in the control loop (+ explicit wait action)"
```

---

## Task 4: `ExtractData` tool over the active tab [#3]

**Files:**
- Create: `src/platform/webFetch.ts` (only `parseJsonLoose` in this task; the rest lands in Phase 2)
- Create: `src/platform/webFetch.test.ts`
- Create: `src/agent/extract.ts` (shared `extractStructured` helper, reused by Task 6)
- Modify: `src/tools/tools.ts` (register `ExtractData`)

**Interfaces:**
- Produces: `parseJsonLoose(text: string): unknown` — tolerant JSON parse (strips code fences, takes the outermost `{...}`/`[...]`); throws on unrecoverable input. Used by the `extractStructured` fallback path.
- Produces: `extractStructured(model: LanguageModel, prompt: string, schema: Record<string, unknown>): Promise<unknown>` — structured-output first, prompted-JSON fallback; throws on total failure. Reused by Task 6's `ExtractDataText`.
- Produces: `ExtractData` tool: `{ instruction: string, schema: <JSON schema object>, reason: string }` → `{ data }` or `{ error }`.

- [ ] **Step 1: Failing test for `parseJsonLoose`**

Create `src/platform/webFetch.test.ts`:
```ts
import { test, expect } from 'vitest'
import { parseJsonLoose } from './webFetch'

test('parses fenced json', () => {
  expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 })
})
test('parses json with surrounding prose', () => {
  expect(parseJsonLoose('Sure! {"a":2} done')).toEqual({ a: 2 })
})
test('parses top-level array', () => {
  expect(parseJsonLoose('[{"a":1},{"a":2}]')).toEqual([{ a: 1 }, { a: 2 }])
})
test('throws on non-json', () => {
  expect(() => parseJsonLoose('nope')).toThrow()
})
```

- [ ] **Step 2: Run — verify it fails**

Run: `npm test`
Expected: FAIL (`parseJsonLoose` not exported / module missing).

- [ ] **Step 3: Implement `parseJsonLoose`**

Create `src/platform/webFetch.ts`:
```ts
/**
 * Tolerant JSON parse for model output that may be fenced or wrapped in prose.
 * Strips ```json fences, then falls back to the outermost brace/bracket span.
 * Throws if nothing parses — callers treat that as an extraction failure.
 */
export function parseJsonLoose(text: string): unknown {
  const unfenced = text.replace(/```(?:json)?/gi, '').trim()
  try {
    return JSON.parse(unfenced)
  } catch {}
  const start = unfenced.search(/[[{]/)
  const end = Math.max(unfenced.lastIndexOf('}'), unfenced.lastIndexOf(']'))
  if (start === -1 || end <= start) throw new Error('no JSON found in text')
  return JSON.parse(unfenced.slice(start, end + 1))
}
```

- [ ] **Step 4: Run — verify it passes**

Run: `npm test`
Expected: PASS (4 tests).

- [ ] **Step 5: Create the shared `extractStructured` helper**

The structured-extraction logic (structured-output first, prompted-JSON fallback) is used by BOTH `ExtractData` here and `ExtractDataText` in Task 6. Put it in one place so there is a single source of truth. Create `src/agent/extract.ts`:
```ts
import { generateObject, generateText, jsonSchema, type LanguageModel } from 'ai'
import { parseJsonLoose } from '../platform/webFetch'

/**
 * Extract a JSON value matching `schema` (a JSON Schema object) from `prompt`.
 * Tries the endpoint's structured-output mode; on failure (endpoints without
 * it) falls back to prompted JSON + tolerant parse. Returns the value or throws.
 * `schema` is passed declaratively via jsonSchema() — never eval'd (CSP).
 */
export async function extractStructured(
  model: LanguageModel,
  prompt: string,
  schema: Record<string, unknown>,
): Promise<unknown> {
  try {
    const { object } = await generateObject({ model, schema: jsonSchema(schema as any), prompt })
    return object
  } catch {
    const { text } = await generateText({
      model,
      prompt: `${prompt}\n\nReturn ONLY JSON matching this schema:\n${JSON.stringify(schema)}`,
    })
    return parseJsonLoose(text)
  }
}
```

- [ ] **Step 6: Register the `ExtractData` tool**

In `src/tools/tools.ts`, add imports:
```ts
import { createModel } from '../agent/provider'
import { extractStructured } from '../agent/extract'
```
Add inside `createAgentTools`'s `tools` object:
```ts
    ExtractData: tool({
      description:
        'Extract structured data from the active tab into a caller-defined JSON schema. Use when the user wants records pulled out — a table, a list of items, fields from a page — as clean JSON. Asks permission first.',
      inputSchema: z.object({
        reason: z.string().describe('Short reason shown to the user, e.g. "To pull the product table into a list"'),
        instruction: z.string().describe('What to extract, e.g. "every product with name and price"'),
        schema: z.record(z.any()).describe('A JSON Schema object describing the desired output shape.'),
      }),
      execute: async ({ reason, instruction, schema }) => {
        const approved = await requestApproval({
          toolName: 'ExtractData',
          summary: 'Extract structured data from this page',
          reason,
        })
        if (!approved) return DENIED
        if (!selected) return { error: 'No model is configured.' }
        const tab = await getActiveTab()
        if (tab?.id === undefined) return { error: 'No active tab found.' }
        const page = await readTabContent(tab.id)
        const source = typeof page === 'object' && page && 'text' in page ? String((page as any).text) : JSON.stringify(page)
        const model = createModel(selected.provider, selected.modelId)
        const prompt = `${instruction}\n\nSource page content:\n${source.slice(0, 40_000)}`
        try {
          return { data: await extractStructured(model, prompt, schema as Record<string, unknown>) }
        } catch (err) {
          return { error: `Could not extract structured data (${err instanceof Error ? err.message : String(err)}).` }
        }
      },
    }),
```
(No `generateObject`/`generateText`/`jsonSchema`/`parseJsonLoose` imports are needed in `tools.ts` — they live in `extract.ts` now.)

- [ ] **Step 7: Typecheck**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 8: Manual verify (`/verify-extension`)**

1. Reload unpacked. Open a page with an obvious table/list.
2. Ask: "Extract every row as `{name, value}` objects." Approve the card.
3. Confirm the tool returns a `data` array in the tool card. Repeat against a local model (e.g. Ollama) to exercise the fallback path if available.

- [ ] **Step 9: Commit**

```bash
git add src/platform/webFetch.ts src/platform/webFetch.test.ts src/agent/extract.ts src/tools/tools.ts
git commit -m "feat: ExtractData tool + shared extractStructured helper"
```

---

# Phase 2 — Research primitives (headless), validated in-panel first

## Task 5: Web-fetch pure logic — SSRF guard, DDG parse, HTML→text

**Files:**
- Modify: `src/platform/webFetch.ts`
- Modify: `src/platform/webFetch.test.ts`

**Interfaces:**
- Produces:
  - `isFetchableUrl(raw: string): { ok: boolean; reason?: string }`
  - `parseDuckDuckGoLite(html: string): { title: string; url: string; snippet: string }[]`
  - `extractReadableText(html: string, maxChars?: number): { title: string; text: string }`

- [ ] **Step 1: Failing tests**

Append to `src/platform/webFetch.test.ts`:
```ts
import { isFetchableUrl, parseDuckDuckGoLite, extractReadableText } from './webFetch'

test('SSRF guard rejects localhost + private ranges + non-http', () => {
  expect(isFetchableUrl('https://example.com').ok).toBe(true)
  expect(isFetchableUrl('http://localhost/x').ok).toBe(false)
  expect(isFetchableUrl('http://127.0.0.1').ok).toBe(false)
  expect(isFetchableUrl('http://10.1.2.3').ok).toBe(false)
  expect(isFetchableUrl('http://192.168.0.1').ok).toBe(false)
  expect(isFetchableUrl('http://169.254.1.1').ok).toBe(false)
  expect(isFetchableUrl('file:///etc/passwd').ok).toBe(false)
  expect(isFetchableUrl('http://printer.local').ok).toBe(false)
})

test('parses DDG-lite result rows', () => {
  const html = `<table><tr><td>1.</td><td>
    <a rel="nofollow" class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.com%2Fp&rut=x">A Title</a></td></tr>
    <tr><td class="result-snippet">A snippet.</td></tr>
    <tr><td><a class="result-link" href="https://b.com">B Title</a></td></tr></table>`
  const rows = parseDuckDuckGoLite(html)
  expect(rows[0]).toEqual({ title: 'A Title', url: 'https://a.com/p', snippet: 'A snippet.' })
  expect(rows[1].url).toBe('https://b.com')
})

test('extractReadableText prefers main and strips chrome', () => {
  const html = `<html><head><title>T</title></head><body>
    <nav>menu</nav><script>x()</script>
    <main><h1>Head</h1><p>Body text here.</p></main><footer>foot</footer></body></html>`
  const { title, text } = extractReadableText(html)
  expect(title).toBe('T')
  expect(text).toContain('Body text here.')
  expect(text).not.toContain('menu')
  expect(text).not.toContain('foot')
})
```

- [ ] **Step 2: Run — verify it fails**

Run: `npm test`
Expected: FAIL (new exports missing).

- [ ] **Step 3: Implement the three functions**

Append to `src/platform/webFetch.ts`:
```ts
/** True only for public http(s) URLs — blocks localhost/private-IP/link-local/.local and non-web schemes (SSRF guard). */
export function isFetchableUrl(raw: string): { ok: boolean; reason?: string } {
  let u: URL
  try { u = new URL(raw) } catch { return { ok: false, reason: 'invalid URL' } }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: `blocked scheme ${u.protocol}` }
  const h = u.hostname.toLowerCase()
  if (h === 'localhost' || h.endsWith('.local') || h === '0.0.0.0' || h === '::1' || h === '[::1]') {
    return { ok: false, reason: 'blocked host' }
  }
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])]
    if (a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) {
      return { ok: false, reason: 'blocked private IP' }
    }
  }
  return { ok: true }
}

/** Parse the lite.duckduckgo.com/lite result table into ranked rows. Fragile by nature — tolerant of missing snippets. */
export function parseDuckDuckGoLite(html: string): { title: string; url: string; snippet: string }[] {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const links = Array.from(doc.querySelectorAll('a.result-link')) as HTMLAnchorElement[]
  const resolve = (href: string): string => {
    try {
      const abs = href.startsWith('//') ? `https:${href}` : href
      const u = new URL(abs, 'https://duckduckgo.com')
      const uddg = u.searchParams.get('uddg')
      return uddg ? decodeURIComponent(uddg) : abs
    } catch { return href }
  }
  return links.map((a) => {
    // The snippet cell is the next .result-snippet after this link's row.
    let snippet = ''
    const row = a.closest('tr')
    const snipCell = row?.nextElementSibling?.querySelector('.result-snippet')
      ?? row?.parentElement?.querySelector('.result-snippet')
    if (snipCell) snippet = (snipCell.textContent ?? '').trim()
    return { title: (a.textContent ?? '').trim(), url: resolve(a.getAttribute('href') ?? ''), snippet }
  }).filter((r) => r.title && r.url)
}

/** Reduce a fetched HTML document to readable text: strip chrome, prefer <main>/<article>, collapse whitespace, cap length. */
export function extractReadableText(html: string, maxChars = 20_000): { title: string; text: string } {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const title = (doc.querySelector('title')?.textContent ?? '').trim()
  doc.querySelectorAll('script,style,noscript,nav,footer,header,aside,form,svg').forEach((n) => n.remove())
  const root = doc.querySelector('main') ?? doc.querySelector('article') ?? doc.body
  const text = (root?.textContent ?? '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*/g, '\n\n').trim()
  return { title, text: text.slice(0, maxChars) }
}
```

- [ ] **Step 4: Run — verify it passes**

Run: `npm test`
Expected: PASS (all webFetch tests).

- [ ] **Step 5: Commit**

```bash
git add src/platform/webFetch.ts src/platform/webFetch.test.ts
git commit -m "feat: web-fetch pure logic (SSRF guard, DDG-lite parse, HTML->text)"
```

---

## Task 6: Research tools (`WebSearch`, `FetchUrl`) + gated in-panel validation

**Files:**
- Modify: `src/platform/webFetch.ts` (add network helpers `searchDuckDuckGo`, `fetchReadable`)
- Create: `src/tools/research.ts` (`createResearchTools`)
- Modify: `src/tools/tools.ts` (TEMP **gated** preview tools for live validation; removed in Task 10)

**Interfaces:**
- Produces: `searchDuckDuckGo(query: string, maxResults?: number): Promise<{ results: {title,url,snippet}[] } | { error: string }>` and `fetchReadable(url: string): Promise<{ url,title,text } | { error: string }>` in `webFetch.ts` — the network layer, shared by BOTH the ungated research tools and the gated foreground previews (single source of truth for the fetch behavior + hardening).
- Produces: `createResearchTools(deps: { selected: { provider: ProviderConfig; modelId: string } | null }): ToolSet` exposing `WebSearch`, `FetchUrl`, `ExtractDataText`. These are **ungated by design** (the read-only, no-user-data sandbox rule) and are wired into the model ONLY inside the offscreen research agent in Task 10 — never the foreground chat.
- Produces (TEMP, this task only): `WebSearchPreview` / `FetchUrlPreview` in the foreground toolset, each routed through `requestApproval` before calling the same `searchDuckDuckGo`/`fetchReadable` helpers, so live DuckDuckGo is validated in-panel **without** violating the "every tool routes through requestApproval" invariant. Task 10 removes these two.
- Consumes: `isFetchableUrl`, `parseDuckDuckGoLite`, `extractReadableText` (Task 5); `extractStructured` (Task 4).

- [ ] **Step 1: Add the network helpers to `webFetch.ts`**

Append to `src/platform/webFetch.ts`:
```ts
const FETCH_TIMEOUT_MS = 15_000
const MAX_BYTES = 2_000_000
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Search DuckDuckGo (keyless lite endpoint) with retry/backoff. Never throws — returns {error} on failure so callers can react. */
export async function searchDuckDuckGo(
  query: string,
  maxResults = 8,
): Promise<{ results: ReturnType<typeof parseDuckDuckGoLite> } | { error: string }> {
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'GET',
        credentials: 'omit',
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (res.status === 202 || res.status === 429) { await sleep(400 * (attempt + 1)); continue }
      if (!res.ok) return { error: `search failed: HTTP ${res.status}` }
      const results = parseDuckDuckGoLite(await res.text()).slice(0, Math.min(maxResults, 20))
      return { results }
    } catch (err) {
      if (attempt === 2) return { error: `search error: ${err instanceof Error ? err.message : String(err)}` }
      await sleep(400 * (attempt + 1))
    }
  }
  return { error: 'search failed after retries' }
}

/** Fetch a public page and return its readable text. SSRF-guarded, credentials omitted, timed, size-capped. Never throws. */
export async function fetchReadable(
  url: string,
): Promise<{ url: string; title: string; text: string } | { error: string }> {
  const guard = isFetchableUrl(url)
  if (!guard.ok) return { error: `refused to fetch (${guard.reason})` }
  try {
    const res = await fetch(url, { credentials: 'omit', redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) return { error: `fetch failed: HTTP ${res.status}` }
    const ct = res.headers.get('content-type') ?? ''
    if (!/text\/html|text\/plain|application\/xhtml/i.test(ct)) return { error: `unsupported content-type: ${ct}` }
    const body = (await res.text()).slice(0, MAX_BYTES)
    const { title, text } = extractReadableText(body)
    return { url: res.url, title, text }
  } catch (err) {
    return { error: `fetch error: ${err instanceof Error ? err.message : String(err)}` }
  }
}
```

- [ ] **Step 2: Implement `createResearchTools` (ungated sandbox tools)**

Create `src/tools/research.ts`:
```ts
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { ProviderConfig } from '../data/settings'
import { createModel } from '../agent/provider'
import { extractStructured } from '../agent/extract'
import { searchDuckDuckGo, fetchReadable } from '../platform/webFetch'

/**
 * Read-only, web-egress-only tools for the BACKGROUND research agent. Ungated by
 * design — there is no user present in the offscreen sandbox, and these tools
 * touch no tabs, cookies, or user data. They are wired into the model ONLY inside
 * the offscreen research agent (Task 10), never the foreground chat.
 */
export function createResearchTools(deps: {
  selected: { provider: ProviderConfig; modelId: string } | null
}): ToolSet {
  return {
    WebSearch: tool({
      description: 'Search the web (DuckDuckGo) and return ranked {title,url,snippet} results.',
      inputSchema: z.object({
        query: z.string().describe('Search query'),
        maxResults: z.number().optional().describe('Default 8, max 20'),
      }),
      execute: async ({ query, maxResults = 8 }) => {
        const r = await searchDuckDuckGo(query, maxResults)
        if ('error' in r) return r
        return r.results.length ? { results: r.results } : { results: [], note: 'No results parsed; try a different query.' }
      },
    }),

    FetchUrl: tool({
      description: 'Fetch a public web page and return its readable text (for reading a search result).',
      inputSchema: z.object({ url: z.string().describe('http(s) URL to read') }),
      execute: async ({ url }) => fetchReadable(url),
    }),

    ExtractDataText: tool({
      description: 'Extract structured JSON (to a JSON schema) from a block of text you already fetched.',
      inputSchema: z.object({
        text: z.string(),
        instruction: z.string(),
        schema: z.record(z.any()),
      }),
      execute: async ({ text, instruction, schema }) => {
        if (!deps.selected) return { error: 'No model configured.' }
        const model = createModel(deps.selected.provider, deps.selected.modelId)
        const prompt = `${instruction}\n\nText:\n${text.slice(0, 40_000)}`
        try {
          return { data: await extractStructured(model, prompt, schema as Record<string, unknown>) }
        } catch (err) {
          return { error: `Could not extract structured data (${err instanceof Error ? err.message : String(err)}).` }
        }
      },
    }),
  }
}
```

- [ ] **Step 3: TEMP gated preview tools in the foreground (for validation)**

In `src/tools/tools.ts`, add `import { searchDuckDuckGo, fetchReadable } from '../platform/webFetch'` and, inside `createAgentTools`'s `tools` object, add these two TEMP tools (a comment marks them for removal in Task 10):
```ts
    // TEMP (Task 6 live-validation only; removed in Task 10 when the ungated
    // research tools move into the offscreen sandbox). Gated so the invariant
    // "every foreground tool routes through requestApproval" holds at this commit.
    WebSearchPreview: tool({
      description: 'Search the web (DuckDuckGo) and return ranked {title,url,snippet} results. Asks permission first.',
      inputSchema: z.object({
        reason: z.string().describe('Short reason shown to the user, e.g. "To find the release notes"'),
        query: z.string().describe('Search query'),
      }),
      execute: async ({ reason, query }) => {
        const approved = await requestApproval({ toolName: 'WebSearchPreview', summary: `Search the web for “${query}”`, reason })
        if (!approved) return DENIED
        return searchDuckDuckGo(query)
      },
    }),
    FetchUrlPreview: tool({
      description: 'Fetch a public web page and return its readable text. Asks permission first.',
      inputSchema: z.object({
        reason: z.string().describe('Short reason shown to the user, e.g. "To read the top result"'),
        url: z.string().describe('http(s) URL to read'),
      }),
      execute: async ({ reason, url }) => {
        const approved = await requestApproval({ toolName: 'FetchUrlPreview', summary: `Fetch ${url}`, reason })
        if (!approved) return DENIED
        return fetchReadable(url)
      },
    }),
```

- [ ] **Step 4: Typecheck**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Manual verify (`/verify-extension`)**

1. Reload unpacked. In the panel ask: "Search the web for the Vercel AI SDK v5 release notes and read the top result."
2. Confirm `WebSearchPreview` returns rows and `FetchUrlPreview` returns readable text in the tool cards — each after its approval card.
3. Ask it to fetch `http://localhost` — confirm `FetchUrlPreview` returns the SSRF refusal, not a fetch.

- [ ] **Step 6: Commit**

```bash
git add src/platform/webFetch.ts src/tools/research.ts src/tools/tools.ts
git commit -m "feat: research tools + gated in-panel preview validation"
```

---

# Phase 3 — Background infrastructure

## Task 7: Research task types + persistence

**Files:**
- Create: `src/data/researchTasks.ts`

**Interfaces:**
- Produces:
  - `type ResearchStatus = 'running' | 'done' | 'error' | 'cancelled'`
  - `interface ResearchTask { id: string; question: string; status: ResearchStatus; steps: string[]; report?: string; sources?: { title: string; url: string }[]; error?: string; startedAt: number; updatedAt: number }`
  - Message types `ResearchMsg` (union) for SW↔offscreen↔panel.
  - `saveTask(t: ResearchTask): Promise<void>`, `getTask(id): Promise<ResearchTask | undefined>`, `listTasks(): Promise<ResearchTask[]>`, `applyUpdate(id, patch): Promise<ResearchTask | undefined>` — all `chrome.storage.local` (SW/panel only).

- [ ] **Step 1: Implement the module**

Create `src/data/researchTasks.ts`:
```ts
/** Persisted research-task state + the SW↔offscreen↔panel message protocol. Runs in SW/panel only (never offscreen). */
export type ResearchStatus = 'running' | 'done' | 'error' | 'cancelled'

export interface ResearchSource { title: string; url: string }

export interface ResearchTask {
  id: string
  question: string
  status: ResearchStatus
  steps: string[]
  report?: string
  sources?: ResearchSource[]
  error?: string
  startedAt: number
  updatedAt: number
}

export type ResearchMsg =
  | { type: 'research.ensureAndStart'; taskId: string; question: string }
  | { type: 'research.start'; taskId: string; question: string; providerConfig: unknown; modelId: string }
  | { type: 'research.update'; taskId: string; step: string }
  | { type: 'research.done'; taskId: string; report: string; sources: ResearchSource[] }
  | { type: 'research.error'; taskId: string; error: string }
  | { type: 'research.cancel'; taskId: string }

const KEY = 'researchTasks'

async function all(): Promise<Record<string, ResearchTask>> {
  const got = await chrome.storage.local.get(KEY)
  return (got[KEY] as Record<string, ResearchTask>) ?? {}
}

export async function saveTask(t: ResearchTask): Promise<void> {
  const map = await all()
  map[t.id] = t
  await chrome.storage.local.set({ [KEY]: map })
}

export async function getTask(id: string): Promise<ResearchTask | undefined> {
  return (await all())[id]
}

export async function listTasks(): Promise<ResearchTask[]> {
  return Object.values(await all()).sort((a, b) => b.startedAt - a.startedAt)
}

export async function applyUpdate(id: string, patch: Partial<ResearchTask>): Promise<ResearchTask | undefined> {
  const map = await all()
  const cur = map[id]
  if (!cur) return undefined
  const next = { ...cur, ...patch, updatedAt: Date.now() }
  map[id] = next
  await chrome.storage.local.set({ [KEY]: map })
  return next
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/data/researchTasks.ts
git commit -m "feat: research task state + message protocol + storage"
```

---

## Task 8: Offscreen document shell + manifest + Vite entry

**Files:**
- Modify: `public/manifest.json`
- Create: `offscreen.html`
- Modify: `vite.config.ts`
- Create: `src/background/offscreen.ts` (handshake only in this task)

**Interfaces:**
- Produces: an offscreen document that logs `research.start` receipt and replies `research.error` "not implemented" — proving the SW↔offscreen channel and lifecycle before the agent lands in Task 9/10.

- [ ] **Step 1: Manifest permissions**

In `public/manifest.json`, change the `permissions` array to include `"offscreen"` and `"notifications"`:
```json
"permissions": ["sidePanel", "storage", "scripting", "tabs", "alarms", "activeTab", "clipboardWrite", "favicon", "offscreen", "notifications"],
```

- [ ] **Step 2: Offscreen HTML shell**

Create `offscreen.html` (repo root):
```html
<!doctype html>
<html>
  <head><meta charset="utf-8" /></head>
  <body>
    <script type="module" src="/src/background/offscreen.ts"></script>
  </body>
</html>
```

- [ ] **Step 3: Vite entry**

In `vite.config.ts`, add to `rollupOptions.input`:
```ts
        offscreen: 'offscreen.html',
```

- [ ] **Step 4: Offscreen handshake module**

Create `src/background/offscreen.ts`:
```ts
// Offscreen document: the headless research host. Only chrome.runtime messaging
// + Web APIs are available here — NO chrome.storage/tabs/notifications.
import type { ResearchMsg } from '../data/researchTasks'

chrome.runtime.onMessage.addListener((msg: ResearchMsg) => {
  if (msg?.type === 'research.start') {
    // Task 10 replaces this with the real research loop.
    chrome.runtime.sendMessage({ type: 'research.error', taskId: msg.taskId, error: 'offscreen not implemented yet' } satisfies ResearchMsg)
  }
  if (msg?.type === 'research.cancel') { /* Task 10 */ }
})
console.info('[offscreen] research host loaded')
```

- [ ] **Step 5: Typecheck + build**

Run: `npm run build`
Expected: PASS; `dist/offscreen.html` + `dist/offscreen.js` produced.

- [ ] **Step 6: Commit**

```bash
git add public/manifest.json offscreen.html vite.config.ts src/background/offscreen.ts
git commit -m "feat: offscreen document shell + manifest offscreen/notifications perms"
```

---

## Task 9: Service-worker orchestration (locked singleton + persist + notify)

**Files:**
- Modify: `src/background.ts`

**Interfaces:**
- Consumes: `ResearchMsg`, `saveTask`, `applyUpdate`, `getTask`, `listTasks` (Task 7); the offscreen doc (Task 8).
- Produces: SW handling of `research.ensureAndStart` (create locked singleton offscreen doc, read settings, forward `research.start`), and persistence of `research.update`/`research.done`/`research.error` + a completion notification. Cancels via `research.cancel` passthrough.

- [ ] **Step 1: Add offscreen lifecycle + research handlers**

In `src/background.ts`, add:
```ts
import type { ResearchMsg, ResearchSource } from './data/researchTasks'
import { saveTask, applyUpdate } from './data/researchTasks'
import { loadSettings } from './data/settings' // adjust to the actual settings loader export

const OFFSCREEN_URL = 'offscreen.html'
const OFFSCREEN_LOCK = 'offscreenLock'

// Only one offscreen document may exist. Guard hasDocument() + a storage.session
// lock so concurrent starts cannot race two createDocument() calls.
async function ensureOffscreen(): Promise<void> {
  // @ts-ignore hasDocument exists at runtime
  if (await chrome.offscreen.hasDocument()) return
  const { [OFFSCREEN_LOCK]: locked } = await chrome.storage.session.get(OFFSCREEN_LOCK)
  if (locked) {
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100))
      // @ts-ignore
      if (await chrome.offscreen.hasDocument()) return
    }
  }
  await chrome.storage.session.set({ [OFFSCREEN_LOCK]: true })
  try {
    // @ts-ignore
    if (!(await chrome.offscreen.hasDocument())) {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ['DOM_PARSER' as chrome.offscreen.Reason],
        justification: 'Parse fetched HTML for background research.',
      })
    }
  } finally {
    await chrome.storage.session.set({ [OFFSCREEN_LOCK]: false })
  }
}

async function notifyDone(taskId: string, question: string): Promise<void> {
  const iconUrl = await researchIconDataUrl()
  chrome.notifications.create(`research-${taskId}`, {
    type: 'basic', iconUrl, title: 'Research complete',
    message: question.slice(0, 120), priority: 1,
  })
}

// No bundled icon files exist, so draw one at runtime (data URL) for the notification.
async function researchIconDataUrl(): Promise<string> {
  const c = new OffscreenCanvas(128, 128)
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#4f46e5'; ctx.fillRect(0, 0, 128, 128)
  ctx.fillStyle = '#fff'; ctx.font = 'bold 72px sans-serif'
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('R', 64, 70)
  const blob = await c.convertToBlob({ type: 'image/png' })
  return await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result as string); fr.readAsDataURL(blob) })
}

chrome.runtime.onMessage.addListener((msg: ResearchMsg) => {
  ;(async () => {
    if (msg?.type === 'research.ensureAndStart') {
      await saveTask({ id: msg.taskId, question: msg.question, status: 'running', steps: [], startedAt: Date.now(), updatedAt: Date.now() })
      await ensureOffscreen()
      const settings = await loadSettings()
      const provider = settings.providers.find((p) => p.id === settings.selectedProviderId) // adjust to real shape
      chrome.runtime.sendMessage({ type: 'research.start', taskId: msg.taskId, question: msg.question, providerConfig: provider, modelId: settings.selectedModelId } satisfies ResearchMsg)
    } else if (msg?.type === 'research.update') {
      const t = await applyUpdate(msg.taskId, {})
      await applyUpdate(msg.taskId, { steps: [...(t?.steps ?? []), msg.step] })
    } else if (msg?.type === 'research.done') {
      const t = await applyUpdate(msg.taskId, { status: 'done', report: msg.report, sources: msg.sources as ResearchSource[] })
      if (t) await notifyDone(msg.taskId, t.question)
    } else if (msg?.type === 'research.error') {
      await applyUpdate(msg.taskId, { status: 'error', error: msg.error })
    }
  })()
  return true
})
```
**Note for the implementer:** the settings-loader import (`loadSettings`, `settings.providers`, `settings.selectedProviderId`, `settings.selectedModelId`) is a placeholder for the real API in `src/data/settings.ts` — open that file and use its actual exported loader + field names before running. This is the one spot that must be reconciled with existing code.

- [ ] **Step 2: Typecheck**

Run: `npm run build`
Expected: PASS after the settings API is reconciled.

- [ ] **Step 3: Manual verify (`/verify-extension`)**

1. Reload unpacked. Open the SW console (`chrome://extensions` → service worker → Inspect).
2. From the panel console (or a temporary button) run `chrome.runtime.sendMessage({type:'research.ensureAndStart',taskId:'t1',question:'ping'})`.
3. Confirm: offscreen doc appears (SW logs "research host loaded"), a `research.error` "not implemented" round-trips, and `chrome.storage.local` `researchTasks.t1.status` becomes `error`. This proves the full channel + persistence before the agent lands.

- [ ] **Step 4: Commit**

```bash
git add src/background.ts
git commit -m "feat: SW orchestration for background research (locked offscreen, persist, notify)"
```

---

## Task 10: Research agent loop (offscreen) + gated `StartResearch` tool

**Files:**
- Create: `src/agent/research.ts`
- Modify: `src/background/offscreen.ts` (real loop)
- Modify: `src/tools/research.ts` (drop the foreground gate note; add `StartResearch`)
- Modify: `src/tools/tools.ts` (remove the TEMP `Object.assign`; register gated `StartResearch`)

**Interfaces:**
- Consumes: `createResearchTools` (Task 6), `createModel`, `runAgentTurn` (`src/agent/agent.ts`), `ResearchMsg` (Task 7).
- Produces: `runResearch(opts: { taskId: string; question: string; provider: ProviderConfig; modelId: string; onStep: (s: string) => void; signal: AbortSignal }): Promise<{ report: string; sources: ResearchSource[] }>`.
- Produces: `StartResearch` tool `{ question: string }` (foreground, gated) → dispatches `research.ensureAndStart`, returns `{ started: true, taskId }`.

- [ ] **Step 1: Research agent core**

Create `src/agent/research.ts`:
```ts
import { runAgentTurn } from './agent'
import { createModel } from './provider'
import { createResearchTools } from '../tools/research'
import type { ProviderConfig } from '../data/settings'
import type { ResearchSource } from '../data/researchTasks'

const RESEARCH_SYSTEM = `You are a research agent running in the background. Answer the user's question by:
1. Planning sub-questions. 2. WebSearch for each. 3. FetchUrl the most relevant results and read them.
4. Optionally ExtractDataText for structured facts. 5. Synthesize a well-structured Markdown report.
Cite every claim inline as [n] and end with a "Sources" list of [n] Title — URL for each URL you actually read.
Be efficient: at most ~8 searches and ~12 fetches. If a source fails, move on.`

/** Run one background research task to completion. Headless: no tabs, no user data. */
export async function runResearch(opts: {
  taskId: string
  question: string
  provider: ProviderConfig
  modelId: string
  onStep: (s: string) => void
  signal: AbortSignal
}): Promise<{ report: string; sources: ResearchSource[] }> {
  const model = createModel(opts.provider, opts.modelId)
  const tools = createResearchTools({ selected: { provider: opts.provider, modelId: opts.modelId } })
  const sources: ResearchSource[] = []
  const result = await runAgentTurn({
    model,
    system: RESEARCH_SYSTEM,
    history: [{ role: 'user', content: opts.question }],
    tools,
    abortSignal: opts.signal,
    onUpdate: (parts) => {
      const last = parts[parts.length - 1]
      if (last?.type === 'tool') opts.onStep(`${last.toolName}: ${JSON.stringify(last.input).slice(0, 120)}`)
      // Collect sources from successful FetchUrl results.
      for (const p of parts) {
        if (p.type === 'tool' && p.toolName === 'FetchUrl' && p.state === 'done' && p.output && typeof p.output === 'object') {
          const o = p.output as { url?: string; title?: string; error?: string }
          if (o.url && !o.error && !sources.some((s) => s.url === o.url)) sources.push({ url: o.url, title: o.title ?? o.url })
        }
      }
    },
  })
  const report = result.parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('')
  return { report, sources }
}
```

- [ ] **Step 2: Wire the real loop into the offscreen doc**

Replace the body of `src/background/offscreen.ts`:
```ts
import type { ResearchMsg } from '../data/researchTasks'
import { runResearch } from '../agent/research'
import type { ProviderConfig } from '../data/settings'

const running = new Map<string, AbortController>()

chrome.runtime.onMessage.addListener((msg: ResearchMsg) => {
  if (msg?.type === 'research.start') {
    const ctrl = new AbortController()
    running.set(msg.taskId, ctrl)
    runResearch({
      taskId: msg.taskId,
      question: msg.question,
      provider: msg.providerConfig as ProviderConfig,
      modelId: msg.modelId,
      signal: ctrl.signal,
      onStep: (step) => chrome.runtime.sendMessage({ type: 'research.update', taskId: msg.taskId, step } satisfies ResearchMsg),
    })
      .then(({ report, sources }) => chrome.runtime.sendMessage({ type: 'research.done', taskId: msg.taskId, report, sources } satisfies ResearchMsg))
      .catch((err) => chrome.runtime.sendMessage({ type: 'research.error', taskId: msg.taskId, error: err instanceof Error ? err.message : String(err) } satisfies ResearchMsg))
      .finally(() => running.delete(msg.taskId))
  } else if (msg?.type === 'research.cancel') {
    running.get(msg.taskId)?.abort()
    running.delete(msg.taskId)
  }
})
console.info('[offscreen] research host loaded')
```

- [ ] **Step 3: Add the gated `StartResearch` tool + remove the TEMP wiring**

In `src/tools/research.ts` add an exported factory that needs the approval gate:
```ts
import type { ApprovalGate } from './tools'
// (add crypto-free id: use the taskId passed by caller instead of Math.random in workflow contexts)

export function createStartResearchTool(requestApproval: ApprovalGate): ToolSet {
  return {
    StartResearch: tool({
      description: 'Launch a background research task (web search + read + synthesize a cited report). It runs even if the side panel is closed and notifies on completion. Asks permission first.',
      inputSchema: z.object({ question: z.string().describe('The research question to investigate.') }),
      execute: async ({ question }) => {
        const approved = await requestApproval({ toolName: 'StartResearch', summary: 'Run background research', reason: question })
        if (!approved) return { denied: true, message: 'The user denied permission for this tool call.' }
        const taskId = `r-${Date.now()}-${Math.floor(performance.now())}`
        chrome.runtime.sendMessage({ type: 'research.ensureAndStart', taskId, question })
        return { started: true, taskId, note: 'Research is running in the background; results will appear in the panel and a notification when done.' }
      },
    }),
  }
}
```
In `src/tools/tools.ts`: remove the TEMP `Object.assign(tools, createResearchTools(...))` line from Task 6, and instead add `Object.assign(tools, createStartResearchTool(requestApproval))`; update the import to `createStartResearchTool`.

- [ ] **Step 4: Typecheck**

Run: `npm run build`
Expected: PASS. (`ApprovalGate` is already exported from `tools.ts`; if a circular import arises, move `ApprovalGate`/`ApprovalRequest` into a tiny `src/tools/approval.ts` and import from there in both files.)

- [ ] **Step 5: Manual verify (`/verify-extension`)**

1. Reload unpacked. Ask: "Research the current best practices for MV3 offscreen documents and write me a short cited report."
2. Approve the `StartResearch` card. Confirm the tool returns `started:true`.
3. Watch the SW console: `research.update` steps stream; on completion a **notification** fires.
4. Inspect `chrome.storage.local` `researchTasks` — the task has `status:'done'`, a `report`, and `sources`.
5. **Close the panel mid-run** on a second task; confirm the notification still fires and the report is persisted.

- [ ] **Step 6: Commit**

```bash
git add src/agent/research.ts src/background/offscreen.ts src/tools/research.ts src/tools/tools.ts
git commit -m "feat: background research agent loop + gated StartResearch tool"
```

---

## Task 11: ResearchTask live card in the panel

**Files:**
- Modify: `src/ui/Chat.tsx`

**Interfaces:**
- Consumes: `ResearchMsg`, `listTasks`, `getTask` (Task 7).
- Produces: a live-updating research card in the transcript: shows streaming steps while `running`, then the rendered Markdown report + source favicons on `done`; reads persisted tasks on mount (so a task finished while closed still shows).

- [ ] **Step 1: Add a runtime message listener + task state**

In `src/ui/Chat.tsx`, add (inside the component):
```ts
const [researchTasks, setResearchTasks] = useState<ResearchTask[]>([])

useEffect(() => {
  listTasks().then(setResearchTasks) // show tasks that finished while the panel was closed
  const onMsg = (msg: ResearchMsg) => {
    if (msg?.type?.startsWith('research.')) listTasks().then(setResearchTasks)
  }
  chrome.runtime.onMessage.addListener(onMsg)
  return () => chrome.runtime.onMessage.removeListener(onMsg)
}, [])
```
with imports `import { listTasks, type ResearchTask, type ResearchMsg } from '../data/researchTasks'` and `useEffect, useState` if not present.

- [ ] **Step 2: Render the cards**

Add near the transcript render (reuse the existing `Markdown` component for the report):
```tsx
{researchTasks.map((t) => (
  <div key={t.id} className="research-card">
    <div className="research-card__head">🔎 {t.question} · {t.status}</div>
    {t.status === 'running' && (
      <ul className="research-card__steps">{t.steps.slice(-6).map((s, i) => <li key={i}>{s}</li>)}</ul>
    )}
    {t.report && <Markdown text={t.report} />}
    {t.sources?.length ? (
      <div className="research-card__sources">{t.sources.map((s) => <a key={s.url} href={s.url} target="_blank" rel="noreferrer">{s.title}</a>)}</div>
    ) : null}
    {t.error && <div className="research-card__error">{t.error}</div>}
  </div>
))}
```

- [ ] **Step 3: Minimal styles**

In `src/ui/styles.css`, add basic `.research-card` styling (border, padding, `.research-card__steps` muted/monospace, `.research-card__error` red). Match existing card styles.

- [ ] **Step 4: Typecheck + build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Manual verify (`/verify-extension`)**

1. Reload unpacked. Start a research task; confirm the card streams steps live, then renders the Markdown report + clickable sources.
2. Start a task, close & reopen the panel; confirm the finished card is present on reopen (loaded from storage).

- [ ] **Step 6: Commit**

```bash
git add src/ui/Chat.tsx src/ui/styles.css
git commit -m "feat: live research task card in the side panel"
```

---

# Phase 4 — Form autofill from profile memory [#7]

## Task 12: `profile` memory kind

**Files:**
- Modify: `src/data/memory.ts`
- Modify: `src/tools/tools.ts` (`SaveMemory` kind enum)

**Interfaces:**
- Produces: memory `kind` accepts `'profile'`; a `getProfileMemories(): Promise<Memory[]>` helper returning `kind==='profile'` entries.

- [ ] **Step 1: Extend the kind union**

In `src/data/memory.ts`, add `'profile'` to the memory `kind` type/union wherever `fact | preference | project | summary` is declared, and add:
```ts
/** Memories the user has marked as reusable profile fields (name, email, address…) for form autofill. */
export async function getProfileMemories(): Promise<Memory[]> {
  return (await getAllMemories()).filter((m) => m.kind === 'profile')
}
```
(Use the existing all-memories accessor name in this file.)

- [ ] **Step 2: Allow `profile` in `SaveMemory`**

In `src/tools/tools.ts`, in the `SaveMemory` `inputSchema`, extend the `kind` enum to include `'profile'` and update its `.describe(...)`: `profile: a reusable personal detail for filling forms (name, email, address)`.

- [ ] **Step 3: Typecheck**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Manual verify**

Ask the agent: "Remember my shipping email is test@example.com as a profile detail." Approve `SaveMemory`; confirm it saves with `kind:'profile'` (check the Memory panel / IndexedDB).

- [ ] **Step 5: Commit**

```bash
git add src/data/memory.ts src/tools/tools.ts
git commit -m "feat: add 'profile' memory kind for form autofill"
```

---

## Task 13: `AutofillForm` tool

**Files:**
- Modify: `src/tools/tools.ts`

**Interfaces:**
- Consumes: `getProfileMemories` (Task 12); the open `ControlSession` + `snapshotPage` + `runControlStep` + `isPointOfNoReturn` (existing).
- Produces: `AutofillForm` tool: within an open control session, fills mapped non-sensitive fields; sensitive fields + submit continue to raise the point-of-no-return card.

- [ ] **Step 1: Register the tool**

In `src/tools/tools.ts`, add `import { getProfileMemories } from '../data/memory'` and inside `createAgentTools`:
```ts
    AutofillForm: tool({
      description:
        'Fill the form on the active tab from the user\'s saved profile memories, within an open page-control session. Maps profile details (name, email, address…) to the indexed fields you pass. Sensitive fields (passwords, payment) and any submit still ask each time. Never invents secrets.',
      inputSchema: z.object({
        fields: z.array(z.object({
          index: z.number().describe('Target field [index] from InspectPage.'),
          value: z.string().describe('The value to enter (you map this from profile memories).'),
          sensitive: z.boolean().optional().describe('True for passwords/payment; forces a confirm and is skipped if not user-provided.'),
        })).describe('The fields to fill and the values to enter.'),
      }),
      execute: async ({ fields }) => {
        const session = pageControl.session()
        if (!session || !session.active) return { error: 'No page-control session is open. Call RequestPageControl first.' }
        const tab = await getActiveTab()
        if (tab?.id === undefined || tab.id !== session.tabId) return { error: 'The controlled tab is no longer active.' }
        const profile = await getProfileMemories()
        const filled: number[] = []
        for (const f of fields) {
          if (session.actionsUsed >= session.maxActions) break
          let snap
          try { snap = await snapshotPage(tab.id) } catch { return { error: 'Cannot read this page.' } }
          const el = snap.elements[f.index]
          const spec: ControlSpec = { action: 'type', index: f.index, text: f.value, clear: true, sensitive: f.sensitive }
          if (isPointOfNoReturn(spec, el, session.origin)) {
            const approved = await requestApproval({ toolName: 'AutofillForm', summary: `Fill a sensitive field (${el?.name ?? f.index})`, reason: 'This field is sensitive.', once: true })
            if (!approved) continue
          }
          session.actionsUsed += 1
          await runControlStep({
            tabId: tab.id, spec, snapshot: snap,
            beforeAct: (i) => (i === undefined ? Promise.resolve() : focusOn(tab.id!, i, undefined)),
            afterAct: () => pulse(tab.id!),
          })
          filled.push(f.index)
        }
        return { filled, note: `Filled ${filled.length} field(s) from profile. Profile memories available: ${profile.length}. Submit is a separate, confirmed step.` }
      },
    }),
```

- [ ] **Step 2: Typecheck**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Manual verify (`/verify-extension`)**

1. Save a couple of `profile` memories (name, email). Reload unpacked.
2. Open a page with a simple form. Ask: "Fill this form with my profile details, but don't submit."
3. Confirm: `RequestPageControl` card → session opens; non-sensitive fields fill with the presence cursor; a sensitive field (e.g. password) raises the one-shot confirm; no submit happens without its own card.

- [ ] **Step 4: Commit**

```bash
git add src/tools/tools.ts
git commit -m "feat: AutofillForm tool (fill forms from profile memory, sensitive gated)"
```

---

## Self-Review (completed during authoring)

- **Spec coverage:** #1 → Tasks 5–6, 10; #3 → Tasks 4, 5(ExtractDataText), 6; #5 → Tasks 7–11; #7 → Tasks 12–13; #8 → Tasks 2–3. Hardening (SSRF, `credentials:'omit'`, offscreen lock, data-URL notification icon, no-`chrome.storage`-in-offscreen, no-eval schema, broadcast transport) each mapped to a specific task. ✅
- **Two reconciliation points flagged inline** (not placeholders — they require reading existing code): (a) the `src/data/settings.ts` loader shape used in Task 9; (b) the memory accessor name in Task 12. Both name the exact file to open.
- **Type consistency:** `ResearchMsg`, `ResearchTask`, `ResearchSource` defined once (Task 7) and consumed by identical names in Tasks 8–11. `runResearch`, `createResearchTools`, `createStartResearchTool`, `waitForStable`, `ControlSpec.timeoutMs` used consistently.
- **YAGNI honored:** no paid search API, no dedicated profile store, no multi-page crawl tool, no store metadata.
```