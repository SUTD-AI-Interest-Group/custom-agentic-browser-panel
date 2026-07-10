# Browser-Use / Page Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the agent an autonomous "browser-use" capability — read, click, fill, select, scroll, highlight, and navigate the active tab — behind a scoped human-in-the-loop session grant, presented on-page with a tint + gliding cursor + spotlight overlay.

**Architecture:** One indexed-DOM element registry (built by injected `chrome.scripting.executeScript` functions, stamped with `data-agent-idx` so it survives across stateless injections) is the single source of truth. It is rendered to the model as text, or as a numbered set-of-marks screenshot when a runtime probe finds the model is vision-capable. Three tools (`RequestPageControl` / `InspectPage` / `ControlPage`) drive a small action loop governed by a per-task `ControlSession` (20-action budget, origin fence, point-of-no-return cards). A persistent presence overlay choreographs each action.

**Tech Stack:** TypeScript (strict), React 18, Vite 6, Vercel AI SDK v5, Chrome MV3 (`chrome.scripting`, `chrome.tabs`, canvas). No backend.

**Design spec:** `docs/superpowers/specs/2026-07-10-browser-use-page-control-design.md` — read it before starting.

## Global Constraints

- **No test suite exists.** Verify every task with `npm run build` (runs `tsc --noEmit` first, so it fails fast on type errors) plus the manual exercise each task specifies. Reload the unpacked extension at `chrome://extensions` after each build to exercise runtime behavior. (Source: `CLAUDE.md` → "Verifying a change".)
- **Code style (convention-only, match by hand):** no semicolons (ASI), single quotes, 2-space indent, `interface` for object shapes / `type` for unions, `/** ... */` on exported types & functions.
- **Architecture invariant:** every state-mutating tool must route through the human-in-the-loop gate (`requestApproval` or the new session gate) before its `execute()` proceeds. No exceptions.
- **No new manifest permissions.** `scripting`, `tabs`, `activeTab`, `<all_urls>` already cover this feature. Do not add `debugger`.
- **Injected functions must be fully self-contained** — they are serialized by `chrome.scripting.executeScript` and run in the page's isolated world. No imports, no closures over module scope. (Pattern: `extractPageContent` in `src/platform/tabs.ts:44`, `selectRegionInPage` in `src/platform/capture.ts:93`.)
- **Git:** commit directly to `main` after each task. Do NOT add any `Co-Authored-By` or "Generated with" trailer to commits.
- **Action budget = 20. Presence tint = `rgba(20,22,30,0.22)`. Cursor glide = 450ms. `MAX_STEPS` = 24.** (Exact values from the spec.)

---

### Task 1: Element registry — DOM indexer (`src/platform/domIndex.ts`)

Builds the perception substrate: an injected function that walks the DOM, filters to visible interactive elements, stamps each with `data-agent-idx`, and returns a structured registry the model can read. Also the cleanup injection and the text serializer.

**Files:**
- Create: `src/platform/domIndex.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces:
  - `interface IndexedElement { index: number; tag: string; role?: string; name: string; type?: string; value?: string; rect: { x: number; y: number; width: number; height: number }; sensitive: boolean }`
  - `interface PageSnapshot { url: string; title: string; origin: string; dpr: number; elements: IndexedElement[]; text: string; truncated: boolean }`
  - `snapshotPage(tabId: number): Promise<PageSnapshot>` — injects the indexer, serializes to text.
  - `clearIndex(tabId: number): Promise<void>` — removes all `data-agent-idx` attributes.

- [ ] **Step 1: Write the module.**

Create `src/platform/domIndex.ts`. The injected `buildInteractiveIndex` is self-contained (mirrors the style of `selectRegionInPage`). It returns raw element data; the side-panel side serializes it.

```ts
// Indexed-DOM perception. An injected walker finds visible interactive
// elements, stamps each with data-agent-idx (so a later, separate injection
// can re-find it — chrome.scripting calls share no JS state, only the DOM),
// and returns a registry the agent reads as text or as set-of-marks.

/** One interactive element the agent can act on, addressed by `index`. */
export interface IndexedElement {
  index: number
  tag: string
  role?: string
  /** Accessible name: aria-label | visible text | placeholder | value. */
  name: string
  type?: string
  value?: string
  /** Viewport rect in CSS pixels. */
  rect: { x: number; y: number; width: number; height: number }
  /** Password/payment-like field — forces an approval card even in a session. */
  sensitive: boolean
}

/** A full read of the current page: the registry plus a compact text form. */
export interface PageSnapshot {
  url: string
  title: string
  origin: string
  dpr: number
  elements: IndexedElement[]
  text: string
  truncated: boolean
}

const MAX_ELEMENTS = 200
const ATTR = 'data-agent-idx'

// Runs inside the target page. Fully self-contained (serialized by
// executeScript). Returns raw element records + page meta.
function buildInteractiveIndex(attr: string, maxElements: number) {
  const SENSITIVE_RE = /card|cvv|ccv|ssn|passw/i
  const INTERACTIVE_TAGS = /^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/
  const INTERACTIVE_ROLES =
    /^(button|link|checkbox|radio|tab|menuitem|switch|option|combobox|textbox)$/
  const vw = window.innerWidth
  const vh = window.innerHeight

  const isVisible = (el: Element): boolean => {
    const r = el.getBoundingClientRect()
    if (r.width < 4 || r.height < 4) return false
    if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) return false
    const s = getComputedStyle(el)
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0)
      return false
    // Topmost at its center — drops occluded elements. Our overlay is
    // pointer-events:none, so it never wins this hit-test.
    const cx = Math.min(vw - 1, Math.max(0, r.left + r.width / 2))
    const cy = Math.min(vh - 1, Math.max(0, r.top + r.height / 2))
    const top = document.elementFromPoint(cx, cy)
    return !!top && (el === top || el.contains(top) || top.contains(el))
  }

  const isInteractive = (el: Element): boolean => {
    const tag = el.tagName
    if (INTERACTIVE_TAGS.test(tag)) return true
    const role = el.getAttribute('role') ?? ''
    if (INTERACTIVE_ROLES.test(role)) return true
    if ((el as HTMLElement).isContentEditable) return true
    if (el.hasAttribute('onclick')) return true
    if (getComputedStyle(el).cursor === 'pointer' && (el as HTMLElement).offsetParent !== null)
      return true
    return false
  }

  const accessibleName = (el: Element): string => {
    const aria = el.getAttribute('aria-label')
    if (aria) return aria.trim()
    const ph = el.getAttribute('placeholder')
    const input = el as HTMLInputElement
    const text = (el as HTMLElement).innerText?.trim() || ''
    return (text || ph || input.value || el.getAttribute('title') || el.getAttribute('name') || '')
      .toString()
      .slice(0, 120)
  }

  // Clear any stamps from a previous snapshot before re-indexing.
  document.querySelectorAll(`[${attr}]`).forEach((n) => n.removeAttribute(attr))

  const out: Array<{
    index: number
    tag: string
    role?: string
    name: string
    type?: string
    value?: string
    rect: { x: number; y: number; width: number; height: number }
    sensitive: boolean
  }> = []
  const all = Array.from(document.querySelectorAll('*'))
  let index = 0
  for (const el of all) {
    if (out.length >= maxElements) break
    if (!isInteractive(el) || !isVisible(el)) continue
    const r = el.getBoundingClientRect()
    const input = el as HTMLInputElement
    const type = input.type || undefined
    const nameId = `${el.getAttribute('name') ?? ''} ${el.id ?? ''}`
    const sensitive =
      type === 'password' ||
      /^cc-|^cc-number|cc-csc/i.test(el.getAttribute('autocomplete') ?? '') ||
      SENSITIVE_RE.test(nameId)
    el.setAttribute(attr, String(index))
    out.push({
      index,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') ?? undefined,
      name: accessibleName(el),
      type,
      value: input.value ? String(input.value).slice(0, 80) : undefined,
      rect: { x: r.left, y: r.top, width: r.width, height: r.height },
      sensitive,
    })
    index++
  }
  return {
    url: location.href,
    title: document.title,
    origin: location.origin,
    dpr: window.devicePixelRatio || 1,
    elements: out,
    total: index,
  }
}

