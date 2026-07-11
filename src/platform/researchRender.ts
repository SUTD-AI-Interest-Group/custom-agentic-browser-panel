// Service-worker-side render host for the hybrid-escalation broker. The offscreen
// research agent cannot touch tabs, so when a page is JS-heavy / paywalled and the
// plain fetch comes back empty, it asks the SW (via research.renderPage) to render
// the URL in a REAL, isolated tab and return the readable text (+ optional shot).
//
// Boundaries (there is no human at the point-of-no-return gate here, so these are
// hard): the caller pre-checks the URL with isFetchableUrl (SSRF); rendering is
// read-only + safe actions only (navigate to the requested URL, scroll to settle
// lazy content) — never a form submit, cross-origin navigation, or auth; and the
// page is loaded in an isolated INCOGNITO window when the extension is allowed
// there, so the render does not ride the user's logged-in cookies (falls back to
// a normal background window otherwise — see caveats).
//
// Known caveats (single-tab, can't be fully exercised without a browser):
//  - Screenshot of a minimized/background tab is best-effort; captureVisibleTab
//    needs the window un-minimized, so 'screenshot'/'both' briefly normalizes it.
//  - PDFs render in Chrome's plugin viewer (no DOM text), so text extraction is
//    thin for them — a dedicated PDF path (pdf.js) is future work.
//  - If the SW is killed mid-life the module-scope tab handle resets and an
//    orphaned background window may linger until the user closes it.

import { isFetchableUrl } from './webFetch'

export interface RenderOutcome {
  text?: string
  title?: string
  finalUrl?: string
  screenshotDataUrl?: string
  error?: string
}

const NAV_TIMEOUT_MS = 30_000
const SETTLE_MS = 900
const IDLE_TEARDOWN_MS = 60_000
const MAX_TEXT = 20_000

let renderWindowId: number | undefined
let renderTabId: number | undefined
let usingIncognito = false
// Serialize renders: one shared tab, one page at a time (fits the sequential loop).
let mutex: Promise<unknown> = Promise.resolve()
let idleTimer: ReturnType<typeof setTimeout> | undefined

/** Render one URL in the isolated tab and return its readable text (+ shot). */
export function renderPage(url: string, want: 'text' | 'screenshot' | 'both'): Promise<RenderOutcome> {
  const run = mutex.then(
    () => doRender(url, want),
    () => doRender(url, want),
  )
  mutex = run.catch(() => {})
  return run
}

async function doRender(url: string, want: 'text' | 'screenshot' | 'both'): Promise<RenderOutcome> {
  // Defense in depth — the SW message handler already guards, re-check here.
  const guard = isFetchableUrl(url)
  if (!guard.ok) return { error: `refused to render (${guard.reason})` }
  if (idleTimer) clearTimeout(idleTimer)
  try {
    const tabId = await ensureTab()
    await navigate(tabId, url)
    // Safe, non-committing settle: scroll to bottom to trigger lazy content.
    await exec(tabId, injScrollToBottom).catch(() => {})
    await sleep(SETTLE_MS)
    const [extracted] = await exec(tabId, injExtractReadable)
    const result = (extracted?.result as { title?: string; text?: string } | undefined) ?? {}
    let screenshotDataUrl: string | undefined
    if (want !== 'text') screenshotDataUrl = await captureBestEffort()
    const tab = await chrome.tabs.get(tabId).catch(() => undefined)
    return {
      text: (result.text ?? '').slice(0, MAX_TEXT),
      title: result.title,
      finalUrl: tab?.url ?? url,
      screenshotDataUrl,
    }
  } catch (err) {
    return { error: `render failed: ${err instanceof Error ? err.message : String(err)}` }
  } finally {
    idleTimer = setTimeout(teardown, IDLE_TEARDOWN_MS)
  }
}

/** Ensure the isolated render tab exists; (re)create its window if needed. */
async function ensureTab(): Promise<number> {
  if (renderTabId !== undefined) {
    try {
      await chrome.tabs.get(renderTabId)
      return renderTabId
    } catch {
      renderTabId = undefined
      renderWindowId = undefined
    }
  }
  // Prefer an isolated incognito window (clean cookie jar); fall back to a normal
  // background window when the extension is not allowed in incognito.
  let win: chrome.windows.Window
  try {
    win = await chrome.windows.create({ incognito: true, focused: false, state: 'minimized' })
    usingIncognito = true
  } catch {
    win = await chrome.windows.create({ focused: false, state: 'minimized' })
    usingIncognito = false
  }
  renderWindowId = win.id
  renderTabId = win.tabs?.[0]?.id
  if (renderTabId === undefined) throw new Error('could not open a render tab')
  return renderTabId
}

/** Navigate the render tab and wait for the load to complete (bounded). */
async function navigate(tabId: number, url: string): Promise<void> {
  await chrome.tabs.update(tabId, { url })
  await new Promise<void>((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      chrome.tabs.onUpdated.removeListener(listener)
      clearTimeout(timer)
      resolve()
    }
    const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && info.status === 'complete') finish()
    }
    chrome.tabs.onUpdated.addListener(listener)
    const timer = setTimeout(finish, NAV_TIMEOUT_MS)
    // Guard against a load that completed before the listener attached.
    void chrome.tabs.get(tabId).then((t) => t.status === 'complete' && finish()).catch(() => finish())
  })
}

/** captureVisibleTab needs the window un-minimized; do it briefly, then restore. */
async function captureBestEffort(): Promise<string | undefined> {
  if (renderWindowId === undefined) return undefined
  try {
    await chrome.windows.update(renderWindowId, { state: 'normal', focused: false })
    await sleep(150)
    const shot = await chrome.tabs.captureVisibleTab(renderWindowId, { format: 'png' })
    await chrome.windows.update(renderWindowId, { state: 'minimized' }).catch(() => {})
    return shot
  } catch {
    return undefined
  }
}

function teardown(): void {
  const id = renderWindowId
  renderWindowId = undefined
  renderTabId = undefined
  if (id !== undefined) chrome.windows.remove(id).catch(() => {})
}

function exec<T>(tabId: number, func: () => T) {
  return chrome.scripting.executeScript({ target: { tabId }, func })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---- Injected page-world functions (self-contained; no imports/closures) ----

/** Scroll to the bottom to trigger lazy-loaded content. Read-only side effect. */
function injScrollToBottom(): void {
  try {
    window.scrollTo(0, document.body.scrollHeight)
  } catch {
    /* ignore */
  }
}

/** Reduce the LIVE (rendered) DOM to readable text — operating on a CLONE so the
 *  page is never mutated. Mirrors platform/webFetch.extractReadableText. */
function injExtractReadable(): { title: string; text: string } {
  const title = (document.title || '').trim()
  const pick = document.querySelector('main') || document.querySelector('article') || document.body
  if (!pick) return { title, text: '' }
  const root = pick.cloneNode(true) as HTMLElement
  root.querySelectorAll('script,style,noscript,nav,footer,header,aside,form,svg').forEach((n) => n.remove())
  root
    .querySelectorAll('p,div,section,article,h1,h2,h3,h4,h5,h6,li,br,tr,td,th,blockquote,pre')
    .forEach((el) => el.after(document.createTextNode('\n')))
  const text = (root.textContent || '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*/g, '\n\n').trim()
  return { title, text: text.slice(0, 20000) }
}

/** For diagnostics/telemetry: whether the last render used an isolated jar. */
export function renderIsIsolated(): boolean {
  return usingIncognito
}