// Runs inside the page: strip all stamps.
function clearAgentIndex(attr: string) {
  document.querySelectorAll(`[${attr}]`).forEach((n) => n.removeAttribute(attr))
}

/** Serialize the registry to the compact text the model reads. */
export function serializeRegistry(elements: IndexedElement[]): string {
  if (elements.length === 0) return '(no interactive elements found)'
  return elements
    .map((e) => {
      const attrs = [
        e.type && e.type !== 'text' ? e.type : '',
        e.name ? `"${e.name}"` : '',
        e.value ? `= "${e.value}"` : '',
        e.sensitive ? '(sensitive)' : '',
      ]
        .filter(Boolean)
        .join(' ')
      return `[${e.index}]<${e.tag}${e.role ? ` role=${e.role}` : ''}> ${attrs}`.trimEnd()
    })
    .join('\n')
}

/** Inject the indexer, returning the current page registry + text form. */
export async function snapshotPage(tabId: number): Promise<PageSnapshot> {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: buildInteractiveIndex,
    args: [ATTR, MAX_ELEMENTS],
  })
  const raw = res?.result
  if (!raw) throw new Error('Could not read the page.')
  const elements = raw.elements as IndexedElement[]
  const truncated = raw.total >= MAX_ELEMENTS
  return {
    url: raw.url,
    title: raw.title,
    origin: raw.origin,
    dpr: raw.dpr,
    elements,
    text: serializeRegistry(elements) + (truncated ? '\n[element list truncated]' : ''),
    truncated,
  }
}

/** Remove all agent index stamps from the page. */
export async function clearIndex(tabId: number): Promise<void> {
  await chrome.scripting
    .executeScript({ target: { tabId }, func: clearAgentIndex, args: [ATTR] })
    .catch(() => {})
}
```

- [ ] **Step 2: Build.**

Run: `npm run build`
Expected: PASS (no type errors, `dist/` written).

- [ ] **Step 3: Manual verification (console-paste).**

Open any content-rich page with a form (e.g. `https://httpbin.org/forms/post`) in Chrome. Open its DevTools → Console. Paste the **body** of `buildInteractiveIndex` as an IIFE with the args inlined:

```js
(function () {
  const attr = 'data-agent-idx', maxElements = 200
  /* … paste the function body here … */
})()
```

Expected: returns an object whose `elements` array lists the form's inputs and the submit button, each with an `index`, a sensible `name`, a `rect`, and `sensitive:false` (or `true` if you test on a login page's password field). Confirm the page's DOM now has `data-agent-idx="0"`, `"1"`, … on those elements (inspect in Elements panel).

- [ ] **Step 4: Commit.**

```bash
git add src/platform/domIndex.ts
git commit -m "Add indexed-DOM page snapshot for agent perception"
```

---

### Task 2: InspectPage tool (text-only) + gate interface + step bump

First end-to-end checkpoint: wire the registry into a read-only tool the agent can call, so "what's on this page?" works. Also introduces the `PageControlGate` interface (stubbed in Chat for now) and bumps the agent step cap. Set-of-marks/vision come later (Task 6); this returns text only.

**Files:**
- Modify: `src/tools/tools.ts` (add `PageControlGate` interface + `InspectPage` tool; change `createAgentTools` signature)
- Modify: `src/agent/agent.ts:40` (`MAX_STEPS` 10 → 24)
- Modify: `src/ui/Chat.tsx:488` (pass a stub gate into `createAgentTools`)

**Interfaces:**
- Consumes: `snapshotPage` (Task 1); `requestApproval`/`ApprovalGate` (`src/tools/tools.ts:28`).
- Produces:
  - `interface ControlSession { tabId: number; origin: string; plan: string; actionsUsed: number; maxActions: number; active: boolean }` (exported from `tools.ts` for now; Task 4 moves it to `pageControl.ts`).
  - `interface PageControlGate { requestSession(input: { plan: string; host: string; tabId: number }): Promise<boolean>; session(): ControlSession | null; endSession(): void }`
  - `createAgentTools(requestApproval: ApprovalGate, pageControl: PageControlGate, tabAccess: TabAccess): ToolSet`

- [ ] **Step 1: Bump the step cap.**

In `src/agent/agent.ts`, change line 40:

```ts
const MAX_STEPS = 24
```

- [ ] **Step 2: Add the gate interface + InspectPage tool.**

In `src/tools/tools.ts`, add imports and types near the top (after the existing imports):

```ts
import { getActiveTab, listOpenTabs, readTabContent } from '../platform/tabs'
import { snapshotPage } from '../platform/domIndex'

/** A per-task grant to control one tab. Origin-fenced and action-budgeted. */
export interface ControlSession {
  tabId: number
  origin: string
  plan: string
  actionsUsed: number
  maxActions: number
  active: boolean
}

/** Human-in-the-loop gate for page control, implemented by the chat UI. */
export interface PageControlGate {
  /** Show the session card with the plan; resolve true if the user allows. */
  requestSession(input: { plan: string; host: string; tabId: number }): Promise<boolean>
  /** The currently open session, or null. */
  session(): ControlSession | null
  /** Close the session and tear down any on-page overlay. */
  endSession(): void
}
```

Change the signature:

```ts
export function createAgentTools(
  requestApproval: ApprovalGate,
  pageControl: PageControlGate,
  tabAccess: TabAccess,
): ToolSet {
```

Add the `InspectPage` tool inside `tools` (alongside `ViewCurrentTab`). Standalone it asks like `ViewCurrentTab`; inside an open session it is free:

```ts
    InspectPage: tool({
      description:
        'Read the active tab as a numbered list of interactive elements (buttons, links, inputs) the agent can act on, each with an [index]. Use before controlling a page, or to re-read after it changes. Asks permission unless a page-control session is already open.',
      inputSchema: z.object({
        reason: z
          .string()
          .describe('Short reason shown to the user, e.g. "To find the search box"'),
      }),
      execute: async ({ reason }) => {
        const tab = await getActiveTab()
        if (tab?.id === undefined) return { error: 'No active tab found.' }
        const open = pageControl.session()
        if (!open || !open.active) {
          const approved = await requestApproval({
            toolName: 'InspectPage',
            summary: 'Read the interactive elements on this page',
            reason,
          })
          if (!approved) return DENIED
        }
        try {
          const snap = await snapshotPage(tab.id)
          return { url: snap.url, title: snap.title, elements: snap.text }
        } catch (err) {
          return { error: `Cannot read this page (${err instanceof Error ? err.message : String(err)}).` }
        }
      },
    }),
```

- [ ] **Step 3: Thread a stub gate through Chat.**

In `src/ui/Chat.tsx`, import the type and add a stub near the other refs (a real implementation lands in Task 4):

```ts
import { createAgentTools, type ApprovalRequest, type PageControlGate } from '../tools/tools'
```

Add above `send()` (near `requestApproval`, line 253):

```ts
  // Stubbed until Task 4 wires the real session gate. Denies control sessions
  // so only read-only tools work for now.
  const pageControl: PageControlGate = {
    requestSession: async () => false,
    session: () => null,
    endSession: () => {},
  }
```

Update the `createAgentTools` call (line 488):

```ts
        tools: createAgentTools(requestApproval, pageControl, settings.tabAccess),
```

- [ ] **Step 4: Build.**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Manual verification (end-to-end).**

Reload the unpacked extension. Open a page with buttons/inputs, open the side panel, and ask: *"List the interactive elements you can see on this page."* Expected: the agent calls `InspectPage`, a permission card appears ("Read the interactive elements on this page"), and on Allow it replies with the numbered `[index]<tag> "name"` list. Deny → it says it was denied.

- [ ] **Step 6: Commit.**

```bash
git add src/tools/tools.ts src/agent/agent.ts src/ui/Chat.tsx
git commit -m "Add InspectPage tool and page-control gate interface"
```

---

### Task 3: Page actions — DOM executors (`src/platform/pageActions.ts`)

The real mutations: click, type (with the native-value-setter trick so React/Vue controlled inputs update), select, scroll, press, navigate. Each resolves the target by `data-agent-idx`. No presence yet (Task 5 wraps these).

**Files:**
- Create: `src/platform/pageActions.ts`

**Interfaces:**
- Consumes: nothing at runtime (resolves elements by the `data-agent-idx` stamped in Task 1).
- Produces:
  - `interface ActionResult { ok: boolean; message: string; urlChanged?: boolean }`
  - `clickElement(tabId: number, index: number): Promise<ActionResult>`
  - `typeIntoElement(tabId: number, index: number, text: string, clear: boolean): Promise<ActionResult>`
  - `selectOption(tabId: number, index: number, value: string): Promise<ActionResult>`
  - `scrollPage(tabId: number, opts: { direction: 'up' | 'down' | 'toElement'; index?: number }): Promise<ActionResult>`
  - `pressKey(tabId: number, keys: string): Promise<ActionResult>`
  - `navigateTab(tabId: number, url: string): Promise<ActionResult>`

- [ ] **Step 1: Write the module.**

Create `src/platform/pageActions.ts`. Each injected function finds `[data-agent-idx="N"]` and acts.

```ts
// Real DOM mutations, dispatched by injecting self-contained functions that
// re-find the target via its data-agent-idx stamp. Text entry uses the native
// value setter so React/Vue controlled inputs actually re-render.

const ATTR = 'data-agent-idx'

/** Outcome of one page action, fed back to the model. */
export interface ActionResult {
  ok: boolean
  message: string
  urlChanged?: boolean
}

function findByIdx(attr: string, index: number): Element | null {
  return document.querySelector(`[${attr}="${index}"]`)
}

function injClick(attr: string, index: number) {
  const el = document.querySelector(`[${attr}="${index}"]`) as HTMLElement | null
  if (!el) return { ok: false, message: `element ${index} is no longer on the page` }
  el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior })
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  el.click()
  return { ok: true, message: `clicked element ${index}` }
}

function injType(attr: string, index: number, text: string, clear: boolean) {
  const el = document.querySelector(`[${attr}="${index}"]`) as HTMLElement | null
  if (!el) return { ok: false, message: `element ${index} is no longer on the page` }
  el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior })
  ;(el as HTMLElement).focus()
  if ((el as HTMLElement).isContentEditable) {
    if (clear) el.textContent = ''
    el.textContent = (el.textContent ?? '') + text
    el.dispatchEvent(new InputEvent('input', { bubbles: true }))
    return { ok: true, message: `typed into element ${index}` }
  }
  const input = el as HTMLInputElement
  const proto =
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  const next = clear ? text : (input.value ?? '') + text
  if (setter) setter.call(input, next)
  else input.value = next
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
  return { ok: true, message: `typed into element ${index}` }
}

function injSelect(attr: string, index: number, value: string) {
  const el = document.querySelector(`[${attr}="${index}"]`) as HTMLSelectElement | null
  if (!el) return { ok: false, message: `element ${index} is no longer on the page` }
  const opt = Array.from(el.options).find(
    (o) => o.value === value || o.text.trim() === value.trim(),
  )
  if (!opt) return { ok: false, message: `no option matching "${value}" in element ${index}` }
  el.value = opt.value
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return { ok: true, message: `selected "${opt.text.trim()}" in element ${index}` }
}

function injScroll(attr: string, direction: string, index: number) {
  if (direction === 'toElement') {
    const el = document.querySelector(`[${attr}="${index}"]`)
    if (!el) return { ok: false, message: `element ${index} is no longer on the page` }
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    return { ok: true, message: `scrolled to element ${index}` }
  }
  window.scrollBy({ top: (direction === 'up' ? -1 : 1) * window.innerHeight * 0.8, behavior: 'smooth' })
  return { ok: true, message: `scrolled ${direction}` }
}

function injPress(keys: string) {
  const el = (document.activeElement as HTMLElement) ?? document.body
  for (const opts of [{}, {}]) void opts
  const fire = (type: string) =>
    el.dispatchEvent(
      new KeyboardEvent(type, { key: keys, bubbles: true, cancelable: true }),
    )
  fire('keydown')
  fire('keyup')
  return { ok: true, message: `pressed ${keys}` }
}

async function inject<T>(tabId: number, func: (...a: any[]) => T, args: any[]): Promise<T> {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args })
  return res?.result as T
}

const guarded = async (tabId: number, fn: () => Promise<ActionResult>): Promise<ActionResult> => {
  try {
    return await fn()
  } catch (err) {
    return { ok: false, message: `cannot act on this page (${err instanceof Error ? err.message : String(err)})` }
  }
}

/** Click the element at `index`. */
export function clickElement(tabId: number, index: number): Promise<ActionResult> {
  return guarded(tabId, () => inject(tabId, injClick, [ATTR, index]))
}

/** Type `text` into the element at `index`; `clear` replaces existing text. */
export function typeIntoElement(
  tabId: number,
  index: number,
  text: string,
  clear: boolean,
): Promise<ActionResult> {
  return guarded(tabId, () => inject(tabId, injType, [ATTR, index, text, clear]))
}

/** Choose an option (by value or visible text) in the <select> at `index`. */
export function selectOption(tabId: number, index: number, value: string): Promise<ActionResult> {
  return guarded(tabId, () => inject(tabId, injSelect, [ATTR, index, value]))
}

/** Scroll the page up/down, or bring element `index` into view. */
export function scrollPage(
  tabId: number,
  opts: { direction: 'up' | 'down' | 'toElement'; index?: number },
): Promise<ActionResult> {
  return guarded(tabId, () => inject(tabId, injScroll, [ATTR, opts.direction, opts.index ?? -1]))
}

/** Dispatch a key (Enter | Tab | Escape) to the focused element. */
export function pressKey(tabId: number, keys: string): Promise<ActionResult> {
  return guarded(tabId, () => inject(tabId, injPress, [keys]))
}

/** Navigate the tab to `url`. Returns urlChanged so the caller can re-fence origin. */
export async function navigateTab(tabId: number, url: string): Promise<ActionResult> {
  try {
    await chrome.tabs.update(tabId, { url })
    return { ok: true, message: `navigating to ${url}`, urlChanged: true }
  } catch (err) {
    return { ok: false, message: `could not navigate (${err instanceof Error ? err.message : String(err)})` }
  }
}
```

> Note: `injPress`'s `for (const opts of [{}, {}])` line is a leftover — delete it; it is shown here only so you don't re-add it. The real body is just the three `fire` lines.

- [ ] **Step 2: Build.**

Run: `npm run build`
Expected: PASS. (Fix the stray `for` line noted above if the linter/tsc flags the unused binding.)

- [ ] **Step 3: Manual verification (console-paste on a React app).**

On a React site with a controlled text input (e.g. the search box at `https://react.dev`), open DevTools Console. First stamp an element by pasting the Task-1 indexer, note the index of the input, then paste `injType`'s body as an IIFE targeting that index with `clear:true` and some text. Expected: the input's visible value updates **and** stays updated (React doesn't wipe it) — proving the native-setter path. Repeat with `injClick` on a button and confirm it fires the button's handler.

- [ ] **Step 4: Commit.**

```bash
git add src/platform/pageActions.ts
git commit -m "Add page action executors with native-setter text entry"
```

---

### Task 4: Session + control tools (`src/tools/pageControl.ts`, `tools.ts`, `Chat.tsx`)

Second end-to-end checkpoint: the session model. Move `ControlSession` to `pageControl.ts`, add the point-of-no-return classifier and the action orchestration, add `RequestPageControl` + `ControlPage` tools, and implement the real `PageControlGate` in Chat (session ref, session card variant, teardown). Actions still fire instantly — presence lands in Task 5.

**Files:**
- Create: `src/tools/pageControl.ts`
- Modify: `src/tools/tools.ts` (move `ControlSession` import from here; add the two tools; keep `PageControlGate` here)
- Modify: `src/ui/Chat.tsx` (real gate, `pageSession` ref, session-card branch, `ToolPill` labels, teardown)
- Modify: `src/ui/styles.css` (session-card + control-pill styles)

**Interfaces:**
- Consumes: `snapshotPage`, `clearIndex` (Task 1); `clickElement`/`typeIntoElement`/`selectOption`/`scrollPage`/`pressKey`/`navigateTab`, `ActionResult` (Task 3); `IndexedElement`, `PageSnapshot` (Task 1); `ApprovalGate` (`tools.ts:28`).
- Produces:
  - (moved) `interface ControlSession { … }` now lives in `pageControl.ts`.
  - `type ControlAction = 'click' | 'type' | 'select' | 'scroll' | 'highlight' | 'navigate' | 'press'`
  - `interface ControlSpec { action: ControlAction; index?: number; text?: string; value?: string; url?: string; keys?: string; direction?: 'up' | 'down' | 'toElement'; label?: string; sensitive?: boolean; clear?: boolean }`
  - `isPointOfNoReturn(spec: ControlSpec, el: IndexedElement | undefined, sessionOrigin: string, snapshot: PageSnapshot): boolean`
  - `runControlStep(deps: ControlStepDeps): Promise<ControlStepResult>` — see Step 2 for the exact shape.

- [ ] **Step 1: Create `pageControl.ts` — session type + classifier.**

```ts
// The page-control session: a per-task grant that governs the action loop.
// Also the point-of-no-return classifier and the per-action orchestration.

import type { IndexedElement, PageSnapshot } from '../platform/domIndex'
import { snapshotPage } from '../platform/domIndex'
import {
  clickElement,
  navigateTab,
  pressKey,
  scrollPage,
  selectOption,
  typeIntoElement,
  type ActionResult,
} from '../platform/pageActions'

/** A per-task grant to control one tab. Origin-fenced and action-budgeted. */
export interface ControlSession {
  tabId: number
  origin: string
  plan: string
  actionsUsed: number
  maxActions: number
  active: boolean
}

export const MAX_SESSION_ACTIONS = 20

export type ControlAction =
  | 'click'
  | 'type'
  | 'select'
  | 'scroll'
  | 'highlight'
  | 'navigate'
  | 'press'

/** One action request from the model. */
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
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

/**
 * True when an action must show an individual approval card even inside a
 * granted session: form submits, cross-origin navigation, sensitive fields,
 * or a model self-flag.
 */
export function isPointOfNoReturn(
  spec: ControlSpec,
  el: IndexedElement | undefined,
  sessionOrigin: string,
): boolean {
  if (spec.sensitive) return true
  if (el?.sensitive) return true
  if (spec.action === 'navigate') {
    return spec.url ? hostOf(spec.url) !== sessionOrigin : false
  }
  if (spec.action === 'press' && /enter/i.test(spec.keys ?? '')) return true
  if (spec.action === 'click' && el) {
    if (el.type === 'submit' || el.type === 'image') return true
    if (/submit|sign in|log ?in|pay|checkout|place order|continue/i.test(el.name)) return true
  }
  return false
}
```

- [ ] **Step 2: Add the orchestration to `pageControl.ts`.**

`runControlStep` performs one action then re-snapshots. (Presence is spliced in Task 5 via the two optional hooks `beforeAct`/`afterAct`.)

```ts
export interface ControlStepDeps {
  tabId: number
  spec: ControlSpec
  snapshot: PageSnapshot
  /** Presence hook: glide the cursor/spotlight to `index` before acting. */
  beforeAct?: (index: number | undefined) => Promise<void>
  /** Presence hook: play the click pulse after acting. */
  afterAct?: () => Promise<void>
}

export interface ControlStepResult extends ActionResult {
  /** Refreshed registry text after the action. */
  registry: string
}

const runRaw = (tabId: number, spec: ControlSpec): Promise<ActionResult> => {
  switch (spec.action) {
    case 'click':
    case 'highlight':
      return clickElementOrHighlight(tabId, spec)
    case 'type':
      return typeIntoElement(tabId, spec.index ?? -1, spec.text ?? '', spec.clear ?? true)
    case 'select':
      return selectOption(tabId, spec.index ?? -1, spec.value ?? '')
    case 'scroll':
      return scrollPage(tabId, { direction: spec.direction ?? 'down', index: spec.index })
    case 'press':
      return pressKey(tabId, spec.keys ?? 'Enter')
    case 'navigate':
      return navigateTab(tabId, spec.url ?? '')
  }
}

// 'highlight' is a read-only show-me: it uses the same scroll-into-view the
// presence layer already does, and reports success without mutating anything.
const clickElementOrHighlight = (tabId: number, spec: ControlSpec): Promise<ActionResult> => {
  if (spec.action === 'highlight') {
    return scrollPage(tabId, { direction: 'toElement', index: spec.index }).then((r) => ({
      ...r,
      message: r.ok ? `highlighted element ${spec.index}` : r.message,
    }))
  }
  return clickElement(tabId, spec.index ?? -1)
}

/** Run one action: presence glide → real action → pulse → re-snapshot. */
export async function runControlStep(deps: ControlStepDeps): Promise<ControlStepResult> {
  const { tabId, spec, beforeAct, afterAct } = deps
  const needsTarget = spec.index !== undefined && spec.action !== 'navigate'
  if (beforeAct && needsTarget) await beforeAct(spec.index)
  const result = await runRaw(tabId, spec)
  if (afterAct && result.ok) await afterAct()
  // Navigation reloads the document; give it a beat before re-reading.
  if (spec.action === 'navigate') await new Promise((r) => setTimeout(r, 600))
  let registry = '(page not re-read)'
  try {
    registry = (await snapshotPage(tabId)).text
  } catch {
    registry = '(could not re-read the page)'
  }
  return { ...result, registry }
}
```

- [ ] **Step 3: Wire the two tools in `tools.ts`.**

Replace the `ControlSession` interface you added in Task 2 with an import, and add the tools. `ControlPage` classifies each action and only cards the point-of-no-return ones:

```ts
import { snapshotPage } from '../platform/domIndex'
import {
  isPointOfNoReturn,
  runControlStep,
  MAX_SESSION_ACTIONS,
  type ControlSession,
  type ControlSpec,
} from './pageControl'
```

(Keep `PageControlGate` in `tools.ts`; its `session()` now returns the imported `ControlSession`.)

Add inside `tools`:

```ts
    RequestPageControl: tool({
      description:
        'Ask the user for permission to control the active tab to carry out a task (fill a form, click through a flow, navigate). State a concise plan. On approval you get a page-control session and the first element list; then use ControlPage for each step and InspectPage to re-read. Point-of-no-return steps (submitting, cross-site navigation, passwords/payments) still ask each time.',
      inputSchema: z.object({
        plan: z
          .string()
          .describe('One or two sentences: what you will do on the page and where you will stop.'),
      }),
      execute: async ({ plan }) => {
        const tab = await getActiveTab()
        if (tab?.id === undefined) return { error: 'No active tab found.' }
        const host = (() => {
          try {
            return new URL(tab.url ?? '').host
          } catch {
            return tab.url ?? 'this page'
          }
        })()
        const granted = await pageControl.requestSession({ plan, host, tabId: tab.id })
        if (!granted) return DENIED
        try {
          const snap = await snapshotPage(tab.id)
          return { started: true, url: snap.url, title: snap.title, elements: snap.text }
        } catch (err) {
          pageControl.endSession()
          return { error: `Cannot control this page (${err instanceof Error ? err.message : String(err)}).` }
        }
      },
    }),

    ControlPage: tool({
      description:
        'Perform ONE action on the active tab within an open page-control session: click, type, select, scroll, highlight, navigate, or press a key. Target elements by their [index] from InspectPage/RequestPageControl. Returns the refreshed element list.',
      inputSchema: z.object({
        action: z.enum(['click', 'type', 'select', 'scroll', 'highlight', 'navigate', 'press']),
        index: z.number().optional().describe('Target element index from the list.'),
        text: z.string().optional().describe('Text to type (action=type).'),
        value: z.string().optional().describe('Option value or label (action=select).'),
        url: z.string().optional().describe('URL to open (action=navigate).'),
        keys: z.string().optional().describe('Key to press: Enter, Tab, or Escape (action=press).'),
        direction: z.enum(['up', 'down', 'toElement']).optional().describe('Scroll direction (action=scroll).'),
        label: z.string().optional().describe('Callout text to show on the page (action=highlight).'),
        clear: z.boolean().optional().describe('Replace existing text instead of appending (action=type).'),
        sensitive: z.boolean().optional().describe('Set true if this step is risky; forces a confirm.'),
      }),
      execute: async (spec: ControlSpec) => {
        const session = pageControl.session()
        if (!session || !session.active)
          return { error: 'No page-control session is open. Call RequestPageControl first.' }
        if (session.actionsUsed >= session.maxActions) {
          pageControl.endSession()
          return { error: `Action budget of ${MAX_SESSION_ACTIONS} reached. Ask the user to continue if more is needed.` }
        }
        const tab = await getActiveTab()
        if (tab?.id === undefined || tab.id !== session.tabId)
          return { error: 'The controlled tab is no longer active.' }
        let snap
        try {
          snap = await snapshotPage(tab.id)
        } catch (err) {
          return { error: `Cannot read this page (${err instanceof Error ? err.message : String(err)}).` }
        }
        const el = spec.index !== undefined ? snap.elements[spec.index] : undefined
        if (isPointOfNoReturn(spec, el, session.origin)) {
          const approved = await requestApproval({
            toolName: 'ControlPage',
            summary: pointOfNoReturnSummary(spec, el),
            reason: 'This step changes state or leaves the page.',
          })
          if (!approved) return DENIED
        }
        session.actionsUsed += 1
        const { registry, ok, message, urlChanged } = await runControlStep({ tabId: tab.id, spec, snapshot: snap })
        return { ok, message, urlChanged, elements: registry, actionsLeft: session.maxActions - session.actionsUsed }
      },
    }),
```

Add this helper near `DENIED` in `tools.ts`:

```ts
function pointOfNoReturnSummary(spec: ControlSpec, el?: { name: string }): string {
  if (spec.action === 'navigate') return `Navigate to ${spec.url}`
  if (spec.action === 'press') return `Press ${spec.keys}`
  if (spec.action === 'click') return `Click “${el?.name || `element ${spec.index}`}”`
  if (spec.action === 'type') return `Enter text into a sensitive field`
  return `Perform ${spec.action}`
}
```

Delete the `ControlSession` interface block added in Task 2 (now imported).

- [ ] **Step 4: Implement the real gate in `Chat.tsx`.**

Replace the stub `pageControl` object with a ref-backed implementation. Add near the other refs (line ~137):

```ts
  const pageSessionRef = useRef<ControlSession | null>(null)
  const [sessionPlan, setSessionPlan] = useState<{ plan: string; host: string } | null>(null)
```

Import `ControlSession` and the teardown helper:

```ts
import { createAgentTools, type ApprovalRequest, type PageControlGate } from '../tools/tools'
import type { ControlSession } from '../tools/pageControl'
import { clearIndex } from '../platform/domIndex'
```

Replace the stub with:

```ts
  const pageControl: PageControlGate = {
    requestSession: ({ plan, host, tabId }) =>
      new Promise<boolean>((resolve) => {
        // Reuse the approval card machinery, but branch the UI to a session card.
        setSessionPlan({ plan, host })
        approvalRef.current = {
          toolName: 'RequestPageControl',
          summary: `Control ${host}`,
          reason: plan,
          resolve: (approved: boolean) => {
            setSessionPlan(null)
            if (approved) {
              pageSessionRef.current = {
                tabId,
                origin: (() => {
                  try {
                    return new URL(currentTab?.url ?? '').origin
                  } catch {
                    return ''
                  }
                })(),
                plan,
                actionsUsed: 0,
                maxActions: 20,
                active: true,
              }
            }
            resolve(approved)
          },
        }
        setApproval(approvalRef.current)
      }),
    session: () => pageSessionRef.current,
    endSession: () => {
      const s = pageSessionRef.current
      pageSessionRef.current = null
      setSessionPlan(null)
      if (s) void clearIndex(s.tabId)
    },
  }
```

In the `finally` block of `send()` (line ~531), tear the session down so nothing is left open across turns:

```ts
    } finally {
      settleApproval(false)
      turnAllowed.current = new Set()
      pageControl.endSession()
      abortRef.current = null
      setStreaming(false)
      setTurnSeq((n) => n + 1)
    }
```

- [ ] **Step 5: Branch the ApprovalCard for sessions + label control pills.**

In the JSX where `<ApprovalCard>` renders (line ~569), when `sessionPlan` is set the card should show the plan and a single **Allow** (no "Allow this chat"). Pass `sessionPlan` into `ApprovalCard` and render a session variant:

```tsx
        {approval && (
          <ApprovalCard
            approval={approval}
            sessionPlan={sessionPlan}
            onDeny={() => settleApproval(false)}
            onAllow={() => settleApproval(true)}
            onAllowSession={() => settleApproval(true, true)}
          />
        )}
```

Update `ApprovalCard`'s signature and body (line ~966) to take `sessionPlan?: { plan: string; host: string } | null` and, when present, render the plan text and hide the "Allow this chat" button:

```tsx
function ApprovalCard({
  approval,
  sessionPlan,
  onDeny,
  onAllow,
  onAllowSession,
}: {
  approval: PendingApproval
  sessionPlan?: { plan: string; host: string } | null
  onDeny: () => void
  onAllow: () => void
  onAllowSession: () => void
}) {
  const isSession = !!sessionPlan
  return (
    <div className={`approval-card ${isSession ? 'session' : ''}`}>
      <div className="approval-header">
        {/* keep the existing lock svg */}
        <span>{isSession ? `Let the agent control ${sessionPlan!.host}?` : approval.summary}</span>
      </div>
      {(isSession ? sessionPlan!.plan : approval.reason) && (
        <div className="approval-reason">{isSession ? sessionPlan!.plan : approval.reason}</div>
      )}
      <div className="approval-actions">
        <button className="btn ghost" onClick={onDeny}>Deny</button>
        {!isSession && (
          <button className="btn ghost" onClick={onAllowSession}>Allow this chat</button>
        )}
        <button className="btn primary" onClick={onAllow}>Allow</button>
      </div>
    </div>
  )
}
```

In `ToolPill` (line ~931), add labels for the new tools before the final `else`:

```ts
  else if (part.toolName === 'InspectPage') label = 'Read the page elements'
  else if (part.toolName === 'RequestPageControl')
    label = output?.started ? 'Started controlling the page' : 'Asked to control the page'
  else if (part.toolName === 'ControlPage') label = controlActionLabel(part.input, output)
```

And add the helper:

```ts
function controlActionLabel(input: any, output: any): string {
  if (output?.denied) return 'Action denied'
  const a = input?.action
  if (a === 'type') return `Typed into element ${input.index}`
  if (a === 'click') return `Clicked element ${input.index}`
  if (a === 'select') return `Selected an option`
  if (a === 'scroll') return input.direction === 'toElement' ? 'Scrolled to an element' : `Scrolled ${input.direction}`
  if (a === 'highlight') return 'Highlighted an element'
  if (a === 'navigate') return `Navigated the page`
  if (a === 'press') return `Pressed ${input.keys}`
  return 'Page action'
}
```

- [ ] **Step 6: Add styles.**

In `src/ui/styles.css`, add a session-card accent (reuse existing `.approval-card` tokens; just tint the border):

```css
.approval-card.session {
  border-color: #7ab8ff;
}
```

- [ ] **Step 7: Build.**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 8: Manual verification (end-to-end).**

Reload the extension. On a multi-field form (`https://httpbin.org/forms/post`), ask: *"Fill this form with sample values but don't submit."* Expected:
1. One **session card** appears titled "Let the agent control httpbin.org?" with the plan; click **Allow**.
2. The agent fills each field with **no further cards** (watch the field values change; live pills read "Typed into element N").
3. If you instead say *"…and submit it"*, the submit step raises an **individual** card ("Click 'Submit'"/"Press Enter").
Also verify: **Stop** mid-run ends it; **Deny** on the session card blocks all actions; asking for 20+ actions returns the budget message. After every path, confirm no `data-agent-idx` stamps remain (Elements panel) — the `finally` teardown ran.

- [ ] **Step 9: Commit.**

```bash
git add src/tools/pageControl.ts src/tools/tools.ts src/ui/Chat.tsx src/ui/styles.css
git commit -m "Add page-control session, action tool, and approval wiring"
```

---

### Task 5: Presence overlay (`src/platform/presence.ts` + orchestration hooks)

Third end-to-end checkpoint: the visible agency layer. Inject a persistent tint + gliding cursor + spotlight; mount it when a session opens, choreograph each action, and tear it down on close.

**Files:**
- Create: `src/platform/presence.ts`
- Modify: `src/tools/tools.ts` (mount on `RequestPageControl` grant; pass presence hooks into `runControlStep`)
- Modify: `src/tools/pageControl.ts` (`endSession` path already calls `clearIndex`; presence unmount is invoked from the gate — see Step 3)
- Modify: `src/ui/Chat.tsx` (`endSession` also unmounts presence)

**Interfaces:**
- Consumes: the `data-agent-idx` stamps (Task 1); `beforeAct`/`afterAct` hooks of `runControlStep` (Task 4).
- Produces:
  - `mountPresence(tabId: number): Promise<void>`
  - `focusOn(tabId: number, index: number, label?: string): Promise<void>` — scroll to, glide cursor, open spotlight, await the 450ms transition.
  - `pulse(tabId: number): Promise<void>`
  - `setPresenceHidden(tabId: number, hidden: boolean): Promise<void>` — for clean screenshots (Task 6).
  - `unmountPresence(tabId: number): Promise<void>`

- [ ] **Step 1: Write the module.**

Create `src/platform/presence.ts`. The overlay is one persistent `<div id="__agent_presence">`; the cursor's last position rides on its dataset. All functions are self-contained injections.

```ts
// The on-page "agent presence": a persistent, pointer-events:none overlay that
// tints the page, glides an agent cursor to the element being acted on, and
// opens a box-shadow "spotlight" hole over it (the same un-tint trick as
// capture.ts). Persistence lives in the page DOM so each stateless injection
// animates from where the cursor last was.

const ROOT_ID = '__agent_presence'
const TINT = 'rgba(20,22,30,0.22)'
const GLIDE_MS = 450

function injMount(rootId: string, tint: string) {
  if (document.getElementById(rootId)) return
  const root = document.createElement('div')
  root.id = rootId
  root.style.cssText =
    'position:fixed;inset:0;z-index:2147483646;pointer-events:none;'
  root.dataset.cx = String(window.innerWidth / 2)
  root.dataset.cy = String(window.innerHeight / 2)

  const tintEl = document.createElement('div')
  tintEl.className = 'tint'
  tintEl.style.cssText = `position:absolute;inset:0;background:${tint};transition:opacity .2s;`

  const spot = document.createElement('div')
  spot.className = 'spot'
  spot.style.cssText =
    'position:absolute;display:none;border:1.5px solid #7ab8ff;border-radius:6px;' +
    `box-shadow:0 0 0 99999px ${tint};transition:all ${450}ms cubic-bezier(.22,.61,.36,1);`

  const cursor = document.createElement('div')
  cursor.className = 'cursor'
  cursor.style.cssText =
    'position:absolute;width:18px;height:18px;left:0;top:0;transition:transform ' +
    `${450}ms cubic-bezier(.22,.61,.36,1);will-change:transform;` +
    `transform:translate(${root.dataset.cx}px,${root.dataset.cy}px);`
  cursor.innerHTML =
    '<svg width="18" height="18" viewBox="0 0 18 18"><path d="M2 2l5.5 13 2-5.5 5.5-2z" fill="#7ab8ff" stroke="white" stroke-width="1"/></svg>'

  root.appendChild(tintEl)
  root.appendChild(spot)
  root.appendChild(cursor)
  document.documentElement.appendChild(root)
}

function injFocus(rootId: string, attr: string, index: number, label: string) {
  const root = document.getElementById(rootId)
  if (!root) return
  const el = document.querySelector(`[${attr}="${index}"]`)
  const spot = root.querySelector('.spot') as HTMLElement
  const cursor = root.querySelector('.cursor') as HTMLElement
  if (!el) {
    spot.style.display = 'none'
    return
  }
  el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior })
  const r = el.getBoundingClientRect()
  const pad = 4
  spot.style.display = 'block'
  spot.style.left = `${r.left - pad}px`
  spot.style.top = `${r.top - pad}px`
  spot.style.width = `${r.width + pad * 2}px`
  spot.style.height = `${r.height + pad * 2}px`
  const tx = r.left + r.width / 2
  const ty = r.top + r.height / 2
  cursor.style.transform = `translate(${tx}px,${ty}px)`
  root.dataset.cx = String(tx)
  root.dataset.cy = String(ty)
  if (label) {
    let tag = root.querySelector('.label') as HTMLElement
    if (!tag) {
      tag = document.createElement('div')
      tag.className = 'label'
      tag.style.cssText =
        'position:absolute;padding:3px 7px;background:#7ab8ff;color:#04101f;border-radius:5px;' +
        'font:12px system-ui;white-space:nowrap;transform:translateY(-130%);'
      root.appendChild(tag)
    }
    tag.textContent = label
    tag.style.left = `${r.left}px`
    tag.style.top = `${r.top}px`
    tag.style.display = 'block'
  }
}

function injPulse(rootId: string) {
  const root = document.getElementById(rootId)
  if (!root) return
  const ring = document.createElement('div')
  ring.style.cssText =
    `position:absolute;left:${root.dataset.cx}px;top:${root.dataset.cy}px;width:8px;height:8px;` +
    'border-radius:50%;background:#7ab8ff;transform:translate(-50%,-50%);opacity:.9;' +
    'transition:all .4s ease-out;pointer-events:none;'
  root.appendChild(ring)
  requestAnimationFrame(() => {
    ring.style.width = '46px'
    ring.style.height = '46px'
    ring.style.opacity = '0'
  })
  setTimeout(() => ring.remove(), 420)
}

function injHidden(rootId: string, hidden: boolean) {
  const root = document.getElementById(rootId)
  if (root) root.style.display = hidden ? 'none' : 'block'
}

function injUnmount(rootId: string) {
  document.getElementById(rootId)?.remove()
}

const ATTR = 'data-agent-idx'

async function run(tabId: number, func: (...a: any[]) => void, args: any[]): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, func, args }).catch(() => {})
}

/** Mount the persistent presence overlay on the tab. */
export function mountPresence(tabId: number): Promise<void> {
  return run(tabId, injMount, [ROOT_ID, TINT])
}

/** Glide the cursor + spotlight to element `index`, then wait out the transition. */
export async function focusOn(tabId: number, index: number, label = ''): Promise<void> {
  await run(tabId, injFocus, [ROOT_ID, ATTR, index, label])
  await new Promise((r) => setTimeout(r, GLIDE_MS))
}

/** Play a click ripple at the cursor. */
export function pulse(tabId: number): Promise<void> {
  return run(tabId, injPulse, [ROOT_ID])
}

/** Hide/show the overlay (used to take a clean screenshot). */
export function setPresenceHidden(tabId: number, hidden: boolean): Promise<void> {
  return run(tabId, injHidden, [ROOT_ID, hidden])
}

/** Remove the overlay entirely. */
export function unmountPresence(tabId: number): Promise<void> {
  return run(tabId, injUnmount, [ROOT_ID])
}
```

- [ ] **Step 2: Mount on grant + pass presence hooks into the step.**

In `tools.ts`, import presence and wire it. On a granted `RequestPageControl`, mount the overlay:

```ts
import { mountPresence, focusOn, pulse } from '../platform/presence'
```

In `RequestPageControl.execute()`, right after `if (!granted) return DENIED`:

```ts
        await mountPresence(tab.id)
```

In `ControlPage.execute()`, pass the hooks into `runControlStep`:

```ts
        const { registry, ok, message, urlChanged } = await runControlStep({
          tabId: tab.id,
          spec,
          snapshot: snap,
          beforeAct: (index) => (index === undefined ? Promise.resolve() : focusOn(tab.id!, index, spec.label)),
          afterAct: () => pulse(tab.id!),
        })
```

- [ ] **Step 3: Unmount on session close.**

In `Chat.tsx`, extend the gate's `endSession` to also unmount presence:

```ts
import { unmountPresence } from '../platform/presence'
```

```ts
    endSession: () => {
      const s = pageSessionRef.current
      pageSessionRef.current = null
      setSessionPlan(null)
      if (s) {
        void clearIndex(s.tabId)
        void unmountPresence(s.tabId)
      }
    },
```

- [ ] **Step 4: Build.**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Manual verification (end-to-end).**

Reload. Repeat the form-fill from Task 4. Expected: on Allow, the page gains a **light tint**; before each field the **agent cursor glides** to it and a **spotlight** lights that field; a **ripple** plays as it types; the tint always clears when the run ends (done / Stop / deny / budget). Try *"highlight the submit button and tell me what it does"* — the cursor glides there with a **label callout**, no click. Confirm (Elements panel) that `#__agent_presence` is gone after the turn.

- [ ] **Step 6: Commit.**

```bash
git add src/platform/presence.ts src/tools/tools.ts src/ui/Chat.tsx
git commit -m "Add on-page agent presence overlay for page control"
```

---

### Task 6: Set-of-marks + vision probe (`src/platform/marks.ts`, `src/agent/vision.ts`, InspectPage upgrade)

Adaptive perception: probe whether the selected model can read images (cached), and when it can, return a numbered set-of-marks screenshot from `InspectPage`/`RequestPageControl` alongside the text.

**Files:**
- Create: `src/platform/marks.ts`
- Create: `src/agent/vision.ts`
- Modify: `src/tools/tools.ts` (InspectPage & RequestPageControl return an image via `toModelOutput` when vision-capable; hide presence for the shot)
- Modify: `src/ui/Chat.tsx` (pass the selected provider/model into `createAgentTools` so tools can probe)

**Interfaces:**
- Consumes: `PageSnapshot.elements` + `dpr` (Task 1); `setPresenceHidden` (Task 5); `createModel` (`src/agent/provider.ts`); `ProviderConfig` (`src/data/settings.ts`).
- Produces:
  - `captureWithMarks(tabId: number, windowId: number, elements: IndexedElement[], dpr: number): Promise<string>` — PNG data URL with numbered boxes.
  - `ensureVisionCapability(provider: ProviderConfig, modelId: string): Promise<boolean>`

- [ ] **Step 1: Write `vision.ts` (probe + cache).**

```ts
// Runtime one-shot probe: does the selected model actually read images? Cached
// per provider+model in chrome.storage.local. We render a small image holding a
// random code and check the model echoes it back — this also catches endpoints
// that silently ignore image parts (they won't return the code).

import { generateText } from 'ai'
import { createModel } from './provider'
import type { ProviderConfig } from '../data/settings'

const CACHE_KEY = 'visionProbe'

async function readCache(): Promise<Record<string, boolean>> {
  const data = await chrome.storage.local.get(CACHE_KEY)
  return (data[CACHE_KEY] as Record<string, boolean>) ?? {}
}

function makeProbeImage(code: string): string {
  const canvas = document.createElement('canvas')
  canvas.width = 240
  canvas.height = 80
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, 240, 80)
  ctx.fillStyle = '#000000'
  ctx.font = 'bold 48px monospace'
  ctx.fillText(code, 30, 56)
  return canvas.toDataURL('image/png')
}

/** True if the model reads images. Probes once, then serves from cache. */
export async function ensureVisionCapability(
  provider: ProviderConfig,
  modelId: string,
): Promise<boolean> {
  const key = `${provider.id}::${modelId}`
  const cache = await readCache()
  if (key in cache) return cache[key]
  // A fixed 4-char code; varying it is unnecessary and would defeat the cache.
  const code = 'K7QX'
  let capable = false
  try {
    const { text } = await generateText({
      model: createModel(provider, modelId),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', image: makeProbeImage(code) },
            { type: 'text', text: 'Reply with ONLY the 4-character code shown in this image.' },
          ],
        },
      ],
    })
    capable = text.toUpperCase().includes(code)
  } catch {
    capable = false
  }
  cache[key] = capable
  await chrome.storage.local.set({ [CACHE_KEY]: cache })
  return capable
}
```

- [ ] **Step 2: Write `marks.ts` (numbered screenshot).**

```ts
// Set-of-marks: capture a clean screenshot of the tab and draw the registry's
// numbered boxes onto it, so a vision model can pick an element by number. The
// same [index] maps to the same DOM node the text registry uses.

import type { IndexedElement } from './domIndex'

const MAX_SIDE = 1400

/** Screenshot the tab and overlay numbered boxes for each indexed element. */
export async function captureWithMarks(
  tabId: number,
  windowId: number,
  elements: IndexedElement[],
  dpr: number,
): Promise<string> {
  const shot = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' })
  const img = new Image()
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('Failed to decode screenshot.'))
    img.src = shot
  })
  const down = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(img.naturalWidth * down)
  canvas.height = Math.round(img.naturalHeight * down)
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  ctx.font = 'bold 12px system-ui'
  for (const el of elements) {
    const x = el.rect.x * dpr * down
    const y = el.rect.y * dpr * down
    const w = el.rect.width * dpr * down
    const h = el.rect.height * dpr * down
    ctx.strokeStyle = '#ff3b6b'
    ctx.lineWidth = 1.5
    ctx.strokeRect(x, y, w, h)
    const tag = String(el.index)
    const tw = ctx.measureText(tag).width + 6
    ctx.fillStyle = '#ff3b6b'
    ctx.fillRect(x, Math.max(0, y - 14), tw, 14)
    ctx.fillStyle = '#ffffff'
    ctx.fillText(tag, x + 3, Math.max(10, y - 3))
  }
  return canvas.toDataURL('image/png')
}
```

- [ ] **Step 3: Pass provider/model into `createAgentTools` and return marks.**

In `Chat.tsx`, extend the call so tools can probe and build the model:

```ts
        tools: createAgentTools(requestApproval, pageControl, settings.tabAccess, selected),
```

(`selected` is already computed at line 141 via `getSelectedProvider(settings)`; it is `{ provider, modelId } | null`.)

In `tools.ts`, widen the signature and add a shared "look at the page" helper that attaches an image via the AI SDK `toModelOutput` channel when the model is vision-capable:

```ts
import { ensureVisionCapability } from '../agent/vision'
import { captureWithMarks } from '../platform/marks'
import { setPresenceHidden } from '../platform/presence'
import type { ProviderConfig } from '../data/settings'

export function createAgentTools(
  requestApproval: ApprovalGate,
  pageControl: PageControlGate,
  tabAccess: TabAccess,
  selected: { provider: ProviderConfig; modelId: string } | null,
): ToolSet {
```

Add a helper (top-level in `tools.ts`) that both `InspectPage` and `RequestPageControl` reuse. It returns the plain text result, and — when vision-capable — a `toModelOutput` so the model receives the marked screenshot as image content:

```ts
// Build a tool return that carries the text registry, plus (for vision models)
// the set-of-marks screenshot as image content via the AI SDK tool-result
// channel. The presence overlay is hidden for the shot so the tint doesn't
// pollute what the model sees.
async function lookResult(
  tab: chrome.tabs.Tab,
  snap: { url: string; title: string; elements: any[]; text: string; dpr: number },
  base: Record<string, unknown>,
  selected: { provider: ProviderConfig; modelId: string } | null,
) {
  const value = { ...base, url: snap.url, title: snap.title, elements: snap.text }
  if (!selected) return value
  const vision = await ensureVisionCapability(selected.provider, selected.modelId).catch(() => false)
  if (!vision || tab.id === undefined || tab.windowId === undefined) return value
  try {
    await setPresenceHidden(tab.id, true)
    const dataUrl = await captureWithMarks(tab.id, tab.windowId, snap.elements as any, snap.dpr)
    await setPresenceHidden(tab.id, false)
    // Attach the image so a vision model sees the numbered marks. AI SDK v5
    // renders `toModelOutput` content parts into the tool-result message.
    return {
      ...value,
      __marks: dataUrl,
      // The tool() wrapper below reads __marks to build toModelOutput.
    }
  } catch {
    await setPresenceHidden(tab.id, false).catch(() => {})
    return value
  }
}
```

For each of `InspectPage` and `RequestPageControl`, capture `snapshotPage` into a `PageSnapshot` (it already exposes `dpr` and `elements`), call `lookResult(tab, snap, base, selected)`, and add a `toModelOutput` to the `tool({...})` definition that converts `__marks` into an image content part:

```ts
      toModelOutput: (output: any) => {
        const parts: any[] = [{ type: 'text', text: JSON.stringify({ ...output, __marks: undefined }) }]
        if (output?.__marks)
          parts.push({ type: 'media', mediaType: 'image/png', data: output.__marks })
        return { type: 'content', value: parts }
      },
```

> **Verify the `toModelOutput` shape against your installed AI SDK v5 minor before relying on it** (see spec §7 note). Run `npm ls ai`. If your minor uses `experimental_toToolResultContent` or a different content-part key (`image` vs `media`), adjust accordingly; the fallback is to skip the image and keep text-only (the model still works via the registry).

- [ ] **Step 4: Build.**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Manual verification (end-to-end, both model types).**

Reload. (a) Select a **vision** model (e.g. gpt-4o). Ask *"What are the interactive elements here?"* → the first probe round-trips once (watch network), caches, and the agent's `InspectPage` result includes the marked screenshot (it should reference elements by their on-image numbers). (b) Select a **non-vision** model (e.g. a text-only Ollama model) → no image is attached, text registry only, and the probe caches `false`. Confirm `chrome.storage.local` has a `visionProbe` map (DevTools → Application → Storage, or `chrome.storage.local.get('visionProbe')` in the panel console).

- [ ] **Step 6: Commit.**

```bash
git add src/platform/marks.ts src/agent/vision.ts src/tools/tools.ts src/ui/Chat.tsx
git commit -m "Add vision probe and set-of-marks perception for vision models"
```

---

### Task 7: Documentation (`README.md`, `CLAUDE.md`)

Fold the capability into the docs so the next reader (human or agent) understands it.

**Files:**
- Modify: `README.md` (Agent tools list + a "Page control" section)
- Modify: `CLAUDE.md` (architecture invariants + source-layout notes)

- [ ] **Step 1: Update `README.md`.**

- Add to the "Agent tools" list (after `SearchMemory`):
  ```markdown
  - **InspectPage** — reads the active tab as a numbered list of interactive elements.
  - **RequestPageControl** — asks once to control the tab for a task, then the agent acts.
  - **ControlPage** — performs one action (click / type / select / scroll / highlight / navigate / press).
  ```
- Add a "Page control" subsection describing: the indexed-DOM registry (`data-agent-idx`), adaptive set-of-marks vs text (runtime vision probe), the per-task session grant with a 20-action budget + point-of-no-return cards + Stop, and the on-page presence overlay (tint + gliding cursor + spotlight). Note it uses only the existing permissions (no `debugger`).
- Update the architecture file map to list `src/platform/domIndex.ts`, `pageActions.ts`, `presence.ts`, `marks.ts`, `src/agent/vision.ts`, `src/tools/pageControl.ts`.

- [ ] **Step 2: Update `CLAUDE.md`.**

- Under "Architecture invariants", add a bullet: page-control actions route through the session gate (`RequestPageControl` → `PageControlGate`) and point-of-no-return actions additionally re-card through `requestApproval`; the presence overlay must always be torn down in the turn `finally`.
- Under "Source layout", note the new files and that injected functions in `src/platform/*` must stay self-contained.

- [ ] **Step 3: Build (docs-only, sanity).**

Run: `npm run build`
Expected: PASS (docs don't affect the build; this just confirms nothing else regressed).

- [ ] **Step 4: Commit.**

```bash
git add README.md CLAUDE.md
git commit -m "Document the page-control / browser-use capability"
```

---

## Self-Review

**Spec coverage:**
- §7 tool surface → Tasks 2 (InspectPage), 4 (RequestPageControl, ControlPage). ✓
- §8 data model → Task 1 (`IndexedElement`, `PageSnapshot`), Task 4 (`ControlSession`, `ControlSpec`). ✓
- §9 approval/session → Task 4 (gate, session ref, card, teardown, budget). ✓
- §10 perception & vision probe → Task 1 (indexer), Task 6 (marks + probe). ✓
- §11 dispatch & point-of-no-return → Task 3 (native-setter executors), Task 4 (`isPointOfNoReturn`). ✓
- §12 presence overlay → Task 5. ✓
- §13 coordination (persist across injections / hide during capture / animate latency / teardown) → Task 5 (dataset persistence, glide await), Task 6 (`setPresenceHidden` around capture), Task 4/5 (`finally` + `endSession` teardown). ✓
- §14 guardrails (budget/origin/stale/unscriptable) → Task 3 (stale + guarded), Task 4 (budget + origin fence). ✓
- §16 verification → each task's manual exercise; the multi-path Task 4/5/6 checks cover the spec's list. ✓
- §17 deferred (`chrome.debugger`, cross-tab) → correctly absent. ✓

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N". The one intentional callout — verifying the AI SDK `toModelOutput` shape against the installed minor (Task 6 Step 3) — is a real verification instruction with a concrete fallback, per spec §7. The stray `for` line in `injPress` (Task 3) is explicitly flagged for deletion.

**Type consistency:** `PageControlGate` (defined Task 2, implemented Task 4) — `requestSession`/`session`/`endSession` signatures match across `tools.ts` and `Chat.tsx`. `ControlSession` is defined in Task 2's `tools.ts`, then moved to `pageControl.ts` and imported back in Task 4 (Task 4 Step 3 says to delete the Task-2 copy — do not leave both). `ControlSpec` fields (`index/text/value/url/keys/direction/label/clear/sensitive`) match between the `ControlPage` zod schema (Task 4) and the `runControlStep`/executor consumers (Tasks 3–5). `snapshotPage`/`clearIndex`/`serializeRegistry` names are stable from Task 1 onward. Presence exports (`mountPresence`/`focusOn`/`pulse`/`setPresenceHidden`/`unmountPresence`) match their call sites in Tasks 5–6.
```
